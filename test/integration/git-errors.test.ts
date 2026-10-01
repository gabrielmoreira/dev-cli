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
        () =>
          git.addWorktree({
            adminRepoPath: root,
            mountPath: join(root, "mount"),
            revision: { mode: "track", branch: "missing-ref" },
          }),
      ]) {
        const error = await failureFrom(operation());
        expect(error.code).toBe("REF_NOT_FOUND");
        expect(error.details?.stderr).toContain("missing-ref");
        expect(error.message).not.toContain("missing-ref");
        expect(error.message.split(/\r?\n/)).toHaveLength(1);
      }
      await git.checkoutRevision(root, "main");
      expect((await git.currentRevision(root)).branch).toBe("main");
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
