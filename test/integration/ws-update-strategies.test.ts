import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

describe("Workspace update ergonomic strategies (Phase 2.6)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-strategy-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", "-b", "main", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-strategy-seed-"));
    await git.runGit(["init", "-b", "main", seedDir]);
    await git.runGit(["config", "user.name", "Seed Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "seed@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "app.txt"), "line one\n");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  /** Advances the remote main by one commit writing the given content. */
  async function advanceRemote(fileName: string, content: string): Promise<void> {
    const advancerDir = await mkdtemp(join(tmpdir(), "dev-cli-strategy-adv-"));
    await git.runGit(["clone", "-q", bareRemotePath, advancerDir]);
    await git.runGit(["config", "user.name", "Advancer"], { cwd: advancerDir });
    await git.runGit(["config", "user.email", "advancer@example.com"], { cwd: advancerDir });
    await fs.writeText(join(advancerDir, fileName), content);
    await git.runGit(["add", "."], { cwd: advancerDir });
    await git.runGit(["commit", "-m", `feat: advance ${fileName}`], { cwd: advancerDir });
    await git.runGit(["push", "-q", "origin", "main"], { cwd: advancerDir });
    await rm(advancerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  }

  async function newWorkspace(name: string): Promise<string> {
    await ws.init({ root: tempRoot, name });
    const added = await ws.add({
      root: tempRoot,
      workspaceName: name,
      source: bareRemotePath,
      branch: "main",
    });
    return added.mountName;
  }

  it("autostashes uncommitted changes across a fast-forward", async () => {
    const mountName = await newWorkspace("stash-clean");
    const mountPath = join(tempRoot, "ws", "stash-clean", mountName);

    // Dirty the mount, then advance the remote behind its back.
    await fs.writeText(join(mountPath, "notes.txt"), "local notes");
    await advanceRemote("app.txt", "line one\nline two\n");

    const result = await ws.update({
      root: tempRoot,
      workspaceName: "stash-clean",
      autostash: true,
      refresh: true,
    });

    const mount = result.mounts.find((m) => m.path === mountName);
    expect(mount?.action).toBe("fast_forward");
    expect(mount?.warning).toBeUndefined();
    // Remote change applied AND local uncommitted file preserved.
    expect(await fs.readText(join(mountPath, "app.txt"))).toContain("line two");
    expect(await fs.readText(join(mountPath, "notes.txt"))).toBe("local notes");
  });

  it("keeps the stash entry safe when autostash pop conflicts", async () => {
    const mountName = await newWorkspace("stash-conflict");
    const mountPath = join(tempRoot, "ws", "stash-conflict", mountName);

    // Same file, same line: remote advance and local edit are guaranteed to conflict.
    await advanceRemote("app.txt", "remote version\n");
    await fs.writeText(join(mountPath, "app.txt"), "local version\n");

    const result = await ws.update({
      root: tempRoot,
      workspaceName: "stash-conflict",
      autostash: true,
      refresh: true,
    });

    const mount = result.mounts.find((m) => m.path === mountName);
    expect(mount?.action).toBe("fast_forward");
    expect(mount?.warning).toContain("stash");
    // Pop conflicted: the file carries conflict markers; HEAD is at the
    // remote tip and the stash entry survives for manual recovery.
    expect(await fs.readText(join(mountPath, "app.txt"))).toContain("<<<<<<<");
    const stashList = await git.runGit(["-C", mountPath, "stash", "list"]);
    expect(stashList.stdout).toContain("dev autostash");
  });

  it("rebases diverged mounts onto the remote branch", async () => {
    const mountName = await newWorkspace("rebase-clean");
    const mountPath = join(tempRoot, "ws", "rebase-clean", mountName);

    // Make the mount diverged: one local commit, one remote commit.
    await advanceRemote("remote-file.txt", "from remote\n");
    await fs.writeText(join(mountPath, "local-file.txt"), "from local\n");
    await git.runGit(["config", "user.name", "Local Dev"], { cwd: mountPath });
    await git.runGit(["config", "user.email", "local@example.com"], { cwd: mountPath });
    await git.runGit(["add", "."], { cwd: mountPath });
    await git.runGit(["commit", "-m", "feat: local work"], { cwd: mountPath });

    const result = await ws.update({
      root: tempRoot,
      workspaceName: "rebase-clean",
      rebase: true,
      refresh: true,
    });

    const mount = result.mounts.find((m) => m.path === mountName);
    expect(mount?.action).toBe("rebase");
    expect(await fs.readText(join(mountPath, "remote-file.txt"))).toContain("from remote");
    expect(await fs.readText(join(mountPath, "local-file.txt"))).toContain("from local");

    // The local commit is preserved on top of the remote tip.
    const log = await git.runGit(["-C", mountPath, "log", "--oneline", "-2"]);
    expect(log.stdout).toContain("feat: local work");
  });

  it("aborts conflicting rebases atomically and reports the conflict", async () => {
    const mountName = await newWorkspace("rebase-conflict");
    const mountPath = join(tempRoot, "ws", "rebase-conflict", mountName);

    // Both sides change the same line of the same file.
    await advanceRemote("app.txt", "remote version v2\n");
    await fs.writeText(join(mountPath, "app.txt"), "local version\n");
    await git.runGit(["config", "user.name", "Local Dev"], { cwd: mountPath });
    await git.runGit(["config", "user.email", "local@example.com"], { cwd: mountPath });
    await git.runGit(["add", "."], { cwd: mountPath });
    await git.runGit(["commit", "-m", "feat: conflicting local change"], { cwd: mountPath });

    const beforeCommit = (await git.runGit(["-C", mountPath, "rev-parse", "HEAD"])).stdout.trim();

    const result = await ws.update({
      root: tempRoot,
      workspaceName: "rebase-conflict",
      rebase: true,
      refresh: true,
    });

    const mount = result.mounts.find((m) => m.path === mountName);
    expect(mount?.action).toBe("skipped");
    expect(mount?.reason).toBe("rebase_conflict");
    expect(mount?.warning).toContain("app.txt");

    // Atomic rollback: same commit, clean worktree, no rebase in progress.
    const afterCommit = (await git.runGit(["-C", mountPath, "rev-parse", "HEAD"])).stdout.trim();
    expect(afterCommit).toBe(beforeCommit);
    const status = await git.runGit(["-C", mountPath, "status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
    const rebaseDir = await git.runGit([
      "-C",
      mountPath,
      "rev-parse",
      "--git-path",
      "rebase-merge",
    ]);
    expect(fs.exists(rebaseDir.stdout.trim())).toBe(false);
  });
});
