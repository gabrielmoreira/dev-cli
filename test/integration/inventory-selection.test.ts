import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInputSource, resolveRepositorySource } from "../../src/inventory";
import { writeInventory, type InventoryRecord } from "../../src/cache";

describe("Inventory Source Resolution Integration (Phase 11)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-inv-sel-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("resolves explicit Git URL directly without reading cache", async () => {
    const explicitUrl = "https://github.com/my-org/core-lib.git";
    const res = await resolveRepositorySource({
      root: tempRoot,
      query: explicitUrl,
    });

    expect(res.sourceUrl).toBe(explicitUrl);
    expect(res.matches).toHaveLength(0);
  });

  test("resolves single matching repository from local cache by name", async () => {
    const records: InventoryRecord[] = [
      {
        id: "1",
        name: "alpha-service",
        url: "https://dev.azure.com/example-org/example-project/_git/alpha-service",
        default_branch: "main",
        description: "Alpha service microservice",
        last_changed: "2026-09-14T20:00:00Z",
        syncedAt: "2026-09-14T21:00:00Z",
      },
      {
        id: "2",
        name: "payments-core",
        url: "https://dev.azure.com/example-org/example-project/_git/payments-core",
        default_branch: "main",
        description: "Payments processing",
        last_changed: "2026-09-14T20:00:00Z",
        syncedAt: "2026-09-14T21:00:00Z",
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      records,
    });

    // Resolve by exact name
    const exactRes = await resolveRepositorySource({
      root: tempRoot,
      query: "alpha-service",
    });

    expect(exactRes.sourceUrl).toBe(records[0].url);
    expect(exactRes.record?.name).toBe("alpha-service");

    // Resolve by partial name when unique
    const partialRes = await resolveRepositorySource({
      root: tempRoot,
      query: "payments",
    });

    expect(partialRes.sourceUrl).toBe(records[1].url);
    expect(partialRes.record?.name).toBe("payments-core");
  });

  test("returns multiple matches when query is ambiguous", async () => {
    const records: InventoryRecord[] = [
      {
        id: "1",
        name: "alpha-service",
        url: "https://dev.azure.com/org/lab/_git/alpha-service",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
      },
      {
        id: "2",
        name: "alpha-worker",
        url: "https://dev.azure.com/org/lab/_git/alpha-worker",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: "dev.azure.com/org",
      records,
    });

    const res = await resolveRepositorySource({
      root: tempRoot,
      query: "alpha",
    });

    expect(res.sourceUrl).toBeUndefined();
    expect(res.matches).toHaveLength(2);
  });

  test("resolves duplicate names by ADO organization and project", async () => {
    const records: InventoryRecord[] = [
      {
        id: "1",
        name: "ado-bot",
        url: "https://dev.azure.com/example-org/retail-app/_git/ado-bot",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
        project: "retail-app",
      },
      {
        id: "2",
        name: "ado-bot",
        url: "https://dev.azure.com/example-org/sandbox-project/_git/ado-bot",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
        project: "sandbox-project",
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      records,
    });

    const result = await resolveRepositorySource({
      root: tempRoot,
      query: "ado:example-org:retail-app:ado-bot",
    });

    expect(result.sourceUrl).toBe(records[0].url);
    expect(result.record?.project).toBe("retail-app");
  });

  test("keeps duplicate repository names ambiguous without an ADO selector", async () => {
    const records: InventoryRecord[] = [
      {
        id: "1",
        name: "expo-hello-world",
        url: "https://dev.azure.com/example-org/retail-app/_git/expo-hello-world",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
        project: "retail-app",
      },
      {
        id: "2",
        name: "expo-hello-world",
        url: "https://dev.azure.com/example-org/expo-hello-world/_git/expo-hello-world",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
        project: "expo-hello-world",
      },
    ];

    await writeInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      records,
    });

    const result = await resolveRepositorySource({
      root: tempRoot,
      query: "expo-hello-world",
    });

    expect(result.sourceUrl).toBeUndefined();
    expect(result.matches).toHaveLength(2);
  });

  test("returns empty matches when query does not match any cached repository", async () => {
    const res = await resolveRepositorySource({
      root: tempRoot,
      query: "nonexistent",
    });

    expect(res.sourceUrl).toBeUndefined();
    expect(res.matches).toHaveLength(0);
  });

  test("never selects a disabled repository and names it when asked for", async () => {
    const base = {
      default_branch: "main",
      description: "",
      last_changed: "",
      syncedAt: "",
      project: "example-project",
    };
    await writeInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      records: [
        { ...base, id: "1", name: "legacy-app", url: "https://x/_git/legacy-app", disabled: true },
        { ...base, id: "2", name: "legacy-api", url: "https://x/_git/legacy-api" },
      ],
    });

    const picker = await resolveRepositorySource({ root: tempRoot });
    expect(picker.matches.map((r) => r.name)).toEqual(["legacy-api"]);

    const named = await resolveInputSource(tempRoot, "legacy-app");
    expect(named.sourceUrl).toBeUndefined();
    expect(named.error).toContain("disabled in Azure DevOps");
  });
});
