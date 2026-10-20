import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessInvocation,
  type HarnessResult,
  type HarnessCapability,
  type ProcessOutcome,
  unavailableCapabilities,
  validateInvocation,
} from "./harness.js";

export interface ClaudeCodeAdapterOptions {
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly spawnProcess?: typeof spawn;
}

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly now: () => string;
  private readonly spawnProcess: typeof spawn;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.executable = options.executable ?? "claude";
    this.env = options.env;
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async detectCapabilities(options: { readonly timeoutMs?: number } = {}): Promise<HarnessCapabilities> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    try {
      const version = await this.runProcess(["--version"], process.cwd(), timeoutMs, MAX_PROBE_OUTPUT_BYTES);
      if (version.outcome !== "succeeded") {
        return unavailableCapabilities(this.id, version.error ?? `Claude CLI version probe ${version.outcome}.`);
      }
      const help = await this.runProcess(["--help"], process.cwd(), timeoutMs, MAX_PROBE_OUTPUT_BYTES);
      if (help.outcome !== "succeeded") {
        return unavailableCapabilities(this.id, help.error ?? `Claude CLI help probe ${help.outcome}.`);
      }

      const helpText = `${help.stdout}\n${help.stderr}`;
      const supported: HarnessCapability[] = ["cancellation", "timeouts", "bounded-output"];
      const unsupported: HarnessCapability[] = ["structured-output", "parallel-agents"];
      const printSupported = /(?:^|\s)-p(?:,|\s|$)|--print(?:\s|,|$)/m.test(helpText);
      if (printSupported) supported.push("prompt-invocation");
      else unsupported.push("prompt-invocation");

      return {
        harnessId: this.id,
        available: printSupported,
        supported,
        unsupported,
        detectedAt: this.now(),
        ...(!printSupported ? { reason: "Claude CLI help does not advertise print/non-interactive mode." } : {}),
      };
    } catch (error) {
      return unavailableCapabilities(this.id, error instanceof Error ? error.message : "Claude CLI capability detection failed.");
    }
  }

  async invoke(request: HarnessInvocation): Promise<HarnessResult> {
    validateInvocation(request);
    const startedAt = this.now();
    const start = performance.now();
    const capabilities = await this.detectCapabilities();
    if (!capabilities.available || !capabilities.supported.includes("prompt-invocation")) {
      const finishedAt = this.now();
      return {
        harnessId: this.id,
        outcome: "unavailable",
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, performance.now() - start),
        error: capabilities.reason ?? "Claude Code print mode is unavailable.",
      };
    }

    const result = await this.runProcess(["-p", request.prompt, "--output-format", "text"], request.cwd,
      request.timeoutMs, request.maxOutputBytes, request.signal);
    const finishedAt = this.now();
    return {
      harnessId: this.id,
      ...result,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, performance.now() - start),
    };
  }

  private runProcess(
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<ProcessOutcome> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let outputTruncated = false;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let spawnError: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (exitCode: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const outcome = timedOut ? "timed_out" : cancelled ? "cancelled" :
          error ? "failed" : exitCode === 0 ? "succeeded" : "failed";
        resolve({
          outcome,
          exitCode,
          stdout,
          stderr,
          outputTruncated,
          ...(error ? { error } : {}),
        });
      };
      const stop = (kind: "timed_out" | "cancelled") => {
        if (settled) return;
        timedOut = kind === "timed_out";
        cancelled = kind === "cancelled";
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref();
      };
      const onAbort = () => stop("cancelled");
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.executable, [...args], {
          cwd,
          env: this.env ?? process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish(null, error instanceof Error ? error.message : "Failed to spawn Claude CLI.");
        return;
      }

      const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
        const remaining = maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          return;
        }
        const accepted = chunk.subarray(0, remaining);
        outputBytes += accepted.length;
        if (accepted.length < chunk.length) outputTruncated = true;
        if (target === "stdout") stdout += accepted.toString("utf8");
        else stderr += accepted.toString("utf8");
        if (outputTruncated) child.kill("SIGTERM");
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
      child.once("error", (error) => {
        spawnError = error.message;
        finish(null, spawnError);
      });
      child.once("close", (code) => finish(code, spawnError));
      timer = setTimeout(() => stop("timed_out"), timeoutMs);
      timer.unref();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
