import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeCodeAdapter, validateInvocation } from "../dist/index.js";

function fakeChildProcess(onSpawn) {
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

test("invocation validation rejects empty prompt and invalid limits", () => {
  assert.throws(() => validateInvocation({ prompt: " ", cwd: "/tmp", timeoutMs: 100, maxOutputBytes: 100 }), /Prompt/);
  assert.throws(() => validateInvocation({ prompt: "hello", cwd: "/tmp", timeoutMs: 0, maxOutputBytes: 100 }), /timeoutMs/);
  assert.throws(() => validateInvocation({ prompt: "hello", cwd: "/tmp", timeoutMs: 100, maxOutputBytes: -1 }), /maxOutputBytes/);
});

test("Claude adapter detects print mode and passes prompt as an argument without a shell", async () => {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    return fakeChildProcess((child) => queueMicrotask(() => {
      if (args[0] === "--version") {
        child.stdout.end("2.0.0\n");
        child.emit("close", 0);
      } else if (args[0] === "--help") {
        child.stdout.end("Usage: claude [-p, --print] [options]\n");
        child.emit("close", 0);
      } else {
        child.stdout.end("done\n");
        child.emit("close", 0);
      }
    }));
  };
  const adapter = new ClaudeCodeAdapter({ executable: "/test/claude", spawnProcess });
  const capabilities = await adapter.detectCapabilities();
  assert.equal(capabilities.available, true);
  assert.ok(capabilities.supported.includes("prompt-invocation"));
  assert.ok(capabilities.unsupported.includes("parallel-agents"));

  const prompt = 'print this literally: "; rm -rf / && $(touch unsafe)';
  const result = await adapter.invoke({ prompt, cwd: "/tmp", timeoutMs: 500, maxOutputBytes: 1024 });
  assert.equal(result.outcome, "succeeded");
  const invocation = calls.at(-1);
  assert.equal(invocation.executable, "/test/claude");
  assert.deepEqual(invocation.args, ["-p", prompt]);
  assert.equal(invocation.options.shell, false);
});

test("Claude adapter fails closed when print mode is not advertised", async () => {
  const spawnProcess = (_executable, args) => fakeChildProcess((child) => queueMicrotask(() => {
    child.stdout.end(args[0] === "--version" ? "2.0.0\n" : "Usage: claude [options]\n");
    child.emit("close", 0);
  }));
  const adapter = new ClaudeCodeAdapter({ spawnProcess });
  const result = await adapter.invoke({ prompt: "hello", cwd: "/tmp", timeoutMs: 500, maxOutputBytes: 1024 });
  assert.equal(result.outcome, "unavailable");
  assert.match(result.error, /does not advertise/);
});

test("real Claude CLI integration is opt-in and uses an isolated temporary directory", { skip: process.env.CLAUDE_CODE_INTEGRATION !== "1" }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "super-agents-claude-integration-"));
  try {
    const adapter = new ClaudeCodeAdapter();
    const capabilities = await adapter.detectCapabilities();
    assert.equal(capabilities.available, true, capabilities.reason);
    const result = await adapter.invoke({ prompt: "Reply with exactly: adapter-integration-ok", cwd, timeoutMs: 30_000, maxOutputBytes: 4096 });
    assert.equal(result.outcome, "succeeded", result.error ?? result.stderr);
    assert.match(result.stdout, /adapter-integration-ok/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});


test("Claude adapter bounds combined stdout/stderr and reports truncation", async () => {
  const spawnProcess = (_executable, args) => fakeChildProcess((child) => queueMicrotask(() => {
    if (args[0] === "--version") child.stdout.end("2.0.0\\n");
    else if (args[0] === "--help") child.stdout.end("Usage: claude -p [options]\\n");
    else child.stdout.end("0123456789");
    child.emit("close", 0);
  }));
  const adapter = new ClaudeCodeAdapter({ spawnProcess });
  const result = await adapter.invoke({
    prompt: "emit output",
    cwd: "/tmp",
    timeoutMs: 500,
    maxOutputBytes: 4,
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 4);
  assert.notEqual(result.outcome, "succeeded");
});

test("Claude adapter reports non-zero prompt exit as failure", async () => {
  const spawnProcess = (_executable, args) => fakeChildProcess((child) => queueMicrotask(() => {
    if (args[0] === "--version") {
      child.stdout.end("2.0.0\\n");
      child.emit("close", 0);
    } else if (args[0] === "--help") {
      child.stdout.end("Usage: claude -p [options]\\n");
      child.emit("close", 0);
    } else {
      child.stderr.end("prompt failed\\n");
      child.emit("close", 7);
    }
  }));
  const adapter = new ClaudeCodeAdapter({ spawnProcess });
  const result = await adapter.invoke({
    prompt: "fail",
    cwd: "/tmp",
    timeoutMs: 500,
    maxOutputBytes: 100,
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.exitCode, 7);
  assert.notEqual(result.outcome, "succeeded");
});
