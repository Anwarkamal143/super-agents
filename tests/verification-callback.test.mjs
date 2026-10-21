import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runVerification, VerificationPersistenceError } from "../dist/verification.js";

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-callback-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function spawnFactory(exitCode = 0) {
  const calls = [];
  const spawnProcess = () => {
    calls.push(true);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode);
    });
    return child;
  };
  return { spawnProcess, calls };
}

function makeConfig(root, spawnProcess, overrides = {}) {
  return {
    repositoryRoot: root,
    allowedExecutables: { node: "/usr/bin/node" },
    checks: [
      { id: "first", kind: "test", executable: "node", args: ["first.js"] },
      { id: "second", kind: "test", executable: "node", args: ["second.js"] },
    ],
    authorize: async () => true,
    spawnProcess,
    ...overrides,
  };
}

test("waits for persistence before authorizing the next check", async () => {
  await withRoot(async (root) => {
    const events = [];
    const fake = spawnFactory();
    const report = await runVerification(makeConfig(root, fake.spawnProcess, {
      authorize: async (_type, payload) => { events.push("authorize:" + payload.checkId); return true; },
      onCheckComplete: async (result) => {
        events.push("persist-start:" + result.checkId);
        await Promise.resolve();
        events.push("persist-done:" + result.checkId);
      },
    }));
    assert.equal(report.status, "passed");
    assert.deepEqual(events, [
      "authorize:first", "persist-start:first", "persist-done:first",
      "authorize:second", "persist-start:second", "persist-done:second",
    ]);
    assert.equal(fake.calls.length, 2);
  });
});

test("persistence rejection prevents later authorization and spawning", async () => {
  await withRoot(async (root) => {
    const fake = spawnFactory();
    const authorized = [];
    const persisted = [];
    await assert.rejects(runVerification(makeConfig(root, fake.spawnProcess, {
      authorize: async (_type, payload) => { authorized.push(payload.checkId); return true; },
      onCheckComplete: async (result) => {
        persisted.push(result.checkId);
        if (result.checkId === "first") throw new Error("storage unavailable");
      },
    })), (error) => {
      assert.ok(error instanceof VerificationPersistenceError);
      assert.equal(error.checkId, "first");
      assert.match(error.message, /Failed to persist verification evidence/);
      assert.doesNotMatch(error.message, /storage unavailable/);
      return true;
    });
    assert.deepEqual(authorized, ["first"]);
    assert.deepEqual(persisted, ["first"]);
    assert.equal(fake.calls.length, 1);
  });
});

test("reports skipped checks through the completion callback after a failure", async () => {
  await withRoot(async (root) => {
    const fake = spawnFactory(2);
    const records = [];
    const report = await runVerification(makeConfig(root, fake.spawnProcess, {
      onCheckComplete: async (result) => records.push({ id: result.checkId, status: result.status }),
    }));
    assert.equal(report.status, "failed");
    assert.deepEqual(records, [
      { id: "first", status: "failed" },
      { id: "second", status: "skipped" },
    ]);
    assert.equal(fake.calls.length, 1);
  });
});
