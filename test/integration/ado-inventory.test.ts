import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createAzureDevOps } from "../../src/ado";
import { syncInventory } from "../../src/inventory";
import { readInventory } from "../../src/cache";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";

describe("Azure DevOps Integration - Inventory Discovery", () => {
  test("authenticates and lists projects and repositories against disposable ADO lab", async () => {
    await ensureAdoFixture();
    const config = getAdoFixtureConfig();

    const client = createAzureDevOps({
      organization: config.organization,
      token: config.pat,
    });

    // 1. List projects
    const projects = await client.listProjects();
    expect(projects.length).toBeGreaterThan(0);
    const labProject = projects.find((p) => p.name === config.project);
    expect(labProject).toBeDefined();
    expect(labProject?.id).toBeTruthy();

    // 2. List repositories across organization
    const orgRepos = await client.listRepositories();
    expect(orgRepos.length).toBeGreaterThan(0);
    const alphaService = orgRepos.find((r) => r.name === config.repoName);
    expect(alphaService).toBeDefined();
    expect(alphaService?.defaultBranch).toBe("refs/heads/main");

    // 3. List repositories scoped to project
    const projectRepos = await client.listRepositories(config.project);
    expect(projectRepos.length).toBeGreaterThan(0);
    const projectAlpha = projectRepos.find((r) => r.name === config.repoName);
    expect(projectAlpha).toBeDefined();
    expect(projectAlpha?.id).toBe(alphaService?.id);
  });

  test("syncs inventory from real ADO into cache and supports offline reading", async () => {
    await ensureAdoFixture();
    const config = getAdoFixtureConfig();
    const tempRoot = await mkdtemp(join(tmpdir(), "dev-ado-inv-"));

    try {
      const client = createAzureDevOps({
        organization: config.organization,
        token: config.pat,
      });

      const tenant = `dev.azure.com/${config.organization}`;
      const result = await syncInventory({
        root: tempRoot,
        tenant,
        client,
        project: config.project,
      });

      expect(result.total).toBeGreaterThan(0);
      expect(existsSync(result.cachePath)).toBe(true);

      // Prove offline guarantee: read inventory directly from cache with zero network access
      const cached = await readInventory({
        root: tempRoot,
        tenant,
      });

      expect(cached.length).toBe(result.total);
      const alpha = cached.find((r) => r.name === config.repoName);
      expect(alpha).toBeDefined();
      expect(alpha?.default_branch).toBe("main");
      expect(alpha?.url).toContain("dev.azure.com/example-org/example-project/_git/alpha-service");
      expect(alpha?.url).not.toContain("pat");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
