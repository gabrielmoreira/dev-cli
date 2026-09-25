import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AzureDevOpsClient } from "../../src/ado";
import { syncData, type SyncDataDeps } from "../../src/sync";
import type { InventorySyncResult } from "../../src/inventory";
import type { InventoryRecord } from "../../src/cache";
import type { WorkItemSyncResult } from "../../src/workitem";
import type { PrSyncResult } from "../../src/pr";
import type { MirrorSyncResult } from "../../src/mirror";

/** The provider returned exactly the cached records. */
function withFetched(
  result: Omit<InventorySyncResult, "fetched" | "removed">,
): InventorySyncResult {
  return { ...result, removed: 0, fetched: result.repositories };
}

describe("Combined Offline Data Sync Pure Orchestration (Phase 14)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-sync-unit-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("syncData coordinates inventory, work items, and pull requests in order", async () => {
    const fakeClient = {} as AzureDevOpsClient;
    const executionOrder: string[] = [];

    const mockDeps: SyncDataDeps = {
      inventory: {
        syncInventory: async (input) => {
          executionOrder.push("inventory");
          expect(input.tenant).toBe("dev.azure.com/example-org");
          return withFetched({
            tenant: input.tenant,
            cachePath: join(input.root, ".dev/cache/inventory/repos.jsonl"),
            total: 2,
            added: 1,
            updated: 1,
            repositories: [
              {
                id: "1",
                name: "alpha-service",
                url: "https://dev.azure.com/example-org/example-project/_git/alpha-service",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "2026-09-15T12:00:00Z",
              },
              {
                id: "2",
                name: "beta-service",
                url: "https://dev.azure.com/example-org/example-project/_git/beta-service",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "2026-09-15T12:00:00Z",
              },
            ],
          });
        },
      },
      workitem: {
        syncWorkItems: async (input) => {
          executionOrder.push("workitem");
          expect(input.project).toBe("example-project");
          return {
            tenant: input.tenant,
            project: input.project,
            cachePath: join(input.root, ".dev/cache/workitems/items.jsonl"),
            total: 5,
            added: 2,
            updated: 3,
            items: [],
          } as WorkItemSyncResult;
        },
      },
      pr: {
        syncPullRequests: async (input) => {
          executionOrder.push(`pr:${input.repo}`);
          return {
            tenant: input.tenant,
            repo: input.repo,
            cachePath: join(input.root, `.dev/cache/pr/${input.repo}.jsonl`),
            total: 1,
            added: 1,
            updated: 0,
            prs: [],
          } as PrSyncResult;
        },
      },
      mirror: {
        sync: async () => {
          executionOrder.push("mirror");
          return {
            updated: [],
            skipped: [],
            stashed: [],
            trace: { totalMs: 0, stages: [], slowestItems: [] },
          } as MirrorSyncResult;
        },
      },
    };

    const result = await syncData(
      {
        root: tempRoot,
        tenant: "dev.azure.com/example-org",
        project: "example-project",
        client: fakeClient,
        syncCanonical: true,
      },
      mockDeps,
    );

    expect(executionOrder).toEqual([
      "inventory",
      "workitem",
      "pr:alpha-service",
      "pr:beta-service",
      "mirror",
    ]);

    expect(result.inventory.total).toBe(2);
    expect(result.workItems?.total).toBe(5);
    expect(result.pullRequests.length).toBe(2);
    expect(result.canonicalRepos).toBeDefined();
    expect(result.timestamp).toBeDefined();
  });

  test("syncData respects explicit repos filter for pull request syncing", async () => {
    const fakeClient = {} as AzureDevOpsClient;
    const syncedPrRepos: string[] = [];

    const mockDeps: SyncDataDeps = {
      inventory: {
        syncInventory: async (input) =>
          withFetched({
            tenant: input.tenant,
            cachePath: "path",
            total: 3,
            added: 0,
            updated: 0,
            repositories: [
              {
                id: "1",
                name: "repo-1",
                url: "url1",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "",
              },
              {
                id: "2",
                name: "repo-2",
                url: "url2",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "",
              },
              {
                id: "3",
                name: "repo-3",
                url: "url3",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "",
              },
            ],
          }),
      },
      workitem: {
        syncWorkItems: async () => ({
          tenant: "",
          project: "",
          cachePath: "",
          total: 0,
          added: 0,
          updated: 0,
          items: [],
        }),
      },
      pr: {
        syncPullRequests: async (input) => {
          syncedPrRepos.push(input.repo);
          return {
            tenant: input.tenant,
            repo: input.repo,
            cachePath: "",
            total: 0,
            added: 0,
            updated: 0,
            prs: [],
          };
        },
      },
    };

    await syncData(
      {
        root: tempRoot,
        tenant: "dev.azure.com/example-org",
        project: "example-project",
        client: fakeClient,
        repos: ["repo-2"],
      },
      mockDeps,
    );

    expect(syncedPrRepos).toEqual(["repo-2"]);
  });

  test("syncData handles partial pull request failure gracefully", async () => {
    const fakeClient = {} as AzureDevOpsClient;

    const mockDeps: SyncDataDeps = {
      inventory: {
        syncInventory: async (input) =>
          withFetched({
            tenant: input.tenant,
            cachePath: "path",
            total: 2,
            added: 0,
            updated: 0,
            repositories: [
              {
                id: "1",
                name: "failing-repo",
                url: "u1",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "",
              },
              {
                id: "2",
                name: "working-repo",
                url: "u2",
                default_branch: "main",
                description: "",
                last_changed: "",
                syncedAt: "",
              },
            ],
          }),
      },
      workitem: {
        syncWorkItems: async () => ({
          tenant: "",
          project: "",
          cachePath: "",
          total: 0,
          added: 0,
          updated: 0,
          items: [],
        }),
      },
      pr: {
        syncPullRequests: async (input) => {
          if (input.repo === "failing-repo") {
            throw new Error("Network timeout on failing-repo");
          }
          return {
            tenant: input.tenant,
            repo: input.repo,
            cachePath: "",
            total: 1,
            added: 1,
            updated: 0,
            prs: [],
          };
        },
      },
    };

    const result = await syncData(
      {
        root: tempRoot,
        tenant: "dev.azure.com/example-org",
        project: "example-project",
        client: fakeClient,
      },
      mockDeps,
    );

    expect(result.pullRequests.length).toBe(1);
    expect(result.pullRequests[0].repo).toBe("working-repo");
    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBe(1);
    expect(result.errors?.[0]).toContain("failing-repo");
  });

  test("syncData reads pull requests only for enabled repositories this run fetched", async () => {
    const record = (id: string, extra: Partial<InventoryRecord> = {}): InventoryRecord => ({
      id,
      name: id,
      url: id,
      default_branch: "main",
      description: "",
      last_changed: "",
      syncedAt: "",
      project: "example-project",
      ...extra,
    });
    const synced: string[] = [];
    const mockDeps: SyncDataDeps = {
      inventory: {
        syncInventory: async (input) => ({
          tenant: input.tenant,
          cachePath: "path",
          total: 3,
          added: 0,
          updated: 2,
          removed: 0,
          // other-project-repo stays in the cache but this run did not fetch it.
          repositories: [record("active"), record("gone", { disabled: true }), record("other")],
          fetched: [record("active"), record("gone", { disabled: true })],
        }),
      },
      workitem: {
        syncWorkItems: async () => {
          throw new Error("not under test");
        },
      },
      pr: {
        syncPullRequests: async (input) => {
          synced.push(input.repo);
          return {
            tenant: input.tenant,
            repo: input.repo,
            cachePath: "",
            total: 0,
            added: 0,
            updated: 0,
            prs: [],
          };
        },
      },
    };

    const result = await syncData(
      {
        root: tempRoot,
        tenant: "dev.azure.com/example-org",
        project: "example-project",
        client: {} as AzureDevOpsClient,
      },
      mockDeps,
    );

    expect(synced).toEqual(["active"]);
    expect(result.skippedDisabled).toEqual(["gone"]);
  });
});
