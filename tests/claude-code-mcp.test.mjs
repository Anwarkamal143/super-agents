import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "dist", "claude-code-mcp.js");
const hookEntry = path.join(root, "dist", "claude-code-pretool-hook.js");

function startClient(cwd, elicitationDecision = "accept", elicitationTimeoutMs) {
  let currentDecision = elicitationDecision;
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      FACTORY_STATE_DIR: ".factory-state",
      ...(elicitationTimeoutMs === undefined ? {} : { FACTORY_ELICITATION_TIMEOUT_MS: String(elicitationTimeoutMs) }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiting = new Map();
  let id = 0;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "elicitation/create") {
        if (currentDecision === "none") continue;
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: currentDecision === "accept"
            ? { action: "accept", content: { decision: "approve" } }
            : currentDecision === "malformed"
              ? { action: "accept", content: {} }
              : currentDecision === "cancel"
                ? { action: "cancel" }
                : { action: "decline" },
        }) + "\n");
      } else if (message.id !== undefined && waiting.has(String(message.id))) {
        waiting.get(String(message.id))(message);
        waiting.delete(String(message.id));
      }
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    waiting.set(String(requestId), resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    const timer = setTimeout(() => {
      waiting.delete(String(requestId));
      reject(new Error(`Timed out waiting for ${method}. stderr=${stderr}`));
    }, 3000);
    timer.unref();
  });
  const tool = async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const item = response.result?.content?.find((entry) => entry.type === "text");
    assert.ok(item, JSON.stringify(response));
    return JSON.parse(item.text);
  };
  return { child, request, tool, setElicitationDecision: (decision) => { currentDecision = decision; }, getStderr: () => stderr };
}

function runHook(cwd, toolName, toolInput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookEntry], {
      cwd,
      env: { ...process.env, FACTORY_STATE_DIR: ".factory-state" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`Hook exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
    child.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: toolInput }));
  });
}

test("MCP bridge requires elicitation and one-time exact native-tool approval", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "super-agents-factory-bridge");

  const created = await client.tool("factory_session_create", { requestId: "test-request" });
  assert.equal(created.run.status, "created");

  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Write one test file and run the deterministic test suite.",
  });
  assert.equal(plan.approved, true);
  assert.equal(plan.run.status, "running");

  const toolInput = { file_path: "/tmp/factory-test.txt", content: "approved content" };
  const approval = await client.tool("factory_action_request_approval", {
    runId: created.run.id,
    actionType: "file.write",
    toolName: "Write",
    toolInput,
    reason: "Create the exact approved test fixture.",
  });
  assert.equal(approval.approved, true);
  assert.equal(typeof approval.approvalId, "string");

  const allowed = await runHook(cwd, "Write", toolInput);
  assert.deepEqual(allowed, {});

  const replay = await runHook(cwd, "Write", toolInput);
  assert.equal(replay.hookSpecificOutput.permissionDecision, "deny");

  const modified = await runHook(cwd, "Write", { ...toolInput, content: "changed after approval" });
  assert.equal(modified.hookSpecificOutput.permissionDecision, "deny");

  const staleInput = { file_path: "/tmp/stale-factory-test.txt", content: "must not run after cancellation" };
  const staleApproval = await client.tool("factory_action_request_approval", {
    runId: created.run.id,
    actionType: "file.write",
    toolName: "Write",
    toolInput: staleInput,
    reason: "Verify cancellation revokes an unused approval.",
  });
  assert.equal(staleApproval.approved, true);
  const cancelled = await client.tool("factory_phase_transition", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
    to: "cancelled",
  });
  assert.equal(cancelled.status, "cancelled");
  const afterCancel = await runHook(cwd, "Write", staleInput);
  assert.equal(afterCancel.hookSpecificOutput.permissionDecision, "deny");
});

test("MCP bridge fails closed when the human declines plan approval", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-decline-"));
  const client = startClient(cwd, "decline");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "declined-request" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "This plan must not be implemented.",
  });
  assert.equal(plan.approved, false);
  assert.equal(plan.blocked, true);
  assert.equal(plan.run.status, "cancelled");
});


test("MCP bridge rejects unsupported protocol negotiation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-protocol-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  const response = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /supports only MCP protocol 2025-11-25/);
});

test("MCP bridge fails closed when elicitation is unavailable or malformed", async (t) => {
  const unavailableCwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-no-elicitation-"));
  const unavailable = startClient(unavailableCwd);
  t.after(async () => {
    unavailable.child.kill("SIGTERM");
    await rm(unavailableCwd, { recursive: true, force: true });
  });
  const initialized = await unavailable.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "super-agents-factory-bridge");
  const created = await unavailable.tool("factory_session_create", { requestId: "no-elicitation" });
  const blocked = await unavailable.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Must not proceed without elicitation.",
  });
  assert.equal(blocked.approved, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.run.status, "cancelled");

  const malformedCwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-malformed-"));
  const malformed = startClient(malformedCwd, "malformed");
  t.after(async () => {
    malformed.child.kill("SIGTERM");
    await rm(malformedCwd, { recursive: true, force: true });
  });
  await malformed.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const malformedRun = await malformed.tool("factory_session_create", { requestId: "malformed-elicitation" });
  const malformedApproval = await malformed.tool("factory_plan_request_approval", {
    runId: malformedRun.run.id,
    expectedRevision: 0,
    plan: "Malformed approval must not proceed.",
  });
  assert.equal(malformedApproval.approved, false);
  assert.equal(malformedApproval.blocked, true);
  assert.equal(malformedApproval.run.status, "cancelled");
});

test("MCP bridge recovers persisted workflow state after server restart", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-recovery-"));
  let client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "recover-me" });
  const approved = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Persist and recover this approved workflow.",
  });
  assert.equal(approved.approved, true);
  const closed = new Promise((resolve) => client.child.once("close", resolve));
  client.child.kill("SIGTERM");
  await closed;

  client = startClient(cwd);
  const recovered = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  assert.equal(recovered.result.serverInfo.name, "super-agents-factory-bridge");
  const session = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(session.run.status, "running");
  assert.equal(session.run.revision, approved.run.revision);
  assert.ok(session.events.length >= 4);
});


test("MCP bridge treats explicit elicitation cancellation as a terminal block", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-cancel-"));
  const client = startClient(cwd, "cancel");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "cancel-plan" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Cancellation must prevent implementation.",
  });
  assert.equal(plan.approved, false);
  assert.equal(plan.blocked, true);
  assert.equal(plan.run.status, "cancelled");
  const action = await client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput: { file_path: "/tmp/never-write.txt", content: "blocked" },
      reason: "This must not reach an approval prompt after cancellation.",
    },
  });
  assert.equal(action.result.isError, true);
  assert.match(action.result.content[0].text, /active workflow phase/);
});

test("MCP bridge rejects stale phase revisions without mutating the workflow", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-stale-revision-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "stale-phase" });
  const approved = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve this plan to advance the revision.",
  });
  assert.equal(approved.approved, true);
  const stale = await client.request("tools/call", {
    name: "factory_phase_transition",
    arguments: { runId: created.run.id, expectedRevision: 0, to: "verifying" },
  });
  assert.ok(stale.error || stale.result?.isError === true, JSON.stringify(stale));
  const current = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(current.run.revision, approved.run.revision);
  assert.equal(current.run.status, "running");
});


test("MCP bridge persists model-reported evidence provenance and never counts it as runner evidence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-evidence-source-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "evidence-source" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Persist evidence provenance distinctly.",
  });
  assert.equal(plan.approved, true);
  const submitted = await client.tool("factory_evidence_submit", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
    summary: "Model claims that tests passed.",
    kind: "test",
    outcome: "passed",
  });
  assert.equal(submitted.stored, true);
  const persisted = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(persisted.evidence.at(-1).source, "model_reported");
  assert.equal(persisted.evidence.at(-1).outcome, "passed");

  const status = await client.tool("factory_delivery_status", { runId: created.run.id });
  assert.equal(status.modelReportedEvidenceCount, 1);
  assert.equal(status.runnerObservedEvidenceCount, 0);
  assert.equal(status.modelReportedEvidencePassed, true);
  assert.equal(status.runnerObservedEvidencePassed, false);
  assert.equal(status.readyForHumanDelivery, false);
});


test("PreToolUse hook fails closed for malformed input and corrupt approval persistence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-hook-fail-closed-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
  const state = path.join(cwd, ".factory-state");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(state, { recursive: true }));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(state, "approvals.json"), '{"approvals":"not-an-array","events":[]}'));
  const corrupt = await runHook(cwd, "Write", { file_path: "/tmp/blocked.txt", content: "blocked" });
  assert.equal(corrupt.hookSpecificOutput.permissionDecision, "deny");
  assert.match(corrupt.hookSpecificOutput.permissionDecisionReason, /failed closed|denied/i);

  const child = spawn(process.execPath, [hookEntry], {
    cwd,
    env: { ...process.env, FACTORY_STATE_DIR: ".factory-state" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end("{not-json");
  const code = await exit;
  assert.equal(code, 0);
  const malformed = JSON.parse(stdout);
  assert.equal(malformed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(malformed.hookSpecificOutput.permissionDecisionReason, /Malformed/);
});

test("PreToolUse hook denies when no approval state exists", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-hook-no-state-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
  const result = await runHook(cwd, "Bash", { command: "echo not-approved" });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /No active one-time human approval/);
});


test("PreToolUse hook allows at most one concurrent consumer of a one-time approval", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-hook-concurrent-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "concurrent-hook-consume" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve one exact fixture action and verify concurrent replay is denied.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/concurrent-approved.txt", content: "only one consumer" };
  const approval = await client.tool("factory_action_request_approval", {
    runId: created.run.id,
    actionType: "file.write",
    toolName: "Write",
    toolInput,
    reason: "Exercise the one-time approval under concurrent hook invocation.",
  });
  assert.equal(approval.approved, true);

  const results = await Promise.all([
    runHook(cwd, "Write", toolInput),
    runHook(cwd, "Write", toolInput),
  ]);
  const allowed = results.filter((result) => Object.keys(result).length === 0);
  const denied = results.filter((result) => result.hookSpecificOutput?.permissionDecision === "deny");
  assert.equal(allowed.length, 1, JSON.stringify(results));
  assert.equal(denied.length, 1, JSON.stringify(results));
});


test("MCP bridge times out plan elicitation into a persisted cancelled run", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-plan-timeout-"));
  const client = startClient(cwd, "none", 25);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "silent-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "plan-timeout" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "This plan must not proceed when the host never answers.",
  });

  assert.equal(plan.approved, false);
  assert.equal(plan.blocked, true);
  assert.equal(plan.run.status, "cancelled");
  assert.match(plan.reason, /timed out/i);
  const persisted = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(persisted.run.status, "cancelled");
});

test("MCP bridge does not create a native action approval when elicitation times out", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-action-timeout-"));
  const client = startClient(cwd, "accept", 25);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "silent-after-plan-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "action-timeout" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve the plan, then simulate a host that never answers action approval.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/action-timeout.txt", content: "must remain unapproved" };
  client.setElicitationDecision("none");
  const response = await client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput,
      reason: "Verify a missing human response fails closed.",
    },
  });
  assert.equal(response.result?.isError, true);
  assert.match(response.result.content?.[0]?.text ?? "", /timed out/i);

  const hookResult = await runHook(cwd, "Write", toolInput);
  assert.equal(hookResult.hookSpecificOutput.permissionDecision, "deny");
});
