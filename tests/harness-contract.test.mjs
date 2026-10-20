import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeCodeAdapter } from "../dist/claude-code.js";
import { ScriptedHarnessAdapter } from "./support/scripted-harness.mjs";

const invocation = (overrides = {}) => ({
  prompt: "return a short success marker",
  cwd: process.cwd(),
  timeoutMs: 500,
  maxOutputBytes: 1024,
  ...overrides,
});

function fakeChild(onSpawn) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.killSignal = signal;
    queueMicrotask(() => child.emit("close", signal === "SIGKILL" ? null : 1));
    return true;
  };
  onSpawn(child);
  return child;
}

function createFakeClaudeAdapter() {
  const spawnProcess = (_executable, args) => fakeChild((child) => queueMicrotask(() => {
    if (args[0] === "--version") {
      child.stdout.end("2.1.0\n");
      child.emit("close", 0);
    } else if (args[0] === "--help") {
      child.stdout.end("Usage: claude -p [options]\n");
      child.emit("close", 0);
    } else if (args[1] === "fixture:large-output") {
      child.stdout.write("x".repeat(80));
      child.stdout.end();
      setImmediate(() => child.emit("close", child.killSignal ? 1 : 0));
    } else {
      child.stdout.end("scripted-ok");
      child.emit("close", 0);
    }
  }));
  return new ClaudeCodeAdapter({ executable: "/fake/claude", spawnProcess });
}

const adapters = [
  { name: "scripted fixture", create: () => new ScriptedHarnessAdapter() },
  { name: "Claude Code adapter with fake process", create: createFakeClaudeAdapter },
];

for (const entry of adapters) {
  test(`portable harness contract: ${entry.name} reports identity and supported invocation`, async () => {
    const adapter = entry.create();
    const capabilities = await adapter.detectCapabilities();
    assert.equal(capabilities.harnessId, adapter.id);
    assert.equal(capabilities.available, true);
    assert.ok(capabilities.supported.includes("prompt-invocation"));
    assert.ok(Array.isArray(capabilities.unsupported));
    if (adapter.id === "scripted-fixture") {
      assert.ok(capabilities.unsupported.includes("cancellation"));
      assert.ok(capabilities.unsupported.includes("timeouts"));
    }
  });

  test(`portable harness contract: ${entry.name} validates input and returns honest success`, async () => {
    const adapter = entry.create();
    await assert.rejects(adapter.invoke(invocation({ prompt: " " })), /Prompt/);
    await assert.rejects(adapter.invoke(invocation({ timeoutMs: 0 })), /timeoutMs/);
    await assert.rejects(adapter.invoke(invocation({ maxOutputBytes: -1 })), /maxOutputBytes/);

    const result = await adapter.invoke(invocation());
    assert.equal(result.harnessId, adapter.id);
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputTruncated, false);
    assert.ok(result.finishedAt);
    assert.ok(result.durationMs >= 0);
  });

  test(`portable harness contract: ${entry.name} bounds output and never reports truncation as success`, async () => {
    const adapter = entry.create();
    const result = await adapter.invoke(invocation({ prompt: "fixture:large-output", maxOutputBytes: 5 }));
    assert.ok(Buffer.byteLength(result.stdout) <= 5);
    assert.equal(result.outputTruncated, true);
    assert.notEqual(result.outcome, "succeeded");
  });
}

test("scripted harness preserves distinct non-success outcomes", async () => {
  const adapter = new ScriptedHarnessAdapter();
  for (const [prompt, expected] of [
    ["fixture:failure", "failed"],
    ["fixture:timeout", "timed_out"],
    ["fixture:cancelled", "cancelled"],
    ["fixture:unavailable", "unavailable"],
  ]) {
    const result = await adapter.invoke(invocation({ prompt }));
    assert.equal(result.outcome, expected);
    assert.notEqual(result.outcome, "succeeded");
  }
});
