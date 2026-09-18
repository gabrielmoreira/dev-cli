import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdoFixture, type AdoFixtureConfig } from "../fixtures/ado-fixture.ts";
import * as fs from "../../src/fs.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";
import { gitPoolPath, workspaceAdminRepoPath } from "../../src/paths.ts";

describe("Workspace add Azure DevOps integration (Phase 2)", () => {
  let tempRoot: string;
  let fixture: AdoFixtureConfig;

  beforeAll(async () => {
    fixture = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-ado-root-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("mounts the real Azure DevOps alpha-service fixture repository into a workspace", async () => {
    // 1. Init workspace
    await ws.init({ root: tempRoot, name: "ado-test-ws" });

    // 2. Extra header with PAT for authenticated clone
    const basic = Buffer.from(`:${fixture.pat}`).toString("base64");
    const extraHeader = `http.extraheader=AUTHORIZATION: basic ${basic}`;

    // 3. Add mount
    const addResult = await ws.add({
      root: tempRoot,
      workspaceName: "ado-test-ws",
      source: fixture.gitUrl,
      branch: "main",
      extraHeader,
    });

    expect(addResult.workspaceName).toBe("ado-test-ws");
    expect(addResult.mountName).toBe("alpha-service");
    expect(addResult.revision.mode).toBe("track");

    // Verify 4 agreed locations:
    // A. Central bare mirror
    const mirrorPath = gitPoolPath({ root: tempRoot, source: fixture.gitUrl });
    expect(fs.exists(mirrorPath)).toBe(true);

    // B. Workspace admin bare clone
    const adminRepoPath = workspaceAdminRepoPath({
      root: tempRoot,
      workspaceName: "ado-test-ws",
      sourceKey: addResult.sourceKey,
    });
    expect(fs.exists(adminRepoPath)).toBe(true);

    // C. Mount worktree
    expect(fs.exists(addResult.mountPath)).toBe(true);
    expect(fs.exists(join(addResult.mountPath, "service.ts"))).toBe(true);
    expect(fs.exists(join(addResult.mountPath, "README.md"))).toBe(true);

    // D. Manifest ws.md
    const manifestPath = join(tempRoot, "ws", "ado-test-ws", "ws.md");
    const { manifest: readManifest } = await manifest.readWorkspace(manifestPath);
    expect(readManifest.mounts.length).toBe(1);
    expect(readManifest.mounts[0].path).toBe("alpha-service");
    expect(readManifest.mounts[0].source).toBe(fixture.gitUrl);
  });

  it("mounts a secondary branch from Azure DevOps simultaneously into the same workspace", async () => {
    const basic = Buffer.from(`:${fixture.pat}`).toString("base64");
    const extraHeader = `http.extraheader=AUTHORIZATION: basic ${basic}`;

    const addResult = await ws.add({
      root: tempRoot,
      workspaceName: "ado-test-ws",
      source: fixture.gitUrl,
      path: "payments-branch",
      branch: "feature/payments",
      extraHeader,
    });

    expect(addResult.mountName).toBe("payments-branch");
    expect(fs.exists(join(addResult.mountPath, "payments.ts"))).toBe(true);

    const manifestPath = join(tempRoot, "ws", "ado-test-ws", "ws.md");
    const { manifest: readManifest } = await manifest.readWorkspace(manifestPath);
    expect(readManifest.mounts.length).toBe(2);
  });
});
