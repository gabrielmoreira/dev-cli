import { describe, expect, test } from "bun:test";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

interface RemovedWorktree {
  adminRepoPath: string;
  mountPath: string;
  force?: boolean;
}

function makeDeps(options: {
  writeFails?: Error;
  removed: RemovedWorktree[];
  removeFails?: Error;
}): ws.WorkspaceDeps {
  return {
    fs: {
      exists: (p: string) => !p.endsWith("core"),
    },
    manifest: {
      readWorkspace: async () => ({ manifest: { mounts: [] }, body: "" }),
      writeWorkspace: async () => {
        if (options.writeFails) throw options.writeFails;
      },
    },
    git: {
      stripCredentialsFromUrl: git.stripCredentialsFromUrl,
      normalizeSourceKey: git.normalizeSourceKey,
      deriveDefaultMountPath: git.deriveDefaultMountPath,
      ensureMirror: async () => ({ sourceKey: "github.com/org/repo", mirrorPath: "/mirror" }),
      ensureWorkspaceRepo: async () => ({ adminRepoPath: "/admin" }),
      resolveDefaultBranch: async () => "main",
      addWorktree: async () => ({ commitSha: "0123456789abcdef" }),
      removeWorktree: async (
        adminRepoPath: string,
        mountPath: string,
        opts: { force?: boolean } = {},
      ) => {
        options.removed.push({ adminRepoPath, mountPath, force: opts.force });
        if (options.removeFails) throw options.removeFails;
      },
    },
    shell: {
      runHook: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    trust: {
      resolveHookExecution: ({ mountHook }: { mountHook?: string }) => ({
        allowed: Boolean(mountHook),
        command: mountHook,
        reason: "explicit_consent",
      }),
    },
  } as unknown as ws.WorkspaceDeps;
}

const input = {
  root: "/dev",
  workspaceName: "payment-fix",
  source: "https://github.com/org/repo.git",
  path: "core",
  branch: "main",
};

async function failureFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected ws.add to reject, but it resolved");
}

describe("ws.add rollback", () => {
  test("removes the worktree it created when the manifest write fails", async () => {
    const removed: RemovedWorktree[] = [];
    const writeFails = new Error("EACCES: permission denied, open 'ws.md'");

    const error = await failureFrom(ws.add(input, makeDeps({ writeFails, removed })));

    expect(error.message).toContain("EACCES: permission denied");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.adminRepoPath).toBe("/admin");
    expect(removed[0]?.mountPath.endsWith("core")).toBe(true);
    expect(removed[0]?.force).toBe(true);
  });

  test("surfaces the original failure even when the rollback itself fails", async () => {
    const removed: RemovedWorktree[] = [];

    const error = await failureFrom(
      ws.add(
        input,
        makeDeps({
          writeFails: new Error("ENOSPC: no space left on device"),
          removeFails: new Error("worktree is locked"),
          removed,
        }),
      ),
    );

    expect(error.message).toContain("ENOSPC: no space left on device");
    expect(removed).toHaveLength(1);
  });

  test("does not remove anything when the manifest write succeeds", async () => {
    const removed: RemovedWorktree[] = [];

    const result = await ws.add(input, makeDeps({ removed }));

    expect(result.mountName).toBe("core");
    expect(removed).toHaveLength(0);
  });
});
