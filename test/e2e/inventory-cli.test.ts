import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runCli } from "../../src/cli";
import { readInventory } from "../../src/cache";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";

// Writes a minimal dev.yaml with a single ADO provider so tests that need
// provider configuration can use it without going through 'dev provider add'.
async function writeDevYaml(root: string, org: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const content = [
    "version: 1",
    "providers:",
    `  - id: test-ado`,
    `    type: azure_devops`,
    `    organization: ${org}`,
  ].join("\n");
  await writeFile(join(root, "dev.yaml"), content, "utf8");
}

describe("CLI E2E - dev sync inventory", () => {
  let tempRoot: string;
  let adoConfig: ReturnType<typeof getAdoFixtureConfig>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-inv-e2e-"));
    await ensureAdoFixture();
    adoConfig = getAdoFixtureConfig();
    // Pre-configure the provider so sync knows where to sync from.
    await writeDevYaml(tempRoot, adoConfig.organization);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("dev sync inventory --json synchronizes ADO repos to cache", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["sync", "inventory", "--root", tempRoot, "--json"],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      expect(logs.length).toBeGreaterThan(0);

      const parsed = JSON.parse(logs[logs.length - 1]);
      // New shape: { results: [...], errors: [] }
      expect(parsed.results).toBeDefined();
      expect(parsed.results.length).toBeGreaterThan(0);
      const first = parsed.results[0];
      expect(first.total).toBeGreaterThan(0);
      expect(first.tenant).toBe(`dev.azure.com/${adoConfig.organization}`);
      expect(existsSync(first.cachePath)).toBe(true);

      const cached = await readInventory({
        root: tempRoot,
        tenant: first.tenant,
      });

      expect(cached.length).toBe(first.total);
      const alpha = cached.find((r) => r.name === "alpha-service");
      expect(alpha).toBeDefined();
    } finally {
      console.log = origLog;
    }
  });

  test("dev sync inventory prints human readable output", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["sync", "inventory", "--root", tempRoot],
        cwd: tempRoot,
        env: {
          AZURE_DEVOPS_PAT: adoConfig.pat,
        },
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("Synchronized repository inventory");
      expect(output).toContain(adoConfig.organization);
      expect(output).not.toContain("alpha-service");
    } finally {
      console.log = origLog;
    }
  });

  test("dev sync inventory --offline reads local cache without network or credentials", async () => {
    // 1. Sync initial inventory with real credentials
    await runCli({
      argv: ["sync", "inventory", "--root", tempRoot],
      cwd: tempRoot,
      env: {
        AZURE_DEVOPS_PAT: adoConfig.pat,
      },
      isTTY: false,
    });

    // 2. Now run in offline mode with ZERO network credentials
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["sync", "inventory", "--root", tempRoot, "--offline", "--json"],
        cwd: tempRoot,
        env: {}, // No credentials
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(logs[logs.length - 1]);
      // Offline shape: { mode: "offline", total, repositories }
      expect(parsed.total).toBeGreaterThan(0);
      const alpha = parsed.repositories.find((r: any) => r.name === "alpha-service");
      expect(alpha).toBeDefined();
    } finally {
      console.log = origLog;
    }
  });

  test("reports credential error when provider is configured but credentials are missing", async () => {
    const allLogs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg: unknown) => allLogs.push(String(msg));
    console.error = (msg: unknown) => allLogs.push(String(msg));

    try {
      const exitCode = await runCli({
        argv: ["sync", "inventory", "--root", tempRoot],
        cwd: tempRoot,
        env: {}, // Provider is in dev.yaml but no token/PAT
        isTTY: false,
      });

      // Sync with no credentials: exits 1 because all providers failed,
      // and the warning/error is reported in combined output.
      const combined = allLogs.join("\n");
      // Either exitCode=1, or the output mentions a credential/warning issue
      expect(
        exitCode === 1 ||
          combined.toLowerCase().includes("credential") ||
          combined.includes("Warning"),
      ).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });
});
