import { describe, expect, test } from "bun:test";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

const SOURCE_WITH_CREDENTIALS = "https://user:ghp_secret@github.com/org/repo.git";
const CANONICAL_SOURCE = "https://github.com/org/repo.git";

function makeDeps(captured: Record<string, string>[]): ws.WorkspaceDeps {
  return {
    fs: {
      exists: (p: string) => !p.endsWith("core"),
    },
    manifest: {
      readWorkspace: async () => ({ manifest: { mounts: [] }, body: "" }),
      writeWorkspace: async () => {},
    },
    git: {
      stripCredentialsFromUrl: git.stripCredentialsFromUrl,
      normalizeSourceKey: git.normalizeSourceKey,
      deriveDefaultMountPath: git.deriveDefaultMountPath,
      ensureMirror: async () => ({ sourceKey: "github.com/org/repo", mirrorPath: "/mirror" }),
      ensureWorkspaceRepo: async () => ({ adminRepoPath: "/admin" }),
      resolveDefaultBranch: async () => "main",
      addWorktree: async () => ({ commitSha: "0123456789abcdef" }),
    },
    shell: {
      runHook: async (_command: string, options: { env: Record<string, string> }) => {
        captured.push(options.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
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

describe("ws.add hook environment", () => {
  test("DEV_SOURCE never carries credentials from the source URL", async () => {
    const captured: Record<string, string>[] = [];

    await ws.add(
      {
        root: "/dev",
        workspaceName: "payment-fix",
        source: SOURCE_WITH_CREDENTIALS,
        path: "core",
        branch: "main",
        explicitConsent: true,
        hooks: {
          pre_checkout: "echo pre",
          post_checkout: "echo post",
          post_add: "echo add",
        },
      },
      makeDeps(captured),
    );

    expect(captured).toHaveLength(3);
    for (const env of captured) {
      expect(env.DEV_SOURCE).toBe(CANONICAL_SOURCE);
      expect(env.DEV_SOURCE).not.toContain("ghp_secret");
    }
  });
});
