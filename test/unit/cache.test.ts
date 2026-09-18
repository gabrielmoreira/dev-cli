import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeInventory,
  readInventory,
  resolveInventoryCachePath,
  type InventoryRecord,
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
});
