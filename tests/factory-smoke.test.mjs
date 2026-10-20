import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, validateFactoryBoard } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("factory smoke: installed skill, board contract, and Claude adapter compose without credentials", async () => {
  const [skill, exampleText] = await Promise.all([
    readFile(path.join(root, ".claude/skills/factory/SKILL.md"), "utf8"),
    readFile(path.join(root, "factory/board.example.json"), "utf8"),
  ]);
  const board = JSON.parse(exampleText);
  const validation = validateFactoryBoard(board);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.match(skill, /single orchestrator/i);
  assert.match(skill, /only writer of `factory\/board\.json`/i);
  assert.match(skill, /Never merge a PR or deploy/i);
  assert.match(skill, /Wait for explicit approval/i);
  assert.equal(board.decisions.length, 0);
  assert.equal(board.tasks.every((task) => task.attempts === 0), true);

  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    return fakeChild((child) => queueMicrotask(() => {
      if (args[0] === "--version") {
        child.stdout.end("2.1.0\n");
        child.emit("close", 0);
      } else if (args[0] === "--help") {
        child.stdout.end("Usage: claude [-p, --print] [options]\n");
        child.emit("close", 0);
      } else {
        child.stdout.end("factory-smoke-ok\n");
        child.emit("close", 0);
      }
    }));
  };
  const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", spawnProcess });
  const capabilities = await adapter.detectCapabilities();
  assert.equal(capabilities.available, true);
  assert.ok(capabilities.supported.includes("prompt-invocation"));

  const prompt = "Inspect only; return the exact string factory-smoke-ok. Do not edit files.";
  const result = await adapter.invoke({
    prompt,
    cwd: root,
    timeoutMs: 500,
    maxOutputBytes: 1024,
  });
  assert.equal(result.outcome, "succeeded");
  assert.match(result.stdout, /factory-smoke-ok/);
  const invocation = calls.at(-1);
  assert.deepEqual(invocation.args, ["-p", prompt]);
  assert.equal(invocation.options.cwd, root);
  assert.equal(invocation.options.shell, false);
});

test("sample target board is valid and starts unapproved with no recorded decisions", async () => {
  const [boardText, manifestText, featureRequest] = await Promise.all([
    readFile(path.join(root, "examples/sample-target/factory/board.example.json"), "utf8"),
    readFile(path.join(root, "examples/sample-target/package.json"), "utf8"),
    readFile(path.join(root, "examples/sample-target/FEATURE_REQUEST.md"), "utf8"),
  ]);
  const board = JSON.parse(boardText);
  const manifest = JSON.parse(manifestText);
  const validation = validateFactoryBoard(board);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(board.status, "awaiting_approval");
  assert.equal(board.decisions.length, 0);
  assert.ok(board.tasks.some((task) => task.status === "needs_approval" && task.approvalRequired));
  assert.ok(board.tasks.every((task) => task.attempts === 0 && task.evidence.length === 0));
  assert.equal(manifest.scripts.test, "node --test");
  assert.match(featureRequest, /not authorization to implement/i);
});

test("factory smoke: missing CLI is unavailable, never a successful run", async () => {
  const adapter = new ClaudeCodeAdapter({
    executable: "/missing/claude",
    spawnProcess: () => {
      const error = new Error("executable not found");
      throw error;
    },
  });
  const result = await adapter.invoke({
    prompt: "smoke",
    cwd: root,
    timeoutMs: 100,
    maxOutputBytes: 100,
  });
  assert.equal(result.outcome, "unavailable");
  assert.notEqual(result.outcome, "succeeded");
  assert.match(result.error, /executable not found/);
});

test("factory smoke: timeout is reported as timed_out, not success", async () => {
  const spawnProcess = (_executable, args) => fakeChild((child) => {
    if (args[0] === "--version") queueMicrotask(() => {
      child.stdout.end("2.1.0\n");
      child.emit("close", 0);
    });
    else if (args[0] === "--help") queueMicrotask(() => {
      child.stdout.end("Usage: claude -p [options]\n");
      child.emit("close", 0);
    });
    if (args[0] !== "--version" && args[0] !== "--help") {
      const keepAlive = setTimeout(() => {}, 1_000);
      child.once("close", () => clearTimeout(keepAlive));
    }
    // Prompt invocation deliberately never closes; the adapter timeout kills it.
  });
  const adapter = new ClaudeCodeAdapter({ spawnProcess });
  const result = await adapter.invoke({
    prompt: "wait forever",
    cwd: root,
    timeoutMs: 20,
    maxOutputBytes: 100,
  });
  assert.equal(result.outcome, "timed_out");
  assert.notEqual(result.outcome, "succeeded");
});
