import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runVerification, VerificationConfigError } from "../dist/index.js";

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "super-agents-verification-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeSpawn({ code = 0, stdout = "", stderr = "", neverClose = false } = {}) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      child.killSignal = signal;
      queueMicrotask(() => child.emit("close", signal === "SIGKILL" ? null : 1));
      return true;
    };
    queueMicrotask(() => {
      if (stdout) child.stdout.write(Buffer.from(stdout));
      if (stderr) child.stderr.write(Buffer.from(stderr));
      child.stdout.end();
      child.stderr.end();
      if (!neverClose) child.emit("close", code);
    });
    return child;
  };
  return { spawnProcess, calls };
}

function config(root, spawnProcess, overrides = {}) {
  return {
    repositoryRoot: root,
    allowedExecutables: { node: "/usr/bin/node" },
    checks: [{ id: "unit-tests", kind: "test", executable: "node", args: ["test.js"], timeoutMs: 100, maxOutputBytes: 1024 }],
    authorize: async (action, payload) => action === "command.execute" && payload.checkId === "unit-tests",
    spawnProcess,
    ...overrides,
  };
}

test("records passing command, exact invocation, timestamps, and complete stream digests", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn({ stdout: "all tests passed\n", stderr: "notice\n" });
    const report = await runVerification(config(root, fake.spawnProcess, {
      now: (() => { let i = 0; return () => new Date(1_800_000_000_000 + i++ * 1000).toISOString(); })(),
    }));
    assert.equal(report.status, "passed");
    assert.equal(report.checks[0].status, "passed");
    assert.equal(report.checks[0].exitCode, 0);
    assert.deepEqual(fake.calls[0].args, ["test.js"]);
    assert.equal(fake.calls[0].options.shell, false);
    assert.equal(report.checks[0].stdout, "all tests passed\n");
    assert.match(report.checks[0].stdoutDigest, /^[a-f0-9]{64}$/);
    assert.ok(report.checks[0].startedAt);
    assert.ok(report.checks[0].finishedAt);
  });
});

test("non-zero exit is failed and output is byte-bounded while full stream digests are retained", async () => {
  await withRoot(async (root) => {
    const fullOutput = "0123456789";
    const fake = fakeSpawn({ code: 2, stdout: fullOutput });
    const report = await runVerification(config(root, fake.spawnProcess, {
      checks: [{ id: "bounded", kind: "command", executable: "node", args: ["check.js"], maxOutputBytes: 4 }],
    }));
    const result = report.checks[0];
    assert.equal(report.status, "failed");
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout.length, 4);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.observedStdoutBytes, fullOutput.length);
    assert.notEqual(result.stdoutDigest, result.stdout);
  });
});

test("timeout and cancellation are distinct outcomes", async () => {
  await withRoot(async (root) => {
    const timeoutFake = fakeSpawn({ neverClose: true });
    const timed = await runVerification(config(root, timeoutFake.spawnProcess, {
      checks: [{ id: "hang", kind: "test", executable: "node", args: [], timeoutMs: 10 }],
    }));
    assert.equal(timed.checks[0].status, "timed_out");

    const controller = new AbortController();
    controller.abort();
    const cancelFake = fakeSpawn({ neverClose: true });
    const cancelled = await runVerification(config(root, cancelFake.spawnProcess, { signal: controller.signal }));
    assert.equal(cancelled.checks[0].status, "cancelled");
    assert.equal(cancelFake.calls.length, 0);
  });
});

test("skipped and unauthorized checks never spawn and never count as passing", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn();
    const skipped = await runVerification(config(root, fake.spawnProcess, {
      checks: [{ id: "skip", kind: "test", executable: "node", args: [], skip: true }],
    }));
    assert.equal(skipped.checks[0].status, "skipped");
    assert.equal(skipped.status, "incomplete");

    const denied = await runVerification(config(root, fake.spawnProcess, {
      authorize: async () => false,
    }));
    assert.equal(denied.checks[0].status, "blocked");
    assert.equal(denied.status, "incomplete");
    assert.equal(fake.calls.length, 0);
  });
});

test("authorization receives exact command identity and environment key names, not values", async () => {
  await withRoot(async (root) => {
    let observed;
    const fake = fakeSpawn();
    await runVerification(config(root, fake.spawnProcess, {
      checks: [{ id: "exact", kind: "command", executable: "node", args: ["--version"], environmentAllowlist: ["PATH"], cwd: "." }],
      authorize: async (_action, payload) => { observed = payload; return true; },
    }));
    assert.equal(observed.executable, "/usr/bin/node");
    assert.deepEqual(observed.args, ["--version"]);
    assert.equal(observed.cwd, root);
    assert.deepEqual(observed.environmentKeys, ["PATH"]);
    assert.equal("environment" in observed, false);
  });
});

test("malformed configs, non-allowlisted executables, and path traversal fail before spawning", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn();
    await assert.rejects(runVerification(config(root, fake.spawnProcess, {
      checks: [{ id: "bad", kind: "test", executable: "unknown", args: [] }],
    })), VerificationConfigError);
    await assert.rejects(runVerification(config(root, fake.spawnProcess, {
      checks: [{ id: "escape", kind: "test", executable: "node", args: [], cwd: "../" }],
    })), VerificationConfigError);
    await assert.rejects(runVerification(config(root, fake.spawnProcess, {
      checks: [
        { id: "duplicate", kind: "test", executable: "node", args: [] },
        { id: "duplicate", kind: "test", executable: "node", args: [] },
      ],
    })), VerificationConfigError);
    await assert.rejects(runVerification({
      repositoryRoot: root,
      checks: [{ id: "no-auth", kind: "test", executable: "node", args: [] }],
      allowedExecutables: { node: "/usr/bin/node" },
    }), /authorization callback is required/);
    assert.equal(fake.calls.length, 0);
  });
});

test("repository-contained nested working directory is accepted", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "packages", "app"), { recursive: true });
    const fake = fakeSpawn();
    const report = await runVerification(config(root, fake.spawnProcess, {
      checks: [{ id: "nested", kind: "test", executable: "node", args: [], cwd: "packages/app" }],
    }));
    assert.equal(report.checks[0].cwd, path.join(root, "packages", "app"));
    assert.equal(report.status, "passed");
  });
});
