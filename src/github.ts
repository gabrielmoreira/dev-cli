import { withHostLimit } from "./host-limit";
import type { InventoryRecord } from "./cache";
import type { InventorySyncResult } from "./inventory";
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

export interface GitHubClient {
  listRepositories(owner?: string): Promise<GitHubRawRepository[]>;
  getRepository(owner: string, repo: string): Promise<GitHubRawRepository>;
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
