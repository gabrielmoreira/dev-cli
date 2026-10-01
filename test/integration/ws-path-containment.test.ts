import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

async function failureFrom(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected rejection, got resolve");
}

describe("workspace mount path containment", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-path-containment-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  test("rejects invalid workspace names before lookup", async () => {
    const error = await failureFrom(ws.loadWorkspaceContext(root, "../outside"));
    expect(error.code).toBe("INVALID_WORKSPACE_NAME");
  });

  test("rejects an escaping duplicate source before reading its manifest or creating a target", async () => {
    const devRoot = join(root, "dev-root");
    const outsideManifest = join(root, "outside", "ws.md");
    await fs.ensureDir(join(root, "outside"));
    await manifest.writeWorkspace(outsideManifest, {
      version: 1,
      name: "outside",
      created_at: new Date(0).toISOString(),
      mounts: [],
    });
    const original = await fs.readText(outsideManifest);
    const error = await failureFrom(
      ws.duplicate({ root: devRoot, sourceName: "../../outside", targetName: "contained" }),
    );
    expect(error.code).toBe("INVALID_WORKSPACE_NAME");
    expect(fs.exists(devRoot)).toBe(false);
    expect(await fs.readText(outsideManifest)).toBe(original);
  });

  test("refuses to remove a manifest mount outside the workspace", async () => {
    await ws.init({ root, name: "contained" });
    const outside = join(root, "ws", "outside");
    await fs.ensureDir(outside);
    await fs.writeText(join(outside, "keep.txt"), "preserve me");
    await manifest.writeWorkspace(join(root, "ws", "contained", "ws.md"), {
      version: 1,
      name: "contained",
      created_at: new Date(0).toISOString(),
      mounts: [
        {
          path: "../outside",
          source: "https://example.com/repository.git",
          revision: { mode: "track", branch: "main" },
        },
      ],
    });

    await expect(
      ws.remove({
        root,
        workspaceName: "contained",
        mountPath: "../outside",
        force: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MOUNT_PATH" });
    expect(fs.exists(join(outside, "keep.txt"))).toBe(true);
  });

  test("refuses to create a manifest mount outside the workspace", async () => {
    await ws.init({ root, name: "contained" });
    await manifest.writeWorkspace(join(root, "ws", "contained", "ws.md"), {
      version: 1,
      name: "contained",
      created_at: new Date(0).toISOString(),
      mounts: [
        {
          path: "../outside",
          source: join(root, "missing.git"),
          revision: { mode: "track", branch: "main" },
        },
      ],
    });

    await expect(ws.update({ root, workspaceName: "contained" })).rejects.toMatchObject({
      code: "INVALID_MOUNT_PATH",
    });
    expect(fs.exists(join(root, "ws", "outside"))).toBe(false);
  });
});
