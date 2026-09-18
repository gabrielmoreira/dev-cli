import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdoWorkItem, AzureDevOpsClient } from "../../src/ado";
import type { WorkItemRecord } from "../../src/cache";
import {
  normalizeAdoWorkItem,
  mergeWorkItemRecords,
  syncWorkItems,
  listWorkItems,
  getWorkItem,
} from "../../src/workitem";
import * as cache from "../../src/cache";

describe("Work Item Orchestration and Normalization (Phase 13)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-wi-unit-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("normalizeAdoWorkItem converts raw ADO item into canonical WorkItemRecord", () => {
    const raw: AdoWorkItem = {
      id: 42,
      url: "https://dev.azure.com/org/proj/_apis/wit/workItems/42",
      fields: {
        "System.Id": 42,
        "System.Title": "Add payment webhook retry",
        "System.WorkItemType": "Issue",
        "System.State": "To Do",
        "System.Description": "Handle transient network partitions.",
        "System.CreatedBy": { displayName: "Example User", uniqueName: "user@example.com" },
        "System.AssignedTo": { displayName: "Example User" },
        "System.CreatedDate": "2026-09-10T12:00:00Z",
        "System.ChangedDate": "2026-09-12T15:30:00Z",
        "System.TeamProject": "example-project",
        "System.AreaPath": "example-project\\Core",
        "System.IterationPath": "example-project\\Sprint 1",
      },
    };

    const record = normalizeAdoWorkItem(
      raw,
      "dev.azure.com/org",
      "example-project",
      "2026-09-14T20:00:00Z",
    );

    expect(record.id).toBe(42);
    expect(record.title).toBe("Add payment webhook retry");
    expect(record.type).toBe("Issue");
    expect(record.state).toBe("To Do");
    expect(record.author).toBe("Example User");
    expect(record.assignedTo).toBe("Example User");
    expect(record.description).toBe("Handle transient network partitions.");
    expect(record.areaPath).toBe("example-project\\Core");
    expect(record.iterationPath).toBe("example-project\\Sprint 1");
    expect(record.tenant).toBe("dev.azure.com/org");
    expect(record.project).toBe("example-project");
    expect(record.syncedAt).toBe("2026-09-14T20:00:00Z");
  });

  test("mergeWorkItemRecords updates existing and appends new records", () => {
    const existing: WorkItemRecord[] = [
      {
        id: 1,
        title: "Old title",
        type: "Issue",
        state: "To Do",
        url: "url/1",
        tenant: "tenant",
        project: "proj",
        syncedAt: "2026-09-01T00:00:00Z",
      },
      {
        id: 2,
        title: "Existing Item 2",
        type: "Task",
        state: "Done",
        url: "url/2",
        tenant: "tenant",
        project: "proj",
        syncedAt: "2026-09-01T00:00:00Z",
      },
    ];

    const incoming: WorkItemRecord[] = [
      {
        id: 1,
        title: "Updated Title 1",
        type: "Issue",
        state: "Doing",
        url: "url/1",
        tenant: "tenant",
        project: "proj",
        syncedAt: "2026-09-14T00:00:00Z",
      },
      {
        id: 3,
        title: "New Item 3",
        type: "Bug",
        state: "To Do",
        url: "url/3",
        tenant: "tenant",
        project: "proj",
        syncedAt: "2026-09-14T00:00:00Z",
      },
    ];

    const merged = mergeWorkItemRecords(existing, incoming);

    expect(merged.length).toBe(3);
    // Descending order by ID
    expect(merged[0].id).toBe(3);
    expect(merged[1].id).toBe(2);
    expect(merged[2].id).toBe(1);
    expect(merged[2].title).toBe("Updated Title 1");
    expect(merged[2].state).toBe("Doing");
  });

  test("writeWorkItems and readWorkItems roundtrip through JSONL cache", async () => {
    const items: WorkItemRecord[] = [
      {
        id: 10,
        title: "Test Item 10",
        type: "Task",
        state: "To Do",
        url: "url/10",
        tenant: "dev.azure.com/my-org",
        project: "core",
        syncedAt: "2026-09-14T00:00:00Z",
      },
    ];

    const cachePath = await cache.writeWorkItems({
      root: tempRoot,
      tenant: "dev.azure.com/my-org",
      project: "core",
      records: items,
    });

    expect(cachePath).toContain("my-org");
    expect(cachePath).toContain("core.jsonl");

    const read = await cache.readWorkItems({
      root: tempRoot,
      tenant: "dev.azure.com/my-org",
      project: "core",
    });

    expect(read.length).toBe(1);
    expect(read[0].id).toBe(10);
    expect(read[0].title).toBe("Test Item 10");
  });

  test("syncWorkItems orchestrates query, fetch, merge, and persistence", async () => {
    let queryOptions: { project?: string; top?: number } | undefined;
    const fakeClient: Partial<AzureDevOpsClient> = {
      queryWorkItems: async (_wiql, options) => {
        queryOptions = options;
        return [{ id: 1, url: "https://dev.azure.com/org/_apis/wit/workItems/1" }];
      },
      getWorkItems: async () => [
        {
          id: 1,
          url: "https://dev.azure.com/org/_apis/wit/workItems/1",
          fields: {
            "System.Id": 1,
            "System.Title": "Fix timeout",
            "System.WorkItemType": "Issue",
            "System.State": "To Do",
            "System.TeamProject": "core",
          },
        },
      ],
    };

    const result = await syncWorkItems({
      root: tempRoot,
      tenant: "dev.azure.com/my-org",
      project: "core",
      limit: 50,
      client: fakeClient as AzureDevOpsClient,
    });

    expect(result.total).toBe(1);
    expect(result.added).toBe(1);
    expect(result.items[0].title).toBe("Fix timeout");
    expect(queryOptions).toEqual({ project: "core", top: 50 });

    const cached = await listWorkItems({
      root: tempRoot,
      tenant: "dev.azure.com/my-org",
      project: "core",
      offline: true,
    });

    expect(cached.length).toBe(1);
    expect(cached[0].id).toBe(1);

    const single = await getWorkItem({
      root: tempRoot,
      id: 1,
      tenant: "dev.azure.com/my-org",
      project: "core",
      offline: true,
    });

    expect(single).toBeDefined();
    expect(single?.title).toBe("Fix timeout");
  });
});
