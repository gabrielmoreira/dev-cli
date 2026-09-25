import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

describe("Workspace initialization integration (Phase 1)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-test-root-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("creates workspace directory, .local folder and initial ws.md", async () => {
    const result = await ws.init({
      root: tempRoot,
      name: "checkout-payment-fix",
      description: "Investigate webhook idempotency",
    });

    expect(result.name).toBe("checkout-payment-fix");
    expect(result.path).toBe(join(tempRoot, "ws", "checkout-payment-fix"));
    expect(fs.exists(result.path)).toBe(true);
    expect(fs.exists(result.localPath)).toBe(true);
    expect(fs.exists(result.manifestPath)).toBe(true);

    const { manifest: readManifest, body } = await manifest.readWorkspace(result.manifestPath);
    expect(readManifest.version).toBe(1);
    expect(readManifest.name).toBe("checkout-payment-fix");
    expect(readManifest.description).toBe("Investigate webhook idempotency");
    expect(readManifest.mounts).toEqual([]);
    expect(body).toContain("# Workspace: checkout-payment-fix");
    expect(body).toContain("Investigate webhook idempotency");
  });

  it("refuses to overwrite an existing workspace", async () => {
    await ws.init({
      root: tempRoot,
      name: "collision-test",
    });

    try {
      await ws.init({
        root: tempRoot,
        name: "collision-test",
      });
      expect.unreachable("Should have thrown WORKSPACE_ALREADY_EXISTS");
    } catch (err) {
      expect(err).toBeInstanceOf(ws.WorkspaceError);
      const wsErr = err as ws.WorkspaceError;
      expect(wsErr.code).toBe("WORKSPACE_ALREADY_EXISTS");
    }
  });

  it("proves that generated workspace matches the exact structured model expected by use cases", async () => {
    const initResult = await ws.init({
      root: tempRoot,
      name: "model-test",
      description: "Structured model verification",
    });

    const read = await manifest.readWorkspace(initResult.manifestPath);
    expect(read.manifest.name).toBe(initResult.name);
    expect(new Date(read.manifest.created_at).getTime()).toBeGreaterThan(0);
    expect(Array.isArray(read.manifest.mounts)).toBe(true);
    expect(read.manifest.mounts.length).toBe(0);
  });

  it("returns an existing workspace when asked to reuse it, and refuses otherwise", async () => {
    const first = await ws.init({ root: tempRoot, name: "again", description: "first" });
    const again = await ws.init({ root: tempRoot, name: "again", reuseExisting: true });

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.path).toBe(first.path);
    expect(again.createdAt).toBe(first.createdAt);
    const { manifest: kept } = await manifest.readWorkspace(first.manifestPath);
    expect(kept.description).toBe("first");

    await expect(ws.init({ root: tempRoot, name: "again" })).rejects.toMatchObject({
      code: "WORKSPACE_ALREADY_EXISTS",
    });
  });
});
