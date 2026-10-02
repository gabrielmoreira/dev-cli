import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../../src/git.ts";

async function failureFrom<
  E extends Error = Error & {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
  },
>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error("expected rejection, got resolve");
}

describe("Git error classification", () => {
  it("classifies a missing local clone source and keeps a successful clone control", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-git-error-"));
    try {
      const remote = join(root, "valid.git");
      expect((await git.runGit(["init", "--bare", remote])).exitCode).toBe(0);
      const result = await git.ensureMirror({ root, source: remote });
      expect(result.created).toBe(true);

      const missing = join(root, "missing.git");
      const error = await failureFrom(git.ensureMirror({ root, source: missing }));
      expect(error.code).toBe("NOT_FOUND");
      expect(error.details?.args).toContain(missing);
      expect(error.message).not.toContain(missing);
      expect(error.message.split(/\r?\n/)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("classifies a missing repository path when fetching", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-git-error-"));
    try {
      const missing = join(root, "missing.git");
      for (const operation of [
        () => git.fetchMirror({ mirrorPath: missing }),
        () => git.fetchAdminRepo(missing),
      ]) {
        const error = await failureFrom(operation());
        expect(error.code).toBe("NOT_FOUND");
        expect(error.message).not.toContain(missing);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("classifies missing checkout refs in real repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-git-error-"));
    try {
      expect((await git.runGit(["init", "-b", "main", root])).exitCode).toBe(0);
      expect(
        (
          await git.runGit([
            "-C",
            root,
            "-c",
            "user.name=Test Author",
            "-c",
            "user.email=test@example.org",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
          ])
        ).exitCode,
      ).toBe(0);
      for (const operation of [
        () => git.switchBranch(root, "missing-ref"),
        () => git.checkoutRevision(root, "missing-ref"),
      ]) {
        const error = await failureFrom(operation());
        expect(error.code).toBe("REF_NOT_FOUND");
        expect(error.details?.stderr).toContain("missing-ref");
      }
      await git.checkoutRevision(root, "main");
      expect((await git.currentRevision(root)).branch).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("names the missing worktree ref and remote source", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-worktree-ref-"));
    try {
      const seed = join(root, "seed");
      const remote = join(root, "remote.git");
      const admin = join(root, "admin.git");
      expect((await git.runGit(["init", "-b", "main", seed])).exitCode).toBe(0);
      expect(
        (
          await git.runGit([
            "-C",
            seed,
            "-c",
            "user.name=Test Author",
            "-c",
            "user.email=test@example.org",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
          ])
        ).exitCode,
      ).toBe(0);
      expect((await git.runGit(["clone", "--bare", seed, remote])).exitCode).toBe(0);
      expect((await git.runGit(["clone", "--bare", remote, admin])).exitCode).toBe(0);
      const error = await failureFrom(
        git.addWorktree({
          adminRepoPath: admin,
          mountPath: join(root, "missing"),
          revision: { mode: "track", branch: "missing-ref" },
        }),
      );
      expect(error.code).toBe("REF_NOT_FOUND");
      expect(error.message).toBe(`Ref 'missing-ref' not found in ${remote}.`);
      expect(error.details).toMatchObject({ ref: "missing-ref", source: remote });
      expect(error.details?.stderr).toContain("missing-ref");
      const control = await git.addWorktree({
        adminRepoPath: admin,
        mountPath: join(root, "valid"),
        revision: { mode: "track", branch: "main" },
      });
      expect((await git.currentRevision(join(root, "valid"))).commitSha).toBe(control.commitSha);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("strips authentication headers from failed Git arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-git-error-"));
    try {
      const error = await failureFrom(
        git.ensureMirror({
          root,
          source: join(root, "missing.git"),
          extraHeader: "http.extraheader=Authorization: Bearer example-secret",
        }),
      );
      expect(error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(error.details)).not.toContain("example-secret");
      expect(error.message).not.toContain("example-secret");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
