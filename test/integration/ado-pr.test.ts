import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createAzureDevOps } from "../../src/ado";
import { syncPullRequests, listPullRequests, getPullRequest } from "../../src/pr";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";

describe("Azure DevOps PR Integration (Phase 12)", () => {
  test("queries and synchronizes real pull requests from ADO fixture", async () => {
    await ensureAdoFixture();
    const config = getAdoFixtureConfig();
    const tempRoot = await mkdtemp(join(tmpdir(), "dev-ado-pr-int-"));

    try {
      const client = createAzureDevOps({
        organization: config.organization,
        token: config.pat,
      });

      // 1. Live ADO query
      const prs = await client.listPullRequests(config.repoName, {
        project: config.project,
        status: "active",
      });

      expect(prs.length).toBeGreaterThan(0);
      const pr1 = prs[0];
      expect(pr1.title).toContain("payments");
      expect(pr1.sourceRefName).toContain("feature/payments");
      expect(pr1.targetRefName).toContain("main");

      // 2. Query single PR
      const single = await client.getPullRequest(config.repoName, pr1.pullRequestId, {
        project: config.project,
      });
      expect(single.pullRequestId).toBe(pr1.pullRequestId);
      expect(single.title).toBe(pr1.title);

      // 3. Sync to local cache
      const tenant = `dev.azure.com/${config.organization}`;
      const syncRes = await syncPullRequests({
        root: tempRoot,
        tenant,
        repo: config.repoName,
        client,
        project: config.project,
      });

      expect(syncRes.total).toBeGreaterThan(0);
      expect(existsSync(syncRes.cachePath)).toBe(true);

      // 4. Prove offline availability
      const offlineList = await listPullRequests({
        root: tempRoot,
        tenant,
        repo: config.repoName,
        offline: true,
      });

      expect(offlineList.length).toBe(syncRes.total);
      expect(offlineList[0].id).toBe(pr1.pullRequestId);

      // 5. Offline get
      const offlineGet = await getPullRequest({
        root: tempRoot,
        id: pr1.pullRequestId,
        tenant,
        repo: config.repoName,
        offline: true,
      });

      expect(offlineGet).toBeDefined();
      expect(offlineGet?.id).toBe(pr1.pullRequestId);
      expect(offlineGet?.title).toBe(pr1.title);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
