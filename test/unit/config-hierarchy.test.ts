import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import { resolveConfig } from "../../src/config.ts";
import { describeError } from "../../src/cli/errors.ts";

describe("Hierarchical Root Resolution (Phase 2.4)", () => {
  it("prioritizes explicit rootFlag over all other discovery mechanisms", async () => {
    const config = resolveConfig({
      rootFlag: "C:/custom-root",
      cwd: "C:/some/cwd",
      env: { DEV_ROOT: "C:/env-root" },
    });
    expect(config.root.replace(/\\/g, "/")).toBe("C:/custom-root");
  });

  it("discovers root via upward directory traversal from cwd", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-hier-test-"));
    const nestedDir = join(tempDir, "ws", "feature-a", "src");
    await fs.ensureDir(nestedDir);
    await fs.writeText(join(tempDir, "dev.yaml"), "sync_strategy: ff-only\n");

    try {
      const config = resolveConfig({
        cwd: nestedDir,
        env: {},
      });
      expect(config.root.replace(/\\/g, "/")).toBe(tempDir.replace(/\\/g, "/"));
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("prioritizes DEV_ROOT environment variable when not inside a dev root", () => {
    const config = resolveConfig({
      cwd: tmpdir(),
      env: { DEV_ROOT: "C:/session-root" },
    });
    expect(config.root.replace(/\\/g, "/")).toBe("C:/session-root");
  });

  it("falls back to default_root in ~/.dev.toml when DEV_ROOT is not set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-home-test-"));
    const fakeToml = join(tempDir, ".dev.toml");
    await fs.writeText(
      fakeToml,
      `default_root = "work"

[roots.work]
path = "C:/WorkDev"
`,
    );

    try {
      const config = resolveConfig({
        cwd: tmpdir(),
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
        },
      });
      expect(config.root.replace(/\\/g, "/")).toBe("C:/WorkDev");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.each([
    ["unescaped Windows path", String.raw`path = "C:\Users\Example\dev"`],
    ["unfinished table", "[roots.work"],
  ])(
    "rejects invalid registry TOML instead of selecting ~/dev: %s",
    async (_label, invalidToml) => {
      const tempDir = await mkdtemp(join(tmpdir(), "dev-hierarchy-invalid-"));
      const registryPath = join(tempDir, ".dev.toml");
      const cwd = join(tempDir, "outside");
      try {
        await fs.ensureDir(cwd);
        await fs.writeText(
          registryPath,
          `private_value = "private-registry-value"\n${invalidToml}`,
        );
        let error: unknown;
        try {
          resolveConfig({ cwd, env: { HOME: tempDir, USERPROFILE: tempDir } });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty("cause", expect.any(Error));
        const described = describeError(error);
        expect(described.code).toBe("INVALID_GLOBAL_TOML");
        expect(described.details).toEqual({ path: registryPath });
        expect(described.message).toContain(registryPath);
        expect(described.message).toMatch(/forward slashes/i);
        expect(described.message).toMatch(/TOML escaping/i);
        expect(described.nextStep).toContain(registryPath);
        expect(JSON.stringify(described)).not.toContain("private-registry-value");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("propagates synchronous registry read failures without selecting ~/dev", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-hierarchy-read-error-"));
    const registryPath = join(tempDir, ".dev.toml");
    const cwd = join(tempDir, "outside");
    try {
      await fs.ensureDir(cwd);
      await fs.ensureDir(registryPath);
      let error: unknown;
      try {
        resolveConfig({ cwd, env: { HOME: tempDir, USERPROFILE: tempDir } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(describeError(error).code).not.toBe("INVALID_GLOBAL_TOML");
      expect(describeError(error).message).not.toMatch(/TOML escaping/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    [String.raw`"C:\\WorkDev"`, String.raw`C:\WorkDev`],
    [String.raw`'C:\WorkDev'`, String.raw`C:\WorkDev`],
  ])("resolves valid TOML Windows registry path %s unchanged", async (tomlPath, expectedPath) => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-hierarchy-windows-"));
    const cwd = join(tempDir, "outside");
    try {
      await fs.ensureDir(cwd);
      await fs.writeText(
        join(tempDir, ".dev.toml"),
        `default_root = "work"\n[roots.work]\npath = ${tomlPath}\n`,
      );
      const config = resolveConfig({ cwd, env: { HOME: tempDir, USERPROFILE: tempDir } });
      expect(config.rootSource).toBe("global");
      expect(config.root).toBe(expectedPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["flag", "file", "env"] as const)(
    "bypasses an invalid registry when root precedence selects %s",
    async (rootSource) => {
      const tempDir = await mkdtemp(join(tmpdir(), "dev-hierarchy-precedence-"));
      const root = join(tempDir, "chosen-root");
      const outside = join(tempDir, "outside");
      const nested = join(root, "nested");
      try {
        await fs.ensureDir(outside);
        await fs.ensureDir(nested);
        await fs.writeText(join(root, "dev.yaml"), "sync_strategy: ff-only\n");
        await fs.writeText(join(tempDir, ".dev.toml"), String.raw`path = "C:\Users\Example\dev"`);
        const config = resolveConfig({
          rootFlag: rootSource === "flag" ? root : undefined,
          cwd: rootSource === "file" ? nested : outside,
          env: {
            HOME: tempDir,
            USERPROFILE: tempDir,
            ...(rootSource === "env" ? { DEV_ROOT: root } : {}),
          },
        });
        expect(config.root).toBe(root);
        expect(config.rootSource).toBe(rootSource);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
