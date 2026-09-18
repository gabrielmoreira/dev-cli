import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
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
    expect(serialized).toContain('default_root = "work"');
    expect(serialized).toContain("[roots.personal]");
    expect(serialized).toContain('path = "C:/Users/ExampleUser/dev"');
    expect(serialized).toContain("[roots.work]");
    expect(serialized).toContain('path = "C:/Users/ExampleUser/Projects/Work"');

    const reparsed = parseGlobalToml(serialized);
    expect(reparsed).toEqual(parsed);
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
