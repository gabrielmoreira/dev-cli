import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("DEV_SOURCE is stripped when update recreates a manifest mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-cli-recreated-hook-"));
    try {
      const workspaceName = "sample-workspace";
      const workspacePath = join(root, "ws", workspaceName);
      const mountPath = join(workspacePath, "core");
      const captured: Record<string, string>[] = [];
      let inspections = 0;
      const mount = {
        path: "core",
        source: SOURCE_WITH_CREDENTIALS,
        revision: { mode: "track" as const, branch: "main" },
        hooks: { pre_checkout: "echo pre", post_checkout: "echo post" },
      };
      const deps = {
        fs: { exists: () => true },
        manifest: {
          readWorkspace: async () => ({
            manifest: {
              version: 1,
              name: workspaceName,
              created_at: new Date(0).toISOString(),
              mounts: [mount],
            },
            body: "human notes",
          }),
          writeWorkspace: async () => {},
        },
        git: {
          stripCredentialsFromUrl: git.stripCredentialsFromUrl,
          normalizeSourceKey: git.normalizeSourceKey,
          fetchMirror: async () => {},
          fetchAdminRepo: async () => {},
          inspectWorktree: async () => {
            inspections++;
            return inspections === 1
              ? {
                  path: mountPath,
                  exists: false,
                  isGitWorktree: false,
                  currentRevision: {},
                  isDirty: false,
                  modifiedFiles: 0,
                  untrackedFiles: 0,
                  aheadCount: 0,
                  behindCount: 0,
                }
              : {
                  path: mountPath,
                  exists: true,
                  isGitWorktree: true,
                  currentRevision: { branch: "main", commitSha: "0123456789abcdef" },
                  isDirty: false,
                  modifiedFiles: 0,
                  untrackedFiles: 0,
                  aheadCount: 0,
                  behindCount: 0,
                };
          },
          ensureMirror: async () => ({
            sourceKey: "github.com/example-org/sample-api",
            mirrorPath: "/mirror",
            created: false,
          }),
          ensureWorkspaceRepo: async () => ({ adminRepoPath: "/admin", created: false }),
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

      const result = await ws.update({ root, workspaceName, explicitConsent: true }, deps);

      expect(result.mounts[0]?.action).toBe("create");
      expect(captured).toHaveLength(2);
      for (const env of captured) {
        expect(env.DEV_SOURCE).toBe(CANONICAL_SOURCE);
        expect(env.DEV_SOURCE).not.toContain("ghp_secret");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
