import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

async function failureFrom(promise: Promise<unknown>): Promise<ws.WorkspaceError> {
  try {
    await promise;
  } catch (error) {
    return error as ws.WorkspaceError;
  }
  throw new Error("expected rejection, got resolve");
}

describe("Workspace revision lifecycle & reconciliation integration (Phase 6)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-rev-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-rev-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "Rev Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "rev@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "rev content");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit for rev lifecycle"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    // Create a tag
    await git.runGit(["tag", "v1.0.0"], { cwd: seedDir });
    await git.runGit(["push", "origin", "v1.0.0"], { cwd: seedDir });

    // Create a secondary branch
    await git.runGit(["checkout", "-b", "feature/lifecycle"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "feature.txt"), "feature content");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: feature branch commit"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/lifecycle"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("handles full revision lifecycle (track, lock, unlock, tag, up, remove)", async () => {
    // 1. Initialize workspace and add mount tracking main
    await ws.init({ root: tempRoot, name: "rev-ws" });
    await ws.add({
      root: tempRoot,
      workspaceName: "rev-ws",
      source: bareRemotePath,
      path: "core-repo",
      branch: "main",
    });

    const manifestPath = join(tempRoot, "ws", "rev-ws", "ws.md");
    let manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).toContain("branch: main");

    // 2. Lock to current commit
    const lockRes = await ws.lock({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
    });
    expect(lockRes.lockedMounts).toHaveLength(1);
    expect(lockRes.lockedMounts[0].commit).toBeDefined();

    manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).toContain("mode: lock");
    expect(manifestData).toContain(lockRes.lockedMounts[0].commit);

    const beforeLockNoop = await stat(manifestPath, { bigint: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const lockAgain = await ws.lock({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
    });
    expect(lockAgain.changed).toBe(false);
    expect(lockAgain.lockedMounts[0]?.commit).toBe(lockRes.lockedMounts[0]?.commit);
    expect(lockAgain.healWarnings).toEqual(lockRes.healWarnings);
    expect((await stat(manifestPath, { bigint: true })).mtimeNs).toBe(beforeLockNoop.mtimeNs);

    // 3. Unlock back to branch feature/lifecycle
    const unlockRes = await ws.unlock({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
      branch: "feature/lifecycle",
    });
    expect(unlockRes.unlockedMounts).toHaveLength(1);
    expect(unlockRes.unlockedMounts[0].branch).toBe("feature/lifecycle");

    manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).toContain("mode: track");
    expect(manifestData).toContain("branch: feature/lifecycle");

    const worktreePath = join(tempRoot, "ws", "rev-ws", "core-repo");
    const inspected = await git.inspectWorktree(worktreePath);
    expect(inspected.currentRevision.branch).toBe("feature/lifecycle");

    const beforeUnlockNoop = await stat(manifestPath, { bigint: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const unlockAgain = await ws.unlock({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
      branch: "feature/lifecycle",
    });
    expect(unlockAgain.changed).toBe(false);
    expect(unlockAgain.unlockedMounts[0]?.branch).toBe("feature/lifecycle");
    expect(unlockAgain.healWarnings).toEqual(unlockRes.healWarnings);
    expect((await stat(manifestPath, { bigint: true })).mtimeNs).toBe(beforeUnlockNoop.mtimeNs);

    const unlockInferred = await ws.unlock({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
    });
    expect(unlockInferred.changed).toBe(false);
    expect(unlockInferred.unlockedMounts[0]?.branch).toBe("feature/lifecycle");
    expect((await stat(manifestPath, { bigint: true })).mtimeNs).toBe(beforeUnlockNoop.mtimeNs);

    // 4. Pin to tag v1.0.0
    const tagRes = await ws.tag({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
      tag: "v1.0.0",
    });
    expect(tagRes.tag).toBe("v1.0.0");

    manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).toContain("mode: tag");
    expect(manifestData).toContain("tag: v1.0.0");

    const beforeTagNoop = await stat(manifestPath, { bigint: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const tagAgain = await ws.tag({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
      tag: "v1.0.0",
    });
    expect(tagAgain.changed).toBe(false);
    expect(tagAgain.tag).toBe("v1.0.0");
    expect(tagAgain.path).toBe(tagRes.path);
    expect(tagAgain.healWarnings).toEqual(tagRes.healWarnings);
    expect((await stat(manifestPath, { bigint: true })).mtimeNs).toBe(beforeTagNoop.mtimeNs);

    // 5. Track branch main again
    await ws.track({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
      branch: "main",
    });
    manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).toContain("branch: main");

    // 6. Delete worktree from disk and prove ws sync recreates it
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(fs.exists(worktreePath)).toBe(false);

    const synced = await ws.update({
      root: tempRoot,
      workspaceName: "rev-ws",
    });
    expect(synced.mounts.map((m) => m.action)).toEqual(["create"]);
    expect(fs.exists(worktreePath)).toBe(true);

    // 7. Test unsafe remove rejection: make dirty and try to remove
    const dirtyFile = join(worktreePath, "dirty.txt");
    await fs.writeText(dirtyFile, "uncommitted changes");

    await expect(
      ws.remove({
        root: tempRoot,
        workspaceName: "rev-ws",
        mountPath: "core-repo",
      }),
    ).rejects.toThrow(/uncommitted changes/);

    expect(fs.exists(worktreePath)).toBe(true);
    manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).toContain("core-repo");

    // 8. Force remove
    const rmRes = await ws.remove({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
      force: true,
    });
    expect(rmRes.removed).toBe(true);
    expect(fs.exists(worktreePath)).toBe(false);

    manifestData = await Bun.file(manifestPath).text();
    expect(manifestData).not.toContain("core-repo");

    // 9. Removing it again reports that nothing is mounted, and changes nothing
    const again = await ws.remove({
      root: tempRoot,
      workspaceName: "rev-ws",
      mountPath: "core-repo",
    });
    expect(again).toEqual({ path: "core-repo", removed: false, healWarnings: [] });
    expect(await Bun.file(manifestPath).text()).toBe(manifestData);
  });

  it("preserves user stashes and reports autostash backups and restore conflicts", async () => {
    const workspaceName = "stash-safety";
    await ws.init({ root: tempRoot, name: workspaceName });
    await ws.add({
      root: tempRoot,
      workspaceName,
      source: bareRemotePath,
      path: "core",
      branch: "main",
    });
    const mountPath = join(tempRoot, "ws", workspaceName, "core");
    const advance = await mkdtemp(join(tmpdir(), "sample-project-stash-advance-"));
    try {
      await git.runGit(["clone", bareRemotePath, advance]);
      await git.runGit(["config", "user.name", "user"], { cwd: advance });
      await git.runGit(["config", "user.email", "user@example.org"], { cwd: advance });

      await fs.writeText(join(mountPath, "user.txt"), "user stash");
      await git.runGit(["stash", "push", "--include-untracked", "-m", "pre-existing user stash"], {
        cwd: mountPath,
      });
      const userStash = (await git.runGit(["rev-parse", "refs/stash"], { cwd: mountPath })).stdout;

      await fs.writeText(join(advance, "remote-one.txt"), "first remote commit");
      await git.runGit(["add", "remote-one.txt"], { cwd: advance });
      await git.runGit(["commit", "-m", "advance remote once"], { cwd: advance });
      await git.runGit(["push", "origin", "main"], { cwd: advance });
      await git.runGit(["-C", mountPath, "fetch", "origin"]);

      await git.stashFastForward({
        worktreePath: mountPath,
        targetRef: "refs/remotes/origin/main",
        stashName: "dev autostash sample-workspace/core clean-case",
      });
      const afterClean = await git.runGit(["stash", "list", "--format=%H"], { cwd: mountPath });
      expect(afterClean.stdout.split(/\r?\n/)).toEqual([userStash]);
      expect(fs.exists(join(mountPath, "user.txt"))).toBe(false);
      expect(await fs.readText(join(mountPath, "remote-one.txt"))).toBe("first remote commit");

      await fs.writeText(join(mountPath, "notes.txt"), "local notes");
      await fs.writeText(join(advance, "remote-two.txt"), "second remote commit");
      await git.runGit(["add", "remote-two.txt"], { cwd: advance });
      await git.runGit(["commit", "-m", "advance remote twice"], { cwd: advance });
      await git.runGit(["push", "origin", "main"], { cwd: advance });

      const result = await ws.update({ root: tempRoot, workspaceName, autostash: true });
      const mount = result.mounts.find((item) => item.path === "core");
      expect(mount?.action).toBe("fast_forward");
      expect(mount?.stash?.stashName).toStartWith(`dev autostash ${workspaceName}/core `);
      expect(mount?.stash?.stashSha).toMatch(/^[a-f0-9]{40}$/);
      expect(mount?.stash?.recovery).toBe(`git stash apply ${mount?.stash?.stashSha}`);
      expect(mount?.warning).toBeUndefined();
      expect(await fs.readText(join(mountPath, "notes.txt"))).toBe("local notes");
      expect(await fs.readText(join(mountPath, "remote-two.txt"))).toBe("second remote commit");
      const afterRestored = await git.runGit(["stash", "list", "--format=%H"], { cwd: mountPath });
      expect(afterRestored.stdout.split(/\r?\n/)).toEqual([mount!.stash!.stashSha, userStash]);

      await fs.writeText(join(mountPath, "collision.txt"), "local version");
      await fs.writeText(join(advance, "collision.txt"), "remote version");
      await git.runGit(["add", "collision.txt"], { cwd: advance });
      await git.runGit(["commit", "-m", "advance conflicting file"], { cwd: advance });
      await git.runGit(["push", "origin", "main"], { cwd: advance });

      const error = await failureFrom(
        ws.update({ root: tempRoot, workspaceName, autostash: true }),
      );
      expect(error).toBeInstanceOf(ws.WorkspaceError);
      expect(error.code).toBe("STASH_RESTORE_FAILED");
      expect(error.details).toEqual({
        path: mountPath,
        stash: expect.stringContaining(`dev autostash ${workspaceName}/core `),
        sha: expect.stringMatching(/^[a-f0-9]{40}$/),
        recovery: `git stash apply ${error.details?.sha}`,
      });
      const kept = await git.runGit(["stash", "list", "--format=%H"], { cwd: mountPath });
      expect(kept.stdout.split(/\r?\n/)).toEqual([
        error.details?.sha as string,
        mount!.stash!.stashSha,
        userStash,
      ]);
      expect(await fs.readText(join(mountPath, "collision.txt"))).toBe("remote version");
    } finally {
      await rm(advance, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
