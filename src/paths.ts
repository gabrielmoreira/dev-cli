import { join } from "node:path";

/**
 * Single semantic owner of the dev-root layout. Every path the CLI derives
 * from a dev root (or for a source/workspace/cache entry) is computed here so
 * the on-disk contract lives in one readable file.
 *
 * Layout of a dev root:
 *   dev.yaml                      declared sources, labels, plugins (truth)
 *   .dev/git/<host>/<owner>/<repo>.git   object pool: one bare mirror per source
 *   .dev/repos/<sourceKey>.git    canonical admin instance (mirrors/ checkouts)
 *   .dev/repos/<ws>/<sourceKey>.git  per-workspace admin instance
 *   .dev/cache/...                derived read-through caches (rebuildable)
 *   mirrors/<host>/.../repo       canonical reference checkouts
 *   ws/<name>/                    workspaces (user files live in mounts)
 */

// --- dev root ---

export function devDir({ root }: { root: string }): string {
  return join(root, ".dev");
}

export function configFilePath({ root }: { root: string }): string {
  return join(root, "dev.yaml");
}

// --- object pool: git objects of a source exist exactly once, here ---

export function gitPoolDir({ root }: { root: string }): string {
  return join(root, ".dev", "git");
}

/** Pool location for a source, derived from its URL:
 * .dev/git/<host>/<owner>/<repo>.git */
export function gitPoolPath({ root, source }: { root: string; source: string }): string {
  const parts = deriveCanonicalParts(source);
  const segments =
    parts.host === "local" ? parts.fullPathSegments : [parts.host, ...parts.fullPathSegments];
  return join(root, ".dev", "git", ...segments) + ".git";
}

// --- repo instances: bare repos holding refs + worktree metadata ---

export function reposDir({ root }: { root: string }): string {
  return join(root, ".dev", "repos");
}

/** Admin of the canonical checkouts under mirrors/. */
export function canonicalAdminRepoPath({
  root,
  sourceKey,
}: {
  root: string;
  sourceKey: string;
}): string {
  return join(root, ".dev", "repos", `${sourceKey}.git`);
}

/** Admin holding workspace-local branches and worktree metadata for mounts. */
export function workspaceAdminRepoPath({
  root,
  workspaceName,
  sourceKey,
}: {
  root: string;
  workspaceName: string;
  sourceKey: string;
}): string {
  return join(root, ".dev", "repos", workspaceName, `${sourceKey}.git`);
}

// --- canonical checkouts ---

export function checkoutsDir({
  root,
  canonicalPrefix = "mirrors",
}: {
  root: string;
  canonicalPrefix?: string;
}): string {
  return join(root, canonicalPrefix);
}

// --- workspaces ---

export function workspacesDir({
  root,
  workspacePrefix = "ws",
}: {
  root: string;
  workspacePrefix?: string;
}): string {
  return join(root, workspacePrefix);
}

export function workspacePath({
  root,
  workspaceName,
  workspacePrefix = "ws",
}: {
  root: string;
  workspaceName: string;
  workspacePrefix?: string;
}): string {
  return join(workspacesDir({ root, workspacePrefix }), workspaceName.trim());
}

export function workspaceManifestPath({
  root,
  workspaceName,
  workspacePrefix = "ws",
}: {
  root: string;
  workspaceName: string;
  workspacePrefix?: string;
}): string {
  return join(workspacePath({ root, workspaceName, workspacePrefix }), "ws.md");
}

// --- caches: derived state, safe to delete and rebuild ---

export function cacheDir({ root }: { root: string }): string {
  return join(root, ".dev", "cache");
}

export function inventoryCachePath({
  root,
  segments,
}: {
  root: string;
  segments: string[];
}): string {
  return join(root, ".dev", "cache", "inventory", ...segments, "repos.jsonl");
}

export function prsCachePath({
  root,
  segments,
  repo,
}: {
  root: string;
  segments: string[];
  repo: string;
}): string {
  return join(root, ".dev", "cache", "prs", ...segments, `${repo}.jsonl`);
}

export function workItemsCachePath({
  root,
  tenantSegments,
  project,
}: {
  root: string;
  tenantSegments: string[];
  project: string;
}): string {
  return join(root, ".dev", "cache", "workitems", ...tenantSegments, `${project}.jsonl`);
}

// --- URL to path semantics ---

export interface CanonicalParts {
  host: string;
  repo: string;
  relativeBaseDir: string;
  fullPathSegments: string[];
}

export function deriveCanonicalParts(url: string, canonicalPrefix = "mirrors"): CanonicalParts {
  let cleaned = url.trim().replace(/\\/g, "/");

  // Strip file:// scheme
  cleaned = cleaned.replace(/^file:\/\//i, "");

  // Check for local file path: Windows drive (e.g. C:/) or absolute Unix path (e.g. /tmp/...)
  const isLocalWindows = /^[a-zA-Z]:\//.test(cleaned);
  const isLocalUnix = cleaned.startsWith("/");

  if (isLocalWindows || isLocalUnix) {
    cleaned = cleaned.replace(/\.git$/, "").replace(/\/+$/, "");
    const segments = cleaned.split("/").filter(Boolean);
    const repo = segments[segments.length - 1] || "repo";
    const relativeBaseDir = join(canonicalPrefix, "local");
    return {
      host: "local",
      repo,
      relativeBaseDir,
      fullPathSegments: ["local", repo],
    };
  }

  // Strip ssh git@
  if (cleaned.startsWith("git@")) {
    cleaned = cleaned.replace(/^git@([^:]+):/, "$1/");
  } else {
    cleaned = cleaned.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@/]+@/i, "");
    cleaned = cleaned.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i, "");
  }

  // Strip userinfo
  cleaned = cleaned.replace(/^[^@/]+@/, "");

  // Strip port
  cleaned = cleaned.replace(/^([^/:]+):\d+/, "$1");

  // Strip trailing .git and slashes
  cleaned = cleaned.replace(/\.git$/, "").replace(/\/+$/, "");

  // Split path segments
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length < 2) {
    const host = "local";
    const repo = segments[0] || "repo";
    return {
      host,
      repo,
      relativeBaseDir: join(canonicalPrefix, host),
      fullPathSegments: [host, repo],
    };
  }

  const host = segments[0];
  const filtered = segments.slice(1).filter((s) => s !== "_git");
  if (filtered.length < 1) {
    const repo = segments[1] || "repo";
    return {
      host,
      repo,
      relativeBaseDir: join(canonicalPrefix, host),
      fullPathSegments: [host, repo],
    };
  }

  const repo = filtered[filtered.length - 1];
  const owners = filtered.slice(0, -1);
  const relativeBaseDir = join(canonicalPrefix, host, ...owners);
  return {
    host,
    repo,
    relativeBaseDir,
    fullPathSegments: filtered,
  };
}
