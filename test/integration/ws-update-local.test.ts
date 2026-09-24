import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

describe("Local workspace safe update integration (Phase 5)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-update-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    // Seed bare remote with initial branches
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-update-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "Seed Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "seed@example.com"], { cwd: seedDir });

    // 1. main branch
    await fs.writeText(join(seedDir, "README.md"), "# Initial Root");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial root commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    // 2. feature/dirty branch
    await git.runGit(["checkout", "-b", "feature/dirty"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "dirty.txt"), "dirty base");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: dirty base"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/dirty"], { cwd: seedDir });

    // 3. feature/ahead branch
    await git.runGit(["checkout", "-b", "feature/ahead"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "ahead.txt"), "ahead base");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: ahead base"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/ahead"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("updates safe mounts via fast-forward while preserving dirty and ahead mounts intact", async () => {
    // 1. Init workspace and add the 3 mounts
    await ws.init({ root: tempRoot, name: "my-update-ws" });

    await ws.add({
      root: tempRoot,
      workspaceName: "my-update-ws",
      source: bareRemotePath,
      path: "mount-clean",
      branch: "main",
    });

    await ws.add({
      root: tempRoot,
      workspaceName: "my-update-ws",
      source: bareRemotePath,
      path: "mount-dirty",
      branch: "feature/dirty",
    });

    await ws.add({
      root: tempRoot,
      workspaceName: "my-update-ws",
      source: bareRemotePath,
      path: "mount-ahead",
      branch: "feature/ahead",
    });

    // 2. Advance remote main branch via a seed clone
    const advancerDir = await mkdtemp(join(tmpdir(), "dev-cli-advancer-"));
    try {
      await git.runGit(["clone", bareRemotePath, advancerDir]);
      await git.runGit(["config", "user.name", "Advancer"], { cwd: advancerDir });
      await git.runGit(["config", "user.email", "advancer@example.com"], { cwd: advancerDir });
      await fs.writeText(join(advancerDir, "advanced.txt"), "advanced content");
      await git.runGit(["add", "."], { cwd: advancerDir });
      await git.runGit(["commit", "-m", "feat: advance main upstream"], { cwd: advancerDir });
      await git.runGit(["push", "origin", "main"], { cwd: advancerDir });
    } finally {
      await rm(advancerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
    }

    // 3. Make mount-dirty dirty with an untracked modified file
    const dirtyFilePath = join(tempRoot, "ws", "my-update-ws", "mount-dirty", "dirty.txt");
    await fs.writeText(dirtyFilePath, "modified uncommitted changes");

    // 4. Make mount-ahead have a local ahead commit
    const aheadMountPath = join(tempRoot, "ws", "my-update-ws", "mount-ahead");
    await git.runGit(["config", "user.name", "Ahead User"], { cwd: aheadMountPath });
    await git.runGit(["config", "user.email", "ahead@example.com"], { cwd: aheadMountPath });
    await fs.writeText(join(aheadMountPath, "local-work.txt"), "local commit work");
    await git.runGit(["add", "."], { cwd: aheadMountPath });
    await git.runGit(["commit", "-m", "feat: local unpushed commit"], { cwd: aheadMountPath });

    // 5. Execute ws.update with refresh
    const result = await ws.update({
      root: tempRoot,
      workspaceName: "my-update-ws",
      refresh: true,
    });

    expect(result.summary.total).toBe(3);
    expect(result.summary.updated).toBe(1);
    expect(result.summary.skipped).toBe(2);

    const cleanResult = result.mounts.find((m) => m.path === "mount-clean");
    expect(cleanResult?.action).toBe("fast_forward");
    expect(cleanResult?.newCommit).not.toBe(cleanResult?.previousCommit);

    // Verify advanced.txt was checked out in mount-clean
    const cleanAdvancedFile = join(tempRoot, "ws", "my-update-ws", "mount-clean", "advanced.txt");
    expect(fs.exists(cleanAdvancedFile)).toBe(true);

    const dirtyResult = result.mounts.find((m) => m.path === "mount-dirty");
    expect(dirtyResult?.action).toBe("skipped");
    expect(dirtyResult?.reason).toBe("dirty_worktree");

    // Verify uncommitted dirty changes were preserved intact!
    expect(await fs.readText(dirtyFilePath)).toBe("modified uncommitted changes");

    const aheadResult = result.mounts.find((m) => m.path === "mount-ahead");
    expect(aheadResult?.action).toBe("skipped");
    expect(aheadResult?.reason).toBe("ahead_commits");

    // Verify local unpushed commit is still on HEAD of mount-ahead!
    const aheadRev = await git.inspectWorktree(aheadMountPath);
    expect(aheadRev.aheadCount).toBe(1);
  });

  it("creates a missing mount and restores a wrong branch, then has nothing left to do", async () => {
    await ws.init({ root: tempRoot, name: "converge" });
    const onMain = await ws.add({
      root: tempRoot,
      workspaceName: "converge",
      source: bareRemotePath,
      path: "on-main",
      branch: "main",
    });
    const removed = await ws.add({
      root: tempRoot,
      workspaceName: "converge",
      source: bareRemotePath,
      path: "removed",
      branch: "feature/dirty",
    });
    await git.runGit(["checkout", "-q", "-b", "stray"], { cwd: onMain.mountPath });
    await rm(removed.mountPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    const preview = await ws.update({ root: tempRoot, workspaceName: "converge", dryRun: true });
    expect(preview.mounts.map((m) => [m.path, m.action])).toEqual([
      ["on-main", "checkout"],
      ["removed", "create"],
    ]);
    expect((await git.inspectWorktree(onMain.mountPath)).currentRevision.branch).toBe("stray");
    expect(fs.exists(removed.mountPath)).toBe(false);

    const first = await ws.update({ root: tempRoot, workspaceName: "converge" });
    const second = await ws.update({ root: tempRoot, workspaceName: "converge" });

    expect(first.mounts.map((m) => [m.path, m.action])).toEqual([
      ["on-main", "checkout"],
      ["removed", "create"],
    ]);
    expect((await git.inspectWorktree(onMain.mountPath)).currentRevision.branch).toBe("main");
    expect((await git.inspectWorktree(removed.mountPath)).currentRevision.branch).toBe(
      "feature/dirty",
    );
    expect(second.mounts.map((m) => m.action)).toEqual(["up_to_date", "up_to_date"]);
  });

  it("leaves a detached mount with its own commits where it is", async () => {
    await ws.init({ root: tempRoot, name: "detached-work" });
    const main = await git.runGit(["rev-parse", "main"], { cwd: bareRemotePath });
    const locked = await ws.add({
      root: tempRoot,
      workspaceName: "detached-work",
      source: bareRemotePath,
      path: "locked",
      commit: main.stdout.trim(),
    });
    await git.runGit(
      [
        "-c",
        "user.name=a",
        "-c",
        "user.email=a@b",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "local work",
      ],
      { cwd: locked.mountPath },
    );
    const localHead = (await git.currentRevision(locked.mountPath)).commitSha;

    const result = await ws.update({ root: tempRoot, workspaceName: "detached-work" });

    expect(result.mounts.map((m) => [m.action, m.reason])).toEqual([["skipped", "ahead_commits"]]);
    expect((await git.currentRevision(locked.mountPath)).commitSha).toBe(localHead);
  });
});
