import type { AdoRepository, AzureDevOpsClient } from "./ado";
import * as cache from "./cache";
import type { InventoryRecord } from "./cache";
import { stripCredentialsFromUrl } from "./git";

export interface SyncInventoryInput {
  root: string;
  tenant: string;
  client: Pick<AzureDevOpsClient, "listRepositories">;
  project?: string;
  now?: () => string;
}

export interface InventorySyncResult {
  tenant: string;
  cachePath: string;
  total: number;
  updated: number;
  added: number;
  repositories: InventoryRecord[];
}

export interface InventoryDeps {
  cache: {
    resolveInventoryCachePath: typeof cache.resolveInventoryCachePath;
    readInventory: typeof cache.readInventory;
    writeInventory: typeof cache.writeInventory;
  };
}

const defaultDeps: InventoryDeps = {
  cache,
};

/**
 * Normalizes an Azure DevOps repository representation into a canonical InventoryRecord.
 */
export function normalizeAdoRepository(
  repo: AdoRepository,
  syncedAt: string = new Date().toISOString(),
): InventoryRecord {
  const rawUrl = repo.webUrl || repo.remoteUrl || repo.url;
  const cleanUrl = stripCredentialsFromUrl(rawUrl);

  const defaultBranch = repo.defaultBranch
    ? repo.defaultBranch.replace(/^refs\/heads\//, "")
    : "main";

  const description = repo.description || repo.project?.description || "";
  const lastChanged = repo.project?.lastUpdateTime || syncedAt;

  return {
    id: repo.id,
    name: repo.name,
    url: cleanUrl,
    default_branch: defaultBranch,
    description,
    last_changed: lastChanged,
    syncedAt,
    project: repo.project?.name,
  };
}

/**
 * Merges incoming inventory records with existing records.
 * Matches records by id (or url). Updates existing, appends new, retains untouched.
 * Returns records sorted alphabetically by name.
 */
export function mergeInventoryRecords(
  existing: InventoryRecord[],
  incoming: InventoryRecord[],
): InventoryRecord[] {
  const map = new Map<string, InventoryRecord>();

  for (const item of existing) {
    map.set(item.id, item);
  }

  for (const item of incoming) {
    // Check if matching by id or existing with same url
    let matchedKey = item.id;
    if (!map.has(matchedKey)) {
      for (const [key, existingItem] of map.entries()) {
        if (existingItem.url === item.url) {
          matchedKey = key;
          break;
        }
      }
    }

    map.set(matchedKey, {
      ...map.get(matchedKey),
      ...item,
    });
  }

  const merged = Array.from(map.values());
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

/**
 * Synchronizes repository inventory from an Azure DevOps client to the local cache.
 */
export async function syncInventory(
  input: SyncInventoryInput,
  deps: InventoryDeps = defaultDeps,
): Promise<InventorySyncResult> {
  const now = input.now ? input.now() : new Date().toISOString();
  const rawRepos = await input.client.listRepositories(input.project);

  const incomingRecords = rawRepos.map((r) => normalizeAdoRepository(r, now));
  const existingRecords = await deps.cache.readInventory({
    root: input.root,
    tenant: input.tenant,
  });

  const existingIds = new Set(existingRecords.map((r) => r.id));
  let added = 0;
  let updated = 0;

  for (const incoming of incomingRecords) {
    if (existingIds.has(incoming.id)) {
      updated++;
    } else {
      added++;
    }
  }

  const mergedRecords = mergeInventoryRecords(existingRecords, incomingRecords);

  const cachePath = await deps.cache.writeInventory({
    root: input.root,
    tenant: input.tenant,
    records: mergedRecords,
  });

  return {
    tenant: input.tenant,
    cachePath,
    total: mergedRecords.length,
    updated,
    added,
    repositories: mergedRecords,
  };
}

/**
 * Checks whether a user-provided input string is an explicit URL or local path.
 */
export function isExplicitSource(str: string): boolean {
  const s = str.trim();
  if (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("git@") ||
    s.startsWith("ssh://") ||
    s.endsWith(".git") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(s)
  ) {
    return true;
  }
  return false;
}

/**
 * Filters and ranks inventory records according to relevance for a query string.
 */
export function filterInventory(records: InventoryRecord[], query?: string): InventoryRecord[] {
  const q = query?.trim().toLowerCase();
  if (!q) {
    return [...records].sort((a, b) => a.name.localeCompare(b.name));
  }

  const scored: Array<{ record: InventoryRecord; score: number }> = [];

  for (const record of records) {
    const name = record.name.toLowerCase();
    const project = (record.project || "").toLowerCase();
    const description = (record.description || "").toLowerCase();
    const url = record.url.toLowerCase();

    let score = 0;

    if (name === q) {
      score = 100;
    } else if (name.startsWith(q)) {
      score = 80;
    } else if (name.includes(q)) {
      score = 60;
    } else if (project === q) {
      score = 40;
    } else if (project.includes(q)) {
      score = 30;
    } else if (description.includes(q)) {
      score = 20;
    } else if (url.includes(q)) {
      score = 10;
    }

    if (score > 0) {
      scored.push({ record, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.record.name.localeCompare(b.record.name);
  });

  return scored.map((s) => s.record);
}

interface AdoRepositorySelector {
  organization: string;
  project: string;
  repository: string;
}

function parseAdoRepositorySelector(query?: string): AdoRepositorySelector | undefined {
  if (!query?.toLowerCase().startsWith("ado:")) {
    return undefined;
  }

  const [organization, project, ...repositoryParts] = query.slice(4).split(":");
  const repository = repositoryParts.join(":");
  if (!organization || !project || !repository) {
    return undefined;
  }

  return { organization, project, repository };
}

function matchesAdoRepositorySelector(
  record: InventoryRecord,
  selector: AdoRepositorySelector,
): boolean {
  let organization: string;
  try {
    const url = new URL(record.url);
    organization = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "");
  } catch {
    return false;
  }

  return (
    organization.toLowerCase() === selector.organization.toLowerCase() &&
    record.project?.toLowerCase() === selector.project.toLowerCase() &&
    record.name.toLowerCase() === selector.repository.toLowerCase()
  );
}

export interface ResolveSelectionResult {
  sourceUrl?: string;
  record?: InventoryRecord;
  matches: InventoryRecord[];
}

/**
 * Resolves a repository source from either an explicit URL/path or a fuzzy search query against the local cache.
 */
export async function resolveRepositorySource(
  input: {
    root: string;
    query?: string;
  },
  deps: {
    loadCached: typeof cache.loadAllCachedInventories;
  } = { loadCached: cache.loadAllCachedInventories },
): Promise<ResolveSelectionResult> {
  const q = input.query?.trim();

  // If query is an explicit URL or filesystem path, return it directly
  if (q && isExplicitSource(q)) {
    return { sourceUrl: q, matches: [] };
  }

  const cached = await deps.loadCached(input.root);
  const adoSelector = parseAdoRepositorySelector(q);
  const matches = adoSelector
    ? cached.filter((record) => matchesAdoRepositorySelector(record, adoSelector))
    : filterInventory(cached, q);

  if (adoSelector && matches.length === 1) {
    return {
      sourceUrl: matches[0].url,
      record: matches[0],
      matches,
    };
  }

  const exactMatches = matches.filter((match) => match.name.toLowerCase() === q?.toLowerCase());
  if (exactMatches.length === 1) {
    return {
      sourceUrl: exactMatches[0].url,
      record: exactMatches[0],
      matches: exactMatches,
    };
  }

  if (matches.length === 1) {
    return {
      sourceUrl: matches[0].url,
      record: matches[0],
      matches,
    };
  }

  return {
    sourceUrl: undefined,
    record: undefined,
    matches,
  };
}

export async function resolveInputSource(
  root: string,
  rawSource?: string,
): Promise<{ sourceUrl?: string; error?: string }> {
  const query = rawSource?.trim();
  if (query && isExplicitSource(query)) {
    return { sourceUrl: query };
  }

  const result = await resolveRepositorySource({ root, query });
  if (result.sourceUrl) {
    return { sourceUrl: result.sourceUrl };
  }

  if (result.matches.length === 0) {
    if (query) {
      return {
        error: `No repository matching '${query}' found in local inventory. Run 'dev sync inventory' to refresh available repositories.`,
      };
    }
    return {
      error: `Repository URL or inventory selection required. Local inventory cache is empty. Run 'dev sync inventory' to populate.`,
    };
  }

  const matchNames = result.matches
    .map((m) => `  - ${m.name} (${m.default_branch}) -> ${m.url}`)
    .join("\n");
  return {
    error: `Ambiguous repository '${query || ""}'. Matching repositories in local inventory:\n${matchNames}\nPlease specify an exact name or full URL.`,
  };
}
