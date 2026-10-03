import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type WorksetDefinition } from "../../src/config.ts";
import { createWorkset, memberSetupCommand, setWorksetSetup } from "../../src/workset.ts";

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dev-cli-workset-setup-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeConfig(root: string, body: string): Promise<void> {
  await Bun.write(join(root, "dev.yaml"), `version: 1\n${body}`);
}

describe("workset setup configuration", () => {
  test("reads the command from the workset and overrides on its members", async () => {
    await withRoot(async (root) => {
      await writeConfig(
        root,
        `worksets:
  incident:
    setup: mise install
    members:
      - source: https://github.com/example/checkout-api.git
        setup: npm ci
      - source: https://github.com/example/checkout-docs.git
        setup: false
      - source: https://github.com/example/checkout-web.git
`,
      );
      const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });
      const incident = config.worksets.incident!;
      expect(incident.setup).toBe("mise install");
      expect(incident.members.map((member) => member.setup)).toEqual(["npm ci", false, undefined]);
    });
  });

  test("refuses a setup command on a label member, which belongs to each declared source", async () => {
    await withRoot(async (root) => {
      await writeConfig(
        root,
        `worksets:
  incident:
    members:
      - label: backend
        setup: mise install
`,
      );
      expect(() => resolveConfig({ rootFlag: root, cwd: root, env: {} })).toThrow();
    });
  });

  test("resolves one member to its own command, the request override, or the workset default", () => {
    const definition: WorksetDefinition = {
      setup: "mise install",
      members: [
        { source: "https://github.com/example/checkout-api.git" },
        { source: "https://github.com/example/checkout-docs.git", setup: "npm ci" },
        { source: "https://github.com/example/checkout-web.git", setup: false },
      ],
    };
    const [inheriting, overriding, optingOut] = definition.members;

    expect(memberSetupCommand(definition, inheriting!)).toBe("mise install");
    expect(memberSetupCommand(definition, inheriting!, "bun install")).toBe("bun install");
    expect(memberSetupCommand(definition, overriding!, "bun install")).toBe("npm ci");
    expect(memberSetupCommand(definition, optingOut!, "bun install")).toBeUndefined();
  });

  test("saves and clears the workset command in dev.yaml", async () => {
    await withRoot(async (root) => {
      await writeConfig(
        root,
        `worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
`,
      );
      const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });

      const saved = await setWorksetSetup(config, "incident", "mise install");
      expect(saved.setup).toBe("mise install");
      expect(config.worksets.incident?.setup).toBe("mise install");
      expect(await readFile(join(root, "dev.yaml"), "utf8")).toContain("setup: mise install");

      const cleared = await setWorksetSetup(config, "incident", undefined);
      expect(cleared.setup).toBeUndefined();
      expect(config.worksets.incident?.setup).toBeUndefined();
      expect(await readFile(join(root, "dev.yaml"), "utf8")).not.toContain("setup:");
    });
  });

  test("createWorkset persists a workset-level command and its member overrides", async () => {
    await withRoot(async (root) => {
      await writeConfig(root, "");
      const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });

      const { created } = await createWorkset(config, "incident", {
        setup: "mise install",
        members: [
          { source: "https://github.com/example/checkout-api.git" },
          { source: "https://github.com/example/checkout-docs.git", setup: false },
        ],
      });

      expect(created).toBe(true);
      const saved = await readFile(join(root, "dev.yaml"), "utf8");
      expect(saved).toContain("setup: mise install");
      expect(saved).toContain("setup: false");
      const reloaded = resolveConfig({ rootFlag: root, cwd: root, env: {} });
      expect(reloaded.worksets.incident?.setup).toBe("mise install");
      expect(reloaded.worksets.incident?.members[1]?.setup).toBe(false);
    });
  });

  test("setWorksetSetup names an unknown workset instead of silently doing nothing", async () => {
    await withRoot(async (root) => {
      await writeConfig(root, "");
      const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });

      await expect(setWorksetSetup(config, "missing", "mise install")).rejects.toMatchObject({
        code: "WORKSET_NOT_FOUND",
      });
    });
  });
});
