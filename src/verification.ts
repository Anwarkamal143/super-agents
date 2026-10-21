import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type VerificationStatus = "passed" | "failed" | "skipped" | "timed_out" | "cancelled" | "blocked";

export interface VerificationCheck {
  readonly id: string;
  readonly kind: "test" | "typecheck" | "command";
  readonly executable: string;
  readonly args: readonly string[];
  /** Relative directory within the selected repository. Defaults to ".". */
  readonly cwd?: string;
  /** Only these keys from process.env are inherited; values are never copied into evidence. */
  readonly environmentAllowlist?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly skip?: boolean;
}

export interface VerificationConfig {
  readonly repositoryRoot: string;
  readonly checks: readonly VerificationCheck[];
  /** Explicit executable allowlist, keyed by stable command id. */
  readonly allowedExecutables: Readonly<Record<string, string>>;
  /** Must authorize the exact check before any process is spawned. */
  readonly authorize: (actionType: "command.execute", payload: VerificationAuthorizationPayload) => Promise<boolean>;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
  readonly now?: () => string;
  readonly id?: () => string;
  readonly spawnProcess?: typeof spawn;
  readonly signal?: AbortSignal;
  /** Awaited after each result; rejection stops the run before another check can start. */
  readonly onCheckComplete?: (result: VerificationEvidenceRecord) => Promise<void>;
}

export interface VerificationAuthorizationPayload {
  readonly checkId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environmentKeys: readonly string[];
}

export interface VerificationEvidenceRecord {
  readonly id: string;
  readonly checkId: string;
  readonly kind: VerificationCheck["kind"];
  readonly status: VerificationStatus;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly outputTruncated: boolean;
  readonly observedStdoutBytes: number;
  readonly observedStderrBytes: number;
  readonly reason?: string;
}

export interface VerificationReport {
  readonly repositoryRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "passed" | "failed" | "incomplete";
  readonly checks: readonly VerificationEvidenceRecord[];
}

export class VerificationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationConfigError";
  }
}

/**
 * Raised when a completed check's evidence cannot be persisted by onCheckComplete.
 * The callback's error is intentionally not retained because it may contain secrets.
 */
export class VerificationPersistenceError extends Error {
  readonly checkId: string;

  constructor(checkId: string) {
    super(`Failed to persist verification evidence for check "${checkId}".`);
    this.name = "VerificationPersistenceError";
    this.checkId = checkId;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"] as const;

export async function runVerification(config: VerificationConfig): Promise<VerificationReport> {
  validateConfig(config);
  const repositoryRoot = await realpath(config.repositoryRoot);
  const rootStats = await lstat(repositoryRoot);
  if (!rootStats.isDirectory()) throw new VerificationConfigError("repositoryRoot must be an existing directory.");

  const now = config.now ?? (() => new Date().toISOString());
  const id = config.id ?? randomUUID;
  const startedAt = now();
  const results: VerificationEvidenceRecord[] = [];
  const spawnProcess = config.spawnProcess ?? spawn;
  const recordResult = async (result: VerificationEvidenceRecord): Promise<void> => {
    results.push(result);
    try {
      await config.onCheckComplete?.(result);
    } catch {
      // Do not expose arbitrary persistence callback errors: adapters may include
      // file paths, serialized evidence, or secret-bearing storage diagnostics.
      // Rejecting here also prevents the loop from authorizing another check.
      throw new VerificationPersistenceError(result.checkId);
    }
  };
  const appendNotRun = async (startIndex: number): Promise<void> => {
    for (const check of config.checks.slice(startIndex)) {
      await recordResult(emptyEvidence(check, "skipped", repositoryRoot, now, id,
        "Not run because an earlier check stopped the verification run."));
    }
  };

  for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
    const check = config.checks[checkIndex];
    const executable = config.allowedExecutables[check.executable];
    const timeoutMs = check.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = check.maxOutputBytes ?? config.defaultMaxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const cwd = await resolveCheckCwd(repositoryRoot, check.cwd ?? ".");
    const environmentKeys = [...new Set([...(check.environmentAllowlist ?? DEFAULT_ENV_KEYS)])].sort();
    const authorizationPayload: VerificationAuthorizationPayload = {
      checkId: check.id,
      executable,
      args: [...check.args],
      cwd,
      timeoutMs,
      maxOutputBytes,
      environmentKeys,
    };

    if (check.skip) {
      await recordResult(emptyEvidence(check, "skipped", cwd, now, id, "Check explicitly configured to skip."));
      continue;
    }

    if (config.signal?.aborted) {
      await recordResult(emptyEvidence(check, "cancelled", cwd, now, id, "Verification run was cancelled before authorization."));
      await appendNotRun(checkIndex + 1);
      break;
    }

    let authorized = false;
    try {
      authorized = await config.authorize("command.execute", authorizationPayload);
    } catch (error) {
      await recordResult(emptyEvidence(check, config.signal?.aborted ? "cancelled" : "blocked", cwd, now, id,
        config.signal?.aborted ? "Verification run was cancelled during authorization." : safeError(error, "Authorization failed.")));
      await appendNotRun(checkIndex + 1);
      break;
    }

    // The parent request may be cancelled while human elicitation is pending.
    // Re-check immediately after the callback and before any process can spawn.
    if (config.signal?.aborted) {
      await recordResult(emptyEvidence(check, "cancelled", cwd, now, id, "Verification run was cancelled during authorization."));
      await appendNotRun(checkIndex + 1);
      break;
    }

    if (!authorized) {
      await recordResult(emptyEvidence(check, "blocked", cwd, now, id, "Execution was not authorized."));
      await appendNotRun(checkIndex + 1);
      break;
    }

    const env: NodeJS.ProcessEnv = {};
    for (const key of environmentKeys) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }

    const result = await executeCheck({
      check,
      executable,
      cwd,
      timeoutMs,
      maxOutputBytes,
      env,
      spawnProcess,
      now,
      id,
      signal: config.signal,
    });
    await recordResult(result);
    if (result.status === "failed" || result.status === "timed_out" || result.status === "cancelled") {
      await appendNotRun(checkIndex + 1);
      break;
    }
  }

  const finishedAt = now();
  const status = results.some((item) => item.status === "failed" || item.status === "timed_out")
    ? "failed"
    : results.some((item) => item.status === "blocked" || item.status === "cancelled" || item.status === "skipped")
      ? "incomplete"
      : "passed";
  return { repositoryRoot, startedAt, finishedAt, status, checks: results };
}

function validateConfig(config: VerificationConfig): void {
  if (!config.repositoryRoot.trim()) throw new VerificationConfigError("repositoryRoot must be non-empty.");
  if (!Array.isArray(config.checks) || config.checks.length === 0) {
    throw new VerificationConfigError("At least one explicitly configured verification check is required.");
  }
  if (typeof config.authorize !== "function") {
    throw new VerificationConfigError("An authorization callback is required; verification fails closed without it.");
  }
  for (const [id, executable] of Object.entries(config.allowedExecutables)) {
    if (!id.trim() || !path.isAbsolute(executable)) {
      throw new VerificationConfigError("Executable allowlist entries require a stable id and absolute executable path.");
    }
  }
  const seen = new Set<string>();
  for (const check of config.checks) {
    if (!check.id.trim() || seen.has(check.id)) throw new VerificationConfigError("Check ids must be non-empty and unique.");
    seen.add(check.id);
    if (!["test", "typecheck", "command"].includes(check.kind)) {
      throw new VerificationConfigError(`Unsupported check kind for ${check.id}.`);
    }
    if (!Object.hasOwn(config.allowedExecutables, check.executable)) {
      throw new VerificationConfigError(`Check ${check.id} references an executable outside the allowlist.`);
    }
    if (!Array.isArray(check.args) || check.args.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new VerificationConfigError(`Check ${check.id} has invalid arguments.`);
    }
    if (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
      throw new VerificationConfigError(`Check ${check.id} timeoutMs must be a positive safe integer.`);
    }
    if (check.maxOutputBytes !== undefined && (!Number.isSafeInteger(check.maxOutputBytes) || check.maxOutputBytes <= 0)) {
      throw new VerificationConfigError(`Check ${check.id} maxOutputBytes must be a positive safe integer.`);
    }
    for (const key of check.environmentAllowlist ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new VerificationConfigError(`Check ${check.id} contains an invalid environment key.`);
      }
    }
  }
  for (const [name, value] of [["defaultTimeoutMs", config.defaultTimeoutMs], ["defaultMaxOutputBytes", config.defaultMaxOutputBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new VerificationConfigError(`${name} must be a positive safe integer.`);
    }
  }
}

async function resolveCheckCwd(root: string, relative: string): Promise<string> {
  if (!relative.trim() || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..")) {
    throw new VerificationConfigError("Check cwd must be a non-empty path contained within repositoryRoot.");
  }
  const resolved = await realpath(path.resolve(root, relative));
  const rel = path.relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new VerificationConfigError("Check cwd resolves outside repositoryRoot.");
  }
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw new VerificationConfigError("Check cwd must resolve to a directory.");
  return resolved;
}

interface ExecuteCheckInput {
  readonly check: VerificationCheck;
  readonly executable: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly now: () => string;
  readonly id: () => string;
  readonly signal?: AbortSignal;
}

async function executeCheck(input: ExecuteCheckInput): Promise<VerificationEvidenceRecord> {
  const { check, executable, cwd, timeoutMs, maxOutputBytes, env, spawnProcess, now, id, signal } = input;
  const startedAt = now();
  const start = performance.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let retainedBytes = 0;
  let outputTruncated = false;
  let outputLimitExceeded = false;
  let timedOut = false;
  let cancelled = false;
  let stopRequested = false;
  let spawnError: string | undefined;
  let executionError: string | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let child: ChildProcess | undefined;
  let resolveResult: ((value: VerificationEvidenceRecord) => void) | undefined;
  let cancelListener: (() => void) | undefined;
  let stdoutDataListener: ((chunk: Buffer) => void) | undefined;
  let stderrDataListener: ((chunk: Buffer) => void) | undefined;
  let stdoutErrorListener: (() => void) | undefined;
  let stderrErrorListener: (() => void) | undefined;

  const resultPromise = new Promise<VerificationEvidenceRecord>((resolve) => { resolveResult = resolve; });
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (cancelListener) signal?.removeEventListener("abort", cancelListener);
    if (stdoutDataListener) child?.stdout?.removeListener("data", stdoutDataListener);
    if (stderrDataListener) child?.stderr?.removeListener("data", stderrDataListener);
    if (stdoutErrorListener) child?.stdout?.removeListener("error", stdoutErrorListener);
    if (stderrErrorListener) child?.stderr?.removeListener("error", stderrErrorListener);
    // A forced settlement can happen without a child close event. Release our
    // stdio streams in every completion path so retained pipes/listeners do not
    // outlive the verification result. This does not prove OS process exit.
    if (child?.stdout && !child.stdout.destroyed) child.stdout.destroy();
    if (child?.stderr && !child.stderr.destroyed) child.stderr.destroy();
    const status: VerificationStatus = timedOut ? "timed_out" : cancelled ? "cancelled" :
      spawnError || executionError || outputLimitExceeded || exitCode !== 0 ? "failed" : "passed";
    resolveResult?.({
      id: id(),
      checkId: check.id,
      kind: check.kind,
      status,
      command: [executable, ...check.args],
      cwd,
      startedAt,
      finishedAt: now(),
      durationMs: Math.max(0, performance.now() - start),
      exitCode,
      stdout,
      stderr,
      stdoutDigest: stdoutHash.digest("hex"),
      stderrDigest: stderrHash.digest("hex"),
      outputTruncated,
      observedStdoutBytes: stdoutBytes,
      observedStderrBytes: stderrBytes,
      ...(spawnError ? { reason: spawnError } : timedOut ? { reason: "Check exceeded its timeout." } :
        cancelled ? { reason: "Check was cancelled." } : outputLimitExceeded ? { reason: "Check exceeded its output limit." } :
          executionError ? { reason: executionError } : {}),
    });
  };
  const stop = (kind: "timed_out" | "cancelled" | "output_limit" | "stream_error") => {
    if (settled || !child || stopRequested) return;
    stopRequested = true;
    timedOut = kind === "timed_out";
    cancelled = kind === "cancelled";
    if (kind === "output_limit") outputLimitExceeded = true;
    if (kind === "stream_error" && !executionError) executionError = "Verification output stream failed.";
    try {
      child.kill("SIGTERM");
    } catch {
      // Still schedule SIGKILL: a failed graceful signal must not disable escalation.
    }
    killTimer = setTimeout(() => {
      if (settled || !child) return;
      try {
        const sent = child.kill("SIGKILL");
        if (!sent && !settled) {
          executionError ??= "Unable to confirm verification process termination.";
          finish(null);
          return;
        }
      } catch {
        executionError ??= "Unable to confirm verification process termination.";
        finish(null);
        return;
      }

      // A successful kill() return means the signal was sent, not that the
      // child and its inherited stdio have closed. Bound this final wait too.
      killTimer = setTimeout(() => {
        if (settled) return;
        executionError ??= "Unable to confirm verification process termination.";
        finish(null);
      }, 250);
    }, 250);
  };

  if (signal?.aborted) {
    cancelled = true;
    finish(null);
    return resultPromise;
  }

  try {
    child = spawnProcess(executable, [...check.args], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spawnError = safeError(error, "Failed to start verification process.");
    finish(null);
    return resultPromise;
  }

  const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
    const hash = target === "stdout" ? stdoutHash : stderrHash;
    hash.update(chunk);
    if (target === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    const remaining = maxOutputBytes - retainedBytes;
    if (remaining <= 0) {
      outputTruncated = true;
      outputLimitExceeded = true;
      stop("output_limit");
      return;
    }
    const accepted = chunk.subarray(0, remaining);
    retainedBytes += accepted.length;
    if (accepted.length < chunk.length) {
      outputTruncated = true;
      outputLimitExceeded = true;
      stop("output_limit");
    }
    if (target === "stdout") stdout += accepted.toString("utf8");
    else stderr += accepted.toString("utf8");
  };
  stdoutDataListener = (chunk: Buffer) => collect(chunk, "stdout");
  stderrDataListener = (chunk: Buffer) => collect(chunk, "stderr");
  child.stdout?.on("data", stdoutDataListener);
  child.stderr?.on("data", stderrDataListener);
  stdoutErrorListener = () => stop("stream_error");
  stderrErrorListener = () => stop("stream_error");
  child.stdout?.on("error", stdoutErrorListener);
  child.stderr?.on("error", stderrErrorListener);
  child.once("error", (error) => {
    if (stopRequested) {
      executionError ??= safeError(error, "Verification process error.");
      return;
    }
    spawnError = safeError(error, "Verification process failed to start.");
    finish(null);
  });
  child.once("close", (code) => finish(code));
  cancelListener = () => stop("cancelled");
  signal?.addEventListener("abort", cancelListener, { once: true });
  timer = setTimeout(() => stop("timed_out"), timeoutMs);
  return resultPromise;
}

function emptyEvidence(
  check: VerificationCheck,
  status: "skipped" | "blocked" | "cancelled",
  cwd: string,
  now: () => string,
  id: () => string,
  reason: string,
): VerificationEvidenceRecord {
  const emptyDigest = createHash("sha256").update("").digest("hex");
  const at = now();
  return {
    id: id(),
    checkId: check.id,
    kind: check.kind,
    status,
    command: [],
    cwd,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutDigest: emptyDigest,
    stderrDigest: emptyDigest,
    outputTruncated: false,
    observedStdoutBytes: 0,
    observedStderrBytes: 0,
    reason,
  };
}


function safeError(_error: unknown, fallback: string): string {
  // Child-process and authorization errors can embed private paths, command
  // arguments, or secret-bearing runtime diagnostics. Evidence exposes only
  // stable operator-safe reasons; detailed diagnostics belong in a protected
  // host log, not the persisted verification report.
  return fallback;
}
