import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { runFactoryMcpServer } from "../dist/claude-code-mcp.js";

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
  const protocolErrors = [];
  const responseCounts = new Map();
  const receivedResponses = new Map();
  const responseWaiters = new Map();
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
      } else if (message.id === null && message.error) {
        protocolErrors.push(message);
      } else if (message.id !== undefined) {
        const key = String(message.id);
        responseCounts.set(key, (responseCounts.get(key) ?? 0) + 1);
        if (waiting.has(key)) {
          waiting.get(key)(message);
          waiting.delete(key);
        } else if (responseWaiters.has(key)) {
          responseWaiters.get(key)(message);
          responseWaiters.delete(key);
        } else {
          receivedResponses.set(key, message);
        }
      }
    }
  });
  const request = (method, params = {}, envelope = {}) => {
    const requestId = ++id;
    let timer;
    const promise = new Promise((resolve, reject) => {
      waiting.set(String(requestId), (message) => {
        clearTimeout(timer);
        if (method === "initialize" && message.result) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        }
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params, ...envelope }) + "\n");
      timer = setTimeout(() => {
        waiting.delete(String(requestId));
        reject(new Error(`Timed out waiting for ${method}. stderr=${stderr}`));
      }, 3000);
      timer.unref();
    });
    promise.requestId = requestId;
    return promise;
  };
  const sendRaw = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const sendRawText = (raw, chunkSize = 32768) => {
    for (let offset = 0; offset < raw.length; offset += chunkSize) child.stdin.write(raw.slice(offset, offset + chunkSize));
    child.stdin.write("\n");
  };
  const sendRawBytes = (raw, chunkSize = 32768, delimiter = "\n") => {
    const bytes = Buffer.from(raw, "utf8");
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      child.stdin.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    child.stdin.write(delimiter);
  };
  const sendRawBytesSplitCrLf = async (raw, chunkSize = 32768) => {
    const bytes = Buffer.from(raw, "utf8");
    const write = async (chunk) => {
      if (!child.stdin.write(chunk)) {
        await new Promise((resolve, reject) => {
          child.stdin.once("drain", resolve);
          child.stdin.once("error", reject);
        });
      }
    };
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      await write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    // Yield between delimiter writes so the stream consumer can observe CR
    // while LF is still pending; no timing sleep is used.
    await write(Buffer.from("\r"));
    await new Promise((resolve) => setImmediate(resolve));
    await write(Buffer.from("\n"));
  };
  const waitForResponse = (requestId, timeoutMs = 3000) => {
    const key = String(requestId);
    if (receivedResponses.has(key)) {
      const response = receivedResponses.get(key);
      receivedResponses.delete(key);
      return Promise.resolve(response);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responseWaiters.delete(key);
        reject(new Error(`Timed out waiting for response id ${key}. stderr=${stderr}`));
      }, timeoutMs);
      responseWaiters.set(key, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
  const nextElicitation = () => {
    if (elicitationQueue.length) return Promise.resolve(elicitationQueue.shift());
    return new Promise((resolve, reject) => {
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const index = elicitationWaiters.indexOf(waiter);
        if (index !== -1) elicitationWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for MCP elicitation. stderr=${stderr}`));
      }, 3000);
      elicitationWaiters.push(waiter);
    });
  };
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
  return { child, request, sendRaw, sendRawText, sendRawBytes, sendRawBytesSplitCrLf, waitForResponse, tool, nextElicitation, respondToElicitation, notifyCancelled, setElicitationDecision: (decision) => { currentDecision = decision; }, getStderr: () => stderr, getQueuedElicitationCount: () => elicitationQueue.length, getProtocolErrors: () => [...protocolErrors], getResponseCount: (requestId) => responseCounts.get(String(requestId)) ?? 0 };
}

function startEmbeddedClient(stateDirectory, reviewProvider) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  let buffered = "";
  let id = 0;
  const server = runFactoryMcpServer({ stateDirectory, input, output, reviewProvider });
  output.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(String(message.id))) {
        const resolve = pending.get(String(message.id));
        pending.delete(String(message.id));
        resolve(message);
      }
    }
  });
  const request = (method, params = {}) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(requestId));
        reject(new Error(`Embedded MCP request timed out: ${method}`));
      }, 3000);
      timer.unref();
      pending.set(String(requestId), (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      input.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
  };
  const tool = async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const text = response.result?.content?.find((entry) => entry.type === "text")?.text;
    assert.ok(text, JSON.stringify(response));
    if (response.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const initialize = async () => {
    const response = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "embedded-review-host", version: "1.0.0" },
    });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  const close = async () => {
    input.end();
    await server;
  };
  return { initialize, request, tool, close };
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

test("MCP bridge keeps duplicate-ID errors uncorrelated so the original request completes exactly once", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-duplicate-rpc-id-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "duplicate-rpc-id" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id, expectedRevision: 0, plan: "Allow a fixture action for duplicate-ID coverage.",
  });
  assert.equal(plan.approved, true);

  client.setElicitationDecision("none");
  const args = {
    runId: created.run.id, actionType: "file.write", toolName: "Write",
    toolInput: { file_path: "/tmp/duplicate-id.txt", content: "must not be written" },
    reason: "Verify duplicate request IDs cannot create a second approval prompt.",
  };
  const original = client.request("tools/call", { name: "factory_action_request_approval", arguments: args });
  const prompt = await client.nextElicitation();
  client.sendRaw({
    jsonrpc: "2.0", id: original.requestId, method: "tools/call",
    params: { name: "factory_action_request_approval", arguments: args },
  });
  client.respondToElicitation(prompt.id, "decline");

  const originalResponse = await original;
  assert.equal(originalResponse.id, original.requestId);
  assert.equal(originalResponse.error, undefined, "the original request must not receive the duplicate's JSON-RPC error");
  const originalPayload = originalResponse.result?.content?.find((entry) => entry.type === "text");
  assert.ok(originalPayload, JSON.stringify(originalResponse));
  assert.equal(JSON.parse(originalPayload.text).approved, false, "the original operation should settle from its own decline");
  assert.equal(client.getResponseCount(original.requestId), 1, "exactly one terminal response may use the original request ID");
  const duplicateError = client.getProtocolErrors().find((message) => message.error?.code === -32600);
  assert.ok(duplicateError, "the duplicate should receive an uncorrelated invalid-request error");
  assert.equal(duplicateError.id, null, "the duplicate error must not steal the original request's correlation ID");

  await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(client.getQueuedElicitationCount(), 0, "duplicate request must not enqueue another human prompt");
  assert.equal(client.getResponseCount(original.requestId), 1, "later requests must not cause a second response for the original ID");
});

test("MCP bridge bounds concurrent tool calls and releases capacity after they settle", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-rpc-concurrency-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "concurrency-bound" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id, expectedRevision: 0, plan: "Allow fixture actions for concurrency coverage.",
  });
  assert.equal(plan.approved, true);

  client.setElicitationDecision("none");
  const calls = Array.from({ length: 16 }, (_, index) => client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id, actionType: "file.write", toolName: "Write",
      toolInput: { file_path: `/tmp/concurrency-${index}.txt`, content: "fixture" },
      reason: "Hold an in-flight request to verify the server concurrency ceiling.",
    },
  }));
  const prompts = await Promise.all(Array.from({ length: 16 }, () => client.nextElicitation()));
  assert.equal(prompts.length, 16);

  const overflow = await client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id, actionType: "file.write", toolName: "Write",
      toolInput: { file_path: "/tmp/concurrency-overflow.txt", content: "must not be approved" },
      reason: "This call must be rejected while the bridge is at capacity.",
    },
  });
  assert.equal(overflow.error?.code, -32000);
  assert.match(overflow.error.message, /server is busy/);

  for (const prompt of prompts) client.respondToElicitation(prompt.id, "decline");
  await Promise.all(calls);
  const recovered = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(recovered.run.id, created.run.id, "a later request should run after in-flight capacity is released");
});

test("MCP bridge accepts an exact-limit frame when CRLF is written separately", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-split-crlf-"));
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

  const frame = {
    jsonrpc: "2.0",
    id: "split-crlf-exact",
    method: "tools/call",
    params: {
      name: "factory_session_create",
      arguments: { requestId: "split-crlf-exact" },
      padding: "",
    },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  frame.params.padding = "x".repeat(1_048_576 - baseBytes);
  const serialized = JSON.stringify(frame);
  assert.equal(Buffer.byteLength(serialized, "utf8"), 1_048_576);

  await client.sendRawBytesSplitCrLf(serialized, 8191);
  const response = await client.waitForResponse("split-crlf-exact");
  assert.equal(response.error, undefined, JSON.stringify(response));
  const state = JSON.parse(await readFile(path.join(cwd, ".factory-state", "workflows.json"), "utf8"));
  assert.equal(state.length, 1);
  assert.equal(state[0].run.status, "created");
});

test("MCP bridge rejects an over-limit frame before a split CRLF can complete it", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-split-crlf-over-"));
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

  const frame = {
    jsonrpc: "2.0",
    id: "split-crlf-over",
    method: "tools/call",
    params: {
      name: "factory_session_create",
      arguments: { requestId: "must-not-dispatch-split-crlf-over" },
      padding: "",
    },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  frame.params.padding = "z".repeat(1_048_577 - baseBytes);
  const serialized = JSON.stringify(frame);
  assert.equal(Buffer.byteLength(serialized, "utf8"), 1_048_577);

  await client.sendRawBytesSplitCrLf(serialized, 8191);
  const recovery = await client.request("tools/list");
  assert.ok(Array.isArray(recovery.result.tools));
  const errors = client.getProtocolErrors();
  assert.ok(errors.some((message) => /exceeds the 1048576-byte limit/.test(message.error.message)));
  assert.ok(errors.every((message) => !JSON.stringify(message).includes("must-not-dispatch-split-crlf-over")));
  await assert.rejects(readFile(path.join(cwd, ".factory-state", "workflows.json")), { code: "ENOENT" });
});

test("MCP bridge accepts frames at the byte limit with LF and CRLF delimiters", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-frame-boundary-"));
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

  const makeCreateFrame = (targetBytes, id, requestId) => {
    const frame = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "factory_session_create",
        arguments: { requestId },
        padding: "",
      },
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    assert.ok(targetBytes >= baseBytes);
    frame.params.padding = "x".repeat(targetBytes - baseBytes);
    const serialized = JSON.stringify(frame);
    assert.equal(Buffer.byteLength(serialized, "utf8"), targetBytes);
    return serialized;
  };

  client.sendRawBytes(makeCreateFrame(1_048_576, "exact-lf", "exact-lf-frame"), 16_381, "\n");
  const lfResponse = await client.waitForResponse("exact-lf");
  assert.equal(lfResponse.error, undefined, JSON.stringify(lfResponse));

  // The CRLF pair is framing, not payload: a maximum-sized JSON frame remains valid.
  client.sendRawBytes(makeCreateFrame(1_048_576, "exact-crlf", "exact-crlf-frame"), 16_379, "\r\n");
  const crlfResponse = await client.waitForResponse("exact-crlf");
  assert.equal(crlfResponse.error, undefined, JSON.stringify(crlfResponse));

  const state = JSON.parse(await readFile(path.join(cwd, ".factory-state", "workflows.json"), "utf8"));
  assert.equal(state.length, 2, "both maximum-sized frames must dispatch exactly once");
  assert.ok(state.every((entry) => entry.run.status === "created"));
});

test("MCP bridge rejects a frame one byte over the limit without dispatch or payload echo", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-frame-over-limit-"));
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

  const frame = {
    jsonrpc: "2.0",
    id: "one-byte-over",
    method: "tools/call",
    params: {
      name: "factory_session_create",
      arguments: { requestId: "must-not-be-created-over-limit" },
      padding: "",
    },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  frame.params.padding = "s".repeat(1_048_577 - baseBytes);
  const serialized = JSON.stringify(frame);
  assert.equal(Buffer.byteLength(serialized, "utf8"), 1_048_577);
  client.sendRawBytes(serialized, 8191);

  // A valid request after the rejected frame proves the parser recovered.
  const barrier = await client.request("tools/list");
  assert.ok(Array.isArray(barrier.result.tools));
  const errors = client.getProtocolErrors();
  assert.ok(errors.some((message) => /exceeds the 1048576-byte limit/.test(message.error.message)));
  assert.ok(errors.every((message) => !JSON.stringify(message).includes("must-not-be-created-over-limit")));
  await assert.rejects(readFile(path.join(cwd, ".factory-state", "workflows.json")), { code: "ENOENT" });
});

test("MCP bridge bounds oversized input frames and resumes at the next newline", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-oversized-frame-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: 77,
    method: "tools/call",
    params: {
      name: "factory_session_create",
      arguments: { requestId: "must-not-be-created" },
      padding: "界".repeat(400_000),
    },
  });
  client.sendRawBytes(oversized, 16_381);

  // The oversized frame is discarded through its newline; a subsequent valid
  // request proves the parser recovers instead of poisoning the input stream.
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "super-agents-factory-bridge");
  await assert.rejects(readFile(path.join(cwd, ".factory-state", "workflows.json")), { code: "ENOENT" });

  const created = await client.tool("factory_session_create", { requestId: "valid-after-oversized-frame" });
  assert.equal(created.run.status, "created");
});

test("MCP bridge rejects malformed JSON-RPC envelopes before dispatch", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-envelope-"));
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

  const badVersion = await client.request("tools/call", {
    name: "factory_session_create",
    arguments: { requestId: "bad-jsonrpc-version" },
  }, { jsonrpc: "1.0" });
  assert.equal(badVersion.error.code, -32600);

  const badParams = await client.request("tools/call", "not-an-object");
  assert.equal(badParams.error.code, -32600);

  // A malformed id cannot be correlated to a response, and a request-only
  // tools/call with no id is a notification: neither may create a workflow.
  client.sendRaw({
    jsonrpc: "2.0",
    id: { invalid: true },
    method: "tools/call",
    params: { name: "factory_session_create", arguments: { requestId: "bad-id" } },
  });
  client.sendRaw({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "factory_session_create", arguments: { requestId: "missing-id" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(readFile(path.join(cwd, ".factory-state", "workflows.json")), { code: "ENOENT" });

  const missingMethod = await client.request(undefined, {}, { method: undefined });
  assert.equal(missingMethod.error.code, -32600);

  const created = await client.tool("factory_session_create", { requestId: "valid-after-invalid" });
  assert.equal(created.run.status, "created");
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

test("MCP action approval persists a denial when the host does not advertise elicitation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-action-no-elicitation-"));
  let client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "initially-capable-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "action-no-elicitation" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id, expectedRevision: 0, plan: "Approve the plan before disabling host elicitation.",
  });
  assert.equal(plan.approved, true);

  // Capability negotiation is connection-scoped. Restart with a new host
  // session that does not advertise elicitation rather than re-initializing.
  const previousClient = client;
  previousClient.child.kill("SIGTERM");
  await new Promise((resolve) => previousClient.child.once("close", resolve));
  client = startClient(cwd);
  await client.request("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "no-elicitation-host", version: "1.0.0" },
  });
  const toolInput = { file_path: "/tmp/no-elicitation.txt", content: "must remain unapproved" };
  const response = await client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id, actionType: "file.write", toolName: "Write", toolInput,
      reason: "Verify missing elicitation support fails closed and is auditable.",
    },
  });
  assert.equal(response.error, undefined);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /elicitation was unavailable or failed/i);

  const ledger = JSON.parse(await readFile(path.join(cwd, ".factory-state", "approvals.json"), "utf8"));
  assert.equal(ledger.approvals.some((item) => item.outcome === "approved" && item.status === "active"), false);
  assert.equal(ledger.approvals.some((item) => item.outcome === "denied" && item.actionType === "file.write"), true);
  assert.equal((await runHook(cwd, "Write", toolInput)).hookSpecificOutput.permissionDecision, "deny");
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


test("MCP server rejects malformed raw tool arguments before workflow mutation", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-invalid-args-"));
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
  const created = await client.tool("factory_session_create", { requestId: "raw-args-test" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Exercise server-side argument validation before any mutation.",
  });
  assert.equal(plan.approved, true);

  const before = await client.tool("factory_session_get", { runId: created.run.id });
  const malformedCalls = [
    { name: "factory_evidence_submit", arguments: { runId: created.run.id, expectedRevision: before.run.revision, summary: "claimed", kind: "made-up", outcome: "passed" } },
    { name: "factory_evidence_submit", arguments: { runId: created.run.id, expectedRevision: before.run.revision, summary: "claimed", kind: "test", outcome: "not-a-result" } },
    { name: "factory_evidence_submit", arguments: { runId: created.run.id, expectedRevision: -1, summary: "claimed", kind: "test", outcome: "passed" } },
    { name: "factory_phase_transition", arguments: { runId: created.run.id, expectedRevision: before.run.revision, to: "completed" } },
    { name: "factory_session_create", arguments: { requestId: "unexpected-field", admin: true } },
    { name: "factory_session_create", arguments: { requestId: " " } },
  ];

  for (const params of malformedCalls) {
    const response = await client.request("tools/call", params);
    assert.equal(response.result?.isError, true, JSON.stringify(response));
  }

  const after = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(after.run.revision, before.run.revision);
  assert.deepEqual(after.steps, before.steps);
  assert.deepEqual(after.evidence, before.evidence);
  const createdFiles = await readFile(path.join(cwd, ".factory-state", "workflows.json"), "utf8");
  assert.equal(createdFiles.includes("unexpected-field"), false);
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

  // Provenance is assigned by the server, never accepted from model-controlled
  // arguments. Try both a direct override and a nested evidence-object bypass.
  const forgedSubmissions = [
    { source: "runner_observed" },
    { source: "review_engine" },
    { evidence: { source: "runner_observed", outcome: "passed", summary: "Forged runner result." } },
  ];
  for (const forgedFields of forgedSubmissions) {
    const response = await client.request("tools/call", {
      name: "factory_evidence_submit",
      arguments: {
        runId: created.run.id,
        expectedRevision: plan.run.revision,
        summary: "Model attempts to forge trusted provenance.",
        kind: "test",
        outcome: "passed",
        ...forgedFields,
      },
    });
    assert.equal(response.result?.isError, true, JSON.stringify(response));
  }

  const afterForgeryAttempts = await client.tool("factory_session_get", { runId: created.run.id });
  assert.deepEqual(afterForgeryAttempts.evidence, persisted.evidence, "rejected provenance overrides must not mutate persisted evidence");

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


test("PreToolUse hook revokes an exact-payload approval after the workflow revision advances", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-hook-stale-revision-"));
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
  const created = await client.tool("factory_session_create", { requestId: "stale-revision-approval" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve one action, then advance the workflow before executing it.",
  });
  assert.equal(plan.approved, true);

  const toolInput = { file_path: "/tmp/stale-revision.txt", content: "must remain blocked" };
  const approval = await client.tool("factory_action_request_approval", {
    runId: created.run.id,
    actionType: "file.write",
    toolName: "Write",
    toolInput,
    reason: "Test approval revision binding.",
  });
  assert.equal(approval.approved, true);
  assert.equal(approval.workflowRevision, plan.run.revision);

  const advanced = await client.tool("factory_phase_transition", {
    runId: created.run.id,
    expectedRevision: approval.workflowRevision,
    to: "verifying",
  });
  assert.equal(advanced.revision, approval.workflowRevision + 1);

  const result = await runHook(cwd, "Write", toolInput);
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /revision|stale/i);

  const ledger = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(cwd, ".factory-state", "approvals.json"), "utf8")));
  assert.equal(ledger.approvals.find((item) => item.id === approval.approvalId).status, "revoked");
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
  assert.equal(response.error, undefined);
  assert.equal(response.result?.isError, undefined);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /elicitation was unavailable or failed/i);

  const ledger = JSON.parse(await readFile(path.join(cwd, ".factory-state", "approvals.json"), "utf8"));
  assert.equal(ledger.approvals.some((item) => item.outcome === "approved" && item.status === "active"), false);
  assert.equal(ledger.approvals.some((item) => item.outcome === "denied" && item.actionType === "file.write"), true);

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
  assert.equal(report.verificationRunStep.status, "succeeded");
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
  assert.deepEqual(evidence[0].runner, {
    checkId: "fixture-check",
    status: "passed",
    exitCode: 0,
    durationMs: report.checks[0].durationMs,
    observedStdoutBytes: Buffer.byteLength("verified"),
    observedStderrBytes: Buffer.byteLength("diagnostic"),
    outputTruncated: false,
    stdoutDigest: report.checks[0].stdoutDigest,
    stderrDigest: report.checks[0].stderrDigest,
  });

  assert.equal(session.run.status, "verifying");
  assert.equal(session.steps[`verification-run-${created.run.id}`].status, "succeeded");

  const delivery = await client.tool("factory_delivery_status", { runId: created.run.id });
  assert.equal(delivery.runnerObservedEvidenceCount, 1);
  assert.equal(delivery.runnerObservedEvidencePassed, true);
  assert.equal(delivery.verificationRunStatus, "succeeded");
  assert.equal(delivery.reviewEngineEvidencePassed, false);
  assert.equal(delivery.readyForHumanDelivery, false, "runner success alone is not delivery readiness");

  // Exercise the real public review tool through a configured host provider;
  // no test mutates the workflow JSON to manufacture trusted evidence.
  const transitioned = await client.tool("factory_phase_transition", {
    runId: created.run.id,
    expectedRevision: session.run.revision,
    to: "reviewing",
  });
  const closed = new Promise((resolve) => client.child.once("close", resolve));
  client.child.kill("SIGTERM");
  await closed;
  let providerCalls = 0;
  const embedded = startEmbeddedClient(path.join(cwd, ".factory-state"), async (request) => {
    providerCalls += 1;
    assert.equal(request.runId, created.run.id);
    assert.equal(request.workflowRevision, transitioned.revision);
    assert.equal(request.repositoryRoot, process.cwd());
    return {
      status: "passed",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      diff: "diff --git a/file b/file\n+reviewed",
      summary: "Independent standards and specification review passed.",
    };
  });
  await embedded.initialize();
  // Unknown model-supplied provenance fields must be rejected by the advertised schema.
  const spoof = await embedded.request("tools/call", {
    name: "factory_review_run",
    arguments: { runId: created.run.id, expectedRevision: transitioned.revision, source: "review_engine", outcome: "passed" },
  });
  assert.equal(spoof.result.isError, true);
  const review = await embedded.tool("factory_review_run", {
    runId: created.run.id,
    expectedRevision: transitioned.revision,
  });
  assert.equal(providerCalls, 1);
  assert.equal(review.status, "passed");
  assert.equal(review.evidenceSource, "review_engine");
  assert.match(review.diffDigest, /^[a-f0-9]{64}$/);
  const ready = await embedded.tool("factory_delivery_status", { runId: created.run.id });
  assert.equal(ready.run.status, "reviewing");
  assert.equal(ready.reviewEngineEvidenceCount, 1);
  assert.equal(ready.reviewEngineEvidencePassed, true);
  assert.equal(ready.readyForHumanDelivery, true);
  assert.equal(ready.automaticDelivery, false);
  assert.equal(transitioned.status, "reviewing");
  await assert.rejects(
    embedded.tool("factory_review_run", { runId: created.run.id, expectedRevision: transitioned.revision }),
    /cannot start safely/i,
  );
  await embedded.close();
});

test("MCP verification rejects overlapping verification attempts before spawning a second process", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-runner-overlap-"));
  const marker = path.join(cwd, "must-not-run-twice.txt");
  const profile = {
    allowedExecutables: { node: process.execPath },
    checks: [{
      id: "overlap-check",
      kind: "command",
      executable: "node",
      args: ["-e", "require('node:fs').appendFileSync('must-not-run-twice.txt', 'ran\\n')"],
      cwd: ".",
      timeoutMs: 2000,
      maxOutputBytes: 1024,
    }],
  };
  const client = startClient(cwd, "accept", 60_000, profile);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "runner-overlap-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "runner-overlap" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Only one verification invocation may own this workflow run.",
  });
  client.setElicitationDecision("none");
  const pending = client.request("tools/call", {
    name: "factory_verification_run",
    arguments: { runId: created.run.id, expectedRevision: plan.run.revision },
  });
  const prompt = await client.nextElicitation();
  assert.equal(prompt.method, "elicitation/create");

  const active = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(active.run.status, "verifying");
  assert.equal(active.steps[`verification-run-${created.run.id}`].status, "running");
  const competing = await client.request("tools/call", {
    name: "factory_verification_run",
    arguments: { runId: created.run.id, expectedRevision: active.run.revision },
  });
  assert.equal(competing.result.isError, true);
  assert.match(competing.result.content[0].text, /already_running|cannot start safely/i);

  client.notifyCancelled(pending.requestId);
  const cancelled = await pending;
  const textResult = cancelled.result.content.find((entry) => entry.type === "text");
  assert.equal(JSON.parse(textResult.text).checks[0].status, "cancelled");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const final = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(final.run.status, "failed");
  assert.equal(final.steps[`verification-run-${created.run.id}`].status, "failed");
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
  assert.equal(report.checks[0].status, "cancelled");
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


test("MCP bridge exposes human-gated interrupted-step recovery and never retries automatically", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-recovery-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const listed = await client.request("tools/list");
  const toolNames = listed.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("factory_session_recover_interrupted"));
  assert.ok(toolNames.includes("factory_step_reconcile"));

  const created = await client.tool("factory_session_create", { requestId: "recovery-test" });
  const statePath = path.join(cwd, ".factory-state", "workflows.json");
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  const record = stored.find((item) => item.run.id === created.run.id);
  record.steps["verify-test"] = {
    id: "verify-test", status: "running", startedAt: "2026-10-21T00:00:00.000Z", attempt: 1,
  };
  await writeFile(statePath, JSON.stringify(stored, null, 2), { mode: 0o600 });

  client.setElicitationDecision("none");
  const recoveryPromise = client.tool("factory_session_recover_interrupted", { runId: created.run.id });
  const recoveryPrompt = await client.nextElicitation();
  assert.match(recoveryPrompt.params.message, /No step will be retried/);
  assert.match(recoveryPrompt.params.message, /verify-test/);
  client.respondToElicitation(recoveryPrompt.id, "accept");
  const recovery = await recoveryPromise;
  assert.deepEqual(recovery.recovered.map((step) => step.status), ["interrupted"]);

  const interrupted = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(interrupted.steps["verify-test"].status, "interrupted");

  const reconciliationPromise = client.tool("factory_step_reconcile", {
    runId: created.run.id,
    stepId: "verify-test",
    resolution: "retry",
    reason: "Inspected the prior process and reconciled its effects.",
  });
  const retryPrompt = await client.nextElicitation();
  assert.match(retryPrompt.params.message, /retry is safe only if replay cannot duplicate harmful effects/);
  assert.match(retryPrompt.params.message, /verify-test/);
  client.respondToElicitation(retryPrompt.id, "accept");
  const reconciled = await reconciliationPromise;
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.step.status, "running");
  assert.equal(reconciled.step.attempt, 2);
  assert.match(reconciled.note, /does not execute the retry automatically/);
  const final = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(final.steps["verify-test"].status, "running");
  assert.equal(final.steps["verify-test"].attempt, 2);
});

test("MCP bridge blocks interrupted-step retry when host reconciliation is declined", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-recovery-decline-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "recovery-decline-test" });
  const statePath = path.join(cwd, ".factory-state", "workflows.json");
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  const record = stored.find((item) => item.run.id === created.run.id);
  record.steps["uncertain-step"] = {
    id: "uncertain-step", status: "interrupted", startedAt: "2026-10-21T00:00:00.000Z", attempt: 1,
  };
  await writeFile(statePath, JSON.stringify(stored, null, 2), { mode: 0o600 });

  client.setElicitationDecision("none");
  const clientCall = client.tool("factory_step_reconcile", {
    runId: created.run.id, stepId: "uncertain-step", resolution: "retry",
    reason: "External effects are not yet confirmed.",
  });
  const prompt = await client.nextElicitation();
  client.respondToElicitation(prompt.id, "decline");
  const result = await clientCall;
  assert.equal(result.reconciled, false);
  assert.equal(result.blocked, true);
  const final = await client.tool("factory_session_get", { runId: created.run.id });
  assert.equal(final.steps["uncertain-step"].status, "interrupted");
  assert.equal(final.steps["uncertain-step"].attempt, 1);
});


test("PreToolUse hook denies malformed persisted workflow state without consuming approval", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-hook-malformed-workflow-"));
  const client = startClient(cwd, "accept");
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "malformed-workflow-state" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Approve a harmless fixture write for this test.",
  });
  assert.equal(plan.approved, true);
  const toolInput = { file_path: "/tmp/approved-after-recovery.txt", content: "approved" };
  const approval = await client.tool("factory_action_request_approval", {
    runId: created.run.id,
    actionType: "file.write",
    toolName: "Write",
    toolInput,
    reason: "Test that malformed workflow state cannot authorize a native action.",
  });
  assert.equal(approval.approved, true);

  const statePath = path.join(cwd, ".factory-state", "workflows.json");
  const validState = await readFile(statePath, "utf8");
  const malformedState = JSON.parse(validState);
  const record = malformedState.find((item) => item.run.id === created.run.id);
  record.run = { id: created.run.id, status: "running" };
  await writeFile(statePath, JSON.stringify(malformedState, null, 2), { mode: 0o600 });

  const denied = await runHook(cwd, "Write", toolInput);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /workflow store|persisted workflow/i);

  await writeFile(statePath, validState, { mode: 0o600 });
  const allowedAfterRestore = await runHook(cwd, "Write", toolInput);
  assert.deepEqual(allowedAfterRestore, {});
});


test("MCP bridge ignores JSON-RPC batch frames without dispatching contained mutations", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-batch-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  client.sendRaw([
    {
      jsonrpc: "2.0",
      id: "batch-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "batch-client", version: "1.0.0" },
      },
    },
    {
      jsonrpc: "2.0",
      id: "batch-create",
      method: "tools/call",
      params: {
        name: "factory_session_create",
        arguments: { requestId: "must-not-be-created-from-batch" },
      },
    },
  ]);

  // A following single request acts as a stream-ordering barrier: its response
  // proves the preceding batch frame was consumed before we inspect persisted state.
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "single-request-client", version: "1.0.0" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  await assert.rejects(
    readFile(path.join(cwd, ".factory-state", "workflows.json")),
    { code: "ENOENT" },
    "a JSON-RPC batch must not initialize the session or dispatch its contained tool call",
  );
  const created = await client.tool("factory_session_create", { requestId: "single-request-after-batch" });
  assert.equal(created.run.status, "created");
});

test("MCP bridge rejects tool calls before initialization without persisting workflow state", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-preinit-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  const response = await client.request("tools/call", {
    name: "factory_session_create",
    arguments: { requestId: "must-not-exist-before-init" },
  });
  assert.equal(response.error.code, -32002);
  await assert.rejects(readFile(path.join(cwd, ".factory-state", "workflows.json")), { code: "ENOENT" });

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test-host", version: "1.0.0" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  const created = await client.tool("factory_session_create", { requestId: "created-after-init" });
  assert.equal(created.run.status, "created");
});

test("MCP bridge rejects duplicate initialize without resetting negotiated capabilities", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-duplicate-init-"));
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
  const duplicate = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "duplicate-client", version: "2.0.0" },
  });
  assert.equal(duplicate.error.code, -32600);
  assert.match(duplicate.error.message, /only be called once/);

  const created = await client.tool("factory_session_create", { requestId: "still-initialized" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "The first negotiated elicitation capability remains active.",
  });
  assert.equal(plan.approved, true);
});

test("MCP bridge cancels pending plan approval and exits promptly when stdin closes", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-stdin-close-"));
  const client = startClient(cwd, "accept", 60_000);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "disconnecting-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "stdin-close" });
  client.setElicitationDecision("none");
  const pendingApproval = client.request("tools/call", {
    name: "factory_plan_request_approval",
    arguments: {
      runId: created.run.id,
      expectedRevision: 0,
      plan: "A disconnected host must not approve this plan.",
    },
  }).catch(() => undefined);
  const prompt = await client.nextElicitation();
  assert.equal(prompt.method, "elicitation/create");

  const exited = new Promise((resolve) => client.child.once("close", resolve));
  client.child.stdin.end();
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP bridge did not exit promptly after stdin closed.")), 1500)),
  ]);
  // The disconnected caller cannot receive a tool response; keep its timeout rejection handled.
  const persisted = JSON.parse(await readFile(path.join(cwd, ".factory-state", "workflows.json"), "utf8"));
  const run = persisted.find((item) => item.run.id === created.run.id);
  assert.ok(run, "workflow remains persisted after transport shutdown");
  assert.equal(run.run.status, "cancelled");
});

test("MCP bridge exits cleanly when stdin reaches EOF without a request", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-clean-eof-"));
  const client = startClient(cwd);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  const exits = [];
  client.child.on("close", (code, signal) => exits.push({ code, signal }));
  const closed = new Promise((resolve) => client.child.once("close", resolve));
  client.child.stdin.end();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP bridge did not exit after clean EOF.")), 1500)),
  ]);
  assert.equal(exits.length, 1, "end and close must not run shutdown more than once");
  await assert.rejects(readFile(path.join(cwd, ".factory-state", "workflows.json")), { code: "ENOENT" });
});

test("MCP bridge does not grant native action approval after stdin closes", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-action-eof-"));
  const client = startClient(cwd, "accept", 60_000);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "action-disconnect-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "action-eof" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Allow the workflow to reach an action-approval request.",
  });
  assert.equal(plan.approved, true);
  client.setElicitationDecision("none");

  const pending = client.request("tools/call", {
    name: "factory_action_request_approval",
    arguments: {
      runId: created.run.id,
      actionType: "file.write",
      toolName: "Write",
      toolInput: { file_path: path.join(cwd, "must-not-write.txt"), content: "no approval" },
      reason: "Verify disconnect cannot approve an exact native action.",
    },
  }).catch(() => undefined);
  const prompt = await client.nextElicitation();
  assert.equal(prompt.method, "elicitation/create");

  const closed = new Promise((resolve) => client.child.once("close", resolve));
  client.child.stdin.end();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Bridge did not exit promptly after action approval disconnect.")), 1500)),
  ]);
  // The disconnected caller cannot receive a response; keep its timeout rejection handled above.

  const ledger = JSON.parse(await readFile(path.join(cwd, ".factory-state", "approvals.json"), "utf8"));
  assert.ok(ledger.events.some((item) => item.kind === "decision_recorded" && item.decisionOutcome === "denied"),
    "disconnect should leave an auditable denial");
  assert.equal(ledger.approvals.some((item) => item.outcome === "approved" && item.actionType === "file.write"), false);
});

test("MCP bridge does not spawn verification command when stdin closes during approval", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-mcp-verification-eof-"));
  const profile = {
    allowedExecutables: { node: process.execPath },
    checks: [{
      id: "disconnect-check",
      kind: "command",
      executable: "node",
      args: ["-e", "require('node:fs').writeFileSync('disconnect-check-ran.txt', 'ran')"],
      cwd: ".",
      timeoutMs: 2000,
      maxOutputBytes: 1024,
    }],
  };
  const client = startClient(cwd, "accept", 60_000, profile);
  t.after(async () => {
    client.child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "verification-disconnect-host", version: "1.0.0" },
  });
  const created = await client.tool("factory_session_create", { requestId: "verification-eof" });
  const plan = await client.tool("factory_plan_request_approval", {
    runId: created.run.id,
    expectedRevision: 0,
    plan: "Allow verification to be requested, but not run without approval.",
  });
  assert.equal(plan.approved, true);
  client.setElicitationDecision("none");

  const pending = client.request("tools/call", {
    name: "factory_verification_run",
    arguments: { runId: created.run.id, expectedRevision: plan.run.revision },
  }).catch(() => undefined);
  const prompt = await client.nextElicitation();
  assert.equal(prompt.method, "elicitation/create");

  const closed = new Promise((resolve) => client.child.once("close", resolve));
  client.child.stdin.end();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Bridge did not exit promptly after verification disconnect.")), 1500)),
  ]);
  // The disconnected caller cannot receive a response; keep its timeout rejection handled above.

  await assert.rejects(readFile(path.join(cwd, "disconnect-check-ran.txt")), { code: "ENOENT" });
  const state = JSON.parse(await readFile(path.join(cwd, ".factory-state", "workflows.json"), "utf8"));
  const run = state.find((item) => item.run.id === created.run.id);
  assert.ok(run, "workflow should remain persisted");
  assert.equal(run.run.status === "completed", false);
});

