import type { AdoWorkItem, AzureDevOpsClient } from "./ado";
import * as cache from "./cache";
import type { WorkItemRecord } from "./cache";

export type { WorkItemRecord } from "./cache";

export interface SyncWorkItemsInput {
  root: string;
  tenant: string;
  project: string;
  client: AzureDevOpsClient;
  query?: string;
  limit?: number;
  now?: () => string;
}

export interface WorkItemSyncResult {
  tenant: string;
  project: string;
  cachePath: string;
  total: number;
  updated: number;
  added: number;
  items: WorkItemRecord[];
}

export interface WorkItemDeps {
  cache: {
    resolveWorkItemCachePath: typeof cache.resolveWorkItemCachePath;
    readWorkItems: typeof cache.readWorkItems;
    writeWorkItems: typeof cache.writeWorkItems;
    loadAllCachedWorkItems: typeof cache.loadAllCachedWorkItems;
  };
}

const defaultDeps: WorkItemDeps = {
  cache,
};

/**
 * Normalizes an Azure DevOps work item into a canonical WorkItemRecord.
 */
export function normalizeAdoWorkItem(
  raw: AdoWorkItem,
  tenant: string,
  project: string,
  syncedAt: string = new Date().toISOString(),
): WorkItemRecord {
  const fields = raw.fields || ({} as AdoWorkItem["fields"]);
  const title = (fields["System.Title"] as string) || "Untitled Work Item";
  const type = (fields["System.WorkItemType"] as string) || "Issue";
  const state = (fields["System.State"] as string) || "Unknown";
  const description = (fields["System.Description"] as string) || "";
  const author =
    fields["System.CreatedBy"]?.displayName || fields["System.CreatedBy"]?.uniqueName || undefined;
  const assignedTo =
    fields["System.AssignedTo"]?.displayName ||
    fields["System.AssignedTo"]?.uniqueName ||
    undefined;
  const areaPath = (fields["System.AreaPath"] as string) || undefined;
  const iterationPath = (fields["System.IterationPath"] as string) || undefined;
  const createdAt = (fields["System.CreatedDate"] as string) || undefined;
  const updatedAt = (fields["System.ChangedDate"] as string) || undefined;

  return {
    id: raw.id,
    type,
    title,
    state,
    assignedTo,
    author,
    url: raw.url,
    areaPath,
    iterationPath,
    description,
    createdAt,
    updatedAt,
    tenant,
    project: (fields["System.TeamProject"] as string) || project,
    syncedAt,
  };
}

/**
 * Merges existing and incoming WorkItemRecords.
 * Updates matching IDs, appends new, and sorts descending by ID.
 */
export function mergeWorkItemRecords(
  existing: WorkItemRecord[],
  incoming: WorkItemRecord[],
): WorkItemRecord[] {
  const map = new Map<number, WorkItemRecord>();

  for (const item of existing) {
    map.set(item.id, item);
  }

  for (const item of incoming) {
    map.set(item.id, {
      ...map.get(item.id),
      ...item,
    });
  }

  const merged = Array.from(map.values());
  merged.sort((a, b) => b.id - a.id);
  return merged;
}

/**
 * Synchronizes work items from an Azure DevOps client to the local JSONL cache.
 */
export async function syncWorkItems(
  input: SyncWorkItemsInput,
  deps: WorkItemDeps = defaultDeps,
): Promise<WorkItemSyncResult> {
  const now = input.now ? input.now() : new Date().toISOString();

  const wiql =
    input.query ||
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${input.project}' ORDER BY [System.ChangedDate] DESC`;

  const refs = await input.client.queryWorkItems(wiql, {
    project: input.project,
    top: input.limit,
  });
  const ids = refs.map((r) => r.id);

  const rawItems =
    ids.length > 0 ? await input.client.getWorkItems(ids, { project: input.project }) : [];
  const incoming = rawItems.map((item) =>
    normalizeAdoWorkItem(item, input.tenant, input.project, now),
  );

  const existing = await deps.cache.readWorkItems({
    root: input.root,
    tenant: input.tenant,
    project: input.project,
  });

  const existingIds = new Set(existing.map((item) => item.id));
  let added = 0;
  let updated = 0;

  for (const item of incoming) {
    if (existingIds.has(item.id)) {
      updated++;
    } else {
      added++;
    }
  }

  const merged = mergeWorkItemRecords(existing, incoming);
  const cachePath = await deps.cache.writeWorkItems({
    root: input.root,
    tenant: input.tenant,
    project: input.project,
    records: merged,
  });

  return {
    tenant: input.tenant,
    project: input.project,
    cachePath,
    total: merged.length,
    updated,
    added,
    items: merged,
  };
}

/**
 * Lists work items from cache or with live sync.
 */
export async function listWorkItems(
  input: {
    root: string;
    tenant?: string;
    project?: string;
    status?: string;
    limit?: number;
    offline?: boolean;
    refresh?: boolean;
    client?: AzureDevOpsClient;
  },
  deps: WorkItemDeps = defaultDeps,
): Promise<WorkItemRecord[]> {
  if (input.refresh && !input.offline && input.client && input.tenant && input.project) {
    await syncWorkItems(
      {
        root: input.root,
        tenant: input.tenant,
        project: input.project,
        client: input.client,
        limit: input.limit,
      },
      deps,
    );
  }

  let records: WorkItemRecord[];
  if (input.tenant) {
    records = await deps.cache.readWorkItems({
      root: input.root,
      tenant: input.tenant,
      project: input.project,
    });
  } else {
    records = await deps.cache.loadAllCachedWorkItems(input.root);
  }

  if (input.status) {
    records = records.filter((r) => r.state.toLowerCase() === input.status!.toLowerCase());
  }

  return records;
}

/**
 * Retrieves a single work item by ID.
 */
export async function getWorkItem(
  input: {
    root: string;
    id: number;
    tenant?: string;
    project?: string;
    offline?: boolean;
    client?: AzureDevOpsClient;
  },
  deps: WorkItemDeps = defaultDeps,
): Promise<WorkItemRecord | undefined> {
  if (!input.offline && input.client && input.tenant) {
    try {
      const raw = await input.client.getWorkItem(input.id, { project: input.project });
      return normalizeAdoWorkItem(raw, input.tenant, input.project || "default");
    } catch {
      // Fallback to cache if remote fails
    }
  }

  const all = input.tenant
    ? await deps.cache.readWorkItems({
        root: input.root,
        tenant: input.tenant,
        project: input.project,
      })
    : await deps.cache.loadAllCachedWorkItems(input.root);

  return all.find((item) => item.id === input.id);
}
