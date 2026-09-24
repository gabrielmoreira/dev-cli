import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText, writeTextAtomic } from "../../src/fs.ts";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dev-cli-fs-atomic-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

describe("fs.writeTextAtomic", () => {
  test("replaces existing content and leaves no temporary file behind", async () => {
    const dir = await scratch();
    const target = join(dir, "ws.md");

    await writeTextAtomic(target, "first");
    await writeTextAtomic(target, "second");

    expect(await readText(target)).toBe("second");
    expect(await readdir(dir)).toEqual(["ws.md"]);
  });

  test("creates the parent directory when it does not exist", async () => {
    const dir = await scratch();
    const target = join(dir, "nested", "deeper", "ws.md");

    await writeTextAtomic(target, "content");

    expect(await readText(target)).toBe("content");
  });
});
