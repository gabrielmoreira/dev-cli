import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHookExecution } from "../../src/trust.ts";
import { resolveConfig, type TrustedScope } from "../../src/config.ts";
import * as git from "../../src/git.ts";
import * as mirror from "../../src/mirror.ts";
import { checkoutsDir } from "../../src/paths.ts";
import { createPluginBase, emit } from "../../src/plugins/index.ts";
import type { ShellExecResult } from "../../src/shell.ts";

describe("QMD and Lifecycle Hooks Pure Resolution (Phase 19)", () => {
  const sampleScopes: TrustedScope[] = [
    {
      provider: "azuredevops",
      tenant: "dev.azure.com",
      owner: "my-org",
      repos: ["payments", "auth"],
      rules: [
        {
          match: "payments",
          hooks: {
            post_add: "mise x -- qmd update --path $DEV_MOUNT_PATH",
            post_sync: "mise x -- qmd index --incremental",
          },
        },
        {
          match: "*",
          hooks: {
            post_add: "echo 'generic post_add'",
            post_sync: "echo 'generic post_sync'",
          },
        },
      ],
    },
  ];

  test("resolves mount-specific post_add hook with top precedence", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "post_add",
      mountHook: "custom-indexer --path $DEV_MOUNT_PATH",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("custom-indexer --path $DEV_MOUNT_PATH");
    expect(result.reason).toBe("trusted_mount_override");
  });

  test("resolves exact scope rule for post_add and post_sync", () => {
    const postAdd = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "post_add",
      trustedScopes: sampleScopes,
    });
    expect(postAdd.allowed).toBe(true);
    expect(postAdd.command).toBe("mise x -- qmd update --path $DEV_MOUNT_PATH");
    expect(postAdd.reason).toBe("trusted_exact_rule");

    const postSync = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "post_sync",
      trustedScopes: sampleScopes,
    });
    expect(postSync.allowed).toBe(true);
    expect(postSync.command).toBe("mise x -- qmd index --incremental");
    expect(postSync.reason).toBe("trusted_exact_rule");
  });

  test("falls back to wildcard rule for repositories without exact match", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/auth",
      hookName: "post_add",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("echo 'generic post_add'");
    expect(result.reason).toBe("trusted_wildcard_rule");
  });

  test("falls back to global hook from dev.yaml when no scope rules match", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/unknown-repo",
      hookName: "post_sync",
      globalHook: "mise x -- qmd index --incremental",
      trustedScopes: [
        {
          provider: "azuredevops",
          tenant: "dev.azure.com",
          owner: "my-org",
          repos: ["unknown-repo"],
        },
      ],
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("mise x -- qmd index --incremental");
    expect(result.reason).toBe("trusted_global_hook");
  });

  test("blocks post_add / post_sync on untrusted repository without consent", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://github.com/untrusted-author/random-repo.git",
      hookName: "post_add",
      mountHook: "mise x -- qmd update --path $DEV_MOUNT_PATH",
      trustedScopes: sampleScopes,
      explicitConsent: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("untrusted_blocked");
  });

  test("allows post_add / post_sync on untrusted repository with explicit consent", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://github.com/untrusted-author/random-repo.git",
      hookName: "post_add",
      mountHook: "mise x -- qmd update --path $DEV_MOUNT_PATH",
      trustedScopes: sampleScopes,
      explicitConsent: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("mise x -- qmd update --path $DEV_MOUNT_PATH");
    expect(result.reason).toBe("explicit_consent");
  });

  test("returns no_hook_defined when no hook is configured", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "non_existent_hook",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_hook_defined");
  });
});

async function makeIndexHookHarness(labels = ["index:docs"]) {
  const root = mkdtempSync(join(tmpdir(), "dev-cli-qmd-hooks-"));
  const source = join(root, "sample-docs").replaceAll("\\", "/");
  await git.runGit(["init", "-b", "main", source]);
  await git.runGit(["-C", source, "config", "user.name", "Sample Author"]);
  await git.runGit(["-C", source, "config", "user.email", "sample@example.com"]);
  writeFileSync(join(source, "README.md"), "Sample documentation\n");
  await git.runGit(["-C", source, "add", "."]);
  await git.runGit(["-C", source, "commit", "-m", "Initial documentation"]);
  writeFileSync(
    join(root, "dev.yaml"),
    JSON.stringify({
      sources: [
        {
          url: source,
          branch: "main",
          labels: Object.fromEntries(labels.map((label) => [label, {}])),
        },
      ],
    }),
  );
  const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });
  const original = createPluginBase(root, config);
  const calls: string[][] = [];
  const base = {
    ...original,
    shell: {
      ...original.shell,
      async runCommand(_bin: string, args: string[] = []): Promise<ShellExecResult> {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
  return { root, source, base, calls };
}

describe("registered qmd indexing hooks", () => {
  test("adds the existing local mirror to the index label without embedding", async () => {
    const { root, source, base, calls } = await makeIndexHookHarness();
    try {
      const checkout = await mirror.ensure({ root, source, branch: "main" });
      expect(existsSync(checkout.path)).toBe(true);

      await emit(base, "label:add:after", {
        root,
        sourceKey: git.normalizeSourceKey(source),
        label: "index:docs",
        meta: {},
      });

      expect(calls).toContainEqual([
        "collection",
        "add",
        checkout.path,
        "--name",
        "index:docs--sample-docs",
      ]);
      expect(calls).toContainEqual(["update"]);
      expect(calls.some((args) => args[0] === "embed")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not materialize an absent mirror on label add", async () => {
    const { root, source, base, calls } = await makeIndexHookHarness();
    try {
      expect(existsSync(checkoutsDir({ root }))).toBe(false);
      await emit(base, "label:add:after", {
        root,
        sourceKey: git.normalizeSourceKey(source),
        label: "index:docs",
        meta: {},
      });

      expect(existsSync(checkoutsDir({ root }))).toBe(false);
      expect(calls.some((args) => args[0] === "collection" && args[1] === "add")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stays silent after mirror sync when the root has no index labels", async () => {
    const { root, base, calls } = await makeIndexHookHarness(["docs"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await emit(base, "mirror:sync:after", {
        root,
        updated: [{ sourceKey: "sample-docs", revision: "main" }],
      });

      expect(calls).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes stale owned collections on label removal without embedding", async () => {
    const { root, source, base, calls } = await makeIndexHookHarness(["index:docs", "index:code"]);
    try {
      await mirror.ensure({ root, source, branch: "main" });
      base.config.sources![0]!.labels = { "index:code": {} };
      base.shell.runCommand = async (_bin, args = []) => {
        calls.push(args);
        return {
          stdout: args[1] === "list" ? "index:docs--sample-docs\nindex:code--sample-docs\n" : "",
          stderr: "",
          exitCode: 0,
        };
      };

      await emit(base, "label:rm:after", {
        root,
        sourceKey: git.normalizeSourceKey(source),
        label: "index:docs",
      });

      expect(calls).toContainEqual(["collection", "remove", "index:docs--sample-docs"]);
      expect(calls.some((args) => args.includes("index:code--sample-docs"))).toBe(false);
      expect(calls.some((args) => args[0] === "embed")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["label:add:after", "label:rm:after"] as const)(
    "stays silent on %s when the root has no index labels",
    async (event) => {
      const { root, source, base, calls } = await makeIndexHookHarness(["docs"]);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await emit(base, event, {
          root,
          sourceKey: git.normalizeSourceKey(source),
          label: "index:docs",
          meta: {},
        });

        expect(calls).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("updates indexed roots after mirror sync without embedding", async () => {
    const { root, base, calls } = await makeIndexHookHarness();
    try {
      await emit(base, "mirror:sync:after", {
        root,
        updated: [{ sourceKey: "sample-docs", revision: "main" }],
      });

      expect(calls).toEqual([["update"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns without rejecting the label event when qmd is unavailable", async () => {
    const { root, source, base } = await makeIndexHookHarness();
    base.shell.runCommand = async () => {
      throw new Error("qmd unavailable");
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await emit(base, "label:add:after", {
        root,
        sourceKey: git.normalizeSourceKey(source),
        label: "index:docs",
        meta: {},
      });

      expect(warn.mock.calls.flat().join(" ")).toContain("Plugin 'qmd'");
      expect(warn.mock.calls.flat().join(" ")).toContain("qmd unavailable");
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
