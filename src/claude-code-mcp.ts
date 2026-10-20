/**
 * Minimal MCP stdio bridge for the active Claude Code session.
 *
 * Deliberately uses only Node.js built-ins and existing factory stores. This
 * avoids adding an unpinned MCP SDK to the current dependency-free runtime;
 * protocol behavior is limited to initialize, tools/list, tools/call, and
 * client-initiated elicitation/create responses.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { WorkflowRun, WorkflowStatus } from "./domain.js";
import { ApprovalPolicy, JsonFileApprovalStore, digestPayload, type ConsequentialAction } from "./approval.js";
import { JsonFileWorkflowStore, WorkflowOrchestrator, WorkflowConflictError } from "./orchestrator.js";
import { WORKFLOW_TRANSITIONS } from "./workflow.js";

type JsonObject = Record<string, unknown>;
type RpcMessage = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: JsonObject; result?: unknown; error?: { code: number; message: string } };
type ElicitationAction = "accept" | "decline" | "cancel";

const TOOLS = [
  { name: "factory_session_create", description: "Create a persisted factory workflow session.", inputSchema: { type: "object", properties: { requestId: { type: "string", minLength: 1 } }, required: ["requestId"], additionalProperties: false } },
  { name: "factory_session_get", description: "Read a workflow session, its revision, audit events, steps and evidence.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 } }, required: ["runId"], additionalProperties: false } },
  { name: "factory_plan_request_approval", description: "Ask the human to approve the exact plan in the active host session. Decline, cancel or unsupported elicitation blocks implementation.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, plan: { type: "string", minLength: 1, maxLength: 12000 } }, required: ["runId", "expectedRevision", "plan"], additionalProperties: false } },
  { name: "factory_phase_transition", description: "Advance a workflow only with the expected persisted revision and a legal transition.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, to: { type: "string", enum: ["ready", "running", "awaiting_approval", "verifying", "reviewing", "completed", "failed", "cancelled"] } }, required: ["runId", "expectedRevision", "to"], additionalProperties: false } },
  { name: "factory_action_request_approval", description: "Request fresh human approval for one exact native Claude Code tool input. Payload must be {toolName, toolInput}; it is bound to a SHA-256 digest and consumed once by the PreToolUse gate.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, actionType: { type: "string", enum: ["file.write", "command.execute"] }, toolName: { type: "string", enum: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] }, toolInput: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["runId", "actionType", "toolName", "toolInput", "reason"], additionalProperties: false } },
  { name: "factory_evidence_submit", description: "Persist bounded evidence from the active model session. Model-reported evidence is not trusted runner evidence.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, summary: { type: "string", minLength: 1, maxLength: 4000 }, kind: { type: "string", enum: ["command", "test", "typecheck", "review", "other"] }, outcome: { type: "string", enum: ["passed", "failed", "skipped", "unknown"] } }, required: ["runId", "expectedRevision", "summary", "kind", "outcome"], additionalProperties: false } },
  { name: "factory_delivery_status", description: "Report delivery readiness; never creates PRs, merges, deploys or publishes.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1 } }, required: ["runId"], additionalProperties: false } },
] as const;

export interface FactoryMcpServerOptions {
  readonly stateDirectory?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export async function runFactoryMcpServer(options: FactoryMcpServerOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const stateDirectory = path.resolve(cwd, options.stateDirectory ?? process.env.FACTORY_STATE_DIR ?? ".factory-state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(path.join(stateDirectory, "workflows.json")));
  const approvals = new ApprovalPolicy(new JsonFileApprovalStore(path.join(stateDirectory, "approvals.json")));
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });
  let nextId = 0;
  let clientElicitation = false;
  const pending = new Map<string | number, (message: RpcMessage) => void>();

  const send = (message: RpcMessage) => { output.write(JSON.stringify(message) + "\n"); };
  const rpcRequest = (method: string, params: JsonObject): Promise<RpcMessage> => new Promise((resolve, reject) => {
    if (!clientElicitation) { reject(new Error("Host does not advertise MCP elicitation; approval is unavailable.")); return; }
    const id = `factory-bridge-${++nextId}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Human elicitation timed out; action blocked.")); }, 120_000);
    timer.unref();
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
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
  const requestHuman = async (message: string): Promise<{ action: ElicitationAction; content?: JsonObject }> => {
    const response = await rpcRequest("elicitation/create", {
      mode: "form",
      message,
      requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["approve", "decline"] } }, required: ["decision"], additionalProperties: false },
    });
    const result = response.result as JsonObject | undefined;
    const action = result?.["action"];
    if (action !== "accept" && action !== "decline" && action !== "cancel") throw new Error("Malformed elicitation response; action blocked.");
    const content = result?.["content"] && typeof result.content === "object" ? result.content as JsonObject : undefined;
    return { action, ...(content ? { content } : {}) };
  };

  const callTool = async (name: string, args: JsonObject): Promise<unknown> => {
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
        try { response = await requestHuman(`Approve this factory plan? Run: ${runId}. Plan SHA-256: ${digest}.\n\n${plan}`); }
        catch (error) {
          await orchestrator.transition(runId, "cancelled", run.revision);
          return { approved: false, blocked: true, reason: error instanceof Error ? error.message : "Elicitation failed." };
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
        if (!(to in WORKFLOW_TRANSITIONS)) throw new TypeError("Unknown workflow phase.");
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
        const response = await requestHuman(`Authorize one exact Claude Code action? Run: ${runId}. Tool: ${toolName}. Action: ${actionType}. SHA-256: ${digest}. Reason: ${reason}\n\nExact tool input:\n${JSON.stringify(toolInput, null, 2)}`);
        if (response.action !== "accept" || response.content?.["decision"] !== "approve") {
          return { approved: false, blocked: true, reason: "Human declined, cancelled, or did not explicitly approve this exact action." };
        }
        // Elicitation gives a human decision; the host does not expose a cryptographically authenticated actor identity.
        const approval = await approvals.recordDecision({ actionType, payload, outcome: "approved", decidedBy: "claude-code-elicitation-host", rationale: reason });
        return { approved: true, approvalId: approval.id, payloadDigest: digest, singleUse: true, actorIdentity: "host does not expose authenticated identity" };
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
          id: randomUUID(), runId, kind, outcome, summary, observedAt: new Date().toISOString(), artifactIds: [],
        });
        return { stored: true, trust: "model-reported-unverified", run: await orchestrator.getWorkflow(runId) };
      }
      case "factory_delivery_status": {
        const runId = requireString(args, "runId");
        const record = await orchestrator.getWorkflow(runId);
        if (!record) throw new Error("Workflow session not found.");
        const allEvidencePassed = record.evidence.length > 0 && record.evidence.every((item) => item.outcome === "passed");
        return { run: record.run, evidenceCount: record.evidence.length, allEvidencePassed, readyForHumanDelivery: record.run.status === "completed" && allEvidencePassed, automaticDelivery: false, note: "Evidence submitted by the active model is not trusted runner evidence." };
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  };

  rl.on("line", (line) => {
    void (async () => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { send({ jsonrpc: "2.0", id: "parse-error", error: { code: -32700, message: "Parse error" } }); return; }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
        return;
      }
      if (!message.method) return;
      if (message.method === "initialize") {
        const capabilities = message.params?.["capabilities"] as JsonObject | undefined;
        const requestedProtocol = message.params?.["protocolVersion"];
        if (requestedProtocol !== "2025-11-25") {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "This minimal bridge supports only MCP protocol 2025-11-25 elicitation. Upgrade the bridge before using a host that negotiates another protocol." } });
          return;
        }
        clientElicitation = Boolean(capabilities?.["elicitation"] && typeof capabilities.elicitation === "object" && (capabilities["elicitation"] as JsonObject)["form"]);
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "super-agents-factory-bridge", version: "0.1.0" }, instructions: "The active Claude Code session is the orchestrator. This server supports only MCP 2025-11-25 elicitation. Elicitation absence or failure blocks approvals. Configure the PreToolUse gate to prevent direct native-tool bypass." } });
        return;
      }
      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
      if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        return;
      }
      if (message.method === "tools/call") {
        try {
          const params = message.params ?? {};
          const name = requireString(params, "name");
          const args = params["arguments"] === undefined ? {} : requireObject(params["arguments"], "arguments");
          const result = await callTool(name, args);
          send({ jsonrpc: "2.0", id: message.id, result: textResult(result) });
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

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
}

if (isDirectExecution()) {
  runFactoryMcpServer().catch((error: unknown) => {
    process.stderr.write(`Factory MCP bridge failed closed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
