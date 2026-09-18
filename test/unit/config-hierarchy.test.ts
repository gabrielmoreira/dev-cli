import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import { resolveConfig } from "../../src/config.ts";

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
});
