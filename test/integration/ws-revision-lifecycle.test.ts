import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

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
});
