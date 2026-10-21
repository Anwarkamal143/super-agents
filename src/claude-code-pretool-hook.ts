/**
 * Claude Code PreToolUse gate for native write/command tools.
 *
 * Configure this as a PreToolUse hook in the consuming repository. Without
 * this hook, the MCP server's approvals do not technically gate native tools.
 */
import path from "node:path";
import { ApprovalPolicy, JsonFileApprovalStore, digestPayload } from "./approval.js";
import { JsonFileWorkflowStore, WorkflowOrchestrator } from "./orchestrator.js";

interface HookInput {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOL = "Bash";
const MAX_HOOK_INPUT_BYTES = 1_048_576;

/**
 * Read at most MAX_HOOK_INPUT_BYTES of stdin before JSON parsing.
 * A single stream chunk may already have been allocated by Node, but this
 * reader never accumulates an unbounded sequence of chunks.
 */
async function readBoundedInput(input: NodeJS.ReadableStream): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of input) {
    const byteLength = Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(String(chunk));
    if (byteLength > MAX_HOOK_INPUT_BYTES - totalBytes) return undefined;

    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    totalBytes += byteLength;
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readBoundedInput(process.stdin);
  if (raw === undefined) {
    deny(`PreToolUse input exceeded the ${MAX_HOOK_INPUT_BYTES}-byte limit; governed action denied.`);
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    deny("Malformed PreToolUse input; governed action denied.");
    return;
  }
  const toolName = input.tool_name;
  if (typeof toolName !== "string") {
    deny("Missing tool name; governed action denied.");
    return;
  }
  if (!FILE_TOOLS.has(toolName) && toolName !== COMMAND_TOOL) {
    process.stdout.write(JSON.stringify({}));
    return;
  }
  if (!input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input)) {
    deny("Malformed native tool input; governed action denied.");
    return;
  }

  const actionType = FILE_TOOLS.has(toolName) ? "file.write" : "command.execute";
  const payload = { toolName, toolInput: input.tool_input };
  const stateDirectory = path.resolve(process.cwd(), process.env["FACTORY_STATE_DIR"] ?? ".factory-state");
  const policy = new ApprovalPolicy(new JsonFileApprovalStore(path.join(stateDirectory, "approvals.json")));
  try {
    const digest = digestPayload(payload);
    const candidate = (await policy.listApprovals()).find((approval) =>
      approval.status === "active" &&
      approval.outcome === "approved" &&
      approval.actionType === actionType &&
      approval.payloadDigest === digest
    );
    if (!candidate) {
      deny(`No active one-time human approval matches this exact ${toolName} input (SHA-256 ${digest}). Request approval through the factory MCP bridge.`);
      return;
    }
    const runId = candidate.scopeId;
    if (!runId) {
      await policy.revoke(candidate.id, "claude-code-pretool-hook");
      deny("Approval is not bound to a workflow run; action denied.");
      return;
    }
    const orchestrator = new WorkflowOrchestrator(new JsonFileWorkflowStore(path.join(stateDirectory, "workflows.json")));
    const guarded = await orchestrator.withActiveWorkflowRevision(
      runId,
      candidate.workflowRevision ?? -1,
      () => policy.authorizeAndConsume(actionType, payload, candidate.id, "claude-code-pretool-hook"),
    );
    if (!guarded.current) {
      await policy.revoke(candidate.id, "claude-code-pretool-hook");
      deny("The workflow run is missing, inactive, or at a different revision; stale approval revoked and action denied.");
      return;
    }
    const authorization = guarded.value;
    if (!authorization.allowed) {
      deny(`Approval could not be consumed safely (${authorization.reason}); action denied.`);
      return;
    }
    process.stdout.write(JSON.stringify({}));
  } catch (error) {
    deny(`Approval store or validation failed; action denied: ${error instanceof Error ? error.message : "unknown failure"}`);
  }
}

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

void main().catch((error: unknown) => {
  deny(`PreToolUse gate failed closed: ${error instanceof Error ? error.message : "unknown failure"}`);
});
