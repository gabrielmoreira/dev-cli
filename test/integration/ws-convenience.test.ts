import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

describe("Workspace convenience operations integration (Phase 7)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-conv-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-conv-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "Convenience Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "conv@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "readme.txt"), "hello convenience");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
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

  it("lists workspaces with metadata and mount counts", async () => {
    await ws.init({ root: tempRoot, name: "beta-ws", description: "Beta workspace" });
    await ws.init({ root: tempRoot, name: "alpha-ws", description: "Alpha workspace" });

    await ws.add({
      root: tempRoot,
      workspaceName: "alpha-ws",
      source: bareRemotePath,
      path: "app",
      branch: "main",
    });

    const list = await ws.list({ root: tempRoot });
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("alpha-ws");
    expect(list[0].mountCount).toBe(1);
    expect(list[0].description).toBe("Alpha workspace");

    expect(list[1].name).toBe("beta-ws");
    expect(list[1].mountCount).toBe(0);
    expect(list[1].description).toBe("Beta workspace");
  });

  it("duplicates workspace with independent admin repos and no worktree lock conflict", async () => {
    const dupRes = await ws.duplicate({
      root: tempRoot,
      sourceName: "alpha-ws",
      targetName: "alpha-clone",
    });

    expect(dupRes.sourceName).toBe("alpha-ws");
    expect(dupRes.targetName).toBe("alpha-clone");
    expect(dupRes.mountsCount).toBe(1);

    const sourceAppPath = join(tempRoot, "ws", "alpha-ws", "app");
    const cloneAppPath = join(tempRoot, "ws", "alpha-clone", "app");

    expect(fs.exists(join(cloneAppPath, "readme.txt"))).toBe(true);

    // Both are on main simultaneously: proves independent admin repositories exist and no Git worktree conflicts occur
    const sourceBranch = await git.runGit(["branch", "--show-current"], { cwd: sourceAppPath });
    const cloneBranch = await git.runGit(["branch", "--show-current"], { cwd: cloneAppPath });
    expect(sourceBranch.stdout).toBe("main");
    expect(cloneBranch.stdout).toBe("main");

    // Making a commit in the source worktree does not mutate the duplicated worktree
    await git.runGit(["config", "user.name", "Tester"], { cwd: sourceAppPath });
    await git.runGit(["config", "user.email", "test@example.com"], { cwd: sourceAppPath });
    await fs.writeText(join(sourceAppPath, "readme.txt"), "modified in source");
    await git.runGit(["commit", "-am", "fix: modify in source"], { cwd: sourceAppPath });

    const sourceStatus = await git.inspectWorktree(sourceAppPath);
    const cloneStatus = await git.inspectWorktree(cloneAppPath);

    expect(sourceStatus.aheadCount).toBe(1);
    expect(cloneStatus.aheadCount).toBe(0);
    expect(cloneStatus.isDirty).toBe(false);
  });

  it("resolves workspace path from explicit name or cwd context", () => {
    const fromName = ws.resolveWorkspacePath({ root: tempRoot, workspaceName: "alpha-ws" });
    expect(fromName.replace(/\\/g, "/")).toBe(join(tempRoot, "ws", "alpha-ws").replace(/\\/g, "/"));

    const fromCwd = ws.resolveWorkspacePath({
      root: tempRoot,
      cwd: join(tempRoot, "ws", "alpha-ws", "app", "src"),
    });
    expect(fromCwd.replace(/\\/g, "/")).toBe(join(tempRoot, "ws", "alpha-ws").replace(/\\/g, "/"));
  });
});
