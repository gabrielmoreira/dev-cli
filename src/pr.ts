import type { AdoPullRequest, AzureDevOpsClient } from "./ado";
import * as cache from "./cache";
import type { PullRequestRecord } from "./cache";

export type { PullRequestRecord } from "./cache";

export interface SyncPullRequestsInput {
  root: string;
  tenant: string;
  repo: string;
  repositoryIdOrName?: string;
  client: Pick<AzureDevOpsClient, "listPullRequests" | "getPullRequest">;
  project?: string;
  status?: "open" | "completed" | "abandoned" | "all";
  now?: () => string;
}

export interface PrSyncResult {
  tenant: string;
  repo: string;
  cachePath: string;
  total: number;
  updated: number;
  added: number;
  prs: PullRequestRecord[];
}

export interface PrDeps {
  cache: {
    resolvePrCachePath: typeof cache.resolvePrCachePath;
    readPullRequests: typeof cache.readPullRequests;
    writePullRequests: typeof cache.writePullRequests;
    loadAllCachedPullRequests: typeof cache.loadAllCachedPullRequests;
  };
}

const defaultDeps: PrDeps = {
  cache,
};

/**
 * Maps Azure DevOps PR status string to canonical status union.
 */
export function mapAdoPrStatus(status: string): "open" | "completed" | "abandoned" {
  const s = status.toLowerCase();
  if (s === "completed") return "completed";
  if (s === "abandoned") return "abandoned";
  return "open";
}

/**
 * Maps canonical status union to Azure DevOps query status.
 */
export function mapCanonicalToAdoStatus(
  status?: "open" | "completed" | "abandoned" | "all",
): "active" | "completed" | "abandoned" | "all" {
  if (status === "open") return "active";
  if (status === "completed") return "completed";
  if (status === "abandoned") return "abandoned";
  return "all";
}

/**
 * Normalizes an Azure DevOps PR into a canonical PullRequestRecord.
 */
export function normalizeAdoPullRequest(
  raw: AdoPullRequest,
  tenant: string,
  repoName: string,
  syncedAt: string = new Date().toISOString(),
): PullRequestRecord {
  const sourceBranch = raw.sourceRefName ? raw.sourceRefName.replace(/^refs\/heads\//, "") : "";
  const targetBranch = raw.targetRefName ? raw.targetRefName.replace(/^refs\/heads\//, "") : "main";
  const author = raw.createdBy?.displayName || raw.createdBy?.uniqueName || "unknown";

  return {
    id: raw.pullRequestId,
    title: raw.title,
    description: raw.description || "",
    status: mapAdoPrStatus(raw.status),
    sourceBranch,
    targetBranch,
    author,
    url: raw.url,
    createdAt: raw.creationDate,
    updatedAt: raw.creationDate,
    isDraft: Boolean(raw.isDraft),
    repository: repoName,
    tenant,
    syncedAt,
  };
}

/**
 * Merges existing and incoming PR records.
 * Updates matching by ID, appends new, sorts descending by ID.
 */
export function mergePullRequestRecords(
  existing: PullRequestRecord[],
  incoming: PullRequestRecord[],
): PullRequestRecord[] {
  const map = new Map<number, PullRequestRecord>();

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
 * Synchronizes pull requests for a repository from an Azure DevOps client to the local cache.
 */
export async function syncPullRequests(
  input: SyncPullRequestsInput,
  deps: PrDeps = defaultDeps,
): Promise<PrSyncResult> {
  const now = input.now ? input.now() : new Date().toISOString();
  const adoStatus = mapCanonicalToAdoStatus(input.status);

  const rawPrs = await input.client.listPullRequests(input.repositoryIdOrName ?? input.repo, {
    project: input.project,
    status: adoStatus,
  });

  const incoming = rawPrs.map((pr) => normalizeAdoPullRequest(pr, input.tenant, input.repo, now));
  const existing = await deps.cache.readPullRequests({
    root: input.root,
    tenant: input.tenant,
    repo: input.repo,
  });

  const existingIds = new Set(existing.map((p) => p.id));
  let added = 0;
  let updated = 0;

  for (const item of incoming) {
    if (existingIds.has(item.id)) {
      updated++;
    } else {
      added++;
    }
  }

  const merged = mergePullRequestRecords(existing, incoming);
  const cachePath = await deps.cache.writePullRequests({
    root: input.root,
    tenant: input.tenant,
    repo: input.repo,
    records: merged,
  });

  return {
    tenant: input.tenant,
    repo: input.repo,
    cachePath,
    total: merged.length,
    updated,
    added,
    prs: merged,
  };
}

export async function refreshProjectPullRequests(
  input: {
    root: string;
    tenant: string;
    projects: string[];
    mine: boolean;
    status?: "open" | "completed" | "abandoned" | "all";
    client: Pick<AzureDevOpsClient, "getCurrentUser" | "listProjectPullRequests">;
    now?: () => string;
  },
  deps: PrDeps = defaultDeps,
): Promise<PullRequestRecord[]> {
  const projects = [...new Set(input.projects.filter(Boolean))];
  const reviewerId = input.mine ? (await input.client.getCurrentUser()).id : undefined;
  const syncedAt = input.now ? input.now() : new Date().toISOString();
  const batches = await Promise.all(
    projects.map((project) =>
      input.client.listProjectPullRequests(project, {
        reviewerId,
        status: mapCanonicalToAdoStatus(input.status),
      }),
    ),
  );
  const records = batches.flatMap((batch) =>
    batch.flatMap((raw) => {
      const repository = raw.repository?.name;
      return repository ? [normalizeAdoPullRequest(raw, input.tenant, repository, syncedAt)] : [];
    }),
  );

  const byRepository = new Map<string, PullRequestRecord[]>();
  for (const record of records) {
    const group = byRepository.get(record.repository);
    if (group) group.push(record);
    else byRepository.set(record.repository, [record]);
  }
  for (const [repository, incoming] of byRepository) {
    const existing = await deps.cache.readPullRequests({
      root: input.root,
      tenant: input.tenant,
      repo: repository,
    });
    await deps.cache.writePullRequests({
      root: input.root,
      tenant: input.tenant,
      repo: repository,
      records: mergePullRequestRecords(existing, incoming),
    });
  }

  records.sort((a, b) => b.id - a.id);
  return records;
}

/**
 * Lists pull requests either from local cache or with an optional live refresh.
 */
export async function listPullRequests(
  input: {
    root: string;
    tenant?: string;
    repo?: string;
    status?: "open" | "completed" | "abandoned" | "all";
    offline?: boolean;
    refresh?: boolean;
    client?: Pick<AzureDevOpsClient, "listPullRequests" | "getPullRequest">;
    project?: string;
  },
  deps: PrDeps = defaultDeps,
): Promise<PullRequestRecord[]> {
  if (input.refresh && !input.offline && input.client && input.tenant && input.repo) {
    await syncPullRequests(
      {
        root: input.root,
        tenant: input.tenant,
        repo: input.repo,
        client: input.client,
        project: input.project,
        status: input.status,
      },
      deps,
    );
  }

  let records: PullRequestRecord[];
  if (input.tenant && input.repo) {
    records = await deps.cache.readPullRequests({
      root: input.root,
      tenant: input.tenant,
      repo: input.repo,
    });
  } else {
    records = await deps.cache.loadAllCachedPullRequests(input.root);
  }

  if (input.status && input.status !== "all") {
    records = records.filter((r) => r.status === input.status);
  }

  return records;
}

/**
 * Gets a specific pull request by ID.
 */
export async function getPullRequest(
  input: {
    root: string;
    id: number;
    tenant?: string;
    repo?: string;
    offline?: boolean;
    client?: Pick<AzureDevOpsClient, "listPullRequests" | "getPullRequest">;
    project?: string;
  },
  deps: PrDeps = defaultDeps,
): Promise<PullRequestRecord | undefined> {
  if (!input.offline && input.client && input.tenant && input.repo) {
    try {
      const raw = await input.client.getPullRequest(input.repo, input.id, {
        project: input.project,
      });
      return normalizeAdoPullRequest(raw, input.tenant, input.repo);
    } catch {
      // Fallback to cache if remote fails
    }
  }

  const all =
    input.tenant && input.repo
      ? await deps.cache.readPullRequests({
          root: input.root,
          tenant: input.tenant,
          repo: input.repo,
        })
      : await deps.cache.loadAllCachedPullRequests(input.root);

  return all.find((p) => p.id === input.id);
}
