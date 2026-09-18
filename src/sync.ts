import type { AzureDevOpsClient } from "./ado";
import * as inventory from "./inventory";
import type { InventorySyncResult } from "./inventory";
import * as workitem from "./workitem";
import type { WorkItemSyncResult } from "./workitem";
import * as pr from "./pr";
import type { PrSyncResult } from "./pr";
import * as mirror from "./mirror";
import type { MirrorSyncResult } from "./mirror";

export interface SyncDataInput {
  root: string;
  tenant: string;
  client: AzureDevOpsClient;
  project?: string;
  repos?: string[];
  syncCanonical?: boolean;
  now?: () => string;
}

export interface SyncDataResult {
  tenant: string;
  project?: string;
  inventory: InventorySyncResult;
  workItems?: WorkItemSyncResult;
  pullRequests: PrSyncResult[];
  canonicalRepos?: MirrorSyncResult;
  errors?: string[];
  timestamp: string;
}

export interface SyncDataDeps {
  inventory: {
    syncInventory: typeof inventory.syncInventory;
  };
  workitem: {
    syncWorkItems: typeof workitem.syncWorkItems;
  };
  pr: {
    syncPullRequests: typeof pr.syncPullRequests;
  };
  mirror?: {
    sync: typeof mirror.sync;
  };
}

const defaultDeps: SyncDataDeps = {
  inventory,
  workitem,
  pr,
  mirror,
};

/**
 * Combined offline data synchronization use case.
 * Orchestrates repository inventory, work items, pull requests,
 * and optional canonical repository mirror synchronization.
 */
export async function syncData(
  input: SyncDataInput,
  deps: SyncDataDeps = defaultDeps,
): Promise<SyncDataResult> {
  const timestamp = input.now ? input.now() : new Date().toISOString();
  const errors: string[] = [];

  // 1. Synchronize repository inventory
  const invResult = await deps.inventory.syncInventory({
    root: input.root,
    tenant: input.tenant,
    client: input.client,
    project: input.project,
    now: () => timestamp,
  });

  // 2. Synchronize work items (if project is scoped or discovered)
  let wiResult: WorkItemSyncResult | undefined;
  const targetProject =
    input.project ||
    (invResult.repositories[0]?.project ? invResult.repositories[0].project : undefined);
  if (targetProject) {
    try {
      wiResult = await deps.workitem.syncWorkItems({
        root: input.root,
        tenant: input.tenant,
        project: targetProject,
        client: input.client,
        now: () => timestamp,
      });
    } catch (err) {
      errors.push(`Work item sync error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Synchronize pull requests for target repositories
  const pullRequests: PrSyncResult[] = [];
  let targetRepos: string[] = [];

  if (input.repos && input.repos.length > 0) {
    targetRepos = input.repos;
  } else {
    // Sync PRs for repositories in inventory (scoped to target project if specified)
    targetRepos = invResult.repositories
      .filter((r) => !targetProject || !r.project || r.project === targetProject)
      .map((r) => r.name);
  }

  for (const repoName of targetRepos) {
    try {
      const prResult = await deps.pr.syncPullRequests({
        root: input.root,
        tenant: input.tenant,
        repo: repoName,
        client: input.client,
        project: targetProject,
        now: () => timestamp,
      });
      pullRequests.push(prResult);
    } catch (err) {
      errors.push(
        `Pull request sync error for ${repoName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Optionally synchronize canonical reference repositories and mirrors
  let canonicalRepos: MirrorSyncResult | undefined;
  if (input.syncCanonical && deps.mirror) {
    try {
      canonicalRepos = await deps.mirror.sync({
        root: input.root,
        refresh: true,
      });
    } catch (err) {
      errors.push(
        `Canonical repositories sync error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    tenant: input.tenant,
    project: targetProject,
    inventory: invResult,
    workItems: wiResult,
    pullRequests,
    canonicalRepos,
    errors: errors.length > 0 ? errors : undefined,
    timestamp,
  };
}
