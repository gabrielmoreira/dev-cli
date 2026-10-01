import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import { workspaceAdminRepoPath } from "../../src/paths.ts";
import * as shell from "../../src/shell.ts";
import * as trust from "../../src/trust.ts";
import * as ws from "../../src/ws.ts";

let root: string;

async function failureFrom(promise: Promise<unknown>): Promise<ws.WorkspaceError> {
  try {
    await promise;
  } catch (error) {
    return error as ws.WorkspaceError;
  }
  throw new Error("expected rejection, got resolve");
}

async function makeRepository(name: string, defaultBranch: string, alsoMain: boolean) {
  const bare = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await git.runGit(["init", "--bare", "-b", defaultBranch, bare]);
  await git.runGit(["init", "-b", defaultBranch, seed]);
  await git.runGit(["config", "user.name", "user"], { cwd: seed });
  await git.runGit(["config", "user.email", "user@example.org"], { cwd: seed });
  await Bun.write(join(seed, "base.txt"), name);
  await git.runGit(["add", "."], { cwd: seed });
  await git.runGit(["commit", "-m", "initial"], { cwd: seed });
  const commit = (await git.runGit(["rev-parse", "HEAD"], { cwd: seed })).stdout;
  await git.runGit(["remote", "add", "origin", bare], { cwd: seed });
  await git.runGit(["push", "-u", "origin", defaultBranch], { cwd: seed });
  if (alsoMain && defaultBranch !== "main") {
    await git.runGit(["checkout", "-b", "main"], { cwd: seed });
    await Bun.write(join(seed, "main.txt"), "not the default");
    await git.runGit(["add", "main.txt"], { cwd: seed });
    await git.runGit(["commit", "-m", "add main"], { cwd: seed });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seed });
  }
  await rm(seed, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { bare, commit };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sample-project-unlock-default-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("workspace unlock default branch", () => {
  for (const [workspaceName, defaultBranch, alsoMain] of [
    ["develop-workspace", "develop", false],
    ["master-workspace", "master", true],
  ] as const) {
    it(`tracks ${defaultBranch} on a detached mount${alsoMain ? " even when main exists" : " without main"}`, async () => {
      const repository = await makeRepository(workspaceName, defaultBranch, alsoMain);
      await ws.init({ root, name: workspaceName });
      await ws.add({
        root,
        workspaceName,
        source: repository.bare,
        path: "core",
        commit: repository.commit,
      });
      const result = await ws.unlock({ root, workspaceName, mountPath: "core" });
      expect(result.unlockedMounts[0]?.branch).toBe(defaultBranch);
      expect(
        (await git.inspectWorktree(join(root, "ws", workspaceName, "core"))).currentRevision.branch,
      ).toBe(defaultBranch);
      const doc = await manifest.readWorkspace(join(root, "ws", workspaceName, "ws.md"));
      expect(doc.manifest.mounts[0]?.revision).toEqual({ mode: "track", branch: defaultBranch });
    });
  }

  for (const choice of ["unattended", "selected", "cancelled"] as const) {
    it(`handles an unresolvable default with ${choice} branch input`, async () => {
      const workspaceName = `unknown-${choice}`;
      const repository = await makeRepository(workspaceName, "develop", false);
      await ws.init({ root, name: workspaceName });
      await ws.add({
        root,
        workspaceName,
        source: repository.bare,
        path: "core",
        commit: repository.commit,
      });
      const adminRepoPath = workspaceAdminRepoPath({
        root,
        workspaceName,
        sourceKey: git.normalizeSourceKey(repository.bare),
      });
      const changedHead = await git.runGit([
        "-C",
        adminRepoPath,
        "symbolic-ref",
        "HEAD",
        "refs/heads/missing-default",
      ]);
      expect(changedHead.exitCode).toBe(0);
      const manifestPath = join(root, "ws", workspaceName, "ws.md");
      const before = await Bun.file(manifestPath).text();
      const deps = {
        fs,
        git,
        manifest,
        shell,
        trust,
        interactions:
          choice === "unattended"
            ? undefined
            : {
                chooseUnlockBranch: async (context: { path: string; adminRepoPath: string }) => {
                  expect(context).toEqual({ path: "core", adminRepoPath });
                  return choice === "selected" ? "develop" : undefined;
                },
              },
      };
      const operation = ws.unlock({ root, workspaceName, mountPath: "core" }, deps);
      if (choice === "selected") {
        expect((await operation).unlockedMounts).toEqual([{ path: "core", branch: "develop" }]);
        expect(
          (await git.inspectWorktree(join(root, "ws", workspaceName, "core"))).currentRevision
            .branch,
        ).toBe("develop");
        expect((await manifest.readWorkspace(manifestPath)).manifest.mounts[0]?.revision).toEqual({
          mode: "track",
          branch: "develop",
        });
      } else {
        const error = await failureFrom(operation);
        expect(error.code).toBe("INTERACTION_REQUIRED");
        expect(error.message).toContain("[branch]");
        expect(error.details).toMatchObject({ path: "core", adminRepoPath, required: "[branch]" });
        expect(await Bun.file(manifestPath).text()).toBe(before);
        expect(
          (await git.inspectWorktree(join(root, "ws", workspaceName, "core"))).currentRevision,
        ).toEqual({ commitSha: repository.commit });
      }
    });
  }
});
