import { describe, expect, test } from "bun:test";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

const SOURCE_WITH_CREDENTIALS = "https://user:ghp_secret@github.com/org/repo.git";
const CANONICAL_SOURCE = "https://github.com/org/repo.git";

function makeDeps(captured: Record<string, string>[]): ws.WorkspaceDeps {
  const readWorkspace = async (): Promise<{
    manifest: manifest.WorkspaceManifest;
    body: string;
  }> => ({
    manifest: {
      version: 1,
      name: "sample-workspace",
      created_at: new Date(0).toISOString(),
      mounts: [],
    },
    body: "",
  });
  const writeWorkspace = async (
    _path: string,
    _manifest: manifest.WorkspaceManifest,
    _body?: string,
  ): Promise<void> => {};
  return {
    fs: {
      exists: (p: string) => !p.endsWith("core"),
    },
    manifest: {
      readWorkspace,
      writeWorkspace,
      updateWorkspace: async (
        path: string,
        mutate: (doc: {
          manifest: manifest.WorkspaceManifest;
          body: string;
        }) => void | Promise<void>,
      ) => {
        const doc = await readWorkspace();
        await mutate(doc);
        await writeWorkspace(path, doc.manifest, doc.body);
        return doc;
      },
    },
    git: {
      stripCredentialsFromUrl: git.stripCredentialsFromUrl,
      normalizeSourceKey: git.normalizeSourceKey,
      deriveDefaultMountPath: git.deriveDefaultMountPath,
      ensureMirror: async () => ({ sourceKey: "github.com/org/repo", mirrorPath: "/mirror" }),
      ensureWorkspaceRepo: async () => ({ adminRepoPath: "/admin" }),
      resolveDefaultBranch: async () => "main",
      hasRevision: async () => true,
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
