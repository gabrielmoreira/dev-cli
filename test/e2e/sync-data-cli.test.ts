import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";
import { writeAdoProviderConfig } from "../fixtures/dev-config";

describe("CLI E2E - dev sync data (Phase 14)", () => {
  let fixtureConfig: ReturnType<typeof getAdoFixtureConfig>;
  let tempRoot: string;

  beforeAll(async () => {
    fixtureConfig = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-sync-data-e2e-"));
    // Write dev.yaml so sync data finds the provider
    await writeAdoProviderConfig(tempRoot, fixtureConfig.organization, fixtureConfig.project);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("dev sync data --json coordinates and caches all data types", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: [
          "sync",
          "data",
          "--root",
          tempRoot,
          "--project",
          fixtureConfig.project,
          "--repos",
          fixtureConfig.repoName,
          "--json",
        ],
        cwd: tempRoot,
        env: {
          ...process.env,
          AZURE_DEVOPS_PAT: fixtureConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      expect(logs.length).toBeGreaterThan(0);

      const parsed = JSON.parse(logs[logs.length - 1]);
      expect(parsed.inventory).toBeDefined();
      expect(parsed.inventory.total).toBeGreaterThan(0);
      expect(parsed.workItems).toBeDefined();
      expect(parsed.workItems.total).toBeGreaterThan(0);
      expect(parsed.pullRequests).toBeDefined();
      expect(parsed.pullRequests.length).toBeGreaterThan(0);
      expect(parsed.timestamp).toBeDefined();
    } finally {
      console.log = origLog;
    }
  });

  test("dev sync data prints human readable combined summary", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: [
          "sync",
          "data",
          "--root",
          tempRoot,
          "--project",
          fixtureConfig.project,
          "--repos",
          fixtureConfig.repoName,
        ],
        cwd: tempRoot,
        env: {
          ...process.env,
          AZURE_DEVOPS_PAT: fixtureConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("Data synchronization complete");
      expect(output).toContain("Repositories:");
      expect(output).toContain("Work Items:");
      expect(output).toContain("Pull Requests:");
    } finally {
      console.log = origLog;
    }
  });

  test("proves offline access to combined cache with zero credentials", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["sync", "data", "--root", tempRoot, "--offline"],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: "",
          AZURE_DEVOPS_EXT_PAT: "",
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("Offline Cached Data");
      expect(output).toContain("Repositories:");
      expect(output).toContain("Work Items:");
      expect(output).toContain("Pull Requests:");
    } finally {
      console.log = origLog;
    }
  });
});
