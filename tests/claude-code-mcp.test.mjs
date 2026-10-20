import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "dist", "claude-code-mcp.js");
const hookEntry = path.join(root, "dist", "claude-code-pretool-hook.js");

function startClient(cwd, elicitationDecision = "accept", elicitationTimeoutMs, verificationProfile) {
  let currentDecision = elicitationDecision;
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      FACTORY_STATE_DIR: ".factory-state",
      ...(elicitationTimeoutMs === undefined ? {} : { FACTORY_ELICITATION_TIMEOUT_MS: String(elicitationTimeoutMs) }),
      ...(verificationProfile === undefined ? {} : { FACTORY_VERIFICATION_PROFILE: JSON.stringify(verificationProfile) }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiting = new Map();
  const elicitationQueue = [];
  const elicitationWaiters = [];
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
        if (currentDecision === "none") {
          const waiter = elicitationWaiters.shift();
          if (waiter) waiter(message);
          else elicitationQueue.push(message);
          continue;
        }
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
  const request = (method, params = {}) => {
    const requestId = ++id;
    let timer;
    const promise = new Promise((resolve, reject) => {
      waiting.set(String(requestId), (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
      timer = setTimeout(() => {
        waiting.delete(String(requestId));
        reject(new Error(`Timed out waiting for ${method}. stderr=${stderr}`));
      }, 3000);
      timer.unref();
    });
    promise.requestId = requestId;
    return promise;
  };
  const nextElicitation = () => elicitationQueue.length
    ? Promise.resolve(elicitationQueue.shift())
    : new Promise((resolve) => elicitationWaiters.push(resolve));
  const respondToElicitation = (elicitationId, decision = "accept") => {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: elicitationId,
      result: decision === "accept"
        ? { action: "accept", content: { decision: "approve" } }
        : { action: decision },
    }) + "\n");
  };
  const notifyCancelled = (requestId) => {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, reason: "Test cancelled the parent tool call." },
    }) + "\n");
  };
  const tool = async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const item = response.result?.content?.find((entry) => entry.type === "text");
    assert.ok(item, JSON.stringify(response));
    return JSON.parse(item.text);
  };
  return { child, request, tool, nextElicitation, respondToElicitation, notifyCancelled, setElicitationDecision: (decision) => { currentDecision = decision; }, getStderr: () => stderr };
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


test("MCP bridge persists cancellation when the host cancels a pending plan approval request", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-parent-cancel-plan-"));
  const client = startClient(cwd, "none", 1000);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "cancelling-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "parent-cancel-plan" });
  const pendingPlan = client.request("tools/call", {
    name: "factory_plan_request_approval",
    arguments: { runId: created.run.id, expectedRevision: 0, plan: "Cancel while waiting for a human decision." },
  });
  const elicitation = await client.nextElicitation();
  client.notifyCancelled(pendingPlan.requestId);

  const response = await pendingPlan;
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.run.status, "cancelled");

  client.respondToElicitation(elicitation.id, "accept");
  const persisted = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(persisted.run.status, "cancelled");
});

test("MCP bridge never grants action approval after parent request cancellation and ignores late elicitation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-parent-cancel-action-"));
  const client = startClient(cwd, "accept", 1000);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "cancelling-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "parent-cancel-action" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve plan before testing cancellation of an action request.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/parent-cancel.txt", content: "must remain unapproved" };
  client.setElicitationDecision("none");
  const pendingAction = client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput,
      reason: "Cancel this action approval request before the human responds.",
    },
  });
  const elicitation = await client.nextElicitation();
  client.notifyCancelled(pendingAction.requestId);

  const response = await pendingAction;
  assert.equal(response.result?.isError, true);
  assert.match(response.result.content?.[0]?.text ?? "", /cancelled/i);

  client.respondToElicitation(elicitation.id, "accept");
  const hookResult = await runHook(cwd, "Write", toolInput);
  assert.equal(hookResult.hookSpecificOutput.permissionDecision, "deny");
});


test("MCP bridge fails closed when an accepted action cannot be persisted to the approval ledger", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-approval-store-failure-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "store-failure-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "approval-store-failure" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve the plan before testing approval persistence failure.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/store-failure.txt", content: "must remain unapproved" };
  const stateDirectory = path.join(cwd, ".factory-state");
  await mkdir(stateDirectory, { recursive: true });
  // Corrupt the approval ledger after plan approval but before the accepted action is persisted.
  await writeFile(path.join(stateDirectory, "approvals.json"), "{invalid-json", "utf8");

  const response = await client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput,
      reason: "Ensure persistence failure cannot turn acceptance into authorization.",
    },
  });
  assert.equal(response.result?.isError, true);
  assert.doesNotMatch(response.result?.content?.[0]?.text ?? "", /"approved"\s*:\s*true/);

  const hookResult = await runHook(cwd, "Write", toolInput);
  assert.equal(hookResult.hookSpecificOutput.permissionDecision, "deny");
  assert.match(hookResult.hookSpecificOutput.permissionDecisionReason, /approval|state|persist|ledger|JSON/i);
});


test("PreToolUse hook denies a matching approval when persisted workflow state is corrupt or missing", async (t) => {
  for (const failureMode of ["corrupt", "missing"]) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), `factory-hook-workflow-${failureMode}-`));
    const client = startClient(cwd);
    t.after(async () => {
      client.child.kill("SIGTERM");
      await rm(cwd, { recursive: true, force: true });
    });

    await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "workflow-state-failure-host", version: "1.0.0" },
    });
    const created = await client.tool("factory_session_create", { requestId: `workflow-state-${failureMode}` });
    const plan = await client.tool("factory_plan_request_approval", {
      runId: created.run.id,
      expectedRevision: 0,
      plan: "Approve a fixture action before corrupting workflow state.",
    });
    assert.equal(plan.approved, true);

    const toolInput = { file_path: `/tmp/workflow-state-${failureMode}.txt`, content: "must remain blocked" };
    const approval = await client.tool("factory_action_request_approval", {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput,
      reason: "Ensure workflow state is validated independently of the matching approval.",
    });
    assert.equal(approval.approved, true);

    const stateDirectory = path.join(cwd, ".factory-state");
    const workflowPath = path.join(stateDirectory, "workflows.json");
    if (failureMode === "corrupt") {
      await writeFile(workflowPath, "{invalid-json", "utf8");
    } else {
      await rm(workflowPath);
    }

    const hookResult = await runHook(cwd, "Write", toolInput);
    assert.equal(
      hookResult.hookSpecificOutput?.permissionDecision,
      "deny",
      `${failureMode} workflow state must deny a matching approval: ${JSON.stringify(hookResult)}`,
    );
  }
});


test("MCP verification runs operator-configured checks and persists runner-observed evidence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-runner-"));
  const profile = {
    allowedExecutables: { node: process.execPath },
    checks: [{
      id: "fixture-check",
      kind: "test",
      executable: "node",
      args: ["-e", "process.stdout.write('verified'); process.stderr.write('diagnostic')"],
      cwd: ".",
      timeoutMs: 2000,
      maxOutputBytes: 1024,
    }],
  };
  const client = startClient(cwd, "accept", undefined, profile);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "runner-test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "runner-evidence" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Run the configured verification fixture.",
  });
  assert.equal(plan.approved, true);

  const report = await client.tool("factory_verification_run", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
  });
  assert.equal(report.status, "passed");
  assert.equal(report.evidenceSource, "runner_observed");
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].status, "passed");
  assert.equal(report.checks[0].exitCode, 0);
  assert.equal(report.checks[0].stdout, undefined, "raw process output is not returned to the model");
  assert.equal(typeof report.checks[0].stdoutDigest, "string");

  const session = await client.tool("factory_session_get", { runId: created.run.id });
  const evidence = session.evidence.filter((item) => item.source === "runner_observed");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, "passed");
  assert.match(evidence[0].summary, /Runner observed passed/);

  const delivery = await client.tool("factory_delivery_status", { runId: created.run.id });
  assert.equal(delivery.runnerObservedEvidenceCount, 1);
  assert.equal(delivery.runnerObservedEvidencePassed, true);
  assert.equal(delivery.readyForHumanDelivery, false);
});

test("MCP verification does not spawn a check when human authorization is declined", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-runner-deny-"));
  const marker = path.join(cwd, "must-not-exist.txt");
  const profile = {
    allowedExecutables: { node: process.execPath },
    checks: [{
      id: "denied-check",
      kind: "command",
      executable: "node",
      args: ["-e", "require('node:fs').writeFileSync('must-not-exist.txt', 'ran')"],
      cwd: ".",
      timeoutMs: 2000,
      maxOutputBytes: 1024,
    }],
  };
  const client = startClient(cwd, "accept", undefined, profile);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "runner-deny-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "runner-denied" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Exercise verification authorization denial.",
  });
  assert.equal(plan.approved, true);
  client.setElicitationDecision("decline");

  const report = await client.tool("factory_verification_run", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
  });
  assert.equal(report.status, "incomplete");
  assert.equal(report.checks[0].status, "blocked");
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(marker)), { code: "ENOENT" });

  const session = await client.tool("factory_session_get", { runId: created.run.id });
  const evidence = session.evidence.filter((item) => item.source === "runner_observed");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, "unknown");
  const delivery = await client.tool("factory_delivery_status", { runId: created.run.id });
  assert.equal(delivery.runnerObservedEvidencePassed, false);
  assert.equal(delivery.readyForHumanDelivery, false);
});


test("MCP verification rejects a missing operator profile before starting a process", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-runner-unconfigured-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "runner-config-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "runner-unconfigured" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Check missing runner configuration.",
  });
  assert.equal(plan.approved, true);
  const response = await client.request("tools/call", {
    name: "factory_verification_run",
    arguments: { runId: created.run.id, expectedRevision: plan.run.revision },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /FACTORY_VERIFICATION_PROFILE/);
  const session = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(session.evidence.some((item) => item.source === "runner_observed"), false);
});

test("MCP verification persists a non-zero process result as failed runner evidence", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-runner-fail-"));
  const profile = {
    allowedExecutables: { node: process.execPath },
    checks: [{
      id: "failing-check",
      kind: "test",
      executable: "node",
      args: ["-e", "throw new Error('expected fixture failure')"],
      cwd: ".",
      timeoutMs: 2000,
      maxOutputBytes: 1024,
    }],
  };
  const client = startClient(cwd, "accept", undefined, profile);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "runner-fail-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "runner-failure" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Check that failing runner processes cannot appear successful.",
  });
  assert.equal(plan.approved, true);
  const report = await client.tool("factory_verification_run", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.checks[0].status, "failed");
  assert.notEqual(report.checks[0].exitCode, 0);
  const session = await client.tool("factory_session_get", { runId: created.run.id });
  const evidence = session.evidence.filter((item) => item.source === "runner_observed");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, "failed");
  const delivery = await client.tool("factory_delivery_status", { runId: created.run.id });
  assert.equal(delivery.runnerObservedEvidencePassed, false);
  assert.equal(delivery.readyForHumanDelivery, false);
});


test("cancelling a pending verification approval prevents the process from starting", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-runner-cancel-"));
  const profile = {
    allowedExecutables: { node: process.execPath },
    checks: [{
      id: "cancelled-check",
      kind: "command",
      executable: "node",
      args: ["-e", "require('node:fs').writeFileSync('cancelled-check-ran.txt', 'ran')"],
      cwd: ".",
      timeoutMs: 2000,
      maxOutputBytes: 1024,
    }],
  };
  const client = startClient(cwd, "accept", undefined, profile);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "runner-cancel-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "runner-cancel" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Verify host cancellation blocks a pending verification process.",
  });
  assert.equal(plan.approved, true);

  client.setElicitationDecision("none");
  const pending = client.request("tools/call", {
    name: "factory_verification_run",
    params: {},
    arguments: { runId: created.run.id, expectedRevision: plan.run.revision },
  });
  const elicitation = await client.nextElicitation();
  client.notifyCancelled(pending.requestId);
  const response = await pending;
  assert.equal(response.error, undefined);
  const item = response.result?.content?.find((entry) => entry.type === "text");
  const report = JSON.parse(item.text);
  assert.equal(report.status, "incomplete");
  assert.equal(report.checks[0].status, "blocked");
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(path.join(cwd, "cancelled-check-ran.txt"))), { code: "ENOENT" });
});


test("MCP bridge does not persist action approval when the workflow is cancelled during elicitation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-stale-action-approval-"));
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
  const created = await client.tool("factory_session_create", { requestId: "stale-action-approval" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve a plan before testing a stale action prompt.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/stale-approved.txt", content: "must remain blocked" };
  client.setElicitationDecision("none");
  const pendingAction = client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput,
      reason: "The workflow may be cancelled while this prompt is open.",
    },
  });
  const prompt = await client.nextElicitation();

  const cancelled = await client.tool("factory_phase_transition", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
    to: "cancelled",
  });
  assert.equal(cancelled.status, "cancelled");
  client.respondToElicitation(prompt.id, "accept");

  const action = await pendingAction;
  assert.equal(action.error, undefined, JSON.stringify(action.error));
  const result = JSON.parse(action.result.content.find((entry) => entry.type === "text").text);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /Workflow changed while approval was pending/);

  const ledger = JSON.parse(await readFile(path.join(cwd, ".factory-state", "approvals.json"), "utf8"));
  assert.equal(
    ledger.approvals.some((approval) => approval.outcome === "approved" && approval.status === "active"),
    false,
    "a stale prompt must not leave an active approved ledger record",
  );
  const denied = await runHook(cwd, "Write", toolInput);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
});


test("MCP bridge rejects an approval prompt when the workflow revision changes but remains active", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-stale-active-action-approval-"));
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
  const created = await client.tool("factory_session_create", { requestId: "stale-active-action-approval" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve a plan before testing a stale active-run prompt.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/stale-active-approved.txt", content: "must remain blocked" };
  client.setElicitationDecision("none");
  const pendingAction = client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput,
      reason: "The workflow revision may advance while this prompt is open.",
    },
  });
  const prompt = await client.nextElicitation();

  const advanced = await client.tool("factory_phase_transition", {
    runId: created.run.id,
    expectedRevision: plan.run.revision,
    to: "verifying",
  });
  assert.equal(advanced.status, "verifying");
  client.respondToElicitation(prompt.id, "accept");

  const action = await pendingAction;
  assert.equal(action.error, undefined, JSON.stringify(action.error));
  const result = JSON.parse(action.result.content.find((entry) => entry.type === "text").text);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /Workflow changed while approval was pending/);

  const ledger = JSON.parse(await readFile(path.join(cwd, ".factory-state", "approvals.json"), "utf8"));
  assert.equal(
    ledger.approvals.some((approval) => approval.outcome === "approved" && approval.status === "active"),
    false,
    "a stale revision must not leave an active approved ledger record",
  );
  const denied = await runHook(cwd, "Write", toolInput);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
});
