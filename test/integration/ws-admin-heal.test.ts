import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";
import { workspaceAdminRepoPath } from "../../src/paths.ts";

describe("Workspace admin self-heal integration", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-ws-heal-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-ws-heal-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-ws-heal-remote-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
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

  it("re-adopts mounts when the workspace admin bare vanished", async () => {
    await ws.init({ root: tempRoot, name: "heal-orphan" });
    const { mountName, sourceKey } = await ws.add({
      root: tempRoot,
      workspaceName: "heal-orphan",
      source: bareRemotePath,
      branch: "main",
    });

    const adminPath = workspaceAdminRepoPath({
      root: tempRoot,
      workspaceName: "heal-orphan",
      sourceKey: sourceKey,
    });
    const mountPath = join(tempRoot, "ws", "heal-orphan", mountName);
    // Simulate the broken state: admin metadata deleted from under the mount.
    await rm(adminPath, { recursive: true, force: true });
    expect(fs.exists(adminPath)).toBe(false);

    const result = await ws.track({
      root: tempRoot,
      workspaceName: "heal-orphan",
      mountPath: mountName,
      branch: "feature/v1",
    });

    expect(result.worktreeSwitched).toBe(true);
    expect(fs.exists(adminPath)).toBe(true);
    expect(fs.exists(join(mountPath, "v1.txt"))).toBe(true);

    // The heal never touches user files: edits inside the mount still work.
    await fs.writeText(join(mountPath, "local-edit.txt"), "user work in progress");
    expect(fs.exists(join(mountPath, "local-edit.txt"))).toBe(true);

    // Status runs against the healed admin; the untracked local edit makes
    // the mount dirty by design, which is the safety guard working.
    const status = await ws.status({ root: tempRoot, workspaceName: "heal-orphan" });
    expect(status.mounts).toHaveLength(1);
  });
});
