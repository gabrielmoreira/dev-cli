import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
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

export async function makeFilesOwnerWritable(targetPath: string): Promise<void> {
  const target = await stat(targetPath);
  if (!target.isDirectory()) {
    await chmod(targetPath, target.mode | 0o200);
    return;
  }

  const entries = await readdir(targetPath, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
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
