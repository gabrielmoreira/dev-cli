import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { glob } from "tinyglobby";
import { writeTextAtomic } from "./fs.ts";
import {
  inventoryCacheDir,
  inventoryCachePath,
  prsCacheDir,
  prsCachePath,
  pullRequestSelectionCachePath,
  workItemsCacheDir,
  workItemsCachePath,
} from "./paths.ts";

export interface InventoryRecord {
  id: string;
  name: string;
  url: string;
  default_branch?: string;
  description: string;
  last_changed: string;
  syncedAt: string;
  project?: string;
  /** The provider reports the repository as disabled: it cannot be cloned or queried. */
  disabled?: boolean;
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
  await writeTextAtomic(filePath, content);
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
  let skippedRows = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as InventoryRecord;
      records.push(record);
    } catch {
      skippedRows += 1;
    }
  }

  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
  return records;
}

/**
 * Loads and combines all inventory records across all cached tenants in $DEV_ROOT/.dev/cache/inventory/.
 */
export async function loadAllCachedInventories(root: string): Promise<InventoryRecord[]> {
  const baseDir = inventoryCacheDir({ root });
  if (!existsSync(baseDir)) {
    return [];
  }

  const files = await glob("**/repos.jsonl", { cwd: baseDir, absolute: true });
  const recordsMap = new Map<string, InventoryRecord>();
  let skippedRows = 0;

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
        } catch {
          skippedRows += 1;
        }
      }
    } catch {}
  }

  const records = Array.from(recordsMap.values());
  records.sort((a, b) => a.name.localeCompare(b.name));
  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
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
  /** Provider project; cache identity is tenant, project, and repository. */
  project?: string;
  tenant: string;
  syncedAt: string;
}

export interface WritePullRequestsOptions {
  root: string;
  tenant: string;
  repo: string;
  project?: string;
  records: PullRequestRecord[];
}

export interface ReadPullRequestsOptions {
  root: string;
  tenant: string;
  repo: string;
  project?: string;
}

/**
 * Resolves path to repository PR cache:
 * $DEV_ROOT/.dev/cache/prs/<tenant>/<project>/<repo>.jsonl
 * Legacy projectless files are ignored and rebuilt by the next sync.
 */
export function resolvePrCachePath(
  root: string,
  tenant: string,
  repo: string,
  project = "unknown",
): string {
  return prsCachePath({
    root,
    segments: [...tenant.split("/").filter(Boolean), project],
    repo,
  });
}

export async function writePullRequests(options: WritePullRequestsOptions): Promise<string> {
  const project = options.project ?? options.records[0]?.project ?? "unknown";
  const filePath = resolvePrCachePath(options.root, options.tenant, options.repo, project);
  const content =
    options.records.map((r) => JSON.stringify(r)).join("\n") +
    (options.records.length > 0 ? "\n" : "");
  await writeTextAtomic(filePath, content);
  return filePath;
}

export async function readPullRequests(
  options: ReadPullRequestsOptions,
): Promise<PullRequestRecord[]> {
  if (!options.project) {
    const all = await loadAllCachedPullRequests(options.root);
    return all.filter(
      (record) => record.tenant === options.tenant && record.repository === options.repo,
    );
  }

  const filePath = resolvePrCachePath(options.root, options.tenant, options.repo, options.project);

  if (!existsSync(filePath)) {
    return [];
  }

  const text = await Bun.file(filePath).text();
  const lines = text.split("\n");
  const records: PullRequestRecord[] = [];
  let skippedRows = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as PullRequestRecord;
      records.push(rec);
    } catch {
      skippedRows += 1;
    }
  }

  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
  return records;
}

export interface PullRequestSelectionOptions {
  root: string;
  tenant: string;
  name: string;
}

function pullRequestSelectionPath(options: PullRequestSelectionOptions): string {
  return pullRequestSelectionCachePath({
    root: options.root,
    tenantSegments: options.tenant.split("/").filter(Boolean),
    name: options.name,
  });
}

export async function writePullRequestSelection(
  options: PullRequestSelectionOptions & { records: PullRequestRecord[] },
): Promise<string> {
  const filePath = pullRequestSelectionPath(options);
  const content =
    options.records.map((record) => JSON.stringify(record)).join("\n") +
    (options.records.length > 0 ? "\n" : "");
  await writeTextAtomic(filePath, content);
  return filePath;
}

export async function readPullRequestSelection(
  options: PullRequestSelectionOptions,
): Promise<PullRequestRecord[] | undefined> {
  const filePath = pullRequestSelectionPath(options);
  if (!existsSync(filePath)) return undefined;
  const text = await Bun.file(filePath).text();
  let skippedRows = 0;
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PullRequestRecord];
      } catch {
        skippedRows += 1;
        return [];
      }
    });
  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
  return records;
}

export async function loadAllCachedPullRequests(root: string): Promise<PullRequestRecord[]> {
  const baseDir = prsCacheDir({ root });
  if (!existsSync(baseDir)) {
    return [];
  }

  const files = await glob("**/*.jsonl", { cwd: baseDir, absolute: true });
  const recordsMap = new Map<string, PullRequestRecord>();
  let skippedRows = 0;

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
            const expectedPath = resolve(
              resolvePrCachePath(root, rec.tenant, rec.repository, rec.project ?? "unknown"),
            );
            if (resolve(fullPath) !== expectedPath) continue;
            const uniqueKey = `${rec.tenant}/${rec.project ?? ""}/${rec.repository}/${rec.id}`;
            recordsMap.set(uniqueKey, rec);
          }
        } catch {
          skippedRows += 1;
        }
      }
    } catch {}
  }

  const records = Array.from(recordsMap.values());
  records.sort((a, b) => b.id - a.id);
  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
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
  await writeTextAtomic(filePath, content);
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
    let skippedRows = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as WorkItemRecord);
      } catch {
        skippedRows += 1;
      }
    }
    if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
    return records;
  }

  const tenantSegments = options.tenant.split("/").filter(Boolean);
  const tenantDir = workItemsCacheDir({ root: options.root, tenantSegments });
  if (!existsSync(tenantDir)) {
    return [];
  }

  const files = await glob("*.jsonl", { cwd: tenantDir, absolute: true });
  const all: WorkItemRecord[] = [];
  let skippedRows = 0;
  for (const f of files) {
    try {
      const text = await Bun.file(f).text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            all.push(JSON.parse(trimmed) as WorkItemRecord);
          } catch {
            skippedRows += 1;
          }
        }
      }
    } catch {}
  }
  all.sort((a, b) => b.id - a.id);
  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
  return all;
}

export async function loadAllCachedWorkItems(root: string): Promise<WorkItemRecord[]> {
  const baseDir = workItemsCacheDir({ root });
  if (!existsSync(baseDir)) {
    return [];
  }

  const files = await glob("**/*.jsonl", { cwd: baseDir, absolute: true });
  const recordsMap = new Map<string, WorkItemRecord>();
  let skippedRows = 0;
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
        } catch {
          skippedRows += 1;
        }
      }
    } catch {}
  }

  const records = Array.from(recordsMap.values());
  records.sort((a, b) => b.id - a.id);
  if (skippedRows > 0) console.warn("Skipped malformed cache rows", skippedRows);
  return records;
}
