import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookEntry = path.join(root, "dist", "claude-code-pretool-hook.js");
const MAX_INPUT_BYTES = 1_048_576;

async function runHook(raw) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "factory-hook-input-limit-"));
  try {
    const result = await new Promise((resolve, reject) => {
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
      child.stdin.end(raw);
    });
    return result;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("PreToolUse hook rejects input exceeding its byte limit before parsing", async () => {
  const oversized = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: "/tmp/must-not-be-authorized.txt", content: "x".repeat(MAX_INPUT_BYTES) },
  });
  assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_INPUT_BYTES);

  const result = await runHook(oversized);
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /exceeded the 1048576-byte limit/);
});

test("PreToolUse hook still handles valid small input in a fresh invocation", async () => {
  const result = await runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/read-only.txt" } }));
  assert.deepEqual(result, {});
});
