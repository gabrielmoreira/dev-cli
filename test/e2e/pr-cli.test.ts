import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";
import { writeAdoProviderConfig } from "../fixtures/dev-config";

describe("CLI E2E - dev pr (Phase 12)", () => {
  let tempRoot: string;
  let adoConfig: ReturnType<typeof getAdoFixtureConfig>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-pr-cli-e2e-"));
    await ensureAdoFixture();
    adoConfig = getAdoFixtureConfig();
    await writeAdoProviderConfig(tempRoot, adoConfig.organization);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("dev pr list --json retrieves and caches pull requests from ADO fixture", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["pr", "list", adoConfig.repoName, "--root", tempRoot, "--json"],
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

      const pr = items.find((p: any) => p.sourceBranch === "feature/payments");
      expect(pr).toBeDefined();
      expect(pr.status).toBe("open");
      expect(pr.targetBranch).toBe("main");
    } finally {
      console.log = origLog;
    }
  });

  test("dev pr list prints human readable summary table", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["pr", "list", adoConfig.repoName, "--root", tempRoot],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("feature/payments");
      expect(output).toContain("main");
      expect(output).toContain("open");
    } finally {
      console.log = origLog;
    }
  });

  test("dev pr view retrieves details of a pull request", async () => {
    // 1. First sync via list
    await runCli({
      argv: ["pr", "list", adoConfig.repoName, "--root", tempRoot],
      cwd: tempRoot,
      env: {
        AZURE_DEVOPS_PAT: adoConfig.pat,
      },
      isTTY: false,
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["pr", "view", "1", "--repo", adoConfig.repoName, "--root", tempRoot, "--json"],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(logs[logs.length - 1]);
      expect(parsed.id).toBe(1);
      expect(parsed.title).toContain("payments");
    } finally {
      console.log = origLog;
    }
  });

  test("proves offline access to cached pull requests with zero credentials", async () => {
    // 1. Initial sync online
    await runCli({
      argv: ["pr", "list", adoConfig.repoName, "--root", tempRoot],
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
        argv: ["pr", "list", adoConfig.repoName, "--root", tempRoot, "--offline", "--json"],
        cwd: tempRoot,
        env: {}, // zero credentials
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(logs[logs.length - 1]);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].sourceBranch).toBe("feature/payments");
    } finally {
      console.log = origLog;
    }
  });
});
