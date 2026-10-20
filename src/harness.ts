import type { ChildProcess } from "node:child_process";

export type HarnessCapability =
  | "prompt-invocation"
  | "structured-output"
  | "cancellation"
  | "timeouts"
  | "bounded-output"
  | "parallel-agents";

export interface HarnessCapabilities {
  readonly harnessId: string;
  readonly available: boolean;
  readonly supported: readonly HarnessCapability[];
  readonly unsupported: readonly HarnessCapability[];
  readonly detectedAt: string;
  readonly reason?: string;
}

export interface HarnessInvocation {
  /** Plain prompt text; adapters must pass it as an argument or stdin, never shell-interpolate it. */
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type HarnessOutcome = "succeeded" | "failed" | "timed_out" | "cancelled" | "unavailable";

export interface HarnessResult {
  readonly harnessId: string;
  readonly outcome: HarnessOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface HarnessAdapter {
  readonly id: string;
  detectCapabilities(options?: { readonly timeoutMs?: number }): Promise<HarnessCapabilities>;
  invoke(request: HarnessInvocation): Promise<HarnessResult>;
}

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface ProcessOutcome extends ProcessOutput {
  readonly outcome: Exclude<HarnessOutcome, "unavailable">;
  readonly exitCode: number | null;
  readonly error?: string;
}

export function validateInvocation(request: HarnessInvocation): void {
  if (!request.prompt.trim()) throw new TypeError("Prompt must be non-empty.");
  if (!request.cwd.trim()) throw new TypeError("Working directory must be non-empty.");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    throw new RangeError("maxOutputBytes must be a positive safe integer.");
  }
}

export function unavailableCapabilities(harnessId: string, reason: string): HarnessCapabilities {
  return {
    harnessId,
    available: false,
    supported: [],
    unsupported: ["prompt-invocation", "structured-output", "cancellation", "timeouts", "bounded-output", "parallel-agents"],
    detectedAt: new Date().toISOString(),
    reason,
  };
}
