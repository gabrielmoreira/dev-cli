import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config.ts";
import { builtinFactories, buildPlugins, createPluginBase, emit } from "../../src/plugins/index.ts";
import type { PluginFactory, PluginBase } from "../../src/plugins/index.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function makeBase(): PluginBase {
  const root = mkdtempSync(join(tmpdir(), "dev-cli-plugins-"));
  return createPluginBase(root, resolveConfig({ rootFlag: root, cwd: root, env: {} }));
}

/** Registers temporary factories, restoring the built-in list afterwards. */
function withFactories(factories: PluginFactory[]): void {
  const originals = [...builtinFactories];
  builtinFactories.length = 0;
  builtinFactories.push(...factories);
  cleanups.push(() => {
    builtinFactories.length = 0;
    builtinFactories.push(...originals);
  });
}

describe("plugin registry", () => {
  it("builds plugins from factories in order", () => {
    const base = makeBase();
    withFactories([
      (b) => ({ name: "first-" + b.root.slice(-6), run: async () => {} }),
      () => ({ name: "second", run: async () => {} }),
    ]);
    const plugins = buildPlugins(base);
    expect(plugins.map((i) => i.name)).toEqual([plugins[0].name, "second"]);
    rmSync(base.root, { recursive: true, force: true });
  });
});

describe("emit", () => {
  it("delivers typed event data to hooks in registration order", async () => {
    const base = makeBase();
    const calls: string[] = [];
    withFactories([
      () => ({
        name: "a",
        run: async () => {},
        hooks: {
          "mirror:sync:after": (_b, data) => {
            calls.push(`a:${data.updated[0]?.sourceKey}:${data.updated[0]?.revision}`);
          },
        },
      }),
      () => ({
        name: "b",
        run: async () => {},
        hooks: {
          "mirror:sync:after": (_b, data) => {
            calls.push(`b:${data.updated.length}`);
          },
        },
      }),
    ]);

    await emit(base, "mirror:sync:after", {
      root: base.root,
      updated: [{ sourceKey: "k1", revision: "main" }],
    });

    expect(calls).toEqual(["a:k1:main", "b:1"]);
    rmSync(base.root, { recursive: true, force: true });
  });

  it("warns and continues when a hook throws", async () => {
    const base = makeBase();
    const warnings: string[] = [];
    const warnSpy = mock((msg: string) => warnings.push(msg));
    const originalWarn = console.warn;
    console.warn = warnSpy as unknown as typeof console.warn;

    withFactories([
      () => ({
        name: "boom",
        run: async () => {},
        hooks: {
          "label:add:after": () => {
            throw new Error("hook exploded");
          },
        },
      }),
      () => ({
        name: "survivor",
        run: async () => {},
        hooks: {
          "label:add:after": (_b, data) => {
            calls(data);
          },
        },
      }),
    ]);

    function calls(_data: {
      sourceKey: string;
      label: string;
      meta: Record<string, unknown>;
    }): void {
      warnings.push("survivor-ran");
    }

    try {
      await emit(base, "label:add:after", {
        root: base.root,
        sourceKey: "k",
        label: "x",
        meta: {},
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((w) => w.includes("boom") && w.includes("hook exploded"))).toBe(true);
    expect(warnings).toContain("survivor-ran");
    rmSync(base.root, { recursive: true, force: true });
  });

  it("skips plugins without a hook for the stage", async () => {
    const base = makeBase();
    let ran = false;
    withFactories([
      () => ({
        name: "no-hook",
        run: async () => {
          ran = true;
        },
      }),
    ]);

    await emit(base, "label:rm:after", { root: base.root, sourceKey: "k", label: "x" });
    expect(ran).toBe(false);
    rmSync(base.root, { recursive: true, force: true });
  });
});

describe("external plugins", () => {
  let base: PluginBase;
  let warnings: string[];

  beforeEach(() => {
    base = makeBase();
    cleanups.push(() => rmSync(base.root, { recursive: true, force: true }));
    withFactories([]);
    warnings = [];
    const warn = spyOn(base.ui, "warn").mockImplementation((message) => {
      warnings.push(String(message));
    });
    cleanups.push(() => warn.mockRestore());
  });

  it.each(["relative", "absolute"])("loads a configured factory from a %s path", async (kind) => {
    const module = join(base.root, "record #%.mjs");
    await Bun.write(
      module,
      `
      import { join } from "node:path";
      export default (base) => ({
        name: "recorder",
        run: async () => {},
        hooks: {
          "mirror:sync:after": async (_ctx, data) => {
            await base.fs.writeText(join(base.root, "calls.json"), JSON.stringify({
              updated: data.updated,
              message: base.config.plugins.recorder.message,
            }));
          },
        },
      });
    `,
    );
    base.config.plugins.recorder = {
      module: kind === "absolute" ? module : "record #%.mjs",
      message: "synced",
    };

    await emit(base, "mirror:sync:after", {
      root: base.root,
      updated: [{ sourceKey: "sample-api", revision: "main" }],
    });

    expect(await Bun.file(join(base.root, "calls.json")).exists()).toBe(true);
    expect(await Bun.file(join(base.root, "calls.json")).json()).toEqual({
      updated: [{ sourceKey: "sample-api", revision: "main" }],
      message: "synced",
    });
    expect(warnings).toEqual([]);
  });

  it.each([
    ["missing file", null],
    ["non-function default", "export default 42;"],
    ["import error", 'throw new Error("import exploded");'],
    ["factory error", 'export default () => { throw new Error("factory exploded"); };'],
    ["wrong plugin name", 'export default () => ({ name: "other", run: async () => {} });'],
  ])("warns once for a %s and runs other plugins", async (_kind, source) => {
    if (source !== null) await Bun.write(join(base.root, "broken.mjs"), source);
    await Bun.write(
      join(base.root, "survivor.mjs"),
      `
      import { join } from "node:path";
      export default (base) => ({
        name: "survivor",
        run: async () => {},
        hooks: { "mirror:sync:after": () => base.fs.writeText(join(base.root, "survived"), "yes") },
      });
    `,
    );
    base.config.plugins.broken = { module: "broken.mjs" };
    base.config.plugins.survivor = { module: "survivor.mjs" };

    await emit(base, "mirror:sync:after", { root: base.root, updated: [] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Plugin 'broken'");
    expect(await Bun.file(join(base.root, "survived")).text()).toBe("yes");
  });

  it("does not import unconfigured modules or plugins without module", async () => {
    await Bun.write(
      join(base.root, "ignored.mjs"),
      `
      import { join } from "node:path";
      await Bun.write(join(import.meta.dirname, "imported"), "yes");
      throw new Error("must not load");
    `,
    );
    base.config.plugins.ignored = { message: "not a module" };

    await emit(base, "mirror:sync:after", { root: base.root, updated: [] });

    expect(await Bun.file(join(base.root, "imported")).exists()).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("skips an external module when a built-in owns its name", async () => {
    let builtInRan = false;
    withFactories([
      () => ({
        name: "recorder",
        run: async () => {},
        hooks: {
          "mirror:sync:after": () => {
            builtInRan = true;
          },
        },
      }),
    ]);
    await Bun.write(
      join(base.root, "collision.mjs"),
      `
      await Bun.write(new URL("./imported", import.meta.url), "yes");
      export default () => ({ name: "recorder", run: async () => {} });
    `,
    );
    base.config.plugins.recorder = { module: "collision.mjs" };

    await emit(base, "mirror:sync:after", { root: base.root, updated: [] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Plugin 'recorder'");
    expect(warnings[0]).toContain("built-in");
    expect(await Bun.file(join(base.root, "imported")).exists()).toBe(false);
    expect(builtInRan).toBe(true);
  });
});
