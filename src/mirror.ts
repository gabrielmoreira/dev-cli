import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import pLimit from "p-limit";
import { basename, dirname, join } from "node:path";
import * as fs from "./fs.ts";
import * as git from "./git.ts";
export {
  deriveCanonicalParts,
  gitPoolPath,
  canonicalAdminRepoPath,
  workspaceAdminRepoPath,
} from "./paths.ts";
export type { CanonicalParts } from "./paths.ts";
import {
  canonicalAdminRepoPath,
  deriveCanonicalParts,
  checkoutsDir,
  gitPoolPath,
  gitPoolDir,
  reposDir,
} from "./paths.ts";
import * as shell from "./shell.ts";
import type { GlobalHooksConfig } from "./config.ts";
import type { MountRevision } from "./manifest.ts";

export class CanonicalMirrorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalMirrorError";
  }
}

export interface PlanCanonicalCheckoutInput {
  root: string;
  canonicalPrefix?: string;
  source: string;
  branch?: string;
  /** Default branch of the source. A checkout at any other revision is a
   * sibling (`<repo>@<branch>`); the default branch always owns `<repo>`.
   * Omitted means the caller is planning the default checkout. */
  defaultBranch?: string;
  alias?: string;
}

export interface CanonicalCheckoutPlan {
  source: string;
  canonicalUrl: string;
  sourceKey: string;
  branch: string;
  isSibling: boolean;
  alias?: string;
  relativePath: string;
  absolutePath: string;
  adminRepoPath: string;
}

export function planCanonicalCheckout(input: PlanCanonicalCheckoutInput): CanonicalCheckoutPlan {
  const parts = deriveCanonicalParts(input.source, input.canonicalPrefix);
  const sourceKey = git.normalizeSourceKey(input.source);
  const canonicalUrl = git.stripCredentialsFromUrl(input.source);
  const branch = input.branch || input.defaultBranch || "main";
  const isSibling = Boolean(input.defaultBranch) && branch !== input.defaultBranch;

  let folderName: string;
  if (input.alias) {
    folderName = input.alias.trim();
  } else if (isSibling) {
    folderName = `${parts.repo}@${branch.replace(/[/\\:]/g, "-")}`;
  } else {
    folderName = parts.repo;
  }

  const relativePath = join(parts.relativeBaseDir, folderName);
  const absolutePath = join(input.root, relativePath);
  const adminRepoPath = canonicalAdminRepoPath({ root: input.root, sourceKey });

  return {
    source: input.source,
    canonicalUrl,
    sourceKey,
    branch,
    isSibling,
    alias: input.alias,
    relativePath,
    absolutePath,
    adminRepoPath,
  };
}

export type MirrorSyncActionType = "fast_forward" | "skip";

export interface MirrorSyncAction {
  action: MirrorSyncActionType;
  reason?: string;
  behindCount?: number;
}

export function planRepoSyncAction(observed: git.ObservedWorktree): MirrorSyncAction {
  if (observed.isDirty) {
    return { action: "skip", reason: "DIRTY_WORKTREE" };
  }

  if (observed.aheadCount > 0 && observed.behindCount > 0) {
    return { action: "skip", reason: "DIVERGED" };
  }

  if (observed.aheadCount > 0) {
    return { action: "skip", reason: "AHEAD_COMMITS" };
  }

  if (observed.behindCount === 0) {
    return { action: "skip", reason: "UP_TO_DATE" };
  }

  return { action: "fast_forward", behindCount: observed.behindCount };
}

export interface MirrorDeps {
  fs: typeof fs;
  git: typeof git;
  shell?: typeof shell;
}

export const defaultDeps: MirrorDeps = {
  fs,
  git,
  shell,
};

export interface MirrorAddInput {
  root: string;
  canonicalPrefix?: string;
  source: string;
  branch?: string;
  pin?: string;
  alias?: string;
  extraHeader?: string;
}

export interface MirrorAddResult {
  sourceKey: string;
  canonicalUrl: string;
  branch: string;
  path: string;
}

export interface MirrorEnsureResult extends MirrorAddResult {
  commitSha?: string;
  created: boolean;
}

function pinToRevision(pin: string): MountRevision {
  return /^[0-9a-f]{7,40}$/i.test(pin) ? { mode: "lock", commit: pin } : { mode: "tag", tag: pin };
}

/** Materializes a canonical checkout for a source at a branch tip or pinned
 * revision. Idempotent: an existing checkout at the planned path is returned
 * as-is with `created: false` (freshness stays the job of mirror sync). */
export async function ensure(
  input: MirrorAddInput,
  deps: MirrorDeps = defaultDeps,
): Promise<MirrorEnsureResult> {
  const { mirrorPath, sourceKey } = await deps.git.ensureMirror({
    root: input.root,
    source: input.source,
    extraHeader: input.extraHeader,
  });

  const canonicalUrl = deps.git.stripCredentialsFromUrl(input.source);
  const { adminRepoPath } = await deps.git.ensureCanonicalRepo({
    root: input.root,
    sourceKey,
    canonicalUrl,
    mirrorPath,
  });

  const pinned = input.pin && input.pin.trim().length > 0 ? input.pin.trim() : undefined;
  const defaultBranch = await deps.git.resolveDefaultBranch(adminRepoPath);
  const branch = pinned || input.branch || defaultBranch;

  const plan = planCanonicalCheckout({
    root: input.root,
    canonicalPrefix: input.canonicalPrefix,
    source: input.source,
    branch,
    defaultBranch,
    alias: input.alias,
  });

  if (deps.fs.exists(plan.absolutePath)) {
    const observed = await deps.git.inspectWorktree(plan.absolutePath);
    return {
      sourceKey,
      canonicalUrl,
      branch,
      path: plan.absolutePath,
      commitSha: observed.currentRevision.commitSha,
      created: false,
    };
  }

  const revision: MountRevision = pinned ? pinToRevision(pinned) : { mode: "track", branch };
  const { commitSha } = await deps.git.addWorktree({
    adminRepoPath,
    mountPath: plan.absolutePath,
    revision,
  });

  return {
    sourceKey,
    canonicalUrl,
    branch,
    path: plan.absolutePath,
    commitSha,
    created: true,
  };
}

export interface MirrorTrackInput {
  root: string;
  canonicalPrefix?: string;
  source: string;
  branch: string;
  alias?: string;
  extraHeader?: string;
}

export interface MirrorTrackResult {
  sourceKey: string;
  branch: string;
  path: string;
  /** False when the branch was already tracked at this path: the request already held. */
  created: boolean;
}

export async function track(
  input: MirrorTrackInput,
  deps: MirrorDeps = defaultDeps,
): Promise<MirrorTrackResult> {
  const { mirrorPath, sourceKey } = await deps.git.ensureMirror({
    root: input.root,
    source: input.source,
    extraHeader: input.extraHeader,
  });

  const canonicalUrl = deps.git.stripCredentialsFromUrl(input.source);
  const { adminRepoPath } = await deps.git.ensureCanonicalRepo({
    root: input.root,
    sourceKey,
    canonicalUrl,
    mirrorPath,
  });

  const defaultBranch = await deps.git.resolveDefaultBranch(adminRepoPath);
  if (!input.alias && input.branch === defaultBranch) {
    throw new CanonicalMirrorError(
      "DEFAULT_BRANCH",
      `'${input.branch}' is the default branch: it is already the canonical checkout. Track a different branch, or pass --name to keep a second checkout of it.`,
    );
  }

  const plan = planCanonicalCheckout({
    root: input.root,
    canonicalPrefix: input.canonicalPrefix,
    source: input.source,
    branch: input.branch,
    defaultBranch,
    alias: input.alias,
  });

  if (deps.fs.exists(plan.absolutePath)) {
    return { sourceKey, branch: input.branch, path: plan.absolutePath, created: false };
  }

  await deps.git.addCanonicalWorktree({
    adminRepoPath,
    checkoutPath: plan.absolutePath,
    branch: input.branch,
  });

  return {
    sourceKey,
    branch: input.branch,
    path: plan.absolutePath,
    created: true,
  };
}

export interface MirrorUntrackInput {
  root: string;
  canonicalPrefix?: string;
  source: string;
  branch: string;
  alias?: string;
  force?: boolean;
}

export interface MirrorUntrackResult {
  path: string;
  removed: boolean;
}

export async function untrack(
  input: MirrorUntrackInput,
  deps: MirrorDeps = defaultDeps,
): Promise<MirrorUntrackResult> {
  const sourceKey = deps.git.normalizeSourceKey(input.source);
  const defaultBranch = await deps.git.resolveDefaultBranch(
    canonicalAdminRepoPath({ root: input.root, sourceKey }),
  );
  if (!input.alias && input.branch === defaultBranch) {
    throw new CanonicalMirrorError(
      "DEFAULT_BRANCH",
      `'${input.branch}' is the default branch: its checkout is the mirror itself, not a tracked sibling.`,
    );
  }

  const plan = planCanonicalCheckout({
    root: input.root,
    canonicalPrefix: input.canonicalPrefix,
    source: input.source,
    branch: input.branch,
    defaultBranch,
    alias: input.alias,
  });

  if (!deps.fs.exists(plan.absolutePath)) {
    throw new CanonicalMirrorError(
      "WORKTREE_NOT_FOUND",
      `Canonical worktree does not exist at ${plan.absolutePath}`,
    );
  }

  const observed = await deps.git.inspectWorktree(plan.absolutePath);
  if (observed.isDirty && !input.force) {
    throw new CanonicalMirrorError(
      "DIRTY_WORKTREE",
      `Worktree at ${plan.absolutePath} has modified or untracked files. Use --force to untrack anyway.`,
    );
  }

  await deps.git.removeWorktree(plan.adminRepoPath, plan.absolutePath, {
    force: input.force,
  });
  await deps.fs.removeDir(plan.absolutePath);

  return {
    path: plan.absolutePath,
    removed: true,
  };
}

export interface MirrorListItem {
  name: string;
  branch: string;
  commitSha?: string;
  path: string;
  sourceUrl?: string;
  isClean: boolean;
  ahead: number;
  behind: number;
}

export async function findRepoWorktrees(
  dir: string,
  deps: MirrorDeps = defaultDeps,
): Promise<string[]> {
  if (typeof deps.fs.findGitWorktrees === "function") {
    return await deps.fs.findGitWorktrees(dir);
  }
  const worktrees: string[] = [];
  if (!deps.fs.exists(dir)) return worktrees;
  return worktrees;
}

export async function list(
  input: { root: string; canonicalPrefix?: string },
  deps: MirrorDeps = defaultDeps,
): Promise<MirrorListItem[]> {
  const checkoutsPath = checkoutsDir({
    root: input.root,
    canonicalPrefix: input.canonicalPrefix,
  });
  const worktreePaths = await findRepoWorktrees(checkoutsPath, deps);
  const items: MirrorListItem[] = [];

  for (const wtPath of worktreePaths) {
    const observed = await deps.git.inspectWorktree(wtPath);
    items.push({
      name: basename(wtPath),
      branch: observed.currentRevision.branch || "unknown",
      commitSha: observed.currentRevision.commitSha,
      path: wtPath,
      sourceUrl: await deps.git.worktreeOriginUrl(wtPath),
      isClean: !observed.isDirty,
      ahead: observed.aheadCount,
      behind: observed.behindCount,
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export interface MirrorSyncItemResult {
  path: string;
  branch: string;
  sourceUrl?: string;
  status: "updated" | "skipped";
  reason?: string;
  behindCount?: number;
}

export interface MirrorStashResult extends git.StashWorktreeResult {
  path: string;
  branch: string;
}

export interface MirrorSyncResult {
  updated: MirrorSyncItemResult[];
  skipped: MirrorSyncItemResult[];
  stashed: MirrorStashResult[];
  hookWarning?: string;
  /** Where the time went: stage durations + the slowest items. */
  trace: SyncTrace;
}

export interface SyncStageTiming {
  name: string;
  ms: number;
}

export interface SyncItemTiming {
  path: string;
  branch: string;
  ms: number;
  status: "updated" | "skipped";
}

export interface SyncTrace {
  totalMs: number;
  stages: SyncStageTiming[];
  slowestItems: SyncItemTiming[];
}

/** Runs fn over items with bounded concurrency while preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(Math.max(1, Math.min(Math.floor(concurrency), items.length || 1)));
  return await Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}

export async function sync(
  input: {
    root: string;
    canonicalPrefix?: string;
    source?: string;
    refresh?: boolean;
    offline?: boolean;
    resolveExtraHeader?: (source: string) => Promise<string | undefined>;
    globalHooks?: GlobalHooksConfig;
  },
  deps: MirrorDeps = defaultDeps,
): Promise<MirrorSyncResult> {
  const checkoutsPath = checkoutsDir({
    root: input.root,
    canonicalPrefix: input.canonicalPrefix,
  });
  let worktreePaths = await findRepoWorktrees(checkoutsPath, deps);

  const targetSourceKey = input.source ? deps.git.normalizeSourceKey(input.source) : undefined;
  if (targetSourceKey) {
    const identified = await Promise.all(
      worktreePaths.map(async (path) => ({ path, source: await deps.git.worktreeOriginUrl(path) })),
    );
    worktreePaths = identified
      .filter((item) => item.source && deps.git.normalizeSourceKey(item.source) === targetSourceKey)
      .map((item) => item.path);
  }

  const stageMs = new Map<string, number>();
  const totalStart = Date.now();
  let stageStart = totalStart;
  // If refresh is requested, refresh mirrors from remote
  if (input.refresh && !input.offline) {
    const poolPaths = targetSourceKey
      ? [gitPoolPath({ root: input.root, source: input.source! })].filter((path) =>
          deps.fs.exists(path),
        )
      : (await deps.fs.findFiles(gitPoolDir({ root: input.root }), (name) => name === "HEAD"))
          .map((head) => dirname(head))
          .filter((path) => path.endsWith(".git"));
    for (const mirrorPath of poolPaths) {
      try {
        await deps.git.fetchMirror({
          mirrorPath,
          resolveExtraHeader: input.resolveExtraHeader,
        });
      } catch {}
    }
    // Propagate pool refs into the canonical admin repos so their
    // origin/<branch> targets are fresh for fast-forward. Fetch from the
    // pool path (recorded in the admin's alternates by --reference), never
    // from origin: the admin's origin is the real remote and fetching it
    // would trigger credential prompts.
    const instancesDir = reposDir({ root: input.root });
    const adminRepoPaths = targetSourceKey
      ? [canonicalAdminRepoPath({ root: input.root, sourceKey: targetSourceKey })].filter((path) =>
          deps.fs.exists(path),
        )
      : (await deps.fs.listDirs(instancesDir))
          .filter((name) => name.endsWith(".git"))
          .map((name) => join(instancesDir, name));
    for (const adminRepoPath of adminRepoPaths) {
      if (!adminRepoPath.endsWith(".git")) continue;
      try {
        const alternates = await deps.fs.readText(
          join(adminRepoPath, "objects", "info", "alternates"),
        );
        const poolObjects = alternates.split(/\r?\n/)[0]?.trim();
        if (!poolObjects) continue;
        const poolPath = dirname(poolObjects);
        if (!deps.fs.exists(poolPath)) continue;
        await deps.git.fetchAdminRepo(adminRepoPath, poolPath);
      } catch {}
    }
    stageMs.set("refresh", Date.now() - stageStart);
  }

  const stashed: MirrorStashResult[] = [];
  const stashFailures = new Map<string, { branch: string; reason: string }>();
  for (const wtPath of worktreePaths) {
    await deps.git.installCanonicalCommitGuardForWorktree(wtPath);
    const observed = await deps.git.inspectWorktree(wtPath);
    if (!observed.isDirty) continue;

    const branch = observed.currentRevision.branch || "main";
    const stashName = `dev mirror sync ${new Date().toISOString()} ${basename(wtPath)} ${randomUUID()}`;
    try {
      const result = await deps.git.stashWorktree(wtPath, stashName);
      stashed.push({ path: wtPath, branch, ...result });
    } catch (error) {
      stashFailures.set(wtPath, {
        branch,
        reason: `STASH_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  stageMs.set("stash", Date.now() - stageStart);

  // Per-checkout work runs in parallel, bounded by CPU cores. Each checkout
  // is an independent worktree of its own admin, so there is no shared write state.
  const concurrency = Math.max(1, cpus().length);
  stageStart = Date.now();

  const itemResults = await mapWithConcurrency(worktreePaths, concurrency, async (wtPath) => {
    const itemStart = Date.now();
    const stashFailure = stashFailures.get(wtPath);
    if (stashFailure) {
      return {
        item: {
          path: wtPath,
          branch: stashFailure.branch,
          status: "skipped" as const,
          reason: stashFailure.reason,
        },
        ms: Date.now() - itemStart,
      };
    }
    const observed = await deps.git.inspectWorktree(wtPath);
    const branch = observed.currentRevision.branch || "main";
    const plan = planRepoSyncAction(observed);

    if (plan.action === "skip") {
      return {
        item: {
          path: wtPath,
          branch,
          status: "skipped" as const,
          reason: plan.reason,
        },
        ms: Date.now() - itemStart,
      };
    }

    try {
      await deps.git.fastForward({
        worktreePath: wtPath,
        targetRef: `origin/${branch}`,
      });
      return {
        item: {
          path: wtPath,
          branch,
          sourceUrl: await deps.git.worktreeOriginUrl(wtPath),
          status: "updated" as const,
          behindCount: plan.behindCount,
        },
        ms: Date.now() - itemStart,
      };
    } catch (error) {
      return {
        item: {
          path: wtPath,
          branch,
          status: "skipped" as const,
          reason: `FAST_FORWARD_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        },
        ms: Date.now() - itemStart,
      };
    }
  });
  stageMs.set("checkouts", Date.now() - stageStart);
  stageStart = Date.now();

  const updated: MirrorSyncItemResult[] = itemResults
    .filter((r) => r.item.status === "updated")
    .map((r) => r.item);
  const skipped: MirrorSyncItemResult[] = itemResults
    .filter((r) => r.item.status === "skipped")
    .map((r) => r.item);

  let hookWarning: string | undefined;
  if (updated.length > 0 && input.globalHooks?.post_sync) {
    const shellDep = deps.shell || shell;
    const res = await shellDep.runHook(input.globalHooks.post_sync, {
      cwd: checkoutsPath,
      env: { DEV_ROOT: input.root },
    });
    if (res.exitCode !== 0) {
      hookWarning = `post_sync hook failed with exit code ${res.exitCode}: ${res.stderr || res.stdout}`;
    }
  }
  stageMs.set("hooks", Date.now() - stageStart);

  const stages = [...stageMs.entries()].map(([name, ms]) => ({ name, ms }));
  const slowestItems = itemResults
    .map((r) => ({
      path: r.item.path,
      branch: r.item.branch,
      ms: r.ms,
      status: r.item.status,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);

  return {
    updated,
    stashed,
    skipped,
    hookWarning,
    trace: { totalMs: Date.now() - totalStart, stages, slowestItems },
  };
}
