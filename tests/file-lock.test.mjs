import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../dist/file-lock.js";

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "super-agents-file-lock-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("file lock has owner-only permissions on POSIX and is released after use", async () => {
  await withDirectory(async (directory) => {
    const lockPath = path.join(directory, "workflow.lock");

    await withFileLock(lockPath, async () => {
      const metadata = await stat(lockPath);
      if (process.platform !== "win32") {
        assert.equal(metadata.mode & 0o777, 0o600);
      }
    });

    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  });
});

test("malformed lock records fail closed and remain untouched", async () => {
  await withDirectory(async (directory) => {
    const lockPath = path.join(directory, "workflow.lock");
    const malformedRecord = "{incomplete";
    let operationStarted = false;

    await writeFile(lockPath, malformedRecord, { encoding: "utf8", mode: 0o600 });

    await assert.rejects(
      withFileLock(
        lockPath,
        async () => {
          operationStarted = true;
        },
        { timeoutMs: 30, retryMs: 1 },
      ),
      /Timed out acquiring file lock/,
    );

    assert.equal(operationStarted, false);
    assert.equal(await readFile(lockPath, "utf8"), malformedRecord);
  });
});

test("a confirmed dead lock owner is reclaimed before the operation runs", async () => {
  await withDirectory(async (directory) => {
    const lockPath = path.join(directory, "workflow.lock");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const deadPid = child.pid;
    assert.ok(Number.isInteger(deadPid));

    child.kill("SIGTERM");
    await once(child, "exit");

    await writeFile(lockPath, JSON.stringify({
      pid: deadPid,
      token: "stale-test-owner-token",
      startedAt: new Date(0).toISOString(),
    }), { encoding: "utf8", mode: 0o600 });

    let operationStarted = false;
    await withFileLock(lockPath, async () => {
      operationStarted = true;
    }, { timeoutMs: 1000, retryMs: 2 });

    assert.equal(operationStarted, true);
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  });
});

test("a live lock owner is preserved when a competing acquisition times out", async () => {
  await withDirectory(async (directory) => {
    const lockPath = path.join(directory, "workflow.lock");
    let signalOwnerStarted;
    let releaseOwner;
    const ownerStarted = new Promise((resolve) => {
      signalOwnerStarted = resolve;
    });
    const ownerRelease = new Promise((resolve) => {
      releaseOwner = resolve;
    });

    const ownerTask = withFileLock(lockPath, async () => {
      signalOwnerStarted();
      await ownerRelease;
    });

    let competingOperationStarted = false;
    try {
      await ownerStarted;
      const originalRecord = await readFile(lockPath, "utf8");

      await assert.rejects(
        withFileLock(
          lockPath,
          async () => {
            competingOperationStarted = true;
          },
          { timeoutMs: 40, retryMs: 2 },
        ),
        /Timed out acquiring file lock/,
      );

      assert.equal(competingOperationStarted, false);
      assert.equal(await readFile(lockPath, "utf8"), originalRecord);
      assert.equal(JSON.parse(originalRecord).pid, process.pid);
    } finally {
      releaseOwner();
      await ownerTask;
    }

    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  });
});
