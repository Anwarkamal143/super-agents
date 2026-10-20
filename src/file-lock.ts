import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

interface LockOwner {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly retryMs?: number;
}

/**
 * Same-host cooperative lock for file-backed stores. Dead local owners are
 * reclaimed; live or unidentifiable owners are never stolen. This is not a
 * distributed lock and must not be used on filesystems with unreliable
 * exclusive-create semantics.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const owner: LockOwner = { pid: process.pid, token, startedAt: new Date().toISOString() };
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      await reclaimDeadOwner(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring file lock: ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const raw = await readFile(lockPath, "utf8");
      const current: unknown = JSON.parse(raw);
      if (isLockOwner(current) && current.token === token && current.pid === process.pid) {
        await unlink(lockPath);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

async function reclaimDeadOwner(lockPath: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isLockOwner(parsed)) return;
    try {
      process.kill(parsed.pid, 0);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") return;
    }
    // Re-check token immediately before unlinking so we do not remove a
    // replacement lock created after the owner file was read.
    const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (isLockOwner(current) && current.token === parsed.token && current.pid === parsed.pid) {
      await unlink(lockPath);
    }
  } catch (error) {
    // An incomplete/malformed owner record may be a process between exclusive
    // create and write. Never guess that it is stale; the lock acquisition
    // deadline will fail closed if the owner cannot be identified.
    if (!isNodeError(error) || error.code !== "ENOENT") return;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<LockOwner>;
  return Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0
    && typeof owner.token === "string" && owner.token.length > 0
    && typeof owner.startedAt === "string";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
