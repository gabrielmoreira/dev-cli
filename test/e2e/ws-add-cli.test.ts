import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdoFixture, type AdoFixtureConfig } from "../fixtures/ado-fixture.ts";
import { writeAdoProviderConfig } from "../fixtures/dev-config.ts";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import { gitPoolPath, workspaceAdminRepoPath } from "../../src/paths.ts";

describe("dev ws add CLI E2E (Phase 2)", () => {
  let tempRoot: string;
  let fixture: AdoFixtureConfig;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    fixture = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-ws-add-"));
    await writeAdoProviderConfig(tempRoot, fixture.organization, fixture.project);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("mounts Azure DevOps fixture via CLI and proves agreement across all 4 locations", async () => {
    // 1. Initialize workspace
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "payment-fix", "--root", tempRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const initExit = await initProc.exited;
    expect(initExit).toBe(0);

    // 2. Add mount
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        fixture.gitUrl,
        "--root",
        tempRoot,
        "--ws",
        "payment-fix",
        "--branch",
        "main",
      ],
      {
        env: {
          ...process.env,
          AZURE_DEVOPS_PAT: fixture.pat,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const addStdout = await new Response(addProc.stdout).text();
    const addStderr = await new Response(addProc.stderr).text();
    const addExit = await addProc.exited;

    expect(addExit).toBe(0);
    expect(addStderr).toBe("");
    expect(addStdout).toContain("✓ Mounted alpha-service @ ");

    // 3. Prove all four locations agree
    const sourceKey = git.normalizeSourceKey(fixture.gitUrl);

    // Location 1: Central Mirror
    const mirrorPath = gitPoolPath({ root: tempRoot, source: fixture.gitUrl });
    expect(fs.exists(mirrorPath)).toBe(true);

    // Location 2: Workspace Admin Bare Repo
    const adminRepoPath = workspaceAdminRepoPath({
      root: tempRoot,
      workspaceName: "payment-fix",
      sourceKey: sourceKey,
    });
    expect(fs.exists(adminRepoPath)).toBe(true);

    // Location 3: Worktree Mount
    const mountPath = join(tempRoot, "ws", "payment-fix", "alpha-service");
    expect(fs.exists(mountPath)).toBe(true);
    expect(fs.exists(join(mountPath, "service.ts"))).toBe(true);

    // Location 4: Manifest ws.md
    const manifestPath = join(tempRoot, "ws", "payment-fix", "ws.md");
    const { manifest: readManifest } = await manifest.readWorkspace(manifestPath);
    expect(readManifest.mounts.length).toBe(1);
    expect(readManifest.mounts[0].path).toBe("alpha-service");
    expect(readManifest.mounts[0].source).toBe(fixture.gitUrl);
    expect(readManifest.mounts[0].revision).toEqual({ mode: "track", branch: "main" });
  });
});
