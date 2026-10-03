import { describe, expect, test } from "bun:test";
import * as git from "../../src/git.ts";
import type * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

function mount(path: string, setup?: string): manifest.MountDefinition {
  return {
    path,
    source: `https://github.com/example/${path}.git`,
    revision: { mode: "track", branch: "main" },
    setup,
  };
}

/** A double for exactly what ws.setup touches: one workspace, one shell, one trust answer. */
function setupDeps(options: {
  mounts: manifest.MountDefinition[];
  trusted: boolean;
  runHook: (
    command: string,
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): ws.WorkspaceDeps {
  const workspaceManifest: manifest.WorkspaceManifest = {
    version: 1,
    name: "sample-workspace",
    created_at: new Date(0).toISOString(),
    mounts: options.mounts,
  };
  return {
    fs: { exists: () => true },
    manifest: {
      readWorkspace: async () => ({ manifest: workspaceManifest, body: "" }),
    },
    git: {
      stripCredentialsFromUrl: git.stripCredentialsFromUrl,
      normalizeSourceKey: git.normalizeSourceKey,
      deriveDefaultMountPath: git.deriveDefaultMountPath,
    },
    shell: {
      runHook: (command: string, opts: { cwd?: string }) =>
        options.runHook(command, opts.cwd ?? ""),
    },
    trust: {
      resolveHookExecution: ({ mountHook }: { mountHook?: string }) =>
        options.trusted
          ? { allowed: true, command: mountHook, reason: "explicit_consent" }
          : { allowed: false, reason: "untrusted_blocked" },
    },
  } as unknown as ws.WorkspaceDeps;
}

describe("ws.setup verdicts", () => {
  test("a thrown shell error fails only that mount and every later mount still runs", async () => {
    const calls: string[] = [];
    const deps = setupDeps({
      mounts: [mount("first", "throws"), mount("second", "fails"), mount("third", "works")],
      trusted: true,
      runHook: async (command: string, cwd: string) => {
        calls.push(`${command}@${cwd}`);
        if (command === "throws") throw new Error("shell exploded");
        if (command === "fails") return { exitCode: 2, stdout: "", stderr: "boom" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await ws.setup(
      { root: "/dev", workspaceName: "sample-workspace", explicitConsent: true },
      deps,
    );

    expect(result.results.map((entry) => [entry.mount, entry.status])).toEqual([
      ["first", "failed"],
      ["second", "failed"],
      ["third", "ok"],
    ]);
    expect(result.results[0]?.message).toContain("shell exploded");
    expect(result.results[1]?.exitCode).toBe(2);
    expect(result.results[1]?.message).toContain("boom");
    expect(result).toMatchObject({ succeeded: 1, failed: 2, skipped: 0 });
    expect(calls.map((call) => call.split("@")[0])).toEqual(["throws", "fails", "works"]);
  });

  test("an untrusted mount keeps its command and reports why, and a selected mount alone runs", async () => {
    const calls: string[] = [];
    const deps = setupDeps({
      mounts: [mount("first", "echo first"), mount("second", "echo second")],
      trusted: false,
      runHook: async (command: string) => {
        calls.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await ws.setup(
      { root: "/dev", workspaceName: "sample-workspace", mountPaths: ["second"] },
      deps,
    );

    expect(result.results.map((entry) => [entry.mount, entry.status, entry.reason])).toEqual([
      ["first", "skipped", "not_selected"],
      ["second", "skipped", "consent_required"],
    ]);
    expect(result.results[1]?.command).toBe("echo second");
    expect(result.results[1]?.message).toContain("does not trust");
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ succeeded: 0, failed: 0, skipped: 2 });
  });

  test("a consent retry of the blocked mount keeps the verdict of the mount that already ran", async () => {
    const mounts = [mount("first", "echo first"), mount("second", "echo second")];
    const first: ws.WorkspaceSetupResult = {
      workspaceName: "sample-workspace",
      workspacePath: "/dev/ws/sample-workspace",
      manifestPath: "/dev/ws/sample-workspace/ws.md",
      results: [
        { mount: "first", path: "/p/first", source: mounts[0]!.source, status: "ok", exitCode: 0 },
        {
          mount: "second",
          path: "/p/second",
          source: mounts[1]!.source,
          status: "skipped",
          reason: "consent_required",
          command: "echo second",
        },
      ],
      succeeded: 1,
      failed: 0,
      skipped: 1,
      healWarnings: [],
    };
    const retry = await ws.setup(
      {
        root: "/dev",
        workspaceName: "sample-workspace",
        explicitConsent: true,
        mountPaths: ["second"],
      },
      setupDeps({
        mounts,
        trusted: true,
        runHook: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    );

    const merged = ws.mergeSetupRetry(first, retry);

    expect(merged.results.map((entry) => [entry.mount, entry.status])).toEqual([
      ["first", "ok"],
      ["second", "ok"],
    ]);
    expect(merged).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 });
  });
});
