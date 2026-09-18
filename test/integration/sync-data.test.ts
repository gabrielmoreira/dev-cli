import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzureDevOps } from "../../src/ado";
import { syncData } from "../../src/sync";
import * as cache from "../../src/cache";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";

describe("Combined Offline Data Sync Integration (Phase 14)", () => {
  let fixtureConfig: ReturnType<typeof getAdoFixtureConfig>;
  let tempRoot: string;

  beforeAll(async () => {
    fixtureConfig = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-sync-data-integ-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("synchronizes inventory, work items, and PRs, then proves offline availability", async () => {
    const client = createAzureDevOps({
      organization: fixtureConfig.organization,
      token: fixtureConfig.pat,
    });

    const tenant = `dev.azure.com/${fixtureConfig.organization}`;

    // 1. Perform online combined sync
    const result = await syncData({
      root: tempRoot,
      tenant,
      project: fixtureConfig.project,
      client,
      repos: [fixtureConfig.repoName],
    });

    expect(result.inventory.total).toBeGreaterThan(0);
    expect(result.workItems).toBeDefined();
    expect(result.workItems!.total).toBeGreaterThan(0);
    expect(result.pullRequests.length).toBeGreaterThan(0);

    // 2. Verify all cache files were populated on disk
    const invPath = cache.resolveInventoryCachePath(tempRoot, tenant);
    expect(existsSync(invPath)).toBe(true);
    const cachedRepos = await cache.readInventory({ root: tempRoot, tenant });
    expect(cachedRepos.length).toBeGreaterThan(0);

    const wiPath = cache.resolveWorkItemCachePath(tempRoot, tenant, fixtureConfig.project);
    expect(existsSync(wiPath)).toBe(true);
    const cachedWis = await cache.readWorkItems({
      root: tempRoot,
      tenant,
      project: fixtureConfig.project,
    });
    expect(cachedWis.length).toBeGreaterThan(0);

    const prPath = cache.resolvePrCachePath(tempRoot, tenant, fixtureConfig.repoName);
    expect(existsSync(prPath)).toBe(true);
    const cachedPrs = await cache.readPullRequests({
      root: tempRoot,
      tenant,
      repo: fixtureConfig.repoName,
    });
    expect(cachedPrs.length).toBeGreaterThan(0);

    // 3. Prove offline readability with zero network access
    const offlineInventories = await cache.loadAllCachedInventories(tempRoot);
    expect(offlineInventories.some((r) => r.name === fixtureConfig.repoName)).toBe(true);

    const offlineWis = await cache.loadAllCachedWorkItems(tempRoot);
    expect(offlineWis.length).toBeGreaterThan(0);
    expect(offlineWis[0].title).toBeDefined();
  });
});
