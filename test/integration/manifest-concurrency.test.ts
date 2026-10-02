import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";
import * as config from "../../src/config.ts";
import * as fs from "../../src/fs.ts";
import * as manifest from "../../src/manifest.ts";
import * as paths from "../../src/paths.ts";
import * as provider from "../../src/provider.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dev-cli-manifest-lock-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function failureFrom(promise: Promise<unknown>): Promise<fs.FileLockError> {
  try {
    await promise;
  } catch (error) {
    return error as fs.FileLockError;
  }
  throw new Error("expected rejection, got resolve");
}

describe("manifest concurrent updates", () => {
  it("retains both independent mutations when each callback awaits", async () => {
    const filePath = join(root, "ws.md");
    await manifest.writeWorkspace(
      filePath,
      {
        version: 1,
        name: "sample-workspace",
        created_at: new Date(0).toISOString(),
        mounts: [],
      },
      "human notes",
    );

    await Promise.all(
      ["api", "web"].map((path) =>
        manifest.updateWorkspace(filePath, async ({ manifest: doc }) => {
          await Bun.sleep(50);
          doc.mounts.push({
            path,
            source: `https://example.org/sample-${path}.git`,
            revision: { mode: "track", branch: "main" },
          });
        }),
      ),
    );

    const saved = await manifest.readWorkspace(filePath);
    expect(saved.manifest.mounts.map((mount) => mount.path).sort()).toEqual(["api", "web"]);
    expect(saved.body).toBe("human notes");
  });

  it("retains concurrent config changes and YAML comments", async () => {
    const configPath = paths.configFilePath({ root });
    await fs.writeText(configPath, "# root settings\nsync_strategy: ff-only\n");
    await Promise.all(
      ["first", "second"].map((key) =>
        config.updateConfig(configPath, async (doc) => {
          await Bun.sleep(50);
          doc.set(key, key);
        }),
      ),
    );
    const saved = await fs.readText(configPath);
    expect(yaml.parse(saved)).toEqual({
      sync_strategy: "ff-only",
      first: "first",
      second: "second",
    });
    expect(saved).toContain("# root settings");
  });

  it("retains both concurrently added providers", async () => {
    const providerRoot = await mkdtemp(join(root, "providers-"));
    await Promise.all([
      provider.addProvider(providerRoot, { id: "first", type: "github", owner: "example-org" }),
      provider.addProvider(providerRoot, { id: "second", type: "github", owner: "sample-org" }),
    ]);
    expect((await provider.listProviders(providerRoot)).map((item) => item.id).sort()).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("file lock ownership", () => {
  it("reclaims a lock whose local owner has exited", async () => {
    const targetPath = join(root, "dead-owner.md");
    const lockPath = `${targetPath}.lock`;
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
    await mkdir(lockPath);
    await fs.writeText(
      join(lockPath, "owner"),
      JSON.stringify({ pid: child.pid, hostname: hostname() }),
    );

    await fs.writeText(targetPath, "0");
    await Promise.all(
      [1, 2].map(() =>
        fs.withFileLock(targetPath, async () => {
          const previous = Number(await fs.readText(targetPath));
          await Bun.sleep(50);
          await fs.writeText(targetPath, String(previous + 1));
        }),
      ),
    );
    expect(await fs.readText(targetPath)).toBe("2");
    expect(fs.exists(lockPath)).toBe(false);
  });

  it("times out without breaking an old lock held by a live owner", async () => {
    const targetPath = join(root, "live-owner.md");
    const lockPath = `${targetPath}.lock`;
    await fs.withFileLock(targetPath, async () => {
      await utimes(lockPath, new Date(0), new Date(0));
      const error = await failureFrom(
        fs.withFileLock(targetPath, async () => fs.writeText(targetPath, "unexpected"), {
          timeoutMs: 100,
        }),
      );
      expect(error.code).toBe("FILE_LOCKED");
      expect(error.details).toEqual({
        path: targetPath,
        lockPath,
        owner: { pid: process.pid, hostname: hostname() },
      });
      expect(error.message).toContain(lockPath);
      expect(fs.exists(lockPath)).toBe(true);
      expect(fs.exists(targetPath)).toBe(false);
    });
    expect(fs.exists(lockPath)).toBe(false);
  });

  it("recovers a reclaim guard left by a waiter that exited", async () => {
    const targetPath = join(root, "dead-reclaimer.md");
    const lockPath = `${targetPath}.lock`;
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
    const deadOwner = JSON.stringify({ pid: child.pid, hostname: hostname() });
    await mkdir(lockPath);
    await fs.writeText(join(lockPath, "owner"), deadOwner);
    await mkdir(`${lockPath}.reclaim`);
    await fs.writeText(join(`${lockPath}.reclaim`, "owner"), deadOwner);

    await fs.withFileLock(targetPath, async () => fs.writeText(targetPath, "written"), {
      timeoutMs: 2_000,
    });
    expect(await fs.readText(targetPath)).toBe("written");
    expect(fs.exists(lockPath)).toBe(false);
    expect(fs.exists(`${lockPath}.reclaim`)).toBe(false);
  });

  it("keeps a live lock when only the reclaim guard is stale", async () => {
    const targetPath = join(root, "live-owner-dead-reclaimer.md");
    const lockPath = `${targetPath}.lock`;
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
    await fs.withFileLock(targetPath, async () => {
      await mkdir(`${lockPath}.reclaim`);
      await fs.writeText(
        join(`${lockPath}.reclaim`, "owner"),
        JSON.stringify({ pid: child.pid, hostname: hostname() }),
      );
      const error = await failureFrom(
        fs.withFileLock(targetPath, async () => fs.writeText(targetPath, "unexpected"), {
          timeoutMs: 300,
        }),
      );
      expect(error.code).toBe("FILE_LOCKED");
      expect(fs.exists(lockPath)).toBe(true);
      expect(fs.exists(targetPath)).toBe(false);
    });
  });
});
