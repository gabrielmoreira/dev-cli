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
    expect(fs.exists(addResult.mountPath)).toBe(true);
    expect(fs.exists(join(addResult.mountPath, "v1.txt"))).toBe(true);

    const manifestPath = join(tempRoot, "ws", "payment-task", "ws.md");
    const { manifest: readManifest } = await manifest.readWorkspace(manifestPath);
    expect(readManifest.mounts.length).toBe(2);
    expect(readManifest.mounts.some((m) => m.path === "v1-mount")).toBe(true);
  });
});
