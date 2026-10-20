import { unavailableCapabilities, validateInvocation } from "../../dist/harness.js";

/**
 * Deterministic test fixture implementing the public adapter contract.
 * It deliberately does not import Claude Code code or spawn a process.
 * Prompts prefixed with "fixture:" select a bounded test outcome.
 */
export class ScriptedHarnessAdapter {
  readonlyId = "scripted-fixture";

  get id() {
    return this.readonlyId;
  }

  async detectCapabilities() {
    return {
      harnessId: this.id,
      available: true,
      supported: ["prompt-invocation", "bounded-output"],
      unsupported: ["structured-output", "cancellation", "timeouts", "parallel-agents"],
      detectedAt: new Date().toISOString(),
    };
  }

  async invoke(request) {
    validateInvocation(request);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const finish = (outcome, { exitCode = outcome === "succeeded" ? 0 : 1, stdout = "", stderr = "", error } = {}) => {
      const bytes = Buffer.from(stdout);
      const outputTruncated = bytes.length > request.maxOutputBytes;
      const boundedStdout = bytes.subarray(0, request.maxOutputBytes).toString("utf8");
      return {
        harnessId: this.id,
        outcome,
        exitCode,
        stdout: boundedStdout,
        stderr,
        outputTruncated,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, performance.now() - start),
        ...(error ? { error } : {}),
      };
    };

    if (request.prompt === "fixture:unavailable") {
      const capabilities = unavailableCapabilities(this.id, "Scripted fixture configured as unavailable.");
      return {
        harnessId: this.id,
        outcome: "unavailable",
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, performance.now() - start),
        error: capabilities.reason,
      };
    }
    if (request.prompt === "fixture:timeout") return finish("timed_out", { exitCode: null, error: "fixture timeout" });
    if (request.prompt === "fixture:cancelled") return finish("cancelled", { exitCode: null, error: "fixture cancelled" });
    if (request.prompt === "fixture:failure") return finish("failed", { exitCode: 9, stderr: "fixture failed" });
    if (request.prompt === "fixture:large-output") return finish("failed", { stdout: "x".repeat(request.maxOutputBytes + 10) });
    return finish("succeeded", { stdout: "scripted-ok" });
  }
}
