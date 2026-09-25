import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinFactories,
  buildIntegrations,
  createPluginBase,
  emit,
} from "../../src/plugins/index.ts";
import type { IntegrationFactory, PluginBase } from "../../src/plugins/index.ts";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) fn();
});

function makeBase(): PluginBase {
  const root = mkdtempSync(join(tmpdir(), "dev-cli-plugins-"));
  return createPluginBase(root);
}

/** Registers temporary factories, restoring the built-in list afterwards. */
function withFactories(factories: IntegrationFactory[]): void {
  const originals = [...builtinFactories];
  builtinFactories.length = 0;
  builtinFactories.push(...factories);
  cleanups.push(() => {
    builtinFactories.length = 0;
    builtinFactories.push(...originals);
  });
}

describe("plugin registry", () => {
  it("builds integrations from factories in order", () => {
    const base = makeBase();
    withFactories([
      (b) => ({ name: "first-" + b.root.slice(-6), run: async () => {} }),
      () => ({ name: "second", run: async () => {} }),
    ]);
    const integrations = buildIntegrations(base);
    expect(integrations.map((i) => i.name)).toEqual([integrations[0].name, "second"]);
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

  it("skips integrations without a hook for the stage", async () => {
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
