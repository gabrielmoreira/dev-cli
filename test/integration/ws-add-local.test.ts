import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";
import { gitPoolPath, workspaceAdminRepoPath } from "../../src/paths.ts";

describe("Workspace add local Git integration (Phase 2)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-ws-add-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-bare-remote-"));

    // 1. Initialize bare remote
    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });

    // 2. Commit and push from seed repository
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello from local git");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/v1"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "v1.txt"), "v1 feature");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: add v1 file"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/v1"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
    await rm(bareRemotePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => {});
  });

  it("mounts a local repository into a workspace preserving the central topology", async () => {
    // 1. Init workspace
    await ws.init({ root: tempRoot, name: "payment-task" });

    // 2. Add mount
    const addResult = await ws.add({
      root: tempRoot,
      workspaceName: "payment-task",
      source: bareRemotePath,
      branch: "main",
    });

    expect(addResult.workspaceName).toBe("payment-task");
    expect(addResult.mountName).toBe(git.deriveDefaultMountPath(bareRemotePath));
    expect(addResult.revision.mode).toBe("track");
    expect(addResult.mirrorReused).toBe(false);

    // Verify 4 locations:
    // A. Central mirror
    const mirrorPath = gitPoolPath({ root: tempRoot, source: bareRemotePath });
    expect(fs.exists(mirrorPath)).toBe(true);

    // B. Workspace admin bare repo
    const adminRepoPath = workspaceAdminRepoPath({
      root: tempRoot,
      workspaceName: "payment-task",
      sourceKey: addResult.sourceKey,
    });
    expect(fs.exists(adminRepoPath)).toBe(true);

    // C. Mount directory
    expect(fs.exists(addResult.mountPath)).toBe(true);
    expect(fs.exists(join(addResult.mountPath, "file.txt"))).toBe(true);

    // D. Manifest ws.md
    const manifestPath = join(tempRoot, "ws", "payment-task", "ws.md");
    const { manifest: readManifest } = await manifest.readWorkspace(manifestPath);
    expect(readManifest.mounts.length).toBe(1);
    expect(readManifest.mounts[0].path).toBe(addResult.mountName);
    expect(readManifest.mounts[0].source).toBe(bareRemotePath);
    expect(readManifest.mounts[0].revision).toEqual({ mode: "track", branch: "main" });
  });

  it("allows multiple independent mounts from the same repository with distinct branches", async () => {
    const addResult = await ws.add({
      root: tempRoot,
      workspaceName: "payment-task",
      source: bareRemotePath,
      path: "v1-mount",
      branch: "feature/v1",
    });

    expect(addResult.mountName).toBe("v1-mount");
    expect(addResult.mirrorReused).toBe(true);
    expect(fs.exists(addResult.mountPath)).toBe(true);
    expect(fs.exists(join(addResult.mountPath, "v1.txt"))).toBe(true);

    const manifestPath = join(tempRoot, "ws", "payment-task", "ws.md");
    const { manifest: readManifest } = await manifest.readWorkspace(manifestPath);
    expect(readManifest.mounts.length).toBe(2);
    expect(readManifest.mounts.some((m) => m.path === "v1-mount")).toBe(true);
  });

  async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
    } catch (error) {
      return (error as ws.WorkspaceError).code;
    }
    return undefined;
  }

  it("reports the same mount requested twice as already mounted", async () => {
    await ws.init({ root: tempRoot, name: "twice" });
    const request = {
      root: tempRoot,
      workspaceName: "twice",
      source: bareRemotePath,
      branch: "main",
    };

    const first = await ws.add(request);
    const second = await ws.add(request);

    expect(first.outcome).toBe("mounted");
    expect(second.outcome).toBe("already_mounted");
    expect(second.mountPath).toBe(first.mountPath);
    expect(second.commitSha).toBe(first.commitSha);
    const { manifest: read } = await manifest.readWorkspace(join(tempRoot, "ws", "twice", "ws.md"));
    expect(read.mounts.length).toBe(1);
  });

  it("refuses a declared path requested with a different branch", async () => {
    const code = await codeOf(() =>
      ws.add({
        root: tempRoot,
        workspaceName: "twice",
        source: bareRemotePath,
        branch: "feature/v1",
      }),
    );
    expect(code).toBe("MOUNT_ALREADY_EXISTS");
  });

  it("adopts the worktree an interrupted add left behind", async () => {
    await ws.init({ root: tempRoot, name: "interrupted" });
    const manifestPath = join(tempRoot, "ws", "interrupted", "ws.md");
    const request = {
      root: tempRoot,
      workspaceName: "interrupted",
      source: bareRemotePath,
      branch: "feature/v1",
    };
    const first = await ws.add(request);
    // The process died after the worktree existed and before ws.md mentioned it.
    const { manifest: declared, body } = await manifest.readWorkspace(manifestPath);
    await manifest.writeWorkspace(manifestPath, { ...declared, mounts: [] }, body);

    const retry = await ws.add(request);

    expect(retry.outcome).toBe("adopted");
    expect(retry.commitSha).toBe(first.commitSha);
    const { manifest: read } = await manifest.readWorkspace(manifestPath);
    expect(read.mounts).toEqual([
      {
        path: first.mountName,
        source: bareRemotePath,
        revision: { mode: "track", branch: "feature/v1" },
      },
    ]);
  });

  it("refuses to adopt a directory that is not this workspace's checkout", async () => {
    await ws.init({ root: tempRoot, name: "foreign" });
    const mountName = git.deriveDefaultMountPath(bareRemotePath);
    await fs.writeText(join(tempRoot, "ws", "foreign", mountName, "notes.txt"), "mine");

    const code = await codeOf(() =>
      ws.add({ root: tempRoot, workspaceName: "foreign", source: bareRemotePath, branch: "main" }),
    );

    expect(code).toBe("MOUNT_PATH_EXISTS_ON_DISK");
    expect(await fs.readText(join(tempRoot, "ws", "foreign", mountName, "notes.txt"))).toBe("mine");
  });

  it("refuses a plain clone sitting at the mount path", async () => {
    await ws.init({ root: tempRoot, name: "cloned" });
    const mountName = git.deriveDefaultMountPath(bareRemotePath);
    await git.runGit(["clone", "-q", bareRemotePath, join(tempRoot, "ws", "cloned", mountName)]);

    const code = await codeOf(() =>
      ws.add({ root: tempRoot, workspaceName: "cloned", source: bareRemotePath, branch: "main" }),
    );

    expect(code).toBe("MOUNT_PATH_EXISTS_ON_DISK");
  });

  it("does not call a declared mount switched to another branch already mounted", async () => {
    await ws.init({ root: tempRoot, name: "switched" });
    const request = {
      root: tempRoot,
      workspaceName: "switched",
      source: bareRemotePath,
      branch: "main",
    };
    const first = await ws.add(request);
    await git.runGit(["checkout", "-q", "-b", "elsewhere"], { cwd: first.mountPath });

    const code = await codeOf(() => ws.add(request));

    expect(code).toBe("MOUNT_ALREADY_EXISTS");
  });
});
