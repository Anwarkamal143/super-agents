import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

test("file lock is owner-readable and owner-writable only on POSIX and released after use", { skip: process.platform === "win32" }, async () => {
  await withDirectory(async (directory) => {
    const lockPath = path.join(directory, "workflow.lock");
    let observedDuringOperation = false;

    await withFileLock(lockPath, async () => {
      const metadata = await stat(lockPath);
      assert.equal(metadata.mode & 0o777, 0o600);
      observedDuringOperation = true;
    });

    assert.equal(observedDuringOperation, true);
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  });
});
