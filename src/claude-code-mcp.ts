/**
 * Minimal MCP stdio bridge for the active Claude Code session.
 *
 * Deliberately uses only Node.js built-ins and existing factory stores. This
 * avoids adding an unpinned MCP SDK to the current dependency-free runtime;
 * protocol behavior is limited to initialize, tools/list, tools/call, and
 * server-initiated elicitation/create responses.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { WorkflowRun, WorkflowStatus } from "./domain.js";
import { ApprovalPolicy, JsonFileApprovalStore, digestPayload, type ConsequentialAction } from "./approval.js";
import { JsonFileWorkflowStore, WorkflowOrchestrator, WorkflowConflictError } from "./orchestrator.js";
import { WORKFLOW_TRANSITIONS } from "./workflow.js";
import { runVerification, type VerificationCheck } from "./verification.js";

type JsonObject = Record<string, unknown>;
type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: JsonObject; result?: unknown; error?: { code: number; message: string } };
type ElicitationAction = "accept" | "decline" | "cancel";

const TOOLS = [
  { name: "factory_session_create", description: "Create a persisted factory workflow session.", inputSchema: { type: "object", properties: { requestId: { type: "string", minLength: 1 } }, required: ["requestId"], additionalProperties: false } },
  { name: "factory_session_get", description: "Read a workflow session, its revision, audit events, steps and evidence.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 } }, required: ["runId"], additionalProperties: false } },
  { name: "factory_session_recover_interrupted", description: "After human confirmation, mark lingering running workflow steps interrupted; never retries them automatically.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 } }, required: ["runId"], additionalProperties: false } },
  { name: "factory_step_reconcile", description: "Human-gated reconciliation of one interrupted step. Retry requires explicit host approval that the previous external effect was inspected and replay is safe.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, stepId: { type: "string", minLength: 1 }, resolution: { type: "string", enum: ["confirm_succeeded", "confirm_failed", "retry"] }, reason: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["runId", "stepId", "resolution", "reason"], additionalProperties: false } },
  { name: "factory_plan_request_approval", description: "Ask the human to approve the exact plan in the active host session. Decline, cancel or unsupported elicitation blocks implementation.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, plan: { type: "string", minLength: 1, maxLength: 12000 } }, required: ["runId", "expectedRevision", "plan"], additionalProperties: false } },
  { name: "factory_phase_transition", description: "Advance a workflow only with the expected persisted revision and a legal transition.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, to: { type: "string", enum: ["verifying", "reviewing", "failed", "cancelled"] } }, required: ["runId", "expectedRevision", "to"], additionalProperties: false } },
  { name: "factory_action_request_approval", description: "Request fresh human approval for one exact native Claude Code tool input. Payload must be {toolName, toolInput}; it is bound to a SHA-256 digest and consumed once by the PreToolUse gate.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, actionType: { type: "string", enum: ["file.write", "command.execute"] }, toolName: { type: "string", enum: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] }, toolInput: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["runId", "actionType", "toolName", "toolInput", "reason"], additionalProperties: false } },
  { name: "factory_verification_run", description: "Run the operator-configured, bounded verification profile. Each exact check requires fresh human approval; results are persisted as runner-observed evidence.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 } }, required: ["runId", "expectedRevision"], additionalProperties: false } },
  { name: "factory_evidence_submit", description: "Persist bounded evidence from the active model session. Model-reported evidence is not trusted runner evidence.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, summary: { type: "string", minLength: 1, maxLength: 4000 }, kind: { type: "string", enum: ["command", "test", "typecheck", "review", "other"] }, outcome: { type: "string", enum: ["passed", "failed", "skipped", "unknown"] } }, required: ["runId", "expectedRevision", "summary", "kind", "outcome"], additionalProperties: false } },
  { name: "factory_delivery_status", description: "Report delivery readiness; never creates PRs, merges, deploys or publishes.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 } }, required: ["runId"], additionalProperties: false } },
] as const;

export interface FactoryMcpServerOptions {
  readonly stateDirectory?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Bounded override intended for tests and controlled local deployments. */
  readonly elicitationTimeoutMs?: number;
}

const DEFAULT_ELICITATION_TIMEOUT_MS = 45_000;
const MAX_ELICITATION_TIMEOUT_MS = 120_000;

export async function runFactoryMcpServer(options: FactoryMcpServerOptions = {}): Promise<void> {
  const configuredTimeout = options.elicitationTimeoutMs ?? Number(process.env["FACTORY_ELICITATION_TIMEOUT_MS"] ?? DEFAULT_ELICITATION_TIMEOUT_MS);
  const elicitationTimeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= MAX_ELICITATION_TIMEOUT_MS
    ? configuredTimeout
    : DEFAULT_ELICITATION_TIMEOUT_MS;
  const cwd = process.cwd();
  const stateDirectory = path.resolve(cwd, options.stateDirectory ?? process.env["FACTORY_STATE_DIR"] ?? ".factory-state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(path.join(stateDirectory, "workflows.json")));
  const approvals = new ApprovalPolicy(new JsonFileApprovalStore(path.join(stateDirectory, "approvals.json")));
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });
  let nextId = 0;
  let clientElicitation = false;
  const pending = new Map<string | number, { resolve: (message: RpcMessage) => void; reject: (error: Error) => void; parentRequestId?: string | number }>();
  const requestControllers = new Map<string | number, AbortController>();

  const send = (message: RpcMessage) => { output.write(JSON.stringify(message) + "\n"); };
  const rpcRequest = (method: string, params: JsonObject, parentRequestId?: string | number): Promise<RpcMessage> => new Promise((resolve, reject) => {
    if (!clientElicitation) { reject(new Error("Host does not advertise MCP elicitation; approval is unavailable.")); return; }
    const id = `factory-bridge-${++nextId}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Human elicitation timed out; action blocked.")); }, elicitationTimeoutMs);
    timer.unref();
    pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); }, reject: (error) => { clearTimeout(timer); reject(error); }, ...(parentRequestId !== undefined ? { parentRequestId } : {}) });
    send({ jsonrpc: "2.0", id, method, params });
  });

  const textResult = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
  const requireString = (obj: JsonObject, key: string): string => {
    const value = obj[key];
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${key} must be a non-empty string.`);
    return value;
  };
  const requireInteger = (obj: JsonObject, key: string): number => {
    const value = obj[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${key} must be a non-negative safe integer.`);
    return value as number;
  };
  const requireObject = (value: unknown, key: string): JsonObject => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${key} must be a plain object.`);
    return value as JsonObject;
  };
  const requestHuman = async (message: string, parentRequestId?: string | number): Promise<{ action: ElicitationAction; content?: JsonObject }> => {
    const response = await rpcRequest("elicitation/create", {
      mode: "form",
      message,
      requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["approve", "decline"] } }, required: ["decision"], additionalProperties: false },
    }, parentRequestId);
    const result = response.result as JsonObject | undefined;
    const action = result?.["action"];
    if (action !== "accept" && action !== "decline" && action !== "cancel") throw new Error("Malformed elicitation response; action blocked.");
    const content = result?.["content"] && typeof result["content"] === "object" ? result["content"] as JsonObject : undefined;
    return { action, ...(content ? { content } : {}) };
  };

  const callTool = async (name: string, args: JsonObject, parentRequestId?: string | number, signal?: AbortSignal): Promise<unknown> => {
    validateToolArguments(name, args);
    switch (name) {
      case "factory_session_create": {
        const requestId = requireString(args, "requestId");
        const now = new Date().toISOString();
        const run: WorkflowRun = { id: randomUUID(), requestId, status: "created", revision: 0, createdAt: now, updatedAt: now };
        return await orchestrator.createRun(run);
      }
      case "factory_session_get": {
        const runId = requireString(args, "runId");
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        return record;
      }
      case "factory_session_recover_interrupted": {
        const runId = requireString(args, "runId");
        const before = await orchestrator.getWorkflow(runId);
        if (!before) throw new Error("Workflow session not found.");
        const running = Object.values(before.steps).filter((step) => step.status === "running").map((step) => step.id).sort();
        if (running.length === 0) return { recovered: [], note: "No running steps require interruption recovery." };
        const response = await requestHuman(
          `Confirm recovery of these lingering running steps? No step will be retried. Inspect any child process or external effect first. Run: ${runId}. Steps: ${running.join(", ")}. Each will be marked interrupted and require separate reconciliation.`,
          parentRequestId,
        );
        if (response.action !== "accept" || response.content?.["decision"] !== "approve") {
          return { recovered: [], blocked: true, reason: "Human declined, cancelled, or did not explicitly approve interruption recovery." };
        }
        const latest = await orchestrator.getWorkflow(runId);
        const latestRunning = latest ? Object.values(latest.steps).filter((step) => step.status === "running").map((step) => step.id).sort() : [];
        if (!latest || latest.run.revision !== before.run.revision || JSON.stringify(latestRunning) !== JSON.stringify(running)) {
          throw new WorkflowConflictError("Workflow changed while recovery approval was pending; reload and inspect current steps.");
        }
        const recovered = await orchestrator.recoverInterruptedSteps(runId, "claude-code-elicitation-host", running);
        return { recovered, note: "Steps were marked interrupted only. No command was replayed; reconcile each step after inspecting its external effects." };
      }
      case "factory_step_reconcile": {
        const runId = requireString(args, "runId");
        const stepId = requireString(args, "stepId");
        const resolution = requireString(args, "resolution") as "confirm_succeeded" | "confirm_failed" | "retry";
        if (!["confirm_succeeded", "confirm_failed", "retry"].includes(resolution)) throw new TypeError("Unknown reconciliation resolution.");
        const reason = requireString(args, "reason");
        if (reason.length > 2000) throw new TypeError("reason exceeds 2000 characters.");
        const before = await orchestrator.getWorkflow(runId);
        if (!before) throw new Error("Workflow session not found.");
        const step = before.steps[stepId];
        if (!step || step.status !== "interrupted") throw new WorkflowConflictError("Step is not awaiting reconciliation.");
        const prompt = resolution === "retry"
          ? `Authorize retry of interrupted step? First inspect and reconcile the previous process/external effect; retry is safe only if replay cannot duplicate harmful effects. Run: ${runId}. Step: ${stepId}. Previous attempt: ${step.attempt ?? 1}. Reason: ${reason}`
          : `Confirm reconciliation of interrupted step. Run: ${runId}. Step: ${stepId}. Resolution: ${resolution}. Previous attempt: ${step.attempt ?? 1}. Reason: ${reason}. Only confirm succeeded/failed if you inspected the actual outcome; this does not create runner evidence.`;
        const response = await requestHuman(prompt, parentRequestId);
        if (response.action !== "accept" || response.content?.["decision"] !== "approve") {
          return { reconciled: false, blocked: true, reason: "Human declined, cancelled, or did not explicitly approve this reconciliation." };
        }
        const latest = await orchestrator.getWorkflow(runId);
        const latestStep = latest?.steps[stepId];
        if (!latest || latest.run.revision !== before.run.revision || !latestStep || latestStep.status !== "interrupted" ||
            latestStep.startedAt !== step.startedAt || (latestStep.attempt ?? 1) !== (step.attempt ?? 1)) {
          throw new WorkflowConflictError("Workflow or step changed while reconciliation approval was pending; reload and inspect again.");
        }
        const reconciled = await orchestrator.resolveInterruptedStep(
          runId, stepId, resolution, "claude-code-elicitation-host", reason,
          { externalEffectReconciled: resolution === "retry" },
        );
        return { reconciled: true, step: reconciled, note: resolution === "retry"
          ? "Retry is authorized only after human-confirmed external-effect reconciliation. The bridge does not execute the retry automatically."
          : "Step status was reconciled by human confirmation. This does not synthesize runner-observed evidence." };
      }
      case "factory_plan_request_approval": {
        const runId = requireString(args, "runId");
        const expectedRevision = requireInteger(args, "expectedRevision");
        const plan = requireString(args, "plan");
        let record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        if (record.run.revision !== expectedRevision) throw new WorkflowConflictError("Stale revision; reload the session before requesting approval.");
        if (record.run.status !== "created" && record.run.status !== "ready") throw new WorkflowConflictError("Plan approval can only be requested for a new or ready run.");
        let run = record.run;
        if (run.status === "created") run = await orchestrator.transition(runId, "ready", run.revision);
        run = await orchestrator.transition(runId, "running", run.revision);
        run = await orchestrator.transition(runId, "awaiting_approval", run.revision);
        const digest = digestPayload({ runId, revision: expectedRevision, plan });
        let response: { action: ElicitationAction; content?: JsonObject };
        try { response = await requestHuman(`Approve this factory plan? Run: ${runId}. Plan SHA-256: ${digest}.\n\n${plan}`, parentRequestId); }
        catch (error) {
          const cancelled = await orchestrator.transition(runId, "cancelled", run.revision);
          return { approved: false, blocked: true, run: cancelled, reason: error instanceof Error ? error.message : "Elicitation failed." };
        }
        if (response.action !== "accept" || response.content?.["decision"] !== "approve") {
          const cancelled = await orchestrator.transition(runId, "cancelled", run.revision);
          return { approved: false, blocked: true, run: cancelled, reason: "Human approval was declined, cancelled, or malformed." };
        }
        const resumed = await orchestrator.transition(runId, "running", run.revision);
        return { approved: true, run: resumed, planDigest: digest, note: "This approves the plan only. Each native file/command action still requires exact action approval through the PreToolUse gate." };
      }
      case "factory_phase_transition": {
        const runId = requireString(args, "runId");
        const revision = requireInteger(args, "expectedRevision");
        const to = requireString(args, "to") as WorkflowStatus;
        if (!(to in WORKFLOW_TRANSITIONS) || to === "completed") throw new TypeError("Unknown or gated workflow phase; completion is not exposed by this bridge.");
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        if (record.run.revision !== revision) throw new WorkflowConflictError("Stale revision; reload the session.");
        return await orchestrator.transition(runId, to, revision);
      }
      case "factory_action_request_approval": {
        const runId = requireString(args, "runId");
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        if (record.run.status !== "running" && record.run.status !== "verifying" && record.run.status !== "reviewing") throw new WorkflowConflictError("Consequential actions are only approvable during an active workflow phase.");
        const actionType = requireString(args, "actionType") as ConsequentialAction;
        const toolName = requireString(args, "toolName");
        const toolInput = requireObject(args["toolInput"], "toolInput");
        const reason = requireString(args, "reason");
        if (!((actionType === "file.write" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) || (actionType === "command.execute" && toolName === "Bash"))) throw new TypeError("Action type does not match the native tool.");
        const payload = { toolName, toolInput };
        const digest = digestPayload(payload);
        const response = await requestHuman(`Authorize one exact Claude Code action? Run: ${runId}. Tool: ${toolName}. Action: ${actionType}. SHA-256: ${digest}. Reason: ${reason}\n\nExact tool input:\n${JSON.stringify(toolInput, null, 2)}`, parentRequestId);
        // Revalidate after the user prompt: the run may have been cancelled or
        // advanced while elicitation was pending. Never mint a stale approval.
        const latest = await orchestrator.getWorkflow(runId);
        const stillActionable = latest !== undefined && latest !== null &&
          latest.run.revision === record.run.revision &&
          (latest.run.status === "running" || latest.run.status === "verifying" || latest.run.status === "reviewing");
        if (!stillActionable) {
          await approvals.recordDecision({
            actionType, payload, outcome: "denied", decidedBy: "claude-code-elicitation-host",
            rationale: "Workflow changed or became non-actionable while approval was pending.", scopeId: runId,
          });
          return { approved: false, blocked: true, reason: "Workflow changed while approval was pending; reload the session and request fresh approval." };
        }
        if (response.action !== "accept" || response.content?.["decision"] !== "approve") {
          await approvals.recordDecision({
            actionType, payload, outcome: "denied", decidedBy: "claude-code-elicitation-host",
            rationale: reason, scopeId: runId,
          });
          return { approved: false, blocked: true, reason: "Human declined, cancelled, or did not explicitly approve this exact action." };
        }
        // Elicitation gives a human decision; the host does not expose a cryptographically authenticated actor identity.
        const approval = await approvals.recordDecision({
          actionType, payload, outcome: "approved", decidedBy: "claude-code-elicitation-host",
          rationale: reason, scopeId: runId,
        });
        return { approved: true, approvalId: approval.id, payloadDigest: digest, singleUse: true, actorIdentity: "host does not expose authenticated identity" };
      }
      case "factory_verification_run": {
        const runId = requireString(args, "runId");
        const expectedRevision = requireInteger(args, "expectedRevision");
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        if (record.run.revision !== expectedRevision) throw new WorkflowConflictError("Stale revision; reload before running verification.");
        if (record.run.status !== "running" && record.run.status !== "verifying") {
          throw new WorkflowConflictError("Verification is only available during an active implementation or verification phase.");
        }

        const rawProfile = process.env["FACTORY_VERIFICATION_PROFILE"];
        if (!rawProfile) throw new Error("Verification is not configured. Set FACTORY_VERIFICATION_PROFILE to an operator-reviewed JSON profile.");
        if (Buffer.byteLength(rawProfile, "utf8") > 64 * 1024) throw new TypeError("FACTORY_VERIFICATION_PROFILE exceeds the 64 KiB configuration limit.");
        let profile: { checks: VerificationCheck[]; allowedExecutables: Record<string, string> };
        try {
          const parsed: unknown = JSON.parse(rawProfile);
          const value = requireObject(parsed, "FACTORY_VERIFICATION_PROFILE");
          if (!Array.isArray(value["checks"]) || value["checks"].length === 0 || value["checks"].length > 50) throw new TypeError("checks must contain between 1 and 50 entries.");
          const allowedExecutables = requireObject(value["allowedExecutables"], "allowedExecutables") as unknown as Record<string, string>;
          if (Object.values(allowedExecutables).some((executable) => typeof executable !== "string" || !path.isAbsolute(executable))) {
            throw new TypeError("allowedExecutables must map stable IDs to absolute executable paths.");
          }
          profile = { checks: value["checks"] as VerificationCheck[], allowedExecutables };
        } catch (error) {
          throw new TypeError(`Invalid operator verification profile: ${error instanceof Error ? error.message : "invalid JSON"}`);
        }

        const persisted: Array<{ checkId: string; status: string; outcome: string; exitCode: number | null; durationMs: number; observedStdoutBytes: number; observedStderrBytes: number; outputTruncated: boolean; stdoutDigest: string; stderrDigest: string; reason?: string }> = [];
        const persistCheck = async (check: import("./verification.js").VerificationEvidenceRecord): Promise<void> => {
          const stepId = `runner-verification-${runId}-${check.checkId}-${randomUUID()}`;
          const started = await orchestrator.beginStep(runId, stepId);
          if (started.status !== "started") throw new WorkflowConflictError(`Could not persist verification step ${check.checkId}.`);
          const outcome = check.status === "passed" ? "passed"
            : check.status === "failed" || check.status === "timed_out" ? "failed"
              : check.status === "skipped" ? "skipped" : "unknown";
          const kind = check.kind === "test" || check.kind === "typecheck" ? check.kind : "command";
          const summary = `Runner observed ${check.status} for ${check.checkId}; exitCode=${check.exitCode ?? "none"}; stdoutSha256=${check.stdoutDigest}; stderrSha256=${check.stderrDigest}; outputTruncated=${check.outputTruncated}.`;
          await orchestrator.finishStep(runId, stepId, outcome === "passed" ? "succeeded" : "failed", summary, {
            id: randomUUID(), runId, source: "runner_observed", kind, outcome, summary,
            observedAt: check.finishedAt, artifactIds: [],
          });
          persisted.push({ checkId: check.checkId, status: check.status, outcome, exitCode: check.exitCode, durationMs: check.durationMs, observedStdoutBytes: check.observedStdoutBytes, observedStderrBytes: check.observedStderrBytes, outputTruncated: check.outputTruncated, stdoutDigest: check.stdoutDigest, stderrDigest: check.stderrDigest, ...(check.reason ? { reason: check.reason } : {}) });
        };
        const report = await runVerification({
          repositoryRoot: cwd,
          checks: profile.checks,
          allowedExecutables: profile.allowedExecutables,
          signal,
          onCheckComplete: persistCheck,
          authorize: async (_actionType, payload) => {
            const response = await requestHuman(
              `Authorize this exact verification process? Run: ${runId}. Check: ${payload.checkId}.\nExecutable: ${payload.executable}\nArguments: ${JSON.stringify(payload.args)}\nWorking directory: ${payload.cwd}\nEnvironment keys: ${payload.environmentKeys.join(", ")}\nTimeout: ${payload.timeoutMs} ms\nOutput limit: ${payload.maxOutputBytes} bytes`,
              parentRequestId,
            );
            const accepted = response.action === "accept" && response.content?.["decision"] === "approve";
            const approval = await approvals.recordDecision({
              actionType: "command.execute", payload, outcome: accepted ? "approved" : "denied",
              decidedBy: "claude-code-elicitation-host", rationale: `Verification check ${payload.checkId}`, scopeId: runId,
            });
            if (!accepted) return false;
            const authorization = await approvals.authorizeAndConsume("command.execute", payload, approval.id, "factory-verification-runner");
            return authorization.allowed;
          },
        });
        return { status: report.status, startedAt: report.startedAt, finishedAt: report.finishedAt, checks: persisted, evidenceSource: "runner_observed", note: "Each result was persisted before the runner advanced to another configured check. Only configured executables and arguments were run; each process required a fresh host approval. The profile is operator-controlled configuration, not repository-discovered input." };
      }
      case "factory_evidence_submit": {
        const runId = requireString(args, "runId");
        const expectedRevision = requireInteger(args, "expectedRevision");
        const summary = requireString(args, "summary");
        const kind = requireString(args, "kind") as "command" | "test" | "typecheck" | "review" | "other";
        const outcome = requireString(args, "outcome") as "passed" | "failed" | "skipped" | "unknown";
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        if (record.run.revision !== expectedRevision) throw new WorkflowConflictError("Stale revision; reload before submitting evidence.");
        if (record.run.status === "completed" || record.run.status === "failed" || record.run.status === "cancelled") throw new WorkflowConflictError("Cannot add evidence to a terminal workflow.");
        const stepId = `reported-evidence-${randomUUID()}`;
        const started = await orchestrator.beginStep(runId, stepId);
        if (started.status !== "started") throw new WorkflowConflictError("Could not create evidence step.");
        await orchestrator.finishStep(runId, stepId, outcome === "failed" ? "failed" : "succeeded", summary, {
          id: randomUUID(), runId, source: "model_reported", kind, outcome, summary, observedAt: new Date().toISOString(), artifactIds: [],
        });
        return { stored: true, trust: "model-reported-unverified", run: await orchestrator.getWorkflow(runId) };
      }
      case "factory_delivery_status": {
        const runId = requireString(args, "runId");
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        const modelReported = record.evidence.filter((item) => item.source === "model_reported");
        const runnerObserved = record.evidence.filter((item) => item.source === "runner_observed");
        const modelReportedEvidencePassed = modelReported.length > 0 && modelReported.every((item) => item.outcome === "passed");
        const runnerObservedEvidencePassed = runnerObserved.length > 0 && runnerObserved.every((item) => item.outcome === "passed");
        return {
          run: record.run,
          evidenceCount: record.evidence.length,
          modelReportedEvidenceCount: modelReported.length,
          runnerObservedEvidenceCount: runnerObserved.length,
          modelReportedEvidencePassed,
          runnerObservedEvidencePassed,
          readyForHumanDelivery: false,
          automaticDelivery: false,
          note: "Evidence provenance is persisted separately. Model-reported claims never count as runner-observed evidence; this bridge still requires a separate human delivery review.",
        };
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  };

  rl.on("line", (line) => {
    void (async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; }
      catch { send({ jsonrpc: "2.0", id: "parse-error", error: { code: -32700, message: "Parse error" } }); return; }

      // Host elicitation replies are JSON-RPC responses, not requests. Accept only
      // a valid response envelope before resolving a pending approval interaction.
      if (isJsonRpcResponse(parsed) && pending.has(parsed.id)) {
        pending.get(parsed.id)!.resolve(parsed);
        pending.delete(parsed.id);
        return;
      }

      if (!isJsonRpcRequest(parsed)) {
        // Notifications have no response channel. Invalid request objects with a
        // usable id receive Invalid Request; malformed ids use JSON-RPC's null id.
        if (isPlainObject(parsed) && Object.hasOwn(parsed, "id")) {
          const id = isValidRequestId(parsed.id) ? parsed.id : null;
          send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
        }
        return;
      }
      const message = parsed;

      // Only the two explicitly supported notifications may be processed without
      // an id. In particular, tools/call must never execute as a notification.
      if (message.id === undefined &&
          message.method !== "notifications/initialized" &&
          message.method !== "notifications/cancelled") return;
      if (message.method === "initialize") {
        const capabilities = message.params?.["capabilities"] as JsonObject | undefined;
        const requestedProtocol = message.params?.["protocolVersion"];
        if (requestedProtocol !== "2025-11-25") {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "This minimal bridge supports only MCP protocol 2025-11-25 elicitation. Upgrade the bridge before using a host that negotiates another protocol." } });
          return;
        }
        clientElicitation = Boolean(capabilities?.["elicitation"] && typeof capabilities["elicitation"] === "object" && (capabilities["elicitation"] as JsonObject)["form"]);
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "super-agents-factory-bridge", version: "0.1.0" }, instructions: "The active Claude Code session is the orchestrator. This server supports only MCP 2025-11-25 elicitation. Elicitation absence or failure blocks approvals. Configure the PreToolUse gate to prevent direct native-tool bypass." } });
        return;
      }
      if (message.method === "notifications/initialized") return;
      if (message.method === "notifications/cancelled") {
        const cancelledRequestId = message.params?.["requestId"];
        if ((typeof cancelledRequestId === "string" || typeof cancelledRequestId === "number") && requestControllers.has(cancelledRequestId)) {
          requestControllers.get(cancelledRequestId)!.abort();
        }
        for (const [elicitationId, request] of pending) {
          if (request.parentRequestId === cancelledRequestId) {
            pending.delete(elicitationId);
            request.reject(new Error("The host cancelled the parent tool call; approval was not granted."));
          }
        }
        return;
      }
      if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        return;
      }
      if (message.method === "tools/call") {
        try {
          const params = message.params ?? {};
          const name = requireString(params, "name");
          const args = params["arguments"] === undefined ? {} : requireObject(params["arguments"], "arguments");
          const controller = new AbortController();
          if (message.id !== undefined) requestControllers.set(message.id, controller);
          try {
            const result = await callTool(name, args, message.id, controller.signal);
            send({ jsonrpc: "2.0", id: message.id, result: textResult(result) });
          } finally {
            if (message.id !== undefined) requestControllers.delete(message.id);
          }
        } catch (error) {
          send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed closed." }] } });
        }
        return;
      }
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    })().catch(() => undefined);
  });
  await new Promise<void>((resolve) => rl.once("close", resolve));
}


/** Validate raw tool arguments against the same schema advertised by tools/list. */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isValidRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRpcRequest(value: unknown): value is RpcMessage {
  if (!isPlainObject(value) || value["jsonrpc"] !== "2.0" ||
      typeof value["method"] !== "string" || value["method"].length === 0) return false;
  if (Object.hasOwn(value, "id") && !isValidRequestId(value["id"])) return false;
  if (Object.hasOwn(value, "params") && !isPlainObject(value["params"])) return false;
  return true;
}

function isJsonRpcResponse(value: unknown): value is RpcMessage & { id: string | number } {
  if (!isPlainObject(value) || value["jsonrpc"] !== "2.0" ||
      !isValidRequestId(value["id"]) || Object.hasOwn(value, "method")) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  return hasResult !== hasError;
}

function validateToolArguments(name: string, args: JsonObject): void {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new TypeError(`Unknown tool: ${name}`);
  validateSchemaValue(args, tool.inputSchema as unknown as JsonObject, "arguments");
}

function validateSchemaValue(value: unknown, schema: JsonObject, at: string): void {
  const type = schema["type"];
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${at} must be an object.`);
    }
    const object = value as JsonObject;
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(object, key)) throw new TypeError(`${at}.${key} is required.`);
      }
    }
    const properties = schema["properties"];
    const propertyMap = properties && typeof properties === "object" && !Array.isArray(properties)
      ? properties as JsonObject : {};
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(propertyMap, key)) throw new TypeError(`${at} contains unexpected field ${key}.`);
      }
    }
    for (const [key, propertySchema] of Object.entries(propertyMap)) {
      if (Object.hasOwn(object, key)) {
        if (!propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) {
          throw new TypeError(`Invalid server schema for ${at}.${key}.`);
        }
        validateSchemaValue(object[key], propertySchema as JsonObject, `${at}.${key}`);
      }
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new TypeError(`${at} must be a string.`);
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) throw new TypeError(`${at} is too short.`);
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) throw new TypeError(`${at} is too long.`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new TypeError(`${at} has an unsupported value.`);
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError(`${at} must be a safe integer.`);
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) throw new TypeError(`${at} is below the minimum.`);
    return;
  }
  throw new TypeError(`Unsupported server schema type for ${at}.`);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  runFactoryMcpServer().catch((error: unknown) => {
    process.stderr.write(`Factory MCP bridge failed closed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
