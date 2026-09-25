import { withHostLimit } from "./host-limit";
import type { InventoryRecord } from "./cache";
import type { PullRequestRecord } from "./cache";
import type { InventorySyncResult } from "./inventory";
import type { PrSyncResult } from "./pr";
import * as cache from "./cache";

export interface GitHubRawRepository {
  id: number;
  name: string;
  full_name?: string;
  html_url?: string;
  clone_url?: string;
  default_branch?: string;
  description?: string | null;
  pushed_at?: string | null;
  updated_at?: string | null;
  disabled?: boolean;
  owner?: {
    login: string;
  };
}

export interface GitHubRawPullRequest {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  merged_at?: string | null;
  html_url?: string;
  head?: {
    ref: string;
    sha?: string;
    repo?: {
      name: string;
      clone_url?: string;
      html_url?: string;
    } | null;
  };
  base?: {
    ref: string;
    sha?: string;
  };
  user?: {
    login: string;
  };
  created_at?: string;
  updated_at?: string;
}

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface ListGitHubPrOptions {
  state?: "open" | "closed" | "all";
}

export interface GitHubClient {
  listRepositories(owner?: string): Promise<GitHubRawRepository[]>;
  getRepository(owner: string, repo: string): Promise<GitHubRawRepository>;
  listPullRequests(
    owner: string,
    repo: string,
    options?: ListGitHubPrOptions,
  ): Promise<GitHubRawPullRequest[]>;
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubRawPullRequest>;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchFn = options.fetch || fetch;
  const baseUrl = (options.baseUrl || "https://api.github.com").replace(/\/+$/, "");

  function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "dev-cli",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (options.token && options.token.trim().length > 0) {
      headers["Authorization"] = `Bearer ${options.token.trim()}`;
    }
    return headers;
  }

  async function request<T>(endpoint: string): Promise<T> {
    const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
    const res = await withHostLimit(url, () =>
      fetchFn(url, {
        method: "GET",
        headers: getHeaders(),
      }),
    );

    if (!res.ok) {
      const bodyText = await res.text();
      throw new Error(`GitHub API error (${res.status}): ${bodyText}`);
    }

    return (await res.json()) as T;
  }

  return {
    async listRepositories(owner?: string): Promise<GitHubRawRepository[]> {
      const endpoint = owner
        ? `/users/${encodeURIComponent(owner)}/repos?per_page=100`
        : "/user/repos?per_page=100";
      return await request<GitHubRawRepository[]>(endpoint);
    },

    async getRepository(owner: string, repo: string): Promise<GitHubRawRepository> {
      return await request<GitHubRawRepository>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      );
    },

    async listPullRequests(
      owner: string,
      repo: string,
      opts?: ListGitHubPrOptions,
    ): Promise<GitHubRawPullRequest[]> {
      const state = opts?.state || "all";
      return await request<GitHubRawPullRequest[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=100`,
      );
    },

    async getPullRequest(
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<GitHubRawPullRequest> {
      return await request<GitHubRawPullRequest>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
      );
    },
  };
}

/**
 * Normalizes a GitHub raw repository payload into a canonical InventoryRecord.
 */
export function normalizeGitHubRepository(
  raw: GitHubRawRepository,
  syncedAt: string = new Date().toISOString(),
): InventoryRecord {
  const name = raw.name;
  const url = raw.clone_url || raw.html_url || `https://github.com/${raw.full_name || name}.git`;
  const default_branch = raw.default_branch || "main";
  const description = raw.description || "";
  const last_changed = raw.pushed_at || raw.updated_at || "";

  return {
    id: String(raw.id),
    name,
    url,
    default_branch,
    description,
    last_changed,
    syncedAt,
    project: raw.owner?.login,
    disabled: raw.disabled === true ? true : undefined,
  };
}

/**
 * Normalizes a GitHub raw pull request payload into a canonical PullRequestRecord.
 */
export function normalizeGitHubPullRequest(
  raw: GitHubRawPullRequest,
  repo: string,
  syncedAt: string = new Date().toISOString(),
): PullRequestRecord {
  let status: "open" | "completed" | "abandoned" = "open";
  if (raw.state === "closed") {
    status = raw.merged_at ? "completed" : "abandoned";
  }

  return {
    id: raw.number,
    title: raw.title || `PR #${raw.number}`,
    description: "",
    status,
    sourceBranch: raw.head?.ref || "unknown",
    targetBranch: raw.base?.ref || "main",
    author: raw.user?.login || "unknown",
    repository: repo,
    tenant: "github.com",
    url: raw.html_url || "",
    isDraft: false,
    createdAt: raw.created_at || syncedAt,
    updatedAt: raw.updated_at || syncedAt,
    syncedAt,
  };
}

/**
 * Synchronizes GitHub repository inventory to local JSONL cache.
 */
export async function syncGitHubInventory(input: {
  root: string;
  owner: string;
  client: GitHubClient;
  now?: () => string;
}): Promise<InventorySyncResult> {
  const timestamp = input.now ? input.now() : new Date().toISOString();
  const rawRepos = await input.client.listRepositories(input.owner);
  const normalized = rawRepos.map((r) => normalizeGitHubRepository(r, timestamp));

  const tenant = `github.com/${input.owner}`;
  const cachePath = cache.resolveInventoryCachePath(input.root, tenant);
  const existing = await cache.readInventory({ root: input.root, tenant });

  // The listing covers the whole owner, so a repository it no longer returns is gone.
  const existingNames = new Set(existing.map((r) => r.name));
  const fetchedNames = new Set(normalized.map((r) => r.name));
  const added = normalized.filter((r) => !existingNames.has(r.name)).length;
  const removed = existing.filter((r) => !fetchedNames.has(r.name)).length;

  const merged = [...normalized].sort((a, b) => a.name.localeCompare(b.name));
  await cache.writeInventory({
    root: input.root,
    tenant,
    records: merged,
  });

  return {
    tenant,
    cachePath,
    total: merged.length,
    added,
    updated: normalized.length - added,
    removed,
    repositories: merged,
    fetched: normalized,
  };
}

/**
 * Synchronizes GitHub pull requests for a repository to local JSONL cache.
 */
export async function syncGitHubPullRequests(input: {
  root: string;
  owner: string;
  repo: string;
  client: GitHubClient;
  now?: () => string;
}): Promise<PrSyncResult> {
  const timestamp = input.now ? input.now() : new Date().toISOString();
  const rawPrs = await input.client.listPullRequests(input.owner, input.repo, { state: "all" });
  const normalized = rawPrs.map((pr) => normalizeGitHubPullRequest(pr, input.repo, timestamp));

  const tenant = `github.com/${input.owner}`;
  const cachePath = cache.resolvePrCachePath(input.root, tenant, input.repo);
  const existing = await cache.readPullRequests({ root: input.root, tenant, repo: input.repo });

  const map = new Map<number, PullRequestRecord>();
  for (const pr of existing) {
    map.set(pr.id, pr);
  }
  let added = 0;
  let updated = 0;

  for (const pr of normalized) {
    if (map.has(pr.id)) {
      updated++;
    } else {
      added++;
    }
    map.set(pr.id, pr);
  }

  const merged = Array.from(map.values()).sort((a, b) => b.id - a.id);
  await cache.writePullRequests({
    root: input.root,
    tenant,
    repo: input.repo,
    records: merged,
  });

  return {
    tenant,
    repo: input.repo,
    cachePath,
    total: merged.length,
    added,
    updated,
    prs: merged,
  };
}
