import { describe, expect, test } from "bun:test";
import {
  normalizeAdoRepository,
  mergeInventoryRecords,
  pruneMissingRecords,
  syncInventory,
} from "../../src/inventory";
import type { AdoRepository, AzureDevOpsClient } from "../../src/ado";
import type { InventoryRecord } from "../../src/cache";

describe("Inventory Orchestration and Normalization", () => {
  test("normalizeAdoRepository normalizes branch, url, and metadata", () => {
    const rawRepo: AdoRepository = {
      id: "uuid-123",
      name: "auth-service",
      url: "https://dev.azure.com/my-org/_apis/git/repositories/uuid-123",
      remoteUrl: "https://token@dev.azure.com/my-org/core/_git/auth-service",
      webUrl: "https://dev.azure.com/my-org/core/_git/auth-service",
      defaultBranch: "refs/heads/feature/payments",
      project: {
        id: "p1",
        name: "core",
        description: "Core project",
        lastUpdateTime: "2026-09-01T12:00:00Z",
      },
    };

    const record = normalizeAdoRepository(rawRepo, "2026-09-14T21:00:00Z");

    expect(record.id).toBe("uuid-123");
    expect(record.name).toBe("auth-service");
    expect(record.default_branch).toBe("feature/payments");
    expect(record.url).toBe("https://dev.azure.com/my-org/core/_git/auth-service");
    expect(record.url).not.toContain("token@");
    expect(record.description).toBe("Core project");
    expect(record.last_changed).toBe("2026-09-01T12:00:00Z");
    expect(record.syncedAt).toBe("2026-09-14T21:00:00Z");
    expect(record.project).toBe("core");
  });

  test("normalizeAdoRepository handles missing optional fields gracefully", () => {
    const rawRepo: AdoRepository = {
      id: "uuid-456",
      name: "empty-service",
      url: "https://dev.azure.com/my-org/_apis/git/repositories/uuid-456",
    };

    const record = normalizeAdoRepository(rawRepo, "2026-09-14T21:00:00Z");

    expect(record.default_branch).toBe("main");
    expect(record.url).toBe("https://dev.azure.com/my-org/_apis/git/repositories/uuid-456");
    expect(record.description).toBe("");
    expect(record.last_changed).toBe("2026-09-14T21:00:00Z");
  });

  test("mergeInventoryRecords updates existing and appends new records", () => {
    const existing: InventoryRecord[] = [
      {
        id: "1",
        name: "service-a",
        url: "https://example.com/a",
        default_branch: "master",
        description: "Old description",
        last_changed: "2026-01-01",
        syncedAt: "2026-01-01",
      },
      {
        id: "2",
        name: "service-b",
        url: "https://example.com/b",
        default_branch: "main",
        description: "Service B",
        last_changed: "2026-01-01",
        syncedAt: "2026-01-01",
      },
    ];

    const incoming: InventoryRecord[] = [
      {
        id: "1", // Update service-a
        name: "service-a",
        url: "https://example.com/a",
        default_branch: "main", // branch updated
        description: "Updated description",
        last_changed: "2026-09-14",
        syncedAt: "2026-09-14",
      },
      {
        id: "3", // New service-c
        name: "service-c",
        url: "https://example.com/c",
        default_branch: "main",
        description: "New service",
        last_changed: "2026-09-14",
        syncedAt: "2026-09-14",
      },
    ];

    const merged = mergeInventoryRecords(existing, incoming);

    expect(merged).toHaveLength(3);
    const serviceA = merged.find((r) => r.id === "1");
    expect(serviceA?.default_branch).toBe("main");
    expect(serviceA?.description).toBe("Updated description");

    const serviceB = merged.find((r) => r.id === "2");
    expect(serviceB).toBeDefined();

    const serviceC = merged.find((r) => r.id === "3");
    expect(serviceC).toBeDefined();
  });

  test("syncInventory fetches, normalizes, merges, and writes cache", async () => {
    let writtenTenant = "";
    let writtenRecords: InventoryRecord[] = [];

    const fakeCache = {
      resolveInventoryCachePath: () => "/fake/path/repos.jsonl",
      readInventory: async () => [
        {
          id: "old-1",
          name: "existing-repo",
          url: "https://dev.azure.com/org/p/_git/existing-repo",
          default_branch: "main",
          description: "",
          last_changed: "2026-01-01",
          syncedAt: "2026-01-01",
        },
      ],
      writeInventory: async (opts: { tenant: string; records: InventoryRecord[] }) => {
        writtenTenant = opts.tenant;
        writtenRecords = opts.records;
        return "/fake/path/repos.jsonl";
      },
    };

    const fakeClient: Pick<AzureDevOpsClient, "listRepositories"> = {
      listRepositories: async () => [
        {
          id: "new-2",
          name: "alpha-service",
          url: "https://dev.azure.com/org/p/_apis/git/repositories/new-2",
          webUrl: "https://dev.azure.com/org/p/_git/alpha-service",
          defaultBranch: "refs/heads/main",
        },
      ],
    };

    const result = await syncInventory(
      {
        root: "/fake/root",
        tenant: "dev.azure.com/my-org",
        client: fakeClient,
        project: "p",
        now: () => "2026-09-14T21:00:00Z",
      },
      { cache: fakeCache as any },
    );

    expect(result.tenant).toBe("dev.azure.com/my-org");
    expect(result.total).toBe(2);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(writtenTenant).toBe("dev.azure.com/my-org");
    expect(writtenRecords).toHaveLength(2);
    expect(result.removed).toBe(0);
    expect(result.fetched.map((r) => r.name)).toEqual(["alpha-service"]);
  });

  test("pruneMissingRecords drops only in-scope records the provider stopped returning", () => {
    const record = (id: string, project?: string): InventoryRecord => ({
      id,
      name: id,
      url: `https://dev.azure.com/org/${project}/_git/${id}`,
      default_branch: "main",
      description: "",
      last_changed: "",
      syncedAt: "",
      project,
    });
    const existing = [record("kept", "p"), record("deleted", "p"), record("elsewhere", "q")];
    const incoming = [record("kept", "p")];

    expect(pruneMissingRecords(existing, incoming, "P").map((r) => r.id)).toEqual([
      "kept",
      "elsewhere",
    ]);
    expect(pruneMissingRecords(existing, incoming).map((r) => r.id)).toEqual(["kept"]);
  });

  test("normalizeAdoRepository keeps the disabled flag and clears it when re-enabled", () => {
    const raw: AdoRepository = { id: "1", name: "old", url: "u", isDisabled: true };
    const disabled = normalizeAdoRepository(raw);
    expect(disabled.disabled).toBe(true);
    const enabled = normalizeAdoRepository({ ...raw, isDisabled: false });
    expect(mergeInventoryRecords([disabled], [enabled])[0].disabled).toBeUndefined();
  });
});
