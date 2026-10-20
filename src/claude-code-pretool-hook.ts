/**
 * Claude Code PreToolUse gate for native write/command tools.
 *
 * Configure this as a PreToolUse hook in the consuming repository. Without
 * this hook, the MCP server's approvals do not technically gate native tools.
 */
import path from "node:path";
import { ApprovalPolicy, JsonFileApprovalStore, digestPayload } from "./approval.js";

interface HookInput {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOL = "Bash";

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
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
    const authorization = await policy.authorizeAndConsume(actionType, payload, candidate.id, "claude-code-pretool-hook");
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
