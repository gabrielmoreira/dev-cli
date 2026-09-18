import { existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { glob } from "tinyglobby";
import { cacheDir, inventoryCachePath, prsCachePath, workItemsCachePath } from "./paths.ts";

const cacheSubdir = ({ root, kind }: { root: string; kind: string }): string =>
  join(cacheDir({ root }), kind);

export interface InventoryRecord {
  id: string;
  name: string;
  url: string;
  default_branch: string;
  description: string;
  last_changed: string;
  syncedAt: string;
  project?: string;
}

export interface WriteInventoryOptions {
  root: string;
  tenant: string;
  records: InventoryRecord[];
}

export interface ReadInventoryOptions {
  root: string;
  tenant: string;
}

async function writeCacheAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await Bun.write(tempPath, content);

  let attempts = 15;
  while (attempts > 0) {
    try {
      await rename(tempPath, filePath);
      return;
    } catch (err: any) {
      if (
        (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EEXIST") &&
        attempts > 1
      ) {
        attempts--;
        await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
        continue;
      }
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * Resolves the absolute path to a tenant inventory JSONL cache file:
 * $DEV_ROOT/.dev/cache/inventory/<tenant>/repos.jsonl
 */
export function resolveInventoryCachePath(root: string, tenant: string): string {
  return inventoryCachePath({ root, segments: tenant.split("/").filter(Boolean) });
}

/**
 * Writes an array of InventoryRecord objects to the cache file in JSONL format atomically.
 */
export async function writeInventory(options: WriteInventoryOptions): Promise<string> {
  const filePath = resolveInventoryCachePath(options.root, options.tenant);
  const content =
    options.records.map((r) => JSON.stringify(r)).join("\n") +
    (options.records.length > 0 ? "\n" : "");
  await writeCacheAtomic(filePath, content);
  return filePath;
}

/**
 * Reads inventory records from the cache file. Returns empty array if file does not exist.
 */
export async function readInventory(options: ReadInventoryOptions): Promise<InventoryRecord[]> {
  const filePath = resolveInventoryCachePath(options.root, options.tenant);

  if (!existsSync(filePath)) {
    return [];
  }

  const text = await Bun.file(filePath).text();
  const lines = text.split("\n");
  const records: InventoryRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as InventoryRecord;
      records.push(record);
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

/**
 * Loads and combines all inventory records across all cached tenants in $DEV_ROOT/.dev/cache/inventory/.
 */
export async function loadAllCachedInventories(root: string): Promise<InventoryRecord[]> {
  const baseDir = cacheSubdir({ root, kind: "inventory" });
  if (!existsSync(baseDir)) {
    return [];
  }

  const files = await glob("**/repos.jsonl", { cwd: baseDir, absolute: true });
  const recordsMap = new Map<string, InventoryRecord>();

  for (const fullPath of files) {
    try {
      const text = await Bun.file(fullPath).text();
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as InventoryRecord;
          if (rec && rec.id) {
            recordsMap.set(rec.id, rec);
          }
        } catch {}
      }
    } catch {}
  }

  const records = Array.from(recordsMap.values());
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

export interface PullRequestRecord {
  id: number;
  title: string;
  description: string;
  status: "open" | "completed" | "abandoned";
  sourceBranch: string;
  targetBranch: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  repository: string;
  tenant: string;
  syncedAt: string;
}

export interface WritePullRequestsOptions {
  root: string;
  tenant: string;
  repo: string;
  records: PullRequestRecord[];
}

export interface ReadPullRequestsOptions {
  root: string;
  tenant: string;
  repo: string;
}

/**
 * Resolves path to repository PR cache:
 * $DEV_ROOT/.dev/cache/prs/<tenant>/<repo>.jsonl
 */
export function resolvePrCachePath(root: string, tenant: string, repo: string): string {
  return prsCachePath({ root, segments: tenant.split("/").filter(Boolean), repo });
}

export async function writePullRequests(options: WritePullRequestsOptions): Promise<string> {
  const filePath = resolvePrCachePath(options.root, options.tenant, options.repo);
  const content =
    options.records.map((r) => JSON.stringify(r)).join("\n") +
    (options.records.length > 0 ? "\n" : "");
  await writeCacheAtomic(filePath, content);
  return filePath;
}

export async function readPullRequests(
  options: ReadPullRequestsOptions,
): Promise<PullRequestRecord[]> {
  const filePath = resolvePrCachePath(options.root, options.tenant, options.repo);

  if (!existsSync(filePath)) {
    return [];
  }

  const text = await Bun.file(filePath).text();
  const lines = text.split("\n");
  const records: PullRequestRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as PullRequestRecord;
      records.push(rec);
    } catch {}
  }

  return records;
}

export interface PullRequestSelectionOptions {
  root: string;
  tenant: string;
  name: string;
}

function pullRequestSelectionPath(options: PullRequestSelectionOptions): string {
  return join(
    cacheDir({ root: options.root }),
    "pr-selections",
    ...options.tenant.split("/").filter(Boolean),
    `${options.name}.jsonl`,
  );
}

export async function writePullRequestSelection(
  options: PullRequestSelectionOptions & { records: PullRequestRecord[] },
): Promise<string> {
  const filePath = pullRequestSelectionPath(options);
  const content =
    options.records.map((record) => JSON.stringify(record)).join("\n") +
    (options.records.length > 0 ? "\n" : "");
  await writeCacheAtomic(filePath, content);
  return filePath;
}

export async function readPullRequestSelection(
  options: PullRequestSelectionOptions,
): Promise<PullRequestRecord[] | undefined> {
  const filePath = pullRequestSelectionPath(options);
  if (!existsSync(filePath)) return undefined;
  const text = await Bun.file(filePath).text();
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PullRequestRecord];
      } catch {
        return [];
      }
    });
}

export async function loadAllCachedPullRequests(root: string): Promise<PullRequestRecord[]> {
  const baseDir = cacheSubdir({ root, kind: "prs" });
  if (!existsSync(baseDir)) {
    return [];
  }

  const files = await glob("**/*.jsonl", { cwd: baseDir, absolute: true });
  const recordsMap = new Map<string, PullRequestRecord>();

  for (const fullPath of files) {
    try {
      const text = await Bun.file(fullPath).text();
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as PullRequestRecord;
          if (rec && rec.id) {
            const uniqueKey = `${rec.tenant}/${rec.repository}/${rec.id}`;
            recordsMap.set(uniqueKey, rec);
          }
        } catch {}
      }
    } catch {}
  }

  const records = Array.from(recordsMap.values());
  records.sort((a, b) => b.id - a.id);
  return records;
}

export interface WorkItemRecord {
  id: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  author?: string;
  url: string;
  areaPath?: string;
  iterationPath?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  tenant: string;
  project: string;
  syncedAt: string;
}

export interface WriteWorkItemsOptions {
  root: string;
  tenant: string;
  project: string;
  records: WorkItemRecord[];
}

export interface ReadWorkItemsOptions {
  root: string;
  tenant: string;
  project?: string;
}

export function resolveWorkItemCachePath(
  root: string,
  tenant: string,
  project: string = "default",
): string {
  return workItemsCachePath({
    root,
    tenantSegments: tenant.split("/").filter(Boolean),
    project,
  });
}

export async function writeWorkItems(options: WriteWorkItemsOptions): Promise<string> {
  const filePath = resolveWorkItemCachePath(options.root, options.tenant, options.project);
  const content = options.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeCacheAtomic(filePath, content);
  return filePath;
}

export async function readWorkItems(options: ReadWorkItemsOptions): Promise<WorkItemRecord[]> {
  if (options.project) {
    const filePath = resolveWorkItemCachePath(options.root, options.tenant, options.project);
    if (!existsSync(filePath)) {
      return [];
    }
    const text = await Bun.file(filePath).text();
    const lines = text.split("\n");
    const records: WorkItemRecord[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as WorkItemRecord);
      } catch {}
    }
    return records;
  }

  const tenantSegments = options.tenant.split("/").filter(Boolean);
  const tenantDir = join(cacheDir({ root: options.root }), "workitems", ...tenantSegments);
  if (!existsSync(tenantDir)) {
    return [];
  }

  const files = await glob("*.jsonl", { cwd: tenantDir, absolute: true });
  const all: WorkItemRecord[] = [];
  for (const f of files) {
    try {
      const text = await Bun.file(f).text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            all.push(JSON.parse(trimmed) as WorkItemRecord);
          } catch {}
        }
      }
    } catch {}
  }
  all.sort((a, b) => b.id - a.id);
  return all;
}

export async function loadAllCachedWorkItems(root: string): Promise<WorkItemRecord[]> {
  const baseDir = cacheSubdir({ root, kind: "workitems" });
  if (!existsSync(baseDir)) {
    return [];
  }

  const files = await glob("**/*.jsonl", { cwd: baseDir, absolute: true });
  const recordsMap = new Map<string, WorkItemRecord>();
  for (const fullPath of files) {
    try {
      const text = await Bun.file(fullPath).text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as WorkItemRecord;
          if (rec && rec.id) {
            const uniqueKey = `${rec.tenant}/${rec.project}/${rec.id}`;
            recordsMap.set(uniqueKey, rec);
          }
        } catch {}
      }
    } catch {}
  }

  const records = Array.from(recordsMap.values());
  records.sort((a, b) => b.id - a.id);
  return records;
}
