import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import * as fs from "../../src/fs";
import { writeInventory, type InventoryRecord } from "../../src/cache";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";
import { writeAdoProviderConfig } from "../fixtures/dev-config";
import { gitPoolPath } from "../../src/paths";

describe("CLI E2E - Repository Selection from Inventory (Phase 11)", () => {
  let tempRoot: string;
  let adoConfig: ReturnType<typeof getAdoFixtureConfig>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-sel-e2e-"));
    await ensureAdoFixture();
    adoConfig = getAdoFixtureConfig();
    await writeAdoProviderConfig(tempRoot, adoConfig.organization, adoConfig.project);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("dev ws add selects repository by name from local inventory cache", async () => {
    // 1. Initialize workspace
    const initExit = await runCli({
      argv: ["ws", "init", "feature-work", "--root", tempRoot],
      cwd: tempRoot,
      env: {},
      isTTY: false,
    });
    expect(initExit).toBe(0);

    // 2. Populate inventory cache with fixture repository
    const records: InventoryRecord[] = [
      {
        id: "fixture-alpha-id",
        name: adoConfig.repoName,
        url: adoConfig.gitUrl,
        default_branch: "main",
        description: "Alpha test service",
        last_changed: "2026-09-14T20:00:00Z",
        syncedAt: "2026-09-14T21:00:00Z",
        project: adoConfig.project,
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: `dev.azure.com/${adoConfig.organization}`,
      records,
    });

    // 3. Mount repository by name only: dev ws add alpha-service --ws feature-work
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const addExit = await runCli({
        argv: ["ws", "add", "alpha-service", "--ws", "feature-work", "--root", tempRoot],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(addExit).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("Mounted repository 'alpha-service' in workspace 'feature-work'");

      // Verify worktree exists on disk
      const mountPath = join(tempRoot, "ws", "feature-work", "alpha-service");
      expect(fs.exists(mountPath)).toBe(true);

      // Verify ws status reports clean
      logs.length = 0;
      const statusExit = await runCli({
        argv: ["ws", "status", "--ws", "feature-work", "--root", tempRoot, "--json"],
        cwd: tempRoot,
        env: {},
        isTTY: false,
      });

      expect(statusExit).toBe(0);
      const statusJson = JSON.parse(logs[logs.length - 1]);
      expect(statusJson.mounts).toHaveLength(1);
      expect(statusJson.mounts[0].state).toBe("clean");
    } finally {
      console.log = origLog;
    }
  });

  test("dev mirror add selects repository by name from local inventory cache", async () => {
    // Populate inventory cache
    const records: InventoryRecord[] = [
      {
        id: "fixture-alpha-id",
        name: adoConfig.repoName,
        url: adoConfig.gitUrl,
        default_branch: "main",
        description: "Alpha test service",
        last_changed: "2026-09-14T20:00:00Z",
        syncedAt: "2026-09-14T21:00:00Z",
        project: adoConfig.project,
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: `dev.azure.com/${adoConfig.organization}`,
      records,
    });

    // Run: dev mirror add alpha-service (name instead of URL)
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const addExit = await runCli({
        argv: ["mirror", "add", "alpha-service", "--root", tempRoot],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(addExit).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("✓ Mirrored ");

      // Verify canonical path exists
      const canonicalPath = join(
        tempRoot,
        "mirrors",
        "dev.azure.com",
        adoConfig.organization,
        adoConfig.project,
        "alpha-service",
      );
      expect(fs.exists(canonicalPath)).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("reports helpful error when repository name is not found in cache", async () => {
    await runCli({
      argv: ["ws", "init", "dummy-ws", "--root", tempRoot],
      cwd: tempRoot,
      env: {},
      isTTY: false,
    });

    const errorLogs: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => errorLogs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["ws", "add", "nonexistent-pkg", "--ws", "dummy-ws", "--root", tempRoot],
        cwd: tempRoot,
        env: {},
        isTTY: false,
      });

      expect(exitCode).toBe(1);
      const errOut = errorLogs.join("\n");
      expect(errOut).toContain("No repository matching 'nonexistent-pkg' found in local inventory");
      expect(errOut).toContain("dev sync inventory");
    } finally {
      console.error = origError;
    }
  });

  test("proves repository selection works completely offline with existing cache and mirror", async () => {
    // 1. Initial add to seed mirror
    await runCli({
      argv: ["ws", "init", "online-ws", "--root", tempRoot],
      cwd: tempRoot,
      env: {},
      isTTY: false,
    });

    const records: InventoryRecord[] = [
      {
        id: "fixture-alpha-id",
        name: adoConfig.repoName,
        url: adoConfig.gitUrl,
        default_branch: "main",
        description: "Alpha test service",
        last_changed: "2026-09-14T20:00:00Z",
        syncedAt: "2026-09-14T21:00:00Z",
        project: adoConfig.project,
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: `dev.azure.com/${adoConfig.organization}`,
      records,
    });

    const onlineExitCode = await runCli({
      argv: ["ws", "add", "alpha-service", "--ws", "online-ws", "--root", tempRoot],
      cwd: tempRoot,
      env: { AZURE_DEVOPS_PAT: adoConfig.pat },
      isTTY: false,
    });
    expect(onlineExitCode).toBe(0);
    expect(fs.exists(gitPoolPath({ root: tempRoot, source: adoConfig.gitUrl }))).toBe(true);

    // 2. Initialize second workspace offline
    await runCli({
      argv: ["ws", "init", "offline-ws", "--root", tempRoot],
      cwd: tempRoot,
      env: {},
      isTTY: false,
    });

    // 3. Mount repository by name ONLY while offline (no PAT, no network calls needed)
    const exitCode = await runCli({
      argv: ["ws", "add", "alpha-service", "--ws", "offline-ws", "--root", tempRoot],
      cwd: tempRoot,
      env: {}, // zero credentials
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    const offlineMount = join(tempRoot, "ws", "offline-ws", "alpha-service");
    expect(fs.exists(offlineMount)).toBe(true);
  });
});
