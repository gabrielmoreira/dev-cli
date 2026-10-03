import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config.ts";
import type { PluginBase } from "../../src/plugins/index.ts";
import type { ShellExecResult } from "../../src/shell.ts";
import {
  createQmdPlugin,
  parseQmdConfig,
  qmdEnv,
  qmdSyncLabels,
  reconcileCollections,
  syncCollections,
} from "../../src/plugins/qmd.ts";

interface QmdCall {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

/** Fake shell: records invocations, answers through a swappable canning fn. */
interface FakeShell {
  calls: QmdCall[];
  runCommand(
    bin: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ): Promise<ShellExecResult>;
  answerWith(canned: (args: string[]) => ShellExecResult): void;
}

function makeFakeShell(): FakeShell {
  const calls: QmdCall[] = [];
  let can: (args: string[]) => ShellExecResult = () => ({ stdout: "", stderr: "", exitCode: 0 });
  return {
    calls,
    answerWith(canned) {
      can = canned;
    },
    async runCommand(bin, args, options = {}) {
      calls.push({ bin, args, env: options.env ?? {} });
      return can(args);
    },
  };
}

interface Harness {
  base: PluginBase;
  shell: FakeShell;
  root: string;
}

function makeHarness(devYaml?: string): Harness {
  const root = mkdtempSync(join(tmpdir(), "dev-cli-qmd-"));
  if (devYaml) writeFileSync(join(root, "dev.yaml"), devYaml);
  const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });
  const shell = makeFakeShell();
  const base = {
    root,
    config,
    shell,
    ui: { error: () => {}, info: () => {}, log: () => {}, warn: () => {} },
  } as unknown as PluginBase;
  return { base, shell, root };
}

describe("qmd plugin config", () => {
  it("defaults to PATH qmd with a scoped registry", () => {
    const cfg = parseQmdConfig(undefined);
    expect(cfg.command).toBe("qmd");
    expect(cfg.config_dir).toBe("scoped");
  });

  it("scopes QMD_CONFIG_DIR under the dev root", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-cli-qmd-"));
    const env = qmdEnv({ root } as PluginBase, parseQmdConfig(undefined));
    expect(env.QMD_CONFIG_DIR).toBe(join(root, ".dev", "plugins", "qmd"));
    rmSync(root, { recursive: true, force: true });
  });

  it("passes global and absolute config dirs through", () => {
    const base = { root: "R" } as PluginBase;
    expect(qmdEnv(base, parseQmdConfig({ qmd: { config_dir: "global" } }))).toEqual({});
    expect(qmdEnv(base, parseQmdConfig({ qmd: { config_dir: "D:/q" } }))).toEqual({
      QMD_CONFIG_DIR: "D:/q",
    });
  });

  it("splits a custom command into prefix + bin", async () => {
    const { base, shell, root } = makeHarness(
      "plugins:\n  qmd:\n    command: mise exec -q -- qmd\n",
    );
    const plugin = createQmdPlugin(base);
    await plugin.run({ subcommand: "x", passthrough: ["status"] });
    expect(shell.calls[0]?.bin).toBe("qmd");
    expect(shell.calls[0]?.args).toEqual(["mise", "exec", "-q", "--", "status"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("qmd sync label selection", () => {
  it("uses every assigned index label when none is explicit", () => {
    const { base, root } = makeHarness(
      [
        "label_defs:",
        '  "index:docs": {}',
        "sources:",
        "  - url: https://github.com/org/code",
        "    labels:",
        '      "index:code": {}',
        "      other: {}",
      ].join("\n"),
    );

    expect(qmdSyncLabels(base.config, "")).toEqual(["index:code"]);
    expect(qmdSyncLabels(base.config, "other")).toEqual(["other"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("qmd sync", () => {
  it("is an empty result without touching qmd when no index label is configured", async () => {
    const { base, shell, root } = makeHarness();
    const config = parseQmdConfig(base.config.plugins);
    expect(await syncCollections(base, config, { label: "", noEmbed: false })).toEqual({
      exitCode: 0,
      labels: [],
      warnings: [],
    });
    expect(shell.calls).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("throws the label error for a label no source carries, before touching qmd", async () => {
    const { base, shell, root } = makeHarness(
      "sources:\n  - url: https://github.com/org/docs\n    branch: main\n",
    );
    const config = parseQmdConfig(base.config.plugins);
    await expect(
      syncCollections(base, config, { label: "ghost", noEmbed: false }),
    ).rejects.toMatchObject({ code: "LABEL_NOT_FOUND" });
    expect(shell.calls).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("reconcileCollections", () => {
  it("adds missing, removes stale owned, updates, and embeds", async () => {
    const { base, shell, root } = makeHarness();
    shell.answerWith((args) => {
      if (args[0] === "collection" && args[1] === "list") {
        return { stdout: "wiki--stale\nwiki--docs\nother--x\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const desired = new Map([["wiki--fresh", "P:/checkouts/fresh"]]);
    const failure = await reconcileCollections(base, parseQmdConfig(undefined), "wiki", desired);

    expect(failure).toBeNull();
    const verbs = shell.calls.map((c) => c.args.join(" "));
    expect(verbs).toContain("collection remove wiki--stale");
    expect(verbs).toContain("collection add P:/checkouts/fresh --name wiki--fresh");
    expect(verbs).toContain("update");
    expect(verbs).toContain("embed");
    // never touches collections owned by other labels
    expect(verbs.some((v) => v.includes("other--x"))).toBe(false);
    // every call runs under the scoped registry env
    const expectedEnv = join(base.root, ".dev", "plugins", "qmd");
    expect(shell.calls.every((c) => c.env.QMD_CONFIG_DIR === expectedEnv)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a failed initial list before mutating collections", async () => {
    const { base, shell, root } = makeHarness();
    shell.answerWith((args) =>
      args[0] === "collection" && args[1] === "list"
        ? { stdout: "wiki--stale", stderr: "registry unavailable", exitCode: 2 }
        : { stdout: "", stderr: "", exitCode: 0 },
    );

    try {
      const failure = await reconcileCollections(
        base,
        parseQmdConfig(undefined),
        "wiki",
        new Map([["wiki--docs", "P:/docs"]]),
      );

      expect(failure).toEqual({
        code: "QMD_FAILED",
        args: ["collection", "list"],
        exitCode: 2,
        step: "collection list",
        stderr: "registry unavailable",
      });
      expect(shell.calls.every((call) => call.args[1] === "list")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["", "wiki--docs-copy\n"])(
    "reports a failed collection add unless a follow-up list confirms the exact name (%j)",
    async (listed) => {
      const { base, shell, root } = makeHarness();
      let listCalls = 0;
      shell.answerWith((args) => {
        if (args[0] === "collection" && args[1] === "list") {
          listCalls++;
          return { stdout: listCalls === 1 ? "" : listed, stderr: "", exitCode: 0 };
        }
        if (args[0] === "collection" && args[1] === "add") {
          return { stdout: "", stderr: "path unavailable", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      try {
        const failure = await reconcileCollections(
          base,
          parseQmdConfig(undefined),
          "wiki",
          new Map([["wiki--docs", "P:/docs"]]),
        );

        expect(failure).toEqual({
          code: "QMD_FAILED",
          args: ["collection", "add", "P:/docs", "--name", "wiki--docs"],
          exitCode: 1,
          step: "collection add",
          stderr: "path unavailable",
        });
        expect(listCalls).toBe(2);
        expect(shell.calls[0]?.env.QMD_CONFIG_DIR).toBe(join(root, ".dev", "plugins", "qmd"));
        expect(shell.calls.some((call) => call.args[0] === "update")).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("reports a failed verification list even if its output names the collection", async () => {
    const { base, shell, root } = makeHarness();
    let listCalls = 0;
    shell.answerWith((args) => {
      if (args[0] === "collection" && args[1] === "list") {
        listCalls++;
        return listCalls === 1
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "wiki--docs", stderr: "registry unavailable", exitCode: 2 };
      }
      if (args[0] === "collection" && args[1] === "add") {
        return { stdout: "", stderr: "already registered", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    try {
      const failure = await reconcileCollections(
        base,
        parseQmdConfig(undefined),
        "wiki",
        new Map([["wiki--docs", "P:/docs"]]),
      );

      expect(failure).toEqual({
        code: "QMD_FAILED",
        args: ["collection", "list"],
        exitCode: 2,
        step: "collection list",
        stderr: "registry unavailable",
      });
      expect(shell.calls.some((call) => call.args[0] === "update")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a failed add when a successful follow-up list confirms the collection", async () => {
    const { base, shell, root } = makeHarness();
    let listCalls = 0;
    shell.answerWith((args) => {
      if (args[0] === "collection" && args[1] === "list") {
        listCalls++;
        return {
          stdout: listCalls === 1 ? "" : "  wiki--docs  P:/docs\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "collection" && args[1] === "add") {
        return { stdout: "", stderr: "already registered", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    try {
      const failure = await reconcileCollections(
        base,
        parseQmdConfig(undefined),
        "wiki",
        new Map([["wiki--docs", "P:/docs"]]),
      );

      expect(failure).toBeNull();
      expect(listCalls).toBe(2);
      expect(shell.calls.some((call) => call.args[0] === "update")).toBe(true);
      expect(shell.calls.some((call) => call.args[0] === "embed")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips embed when asked and reports update failures", async () => {
    const { base, shell, root } = makeHarness();
    shell.answerWith((args) => {
      if (args[0] === "update") return { stdout: "", stderr: "update boom", exitCode: 3 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const failure = await reconcileCollections(
      base,
      parseQmdConfig(undefined),
      "wiki",
      new Map([["wiki--docs", "P:/d"]]),
      { embed: false },
    );

    expect(failure).toEqual({
      code: "QMD_FAILED",
      args: ["update"],
      exitCode: 3,
      step: "update",
      stderr: "update boom",
    });
    expect(shell.calls.some((c) => c.args[0] === "embed")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("can defer reindexing while multiple label groups are reconciled", async () => {
    const { base, shell, root } = makeHarness();

    const failure = await reconcileCollections(
      base,
      parseQmdConfig(undefined),
      "wiki",
      new Map([["wiki--docs", "P:/d"]]),
      { update: false, embed: false },
    );

    expect(failure).toBeNull();
    expect(shell.calls.some((call) => call.args[0] === "update")).toBe(false);
    expect(shell.calls.some((call) => call.args[0] === "embed")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
