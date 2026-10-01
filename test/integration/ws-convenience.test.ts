import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as shell from "../../src/shell.ts";
import * as trust from "../../src/trust.ts";
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

  async function failureFrom(promise: Promise<unknown>): Promise<Error & { code?: string }> {
    try {
      await promise;
    } catch (error) {
      return error as Error & { code?: string };
    }
    throw new Error("expected rejection, got resolve");
  }

  it("rolls back failed init and duplicate attempts so both targets can be retried", async () => {
    let failPath: string | undefined;
    const deps: ws.WorkspaceDeps = {
      fs,
      git,
      shell,
      trust,
      manifest: {
        ...manifest,
        async writeWorkspace(filePath, value, body) {
          if (filePath === failPath) {
            throw Object.assign(new Error("injected manifest failure"), {
              code: "INJECTED_WRITE_FAILURE",
            });
          }
          await manifest.writeWorkspace(filePath, value, body);
        },
      },
    };

    const sibling = await ws.init({ root: tempRoot, name: "rollback-sibling" });
    const siblingManifest = await fs.readText(sibling.manifestPath);
    const siblingNotes = join(sibling.localPath, "notes.txt");
    await fs.writeText(siblingNotes, "keep existing workspace notes");

    const initPath = join(tempRoot, "ws", "retry-init");
    failPath = join(initPath, "ws.md");
    expect((await failureFrom(ws.init({ root: tempRoot, name: "retry-init" }, deps))).code).toBe(
      "INJECTED_WRITE_FAILURE",
    );
    expect(fs.exists(initPath)).toBe(false);
    expect(await fs.readText(sibling.manifestPath)).toBe(siblingManifest);
    expect(await fs.readText(siblingNotes)).toBe("keep existing workspace notes");
    failPath = undefined;
    expect((await ws.init({ root: tempRoot, name: "retry-init" }, deps)).created).toBe(true);

    await ws.init({ root: tempRoot, name: "rollback-source" });
    await ws.add({
      root: tempRoot,
      workspaceName: "rollback-source",
      source: bareRemotePath,
      path: "app",
      branch: "main",
    });
    const sourceMount = join(tempRoot, "ws", "rollback-source", "app", "readme.txt");
    expect(fs.exists(sourceMount)).toBe(true);

    const targetPath = join(tempRoot, "ws", "retry-copy");
    failPath = join(targetPath, "ws.md");
    expect(
      (
        await failureFrom(
          ws.duplicate(
            { root: tempRoot, sourceName: "rollback-source", targetName: "retry-copy" },
            deps,
          ),
        )
      ).code,
    ).toBe("INJECTED_WRITE_FAILURE");
    expect(fs.exists(targetPath)).toBe(false);
    expect(fs.exists(sourceMount)).toBe(true);
    expect(await fs.readText(sibling.manifestPath)).toBe(siblingManifest);
    expect(await fs.readText(siblingNotes)).toBe("keep existing workspace notes");

    failPath = undefined;
    const retried = await ws.duplicate(
      { root: tempRoot, sourceName: "rollback-source", targetName: "retry-copy" },
      deps,
    );
    expect(retried.targetName).toBe("retry-copy");
    expect(fs.exists(join(targetPath, "app", "readme.txt"))).toBe(true);
  });
});
