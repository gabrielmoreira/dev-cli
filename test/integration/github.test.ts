import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { resolveGitHubCredential } from "../../src/credentials";
import { createGitHubClient, syncGitHubInventory } from "../../src/github";
import * as cache from "../../src/cache";

describe("GitHub Integration & Cross-Provider Inventory (Phase 15)", () => {
  test("reads public repositories from github.com/octocat without mutation", async () => {
    const config = resolveConfig({
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    let token: string | undefined;

    try {
      const cred = await resolveGitHubCredential(config);
      token = cred.token;
    } catch {
      // Unauthenticated public API access fallback if token not configured
    }

    const client = createGitHubClient({ token });
    const repos = await client.listRepositories("octocat");

    expect(repos).toBeDefined();
    expect(repos.length).toBeGreaterThan(0);

    const first = repos[0];
    expect(first.name).toBeDefined();
    expect(first.html_url).toContain("github.com/octocat");

    // Fetch individual repository metadata
    const repoDetails = await client.getRepository("octocat", first.name);
    expect(repoDetails.name).toBe(first.name);
  });

  test("cross-provider inventory: cache can hold both Azure DevOps and GitHub records", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dev-cross-provider-"));

    try {
      const config = resolveConfig({
        cwd: tempRoot,
        rootFlag: tempRoot,
        env: process.env as Record<string, string>,
      });
      let token: string | undefined;
      try {
        const cred = await resolveGitHubCredential(config);
        token = cred.token;
      } catch {}

      const client = createGitHubClient({ token });

      // 1. Sync a public GitHub inventory without personal account defaults
      const ghResult = await syncGitHubInventory({
        root: tempRoot,
        owner: "octocat",
        client,
      });

      expect(ghResult.total).toBeGreaterThan(0);

      // 2. Add an Azure DevOps inventory record
      const adoTenant = "dev.azure.com/example-org";
      const adoRecord: cache.InventoryRecord = {
        id: "ado-1",
        name: "alpha-service",
        url: "https://dev.azure.com/example-org/example-project/_git/alpha-service",
        default_branch: "main",
        description: "Azure DevOps test service",
        last_changed: "2026-09-15T10:00:00Z",
        syncedAt: "2026-09-15T12:00:00Z",
        project: "example-project",
      };

      await cache.writeInventory({
        root: tempRoot,
        tenant: adoTenant,
        records: [adoRecord],
      });

      // 3. Load all cached inventories across providers
      const allCached = await cache.loadAllCachedInventories(tempRoot);
      expect(allCached.length).toBeGreaterThan(1);

      const hasAdo = allCached.some((r) => r.url.includes("dev.azure.com"));
      const hasGitHub = allCached.some((r) => r.url.includes("github.com"));

      expect(hasAdo).toBe(true);
      expect(hasGitHub).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
