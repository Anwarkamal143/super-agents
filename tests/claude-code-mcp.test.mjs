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

function startClient(cwd, elicitationDecision = "accept") {
  const child = spawn(process.execPath, [serverEntry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: elicitationDecision === "accept"
            ? { action: "accept", content: { decision: "approve" } }
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
  return { child, request, tool, getStderr: () => stderr };
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
