import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";
import { writeAdoProviderConfig } from "../fixtures/dev-config";

describe("CLI E2E - dev wi (Phase 13)", () => {
  let tempRoot: string;
  let adoConfig: ReturnType<typeof getAdoFixtureConfig>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-wi-cli-e2e-"));
    await ensureAdoFixture();
    adoConfig = getAdoFixtureConfig();
    await writeAdoProviderConfig(tempRoot, adoConfig.organization, adoConfig.project);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("dev wi list --json retrieves and caches work items from ADO fixture", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["wi", "list", "--project", adoConfig.project, "--root", tempRoot, "--json"],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      expect(logs.length).toBeGreaterThan(0);

      const parsed = JSON.parse(logs[logs.length - 1]);
      // Online multi-provider shape: { items: [...], errors: [] }
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);

      const item = items.find((w: any) => w.title.includes("payment"));
      expect(item).toBeDefined();
      expect(item.project).toBe(adoConfig.project);
    } finally {
      console.log = origLog;
    }
  });

  test("dev wi list prints human readable summary table", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["wi", "list", "--project", adoConfig.project, "--root", tempRoot],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("payment");
    } finally {
      console.log = origLog;
    }
  });

  test("dev wi view retrieves details of a work item", async () => {
    // 1. First sync via list
    await runCli({
      argv: ["wi", "list", "--project", adoConfig.project, "--root", tempRoot],
      cwd: tempRoot,
      env: {
        AZURE_DEVOPS_PAT: adoConfig.pat,
      },
      isTTY: false,
    });

    const targetId = String(adoConfig.workItemId || 1);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: [
          "wi",
          "view",
          targetId,
          "--project",
          adoConfig.project,
          "--root",
          tempRoot,
          "--json",
        ],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(logs[logs.length - 1]);
      expect(parsed.id).toBe(Number(targetId));
      expect(parsed.title).toContain("payment");
    } finally {
      console.log = origLog;
    }
  });

  test("proves offline access to cached work items with zero credentials", async () => {
    // 1. Initial sync online
    await runCli({
      argv: ["wi", "list", "--project", adoConfig.project, "--root", tempRoot],
      cwd: tempRoot,
      env: {
        AZURE_DEVOPS_PAT: adoConfig.pat,
      },
      isTTY: false,
    });

    // 2. Query offline without any credentials
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: [
          "wi",
          "list",
          "--project",
          adoConfig.project,
          "--root",
          tempRoot,
          "--offline",
          "--json",
        ],
        cwd: tempRoot,
        env: {}, // zero credentials
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(logs[logs.length - 1]);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].title).toContain("payment");
    } finally {
      console.log = origLog;
    }
  });
});
