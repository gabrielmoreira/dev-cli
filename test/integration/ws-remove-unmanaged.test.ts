import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

async function failureFrom(promise: Promise<unknown>): Promise<ws.WorkspaceError> {
  try {
    await promise;
  } catch (error) {
    return error as ws.WorkspaceError;
  }
  throw new Error("expected rejection, got resolve");
}

describe("workspace removal preserves local-only commits", () => {
  let root: string;
  let devRoot: string;
  const workspaceNames = ["sample-unmanaged", "sample-managed"];
  const localCommits = new Map<string, string>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sample-project-remove-unmanaged-"));
    const bare = join(root, "remote.git");
    const seed = join(root, "seed");
    devRoot = join(root, "dev-root");
    expect((await git.runGit(["init", "--bare", "-b", "main", bare])).exitCode).toBe(0);
    expect((await git.runGit(["init", "-b", "main", seed])).exitCode).toBe(0);
    for (const args of [
      ["config", "user.name", "user"],
      ["config", "user.email", "user@example.org"],
    ]) {
      expect((await git.runGit(args, { cwd: seed })).exitCode).toBe(0);
    }
    await fs.writeText(join(seed, "base.txt"), "base");
    for (const args of [
      ["add", "."],
      ["commit", "-m", "initial"],
      ["remote", "add", "origin", bare],
      ["push", "-u", "origin", "main"],
    ]) {
      expect((await git.runGit(args, { cwd: seed })).exitCode).toBe(0);
    }

    const cliPath = join(process.cwd(), "src", "cli.ts");
    for (const workspaceName of workspaceNames) {
      for (const args of [
        ["ws", "init", workspaceName, "--root", devRoot],
        [
          "ws",
          "add",
          bare,
          "--ws",
          workspaceName,
          "--path",
          "core",
          "--branch",
          "main",
          "--root",
          devRoot,
        ],
      ]) {
        const proc = Bun.spawn(["bun", cliPath, ...args], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      }
      const mountPath = join(devRoot, "ws", workspaceName, "core");
      if (workspaceName === "sample-unmanaged") {
        await rm(mountPath, { recursive: true, force: true });
        expect((await git.runGit(["clone", bare, mountPath])).exitCode).toBe(0);
      }
      for (const args of [
        ["config", "user.name", "user"],
        ["config", "user.email", "user@example.org"],
        ["checkout", "--no-track", "-b", "users/alice/local-only"],
      ]) {
        expect((await git.runGit(args, { cwd: mountPath })).exitCode).toBe(0);
      }
      await fs.writeText(join(mountPath, "local.txt"), "keep this commit");
      expect((await git.runGit(["add", "local.txt"], { cwd: mountPath })).exitCode).toBe(0);
      expect(
        (await git.runGit(["commit", "-m", "local-only commit"], { cwd: mountPath })).exitCode,
      ).toBe(0);
      const head = await git.runGit(["rev-parse", "HEAD"], { cwd: mountPath });
      expect(head.exitCode).toBe(0);
      localCommits.set(workspaceName, head.stdout);
      expect(
        (await git.runGit(["rev-parse", "@{upstream}"], { cwd: mountPath })).exitCode,
      ).not.toBe(0);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("refuses an unmanaged clone and preserves its local-only commit and manifest entry", async () => {
    const workspaceName = "sample-unmanaged";
    const mountPath = join(devRoot, "ws", workspaceName, "core");
    const localCommit = localCommits.get(workspaceName)!;
    const error = await failureFrom(ws.remove({ root: devRoot, workspaceName, mountPath: "core" }));

    expect(error.code).toBe("UNMANAGED_CHECKOUT");
    expect(fs.exists(mountPath)).toBe(true);
    const reachable = await git.runGit(["rev-parse", localCommit], { cwd: mountPath });
    expect(reachable.exitCode).toBe(0);
    expect(reachable.stdout).toBe(localCommit);
    const doc = await manifest.readWorkspace(join(devRoot, "ws", workspaceName, "ws.md"));
    expect(doc.manifest.mounts.map((mount) => mount.path)).toContain("core");
  });

  it("refuses a registered worktree with an unpushed commit on a branch without an upstream", async () => {
    const workspaceName = "sample-managed";
    const mountPath = join(devRoot, "ws", workspaceName, "core");
    const localCommit = localCommits.get(workspaceName)!;
    const error = await failureFrom(ws.remove({ root: devRoot, workspaceName, mountPath: "core" }));

    expect(error.code).toBe("UNSAFE_REMOVE");
    expect(error.details?.aheadCount).toBe(1);
    const reachable = await git.runGit(["rev-parse", localCommit], { cwd: mountPath });
    expect(reachable.exitCode).toBe(0);
    expect(reachable.stdout).toBe(localCommit);
    const doc = await manifest.readWorkspace(join(devRoot, "ws", workspaceName, "ws.md"));
    expect(doc.manifest.mounts.map((mount) => mount.path)).toContain("core");
  });
});
