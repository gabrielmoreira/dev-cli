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
  status?: PullRequestStatusFilter;
  now?: () => string;
}

export interface PrSyncResult {
  tenant: string;
  repo: string;
  cachePath: string;
  total: number;
  updated: number;
  added: number;
  /** What the provider returned for this query (the cache may hold more). */
  prs: PullRequestRecord[];
  /** The provider had more than PULL_REQUEST_LIMIT pull requests for this query. */
  truncated: boolean;
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

/** Which pull requests a listing asks for; `closed` is completed and abandoned together. */
export const PULL_REQUEST_STATUS_FILTERS = [
  "open",
  "completed",
  "abandoned",
  "closed",
  "all",
] as const;
export type PullRequestStatusFilter = (typeof PULL_REQUEST_STATUS_FILTERS)[number];

export function isPullRequestStatusFilter(value: string): value is PullRequestStatusFilter {
  return (PULL_REQUEST_STATUS_FILTERS as readonly string[]).includes(value);
}

export function matchesStatus(record: PullRequestRecord, filter: PullRequestStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "closed") return record.status !== "open";
  return record.status === filter;
}

/**
 * Maps canonical status filter to Azure DevOps query status. The provider has no
 * "closed" query, so it reads every status and the caller filters.
 */
export function mapCanonicalToAdoStatus(
  status?: PullRequestStatusFilter,
): "active" | "completed" | "abandoned" | "all" {
  if (status === "open") return "active";
  if (status === "completed") return "completed";
  if (status === "abandoned") return "abandoned";
  return "all";
}

/**
 * Most pull requests one query reads, newest first. Listings ask for open pull
 * requests only, so this is a safety bound rather than a page size.
 */
export const PULL_REQUEST_LIMIT = 2000;

/**
 * The browser URL of a pull request. The REST `url` does not open in a browser;
 * a single-PR read carries the repository's web URL, and a listing carries the
 * project name, which replaces the project id in the REST URL's base.
 */
function pullRequestWebUrl(raw: AdoPullRequest): string {
  const repository = raw.repository;
  if (repository?.webUrl) return `${repository.webUrl}/pullrequest/${raw.pullRequestId}`;
  const base = raw.url.split("/_apis/")[0];
  const project = repository?.project;
  if (!repository?.name || !project || !base.endsWith(`/${project.id}`)) return raw.url;
  const organization = base.slice(0, -project.id.length - 1);
  return `${organization}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repository.name)}/pullrequest/${raw.pullRequestId}`;
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
    url: pullRequestWebUrl(raw),
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
    limit: PULL_REQUEST_LIMIT,
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

  // A pull request cached as open that an open-only query no longer returns was
  // completed or abandoned since; it stays out of every open listing.
  const complete = rawPrs.length < PULL_REQUEST_LIMIT;
  const kept =
    adoStatus === "active" && complete
      ? existing.filter((p) => p.status !== "open" || incoming.some((i) => i.id === p.id))
      : existing;
  const merged = mergePullRequestRecords(kept, incoming);
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
    prs: filterByStatus(incoming, input.status),
    truncated: !complete,
  };
}

export async function refreshProjectPullRequests(
  input: {
    root: string;
    tenant: string;
    projects: string[];
    mine: boolean;
    status?: PullRequestStatusFilter;
    client: Pick<AzureDevOpsClient, "getCurrentUser" | "listProjectPullRequests">;
    now?: () => string;
  },
  deps: PrDeps = defaultDeps,
): Promise<PullRequestRecord[]> {
  const projects = [...new Set(input.projects.filter(Boolean))];
  // "Mine" is what I wrote or what waits for my review: two provider queries.
  const userId = input.mine ? (await input.client.getCurrentUser()).id : undefined;
  const syncedAt = input.now ? input.now() : new Date().toISOString();
  const status = mapCanonicalToAdoStatus(input.status);
  const limit = PULL_REQUEST_LIMIT;
  const filters: Array<{ reviewerId?: string; creatorId?: string }> = userId
    ? [{ creatorId: userId }, { reviewerId: userId }]
    : [{}];
  const batches = await Promise.all(
    projects.flatMap((project) =>
      filters.map((filter) =>
        input.client.listProjectPullRequests(project, { ...filter, status, limit }),
      ),
    ),
  );
  const seen = new Set<number>();
  const records = batches.flatMap((batch) =>
    batch.flatMap((raw) => {
      const repository = raw.repository?.name;
      if (!repository || seen.has(raw.pullRequestId)) return [];
      seen.add(raw.pullRequestId);
      return [normalizeAdoPullRequest(raw, input.tenant, repository, syncedAt)];
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
  return filterByStatus(records, input.status);
}

/**
 * Lists pull requests either from local cache or with an optional live refresh.
 */
export async function listPullRequests(
  input: {
    root: string;
    tenant?: string;
    repo?: string;
    status?: PullRequestStatusFilter;
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

  return filterByStatus(records, input.status);
}

function filterByStatus(
  records: PullRequestRecord[],
  status: PullRequestStatusFilter | undefined,
): PullRequestRecord[] {
  return status ? records.filter((record) => matchesStatus(record, status)) : records;
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
