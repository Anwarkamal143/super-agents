import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runVerification, VerificationConfigError, VerificationPersistenceError } from "../dist/index.js";

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
    authorize: async (action) => action === "command.execute",
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


test("authorization denial stops the run and never requests approval for later checks", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn();
    const authorizations = [];
    const report = await runVerification(config(root, fake.spawnProcess, {
      checks: [
        { id: "denied", kind: "test", executable: "node", args: ["first.js"] },
        { id: "must-not-prompt", kind: "test", executable: "node", args: ["second.js"] },
        { id: "also-not-run", kind: "typecheck", executable: "node", args: ["third.js"] },
      ],
      authorize: async (_action, payload) => { authorizations.push(payload.checkId); return false; },
    }));
    assert.equal(report.status, "incomplete");
    assert.deepEqual(authorizations, ["denied"]);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(report.checks.map((check) => check.status), ["blocked", "skipped", "skipped"]);
    assert.match(report.checks[1].reason, /earlier check stopped/);
    assert.match(report.checks[2].reason, /earlier check stopped/);
  });
});

test("failed check stops later approvals and preserves one result per configured check", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn({ code: 2, stderr: "first check failed" });
    const authorizations = [];
    const report = await runVerification(config(root, fake.spawnProcess, {
      checks: [
        { id: "failure", kind: "test", executable: "node", args: ["first.js"] },
        { id: "must-not-prompt", kind: "test", executable: "node", args: ["second.js"] },
      ],
      authorize: async (_action, payload) => { authorizations.push(payload.checkId); return true; },
    }));
    assert.equal(report.status, "failed");
    assert.deepEqual(authorizations, ["failure"]);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(report.checks.map((check) => check.status), ["failed", "skipped"]);
    assert.match(report.checks[1].reason, /earlier check stopped/);
  });
});

test("cancellation while authorization is pending prevents spawn and later approval prompts", async () => {
  await withRoot(async (root) => {
    const controller = new AbortController();
    const fake = fakeSpawn();
    const authorizations = [];
    const report = await runVerification(config(root, fake.spawnProcess, {
      signal: controller.signal,
      checks: [
        { id: "cancel-during-prompt", kind: "test", executable: "node", args: ["first.js"] },
        { id: "must-not-prompt", kind: "test", executable: "node", args: ["second.js"] },
      ],
      authorize: async (_action, payload) => {
        authorizations.push(payload.checkId);
        controller.abort();
        return true;
      },
    }));
    assert.equal(report.status, "incomplete");
    assert.deepEqual(authorizations, ["cancel-during-prompt"]);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(report.checks.map((check) => check.status), ["cancelled", "skipped"]);
    assert.match(report.checks[1].reason, /earlier check stopped/);
  });
});

test("successful checks continue, while an explicitly skipped check does not stop the run", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn();
    const authorizations = [];
    const report = await runVerification(config(root, fake.spawnProcess, {
      checks: [
        { id: "first", kind: "test", executable: "node", args: ["first.js"] },
        { id: "configured-skip", kind: "test", executable: "node", args: [], skip: true },
        { id: "last", kind: "typecheck", executable: "node", args: ["last.js"] },
      ],
      authorize: async (_action, payload) => { authorizations.push(payload.checkId); return true; },
    }));
    assert.equal(report.status, "incomplete");
    assert.deepEqual(authorizations, ["first", "last"]);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(report.checks.map((check) => check.status), ["passed", "skipped", "passed"]);
  });
});


test("timed-out check stops later approvals and leaves later checks explicitly skipped", async () => {
  await withRoot(async (root) => {
    const fake = fakeSpawn({ neverClose: true });
    const authorizations = [];
    const report = await runVerification(config(root, fake.spawnProcess, {
      checks: [
        { id: "timeout", kind: "test", executable: "node", args: ["hang.js"], timeoutMs: 10 },
        { id: "must-not-prompt", kind: "test", executable: "node", args: ["second.js"] },
      ],
      authorize: async (_action, payload) => { authorizations.push(payload.checkId); return true; },
    }));
    assert.equal(report.status, "failed");
    assert.deepEqual(authorizations, ["timeout"]);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(report.checks.map((check) => check.status), ["timed_out", "skipped"]);
    assert.match(report.checks[1].reason, /earlier check stopped/);
  });
});


test("output-limit overflow fails even when the process exits successfully after SIGTERM", async () => {
  await withRoot(async (root) => {
    const calls = [];
    const spawnProcess = (_executable, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        calls.push(signal);
        // Simulate a process that handles SIGTERM and exits with code 0.
        queueMicrotask(() => child.emit("close", 0));
        return true;
      };
      queueMicrotask(() => {
        child.stdout.write(Buffer.from("0123456789"));
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
      return child;
    };

    const report = await runVerification(config(root, spawnProcess, {
      checks: [{ id: "overflow", kind: "command", executable: "node", args: [], maxOutputBytes: 4 }],
    }));
    const result = report.checks[0];
    assert.equal(report.status, "failed");
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, "Check exceeded its output limit.");
    assert.equal(result.stdout.length, 4);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.observedStdoutBytes, 10);
    assert.equal(result.stdoutDigest, createHash("sha256").update("0123456789").digest("hex"));
    assert.deepEqual(calls, ["SIGTERM"]);
  });
});


test("output-limit overflow escalates to SIGKILL when a child ignores SIGTERM", async () => {
  await withRoot(async (root) => {
    const calls = [];
    const spawnProcess = (_executable, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        calls.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
        return true;
      };
      queueMicrotask(() => {
        child.stdout.write(Buffer.from("overflow"));
        child.stdout.end();
        child.stderr.end();
      });
      return child;
    };

    const report = await runVerification(config(root, spawnProcess, {
      checks: [{ id: "stubborn-overflow", kind: "command", executable: "node", args: [], maxOutputBytes: 2, timeoutMs: 1000 }],
    }));
    assert.equal(report.status, "failed");
    assert.equal(report.checks[0].status, "failed");
    assert.equal(report.checks[0].reason, "Check exceeded its output limit.");
    assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
  });
});


test("stdout and stderr stream errors fail the check without escaping as unhandled errors", async () => {
  await withRoot(async (root) => {
    for (const streamName of ["stdout", "stderr"]) {
      const spawnProcess = (_executable, _args, _options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal) => {
          if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0));
          return true;
        };
        queueMicrotask(() => {
          child[streamName].emit("error", new Error("private stream details"));
        });
        return child;
      };

      const report = await runVerification(config(root, spawnProcess, {
        checks: [{ id: streamName, kind: "command", executable: "node", args: [] }],
      }));
      assert.equal(report.status, "failed");
      assert.equal(report.checks[0].status, "failed");
      assert.equal(report.checks[0].reason, "Verification output stream failed.");
    }
  });
});

test("termination escalation is attempted after SIGTERM throws or returns false", async () => {
  await withRoot(async (root) => {
    for (const mode of ["throws", "false"]) {
      const calls = [];
      const spawnProcess = (_executable, _args, _options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal) => {
          calls.push(signal);
          if (signal === "SIGTERM") {
            if (mode === "throws") throw new Error("signal failed");
            return false;
          }
          queueMicrotask(() => child.emit("close", null));
          return true;
        };
        queueMicrotask(() => child.stdout.emit("error", new Error("stream broke")));
        return child;
      };

      const report = await runVerification(config(root, spawnProcess, {
        checks: [{ id: mode, kind: "command", executable: "node", args: [], timeoutMs: 1000 }],
      }));
      assert.equal(report.status, "failed");
      assert.equal(report.checks[0].status, "failed");
      assert.equal(report.checks[0].reason, "Verification output stream failed.");
      assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
    }
  });
});

test("failed SIGKILL attempt settles as failed instead of hanging forever", async () => {
  await withRoot(async (root) => {
    const calls = [];
    const spawnProcess = (_executable, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        calls.push(signal);
        if (signal === "SIGKILL") throw new Error("signal failed");
        return true;
      };
      queueMicrotask(() => child.stderr.emit("error", new Error("stream broke")));
      return child;
    };

    const report = await runVerification(config(root, spawnProcess, {
      checks: [{ id: "unconfirmed-termination", kind: "command", executable: "node", args: [], timeoutMs: 1000 }],
    }));
    assert.equal(report.status, "failed");
    assert.equal(report.checks[0].status, "failed");
    assert.equal(report.checks[0].reason, "Verification output stream failed.");
    assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
  });
});


test("verification settles and releases stdio when SIGKILL is sent but close never arrives", async () => {
  await withRoot(async (root) => {
    const calls = [];
    const authorizations = [];
    let spawnedChild;
    const spawnProcess = (_executable, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        calls.push(signal);
        return true;
      };
      spawnedChild = child;
      return child;
    };

    const report = await runVerification(config(root, spawnProcess, {
      checks: [
        { id: "stuck-child", kind: "command", executable: "node", args: [], timeoutMs: 10 },
        { id: "must-not-run", kind: "test", executable: "node", args: [], timeoutMs: 100 },
      ],
      authorize: async (_action, payload) => {
        authorizations.push(payload.checkId);
        return true;
      },
    }));

    assert.equal(report.status, "failed");
    assert.equal(report.checks[0].status, "timed_out");
    assert.match(report.checks[0].reason, /timeout/i);
    assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(authorizations, ["stuck-child"]);
    assert.deepEqual(report.checks.map((check) => check.status), ["timed_out", "skipped"]);
    assert.equal(spawnedChild.stdout.listenerCount("data"), 0);
    assert.equal(spawnedChild.stderr.listenerCount("data"), 0);
    assert.equal(spawnedChild.stdout.listenerCount("error"), 0);
    assert.equal(spawnedChild.stderr.listenerCount("error"), 0);
    assert.equal(spawnedChild.stdout.destroyed, true);
    assert.equal(spawnedChild.stderr.destroyed, true);
  });
});

test("process error during shutdown preserves escalation and cleans stream listeners after close", async () => {
  await withRoot(async (root) => {
    const calls = [];
    let spawnedChild;
    const spawnProcess = (_executable, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        calls.push(signal);
        if (signal === "SIGTERM") child.emit("error", new Error("signal error"));
        if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
        return true;
      };
      spawnedChild = child;
      queueMicrotask(() => child.stdout.emit("error", new Error("stream broke")));
      return child;
    };

    const report = await runVerification(config(root, spawnProcess, {
      checks: [{ id: "error-close-race", kind: "command", executable: "node", args: [], timeoutMs: 1000 }],
    }));
    assert.equal(report.status, "failed");
    assert.equal(report.checks[0].status, "failed");
    assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
    assert.equal(spawnedChild.stdout.listenerCount("error"), 0);
    assert.equal(spawnedChild.stderr.listenerCount("error"), 0);
  });
});


test("evidence persistence failure is typed, redacted, and prevents later checks", async () => {
  await withRoot(async (root) => {
    for (const failingCheckId of ["first", "second"]) {
      const fake = fakeSpawn();
      const authorizations = [];
      const persisted = [];
      const checks = [
        { id: "first", kind: "test", executable: "node", args: ["first.js"] },
        { id: "second", kind: "test", executable: "node", args: ["second.js"] },
        { id: "third", kind: "test", executable: "node", args: ["third.js"] },
      ];

      await assert.rejects(
        runVerification(config(root, fake.spawnProcess, {
          checks,
          authorize: async (_action, payload) => {
            authorizations.push(payload.checkId);
            return true;
          },
          onCheckComplete: async (result) => {
            persisted.push(result.checkId);
            if (result.checkId === failingCheckId) {
              throw new Error("storage secret: private-token-123");
            }
          },
        })),
        (error) => {
          assert.ok(error instanceof VerificationPersistenceError);
          assert.equal(error.name, "VerificationPersistenceError");
          assert.equal(error.checkId, failingCheckId);
          assert.match(error.message, /Failed to persist verification evidence/);
          assert.doesNotMatch(error.message, /private-token-123|storage secret/);
          assert.equal("cause" in error, false);
          return true;
        },
      );

      const failedIndex = checks.findIndex((check) => check.id === failingCheckId);
      assert.deepEqual(persisted, checks.slice(0, failedIndex + 1).map((check) => check.id));
      assert.deepEqual(authorizations, checks.slice(0, failedIndex + 1).map((check) => check.id));
      assert.equal(fake.calls.length, failedIndex + 1);
    }
  });
});
