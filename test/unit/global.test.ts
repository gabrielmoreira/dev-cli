import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import { describeError } from "../../src/cli/errors.ts";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  parseGlobalToml,
  resolveRootFromGlobal,
  saveGlobalConfig,
  serializeGlobalToml,
  type GlobalConfig,
} from "../../src/global.ts";

describe("Global Configuration (~/.dev.toml) (Phase 2.4)", () => {
  it("computes default global config path under user home directory", () => {
    const customHome = "C:/Users/TestUser";
    const path = getGlobalConfigPath(customHome);
    expect(path.replace(/\\/g, "/")).toBe("C:/Users/TestUser/.dev.toml");
  });

  it("parses empty or missing TOML into clean empty config", () => {
    const config = parseGlobalToml("");
    expect(config.default_root).toBeUndefined();
    expect(config.roots).toEqual({});
  });

  it("parses a quoted default root with a TOML inline comment", () => {
    expect(parseGlobalToml('default_root = "work" # active root')).toEqual({
      default_root: "work",
      roots: {},
    });
    expect(parseGlobalToml('default_root = "work"').default_root).toBe("work");
  });

  it("parses and serializes TOML with default root and named roots roundtrip", () => {
    const toml = `default_root = "work"

[roots.personal]
path = "C:/Users/ExampleUser/dev"

[roots.work]
path = "C:/Users/ExampleUser/Projects/Work"
`;

    const parsed = parseGlobalToml(toml);
    expect(parsed.default_root).toBe("work");
    expect(parsed.roots.personal?.path).toBe("C:/Users/ExampleUser/dev");
    expect(parsed.roots.work?.path).toBe("C:/Users/ExampleUser/Projects/Work");

    const serialized = serializeGlobalToml(parsed);

    const reparsed = parseGlobalToml(serialized);
    expect(reparsed).toEqual(parsed);
  });

  it("roundtrips escaped registry strings while normalizing Windows paths", () => {
    const config: GlobalConfig = {
      default_root: 'work"archive\\backup',
      roots: {
        work: { path: 'C:\\Projects\\"sample"\\workspace' },
      },
    };

    expect(parseGlobalToml(serializeGlobalToml(config))).toEqual({
      default_root: config.default_root,
      roots: { work: { path: 'C:/Projects/"sample"/workspace' } },
    });
  });

  it("roundtrips dotted root aliases as literal registry keys", () => {
    const config: GlobalConfig = {
      default_root: "sample.root",
      roots: { "sample.root": { path: "/tmp/sample-root" } },
    };

    expect(parseGlobalToml(serializeGlobalToml(config))).toEqual(config);
  });

  it.each([
    ['"C:/WorkDev"', "C:/WorkDev"],
    [String.raw`"C:\\WorkDev"`, String.raw`C:\WorkDev`],
    [String.raw`'C:\WorkDev'`, String.raw`C:\WorkDev`],
  ])("preserves a valid TOML Windows path %s", (tomlPath, expectedPath) => {
    expect(parseGlobalToml(`[roots.work]\npath = ${tomlPath}`).roots.work?.path).toBe(expectedPath);
  });

  it.each([
    ["unescaped Windows path", String.raw`path = "C:\Users\Example\dev"`],
    ["unfinished table", "[roots.work"],
    ["numeric default root", "default_root = 1"],
    ["scalar roots", 'roots = "bad"'],
    ["array roots", "roots = []"],
    ["scalar root entry", '[roots]\nwork = "bad"'],
    ["array root entry", "roots = { work = [] }"],
    ["missing root path", "[roots.work]"],
    ["non-string root path", "[roots.work]\npath = 1"],
  ])("reports invalid registry TOML from async loading: %s", async (_label, invalidToml) => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-global-invalid-"));
    const configPath = join(tempDir, ".dev.toml");
    try {
      await fs.writeText(configPath, `private_value = "private-registry-value"\n${invalidToml}`);
      const error: unknown = await loadGlobalConfig(configPath).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("cause", expect.any(Error));
      const described = describeError(error);
      expect(described.code).toBe("INVALID_GLOBAL_TOML");
      expect(described.details).toEqual({ path: configPath });
      expect(described.message).toContain(configPath);
      expect(described.message).toMatch(/forward slashes/i);
      expect(described.message).toMatch(/TOML escaping/i);
      expect(described.nextStep).toContain(configPath);
      expect(JSON.stringify(described)).not.toContain("private-registry-value");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves async registry read failures as filesystem errors", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-global-read-error-"));
    const configPath = join(tempDir, ".dev.toml");
    try {
      await fs.ensureDir(configPath);
      const error: unknown = await loadGlobalConfig(configPath).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(describeError(error).code).not.toBe("INVALID_GLOBAL_TOML");
      expect(describeError(error).message).not.toMatch(/TOML escaping/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads and saves config to disk atomically", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-global-test-"));
    const configPath = join(tempDir, ".dev.toml");

    try {
      // Missing file defaults to empty config
      const initial = await loadGlobalConfig(configPath);
      expect(initial.roots).toEqual({});

      // Save updated config
      const updated: GlobalConfig = {
        default_root: "main",
        roots: {
          main: { path: "D:/dev-main" },
        },
      };
      await saveGlobalConfig(updated, configPath);
      expect(fs.exists(configPath)).toBe(true);

      const reloaded = await loadGlobalConfig(configPath);
      expect(reloaded.default_root).toBe("main");
      expect(reloaded.roots.main?.path).toBe("D:/dev-main");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("resolves alias if present in global config, or returns raw path", () => {
    const config: GlobalConfig = {
      default_root: "work",
      roots: {
        work: { path: "C:/Projects/Work" },
        home: { path: "C:/Projects/Personal" },
      },
    };

    expect(resolveRootFromGlobal("work", config)).toBe("C:/Projects/Work");
    expect(resolveRootFromGlobal("home", config)).toBe("C:/Projects/Personal");
    expect(resolveRootFromGlobal("C:/Custom/Path", config)).toBe("C:/Custom/Path");
  });
});
