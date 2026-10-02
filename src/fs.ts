import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

export async function writeText(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

/**
 * Writes a file the way a durable record must be written: to a temporary file
 * first, then renamed over the target. A crash mid-write leaves either the old
 * content or the new one, never a truncated file.
 */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await Bun.write(tempPath, content);

  let attempts = 15;
  while (attempts > 0) {
    try {
      await rename(tempPath, path);
      return;
    } catch (err: any) {
      if (
        (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EEXIST") &&
        attempts > 1
      ) {
        attempts--;
        await Bun.sleep(10 + Math.floor(Math.random() * 20));
        continue;
      }
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}

export class FileLockError extends Error {
  readonly code = "FILE_LOCKED";
  readonly details: {
    path: string;
    lockPath: string;
    owner?: { pid: number; hostname: string };
    reclaimPath?: string;
  };

  constructor(
    path: string,
    lockPath: string,
    owner?: { pid: number; hostname: string },
    reclaimPath?: string,
  ) {
    super(
      reclaimPath
        ? `Timed out waiting for file lock: ${lockPath}. A reclaim guard is stuck at ${reclaimPath}; remove both only if you know their owners are gone.`
        : `Timed out waiting for file lock: ${lockPath}. Remove it only if you know it is stale.`,
    );
    this.name = "FileLockError";
    this.details = {
      path,
      lockPath,
      ...(owner ? { owner } : {}),
      ...(reclaimPath ? { reclaimPath } : {}),
    };
  }
}

/** Serializes writers; timeoutMs defaults to 10 seconds and never breaks a live lock. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  // Beside the lock, not inside it: a waiter creating an entry inside the lock
  // while the owner removes it can leave an empty, ownerless lock behind.
  const reclaimPath = `${lockPath}.reclaim`;
  const localHostname = hostname();
  const startedAt = Date.now();
  let created = false;
  let owner: { pid: number; hostname: string } | undefined;

  try {
    while (!created) {
      try {
        await mkdir(lockPath);
        created = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      // Only one waiter may verify and reclaim a dead owner at a time. A guard left
      // by a waiter that crashed mid-reclaim is never removed automatically: every
      // automatic takeover needs a guard of its own. The timeout names it instead.
      let reclaimCreated = false;
      try {
        await mkdir(reclaimPath);
        reclaimCreated = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code !== "EEXIST") throw error;
      }
      if (reclaimCreated) {
        let dead = false;
        try {
          await writeText(
            join(reclaimPath, "owner"),
            JSON.stringify({ pid: process.pid, hostname: localHostname }),
          );
          const lockOwner = await readLockOwner(lockPath, localHostname);
          owner = lockOwner.owner;
          dead = lockOwner.dead;
          if (dead) await rm(lockPath, { recursive: true, force: true });
        } finally {
          await rm(reclaimPath, { recursive: true, force: true });
        }
        if (dead) continue;
      }

      if (Date.now() - startedAt >= (options.timeoutMs ?? 10_000)) {
        const guard = reclaimCreated ? undefined : await readLockOwner(reclaimPath, localHostname);
        throw new FileLockError(targetPath, lockPath, owner, guard?.dead ? reclaimPath : undefined);
      }
      await Bun.sleep(50);
    }

    await writeText(
      join(lockPath, "owner"),
      JSON.stringify({ pid: process.pid, hostname: localHostname }),
    );
    return await fn();
  } finally {
    if (created) await rm(lockPath, { recursive: true, force: true });
  }
}

/** Missing, unreadable, or other-host ownership is not proof that the owner died. */
async function readLockOwner(
  dir: string,
  localHostname: string,
): Promise<{ owner?: { pid: number; hostname: string }; dead: boolean }> {
  let parsed: { pid?: unknown; hostname?: unknown };
  try {
    parsed = JSON.parse(await readText(join(dir, "owner")));
  } catch {
    return { dead: false };
  }
  if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return { dead: false };
  if (typeof parsed.hostname !== "string") return { dead: false };
  const owner = { pid: parsed.pid as number, hostname: parsed.hostname };
  if (owner.hostname !== localHostname) return { owner, dead: false };
  try {
    process.kill(owner.pid, 0);
    return { owner, dead: false };
  } catch (error) {
    return { owner, dead: (error as NodeJS.ErrnoException).code === "ESRCH" };
  }
}

export async function makeExecutable(path: string): Promise<void> {
  await chmod(path, 0o755);
}
export async function mode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode;
  } catch {
    return undefined;
  }
}

/** Restores owner write on a path and, for a directory, on every file and directory in it. */
export async function makeOwnerWritable(targetPath: string): Promise<void> {
  const target = await stat(targetPath);
  await chmod(targetPath, target.mode | 0o200);
  if (!target.isDirectory()) return;

  const entries = await readdir(targetPath, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const fullPath = join(entry.parentPath || targetPath, entry.name);
    const entryStat = await stat(fullPath);
    await chmod(fullPath, entryStat.mode | 0o200);
  }
}

export async function makeFileExecutable(path: string): Promise<void> {
  const fileStat = await stat(path);
  await chmod(path, fileStat.mode | 0o111);
}

/** Moves a directory to a new location on the same volume. */
export async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(join(to, ".."), { recursive: true });
  await rename(from, to);
}

/** Deletes a file, tolerating missing targets. */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function removeDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const trash = `${dirPath}-del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await rename(dirPath, trash);
      await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
      return;
    } catch {
      try {
        await rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (!existsSync(dirPath)) return;
      } catch {}
    }
    if (existsSync(dirPath)) {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    } else {
      return;
    }
  }
  if (existsSync(dirPath)) {
    throw new Error(`Failed to remove directory: ${dirPath}`);
  }
}

export async function listDirs(parentPath: string): Promise<string[]> {
  try {
    const entries = await readdir(parentPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function findFiles(
  baseDir: string,
  filter: (name: string) => boolean,
): Promise<string[]> {
  if (!existsSync(baseDir)) return [];
  try {
    const entries = await readdir(baseDir, { recursive: true, withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && filter(entry.name)) {
        const parent =
          (entry as { parentPath?: string; path?: string }).parentPath ||
          (entry as { parentPath?: string; path?: string }).path ||
          baseDir;
        results.push(join(parent, entry.name));
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function findGitWorktrees(dir: string): Promise<string[]> {
  const worktrees: string[] = [];
  if (!existsSync(dir)) return worktrees;

  async function walk(current: string) {
    try {
      const gitEntry = join(current, ".git");
      if (existsSync(gitEntry)) {
        worktrees.push(current);
        return;
      }

      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(join(current, entry.name));
        }
      }
    } catch {}
  }

  await walk(dir);
  return worktrees;
}
