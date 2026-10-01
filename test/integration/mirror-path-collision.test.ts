import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as mirror from "../../src/mirror.ts";

async function failureFrom(
  p: Promise<unknown>,
): Promise<Error & { code?: string; details?: Record<string, unknown> }> {
  try {
    await p;
  } catch (error) {
    return error as Error & { code?: string; details?: Record<string, unknown> };
  }
  throw new Error("expected rejection, got resolve");
}

describe("mirror sibling path collisions", () => {
  let tempRoot: string;
  let seedDir: string;
  let barePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-mirror-collision-"));
    seedDir = join(tempRoot, "seed");
    barePath = join(tempRoot, "sample-api.git");
    await mkdir(seedDir);
    await mkdir(barePath);
    await git.runGit(["init", "--bare", "-b", "main"], { cwd: barePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.org"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "base.txt"), "base");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "base"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", barePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/a"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "slash.txt"), "slash");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "slash branch"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/a"], { cwd: seedDir });

    await git.runGit(["checkout", "main"], { cwd: seedDir });
    await git.runGit(["checkout", "-b", "feature-a"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "hyphen.txt"), "hyphen");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "hyphen branch"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature-a"], { cwd: seedDir });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("refuses to reuse a sibling path owned by another branch", async () => {
    const root = join(tempRoot, "reuse");
    const first = await mirror.ensure({ root, source: barePath, branch: "feature/a" });
    expect(first.branch).toBe("feature/a");
    expect((await git.inspectWorktree(first.path)).currentRevision.branch).toBe("feature/a");

    const error = await failureFrom(mirror.track({ root, source: barePath, branch: "feature-a" }));
    expect(error.code).toBe("MIRROR_PATH_COLLISION");
    expect(error.message).toContain("feature/a");
    expect(error.message).toContain("feature-a");
    expect(error.details).toEqual({
      path: first.path,
      existingBranch: "feature/a",
      requestedBranch: "feature-a",
    });
    expect(fs.exists(first.path)).toBe(true);
    const observed = await git.inspectWorktree(first.path);
    expect(observed.currentRevision.branch).toBe("feature/a");
    expect(observed.currentRevision.commitSha).toBe(first.commitSha);
    expect(await fs.readText(join(first.path, "slash.txt"))).toBe("slash");
  });

  it("refuses to add a sibling at a path owned by another branch", async () => {
    const root = join(tempRoot, "add");
    const first = await mirror.ensure({ root, source: barePath, branch: "feature/a" });

    const error = await failureFrom(mirror.ensure({ root, source: barePath, branch: "feature-a" }));
    expect(error.code).toBe("MIRROR_PATH_COLLISION");
    expect(error.message).toContain("feature/a");
    expect(error.message).toContain("feature-a");
    expect(error.details).toEqual({
      path: first.path,
      existingBranch: "feature/a",
      requestedBranch: "feature-a",
    });
    expect(fs.exists(first.path)).toBe(true);
    const observed = await git.inspectWorktree(first.path);
    expect(observed.currentRevision.branch).toBe("feature/a");
    expect(observed.currentRevision.commitSha).toBe(first.commitSha);
    expect(await fs.readText(join(first.path, "slash.txt"))).toBe("slash");
  });

  it("refuses to remove a sibling path owned by another branch even with force", async () => {
    const root = join(tempRoot, "remove");
    const first = await mirror.ensure({ root, source: barePath, branch: "feature/a" });

    for (const force of [false, true]) {
      const error = await failureFrom(
        mirror.untrack({ root, source: barePath, branch: "feature-a", force }),
      );
      expect(error.code).toBe("MIRROR_PATH_COLLISION");
      expect(error.message).toContain("feature/a");
      expect(error.message).toContain("feature-a");
      expect(error.details).toEqual({
        path: first.path,
        existingBranch: "feature/a",
        requestedBranch: "feature-a",
      });
      expect(fs.exists(first.path)).toBe(true);
      const observed = await git.inspectWorktree(first.path);
      expect(observed.currentRevision.branch).toBe("feature/a");
      expect(observed.currentRevision.commitSha).toBe(first.commitSha);
      expect(await fs.readText(join(first.path, "slash.txt"))).toBe("slash");
    }
  });
});
