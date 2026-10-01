import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeInventory,
  readInventory,
  resolveInventoryCachePath,
  loadAllCachedInventories,
  loadAllCachedPullRequests,
  loadAllCachedWorkItems,
  readPullRequests,
  readPullRequestSelection,
  readWorkItems,
  resolvePrCachePath,
  resolveWorkItemCachePath,
  writePullRequests,
  writePullRequestSelection,
  writeWorkItems,
  type InventoryRecord,
  type PullRequestRecord,
  type WorkItemRecord,
} from "../../src/cache";

describe("Inventory Cache (JSONL)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cache-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("resolves correct cache path for multi-segment tenant", () => {
    const path = resolveInventoryCachePath(tempRoot, "dev.azure.com/example-org");
    const expected = join(
      tempRoot,
      ".dev",
      "cache",
      "inventory",
      "dev.azure.com",
      "example-org",
      "repos.jsonl",
    );
    expect(path).toBe(expected);
  });

  test("readInventory returns empty array when file does not exist", async () => {
    const records = await readInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
    });
    expect(records).toEqual([]);
  });

  test("rejects pull request selection traversal outside the dev root", async () => {
    const root = join(tempRoot, "root");
    const outsidePath = join(tempRoot, "outside.jsonl");
    const originalContent = "private data\n";
    await Bun.write(outsidePath, originalContent);
    const options = { root, tenant: "../../../..", name: "outside" };

    await expect(readPullRequestSelection(options)).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    await expect(writePullRequestSelection({ ...options, records: [] })).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    expect(await Bun.file(outsidePath).text()).toBe(originalContent);
  });

  test("writeInventory writes atomic JSONL and readInventory reads it back", async () => {
    const items: InventoryRecord[] = [
      {
        id: "101",
        name: "alpha-service",
        url: "https://dev.azure.com/example-org/example-project/_git/alpha-service",
        default_branch: "main",
        description: "Alpha service description",
        last_changed: "2026-09-14T19:48:10.52Z",
        syncedAt: "2026-09-14T21:00:00.00Z",
        project: "example-project",
      },
      {
        id: "102",
        name: "payments-core",
        url: "https://dev.azure.com/example-org/example-project/_git/payments-core",
        default_branch: "master",
        description: "",
        last_changed: "2026-09-14T20:00:00.00Z",
        syncedAt: "2026-09-14T21:00:00.00Z",
      },
    ];

    const cachePath = await writeInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      records: items,
    });

    const expectedPath = resolveInventoryCachePath(tempRoot, "dev.azure.com/example-org");
    expect(cachePath).toBe(expectedPath);

    // Verify raw file content is valid JSONL (one JSON object per line)
    const fileContent = await Bun.file(cachePath).text();
    const lines = fileContent.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(items[0]);
    expect(JSON.parse(lines[1])).toEqual(items[1]);

    // Verify readInventory returns identical records
    const readRecords = await readInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
    });

    expect(readRecords).toHaveLength(2);
    expect(readRecords[0]).toEqual(items[0]);
    expect(readRecords[1]).toEqual(items[1]);
  });

  test("readInventory skips blank lines and whitespace", async () => {
    const cachePath = resolveInventoryCachePath(tempRoot, "dev.azure.com/example-org");
    await Bun.write(
      cachePath,
      '\n{"id":"1","name":"repo1","url":"https://example.com","default_branch":"main","description":"","last_changed":"","syncedAt":""}\n\n   \n',
    );

    const records = await readInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
    });

    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("repo1");
  });

  test("parallel writes execute atomically without corrupting cache", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeInventory({
        root: tempRoot,
        tenant: "dev.azure.com/example-org",
        records: [
          {
            id: `batch-${i}`,
            name: `repo-${i}`,
            url: `https://example.com/repo-${i}`,
            default_branch: "main",
            description: `Batch ${i}`,
            last_changed: new Date().toISOString(),
            syncedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    await Promise.all(writes);

    const records = await readInventory({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
    });

    expect(records.length).toBe(1);
    expect(records[0].id).toMatch(/^batch-\d+$/);
  });

  test("warns once with the count of malformed rows and keeps valid cache records", async () => {
    const tenant = "sample-tenant";
    const repo = "sample-api";
    const project = "sample-project";
    const inventoryRecord: InventoryRecord = {
      id: "1",
      name: repo,
      url: "https://example.org/sample-api",
      default_branch: "main",
      description: "",
      last_changed: "",
      syncedAt: "2026-10-01T00:00:00Z",
    };
    const pullRequestRecord: PullRequestRecord = {
      id: 1,
      title: "Change",
      description: "",
      status: "open",
      sourceBranch: "feature",
      targetBranch: "main",
      author: "sample-user",
      url: "https://example.org/sample-api/1",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      isDraft: false,
      repository: repo,
      project,
      tenant,
      syncedAt: "2026-10-01T00:00:00Z",
    };
    const workItemRecord: WorkItemRecord = {
      id: 1,
      type: "Task",
      title: "Change",
      state: "Active",
      url: "https://example.org/sample-api/1",
      tenant,
      project,
      syncedAt: "2026-10-01T00:00:00Z",
    };

    const inventoryPath = await writeInventory({
      root: tempRoot,
      tenant,
      records: [inventoryRecord],
    });
    const prPath = await writePullRequests({
      root: tempRoot,
      tenant,
      repo,
      project,
      records: [pullRequestRecord],
    });
    const selectionPath = await writePullRequestSelection({
      root: tempRoot,
      tenant,
      name: "selection",
      records: [pullRequestRecord],
    });
    const workItemPath = await writeWorkItems({
      root: tempRoot,
      tenant,
      project,
      records: [workItemRecord],
    });
    for (const path of [inventoryPath, prPath, selectionPath, workItemPath]) {
      await Bun.write(path, `${await Bun.file(path).text()}\n \t\r\nnot-json\n{\n\n`);
    }

    const warn = spyOn(console, "warn");
    try {
      expect((await readInventory({ root: tempRoot, tenant })).map((record) => record.id)).toEqual([
        "1",
      ]);
      expect((await loadAllCachedInventories(tempRoot)).map((record) => record.id)).toEqual(["1"]);
      expect(
        (await readPullRequests({ root: tempRoot, tenant, repo, project })).map(
          (record) => record.id,
        ),
      ).toEqual([1]);
      expect(
        (await readPullRequestSelection({ root: tempRoot, tenant, name: "selection" }))?.map(
          (record) => record.id,
        ),
      ).toEqual([1]);
      expect((await loadAllCachedPullRequests(tempRoot)).map((record) => record.id)).toEqual([1]);
      expect(
        (await readWorkItems({ root: tempRoot, tenant, project })).map((record) => record.id),
      ).toEqual([1]);
      expect((await readWorkItems({ root: tempRoot, tenant })).map((record) => record.id)).toEqual([
        1,
      ]);
      expect((await loadAllCachedWorkItems(tempRoot)).map((record) => record.id)).toEqual([1]);

      expect(warn).toHaveBeenCalledTimes(8);
      expect(warn.mock.calls.map((call) => call[1])).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
      expect(warn.mock.calls.every((call) => call[0] === "Skipped malformed cache rows")).toBe(
        true,
      );
      expect(resolvePrCachePath(tempRoot, tenant, repo, project)).toBe(prPath);
      expect(resolveWorkItemCachePath(tempRoot, tenant, project)).toBe(workItemPath);
    } finally {
      warn.mockRestore();
    }
  });
});
