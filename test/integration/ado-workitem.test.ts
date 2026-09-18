import { describe, expect, test, beforeAll } from "bun:test";
import { createAzureDevOps } from "../../src/ado";
import { getAdoFixtureConfig, ensureAdoFixture } from "../fixtures/ado-fixture";

describe("Azure DevOps Work Item Integration (Phase 13)", () => {
  let config: ReturnType<typeof getAdoFixtureConfig>;

  beforeAll(async () => {
    config = await ensureAdoFixture();
  });

  test("queries and retrieves real work items from ADO project", async () => {
    const client = createAzureDevOps({
      organization: config.organization,
      token: config.pat,
    });

    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${config.project}' ORDER BY [System.ChangedDate] DESC`;
    const refs = await client.queryWorkItems(wiql, { project: config.project });

    expect(refs.length).toBeGreaterThan(0);
    const targetId = config.workItemId || refs[0].id;

    const item = await client.getWorkItem(targetId, { project: config.project });
    expect(item).toBeDefined();
    expect(item.id).toBe(targetId);
    expect(item.fields["System.TeamProject"]).toBe(config.project);
    expect(item.fields["System.Title"]).toBeDefined();
    expect(typeof item.fields["System.Title"]).toBe("string");
  });
});
