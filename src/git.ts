import { basename, dirname, join } from "node:path";
import { canonicalAdminRepoPath, gitPoolPath, reposDir, workspaceAdminRepoPath } from "./paths.ts";
import { withHostLimit } from "./host-limit.ts";

export {
  deriveCanonicalParts,
  gitPoolPath,
  canonicalAdminRepoPath,
  workspaceAdminRepoPath,
} from "./paths.ts";
export type { CanonicalParts } from "./paths.ts";
import * as fs from "./fs.ts";
import type { MountRevision } from "./manifest.ts";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGit(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    source?: string | URL;
  } = {},
): Promise<GitExecResult> {
  const execute = async (): Promise<GitExecResult> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // Messages must be untranslated: some call sites match git's own wording.
        // gettext picks LANGUAGE first, so both are needed to be certain.
        LANGUAGE: "",
        LC_ALL: "C",
        ...options.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  };

  return options.source ? await withHostLimit(options.source, execute) : await execute();
}

export interface RemoteBranches {
  defaultBranch?: string;
  branches: string[];
}

export async function listRemoteBranches(options: {
  source: string;
  extraHeader?: string;
}): Promise<RemoteBranches> {
  const args: string[] = [];
  if (options.extraHeader) args.push("-c", options.extraHeader);
  args.push("ls-remote", "--symref", options.source, "HEAD", "refs/heads/*");
  const result = await runGit(args, { source: options.source });
  if (result.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to list branches for ${options.source}: ${result.stderr || result.stdout}`,
      ),
    );
  }
  let defaultBranch: string | undefined;
  const branches = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [first, second] = line.split(/\s+/);
    if (first === "ref:" && second?.startsWith("refs/heads/")) {
      defaultBranch = second.slice("refs/heads/".length);
    } else if (second?.startsWith("refs/heads/")) {
      branches.add(second.slice("refs/heads/".length));
    }
  }
  const sorted = [...branches].sort((left, right) => left.localeCompare(right));
  if (defaultBranch) {
    return {
      defaultBranch,
      branches: [defaultBranch, ...sorted.filter((branch) => branch !== defaultBranch)],
    };
  }
  return { branches: sorted };
}

export function stripCredentialsFromUrl(url: string): string {
  return url.trim().replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]+@/i, "$1");
}

/**
 * Removes `user:secret@` from every URL inside a free-text string. Use this on anything
 * that reaches a user, a log or a hook: error messages, git stderr, reports. Unlike
 * stripCredentialsFromUrl it is not anchored, so it also cleans URLs embedded in a
 * sentence, and it is safe to apply to text that contains no URL at all.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1");
}

export function normalizeSourceKey(url: string): string {
  let cleaned = url.trim();

  // Strip ssh git@
  if (cleaned.startsWith("git@")) {
    cleaned = cleaned.replace(/^git@([^:]+):/, "$1/");
  } else {
    // Strip scheme with user:password@ or token@ (https://, http://, ssh://, git://, etc.)
    cleaned = cleaned.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@/]+@/i, "");
    // Strip scheme without credentials
    cleaned = cleaned.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i, "");
  }

  // Strip any remaining userinfo if protocol was omitted (e.g. user:pass@host/repo)
  cleaned = cleaned.replace(/^[^@/]+@/, "");

  // Strip port if present e.g. host:8080/path -> host/path
  cleaned = cleaned.replace(/^([^/:]+):\d+/, "$1");

  // Strip trailing .git
  cleaned = cleaned.replace(/\.git$/, "");

  // Strip trailing slashes
  cleaned = cleaned.replace(/\/+$/, "");

  // Replace separators and special chars with double underscore
  const sanitized = cleaned
    .split("/")
    .filter(Boolean)
    .join("__")
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  return sanitized;
}

export function deriveDefaultMountPath(url: string): string {
  let cleaned = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const lastSlash = Math.max(
    cleaned.lastIndexOf("/"),
    cleaned.lastIndexOf("\\"),
    cleaned.lastIndexOf(":"),
  );
  if (lastSlash >= 0) {
    cleaned = cleaned.slice(lastSlash + 1);
  }
  return cleaned;
}

export interface EnsureMirrorOptions {
  root: string;
  source: string;
  extraHeader?: string;
}

export interface EnsureMirrorResult {
  sourceKey: string;
  mirrorPath: string;
  created: boolean;
}

export async function ensureMirror(options: EnsureMirrorOptions): Promise<EnsureMirrorResult> {
  const sourceKey = normalizeSourceKey(options.source);
  const mirrorPath = gitPoolPath({ root: options.root, source: options.source });

  if (fs.exists(mirrorPath)) {
    return { sourceKey, mirrorPath, created: false };
  }

  await fs.ensureDir(join(mirrorPath, ".."));

  const cloneArgs: string[] = [];
  if (options.extraHeader) {
    cloneArgs.push("-c", options.extraHeader);
  }
  cloneArgs.push("clone", "--mirror", options.source, mirrorPath);

  const res = await runGit(cloneArgs, { source: options.source });
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to create mirror for ${options.source}: ${res.stderr || res.stdout}`,
      ),
    );
  }

  // Configure gc invariants
  await runGit(["-C", mirrorPath, "config", "gc.auto", "0"]);
  await runGit(["-C", mirrorPath, "config", "gc.pruneExpire", "never"]);

  return { sourceKey, mirrorPath, created: true };
}

export interface FetchMirrorOptions {
  mirrorPath: string;
  resolveExtraHeader?: (source: string) => Promise<string | undefined>;
}

// Two workspaces of one source sync side by side: the second joins the fetch
// already running instead of racing it for the pool's ref locks.
const mirrorFetchesInFlight = new Map<string, Promise<void>>();

export function fetchMirror(options: FetchMirrorOptions): Promise<void> {
  const running = mirrorFetchesInFlight.get(options.mirrorPath);
  if (running) return running;
  const fetch = fetchMirrorNow(options).finally(() =>
    mirrorFetchesInFlight.delete(options.mirrorPath),
  );
  mirrorFetchesInFlight.set(options.mirrorPath, fetch);
  return fetch;
}

async function fetchMirrorNow(options: FetchMirrorOptions): Promise<void> {
  const origin = await runGit(["-C", options.mirrorPath, "remote", "get-url", "origin"]);
  const source = origin.exitCode === 0 ? origin.stdout.trim() : undefined;
  const extraHeader = source ? await options.resolveExtraHeader?.(source) : undefined;
  const args = ["-C", options.mirrorPath];
  if (extraHeader) {
    args.push("-c", extraHeader);
  }
  args.push("fetch", "--prune", "origin");

  const res = await runGit(args, { source });
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to fetch mirror at ${options.mirrorPath}: ${res.stderr || res.stdout}`,
      ),
    );
  }
}

export async function fetchAdminRepo(adminRepoPath: string, mirrorPath?: string): Promise<void> {
  const args = ["-C", adminRepoPath, "fetch"];
  if (mirrorPath) {
    args.push(mirrorPath, "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*");
  } else {
    args.push("--prune", "origin");
  }
  const origin = mirrorPath
    ? undefined
    : await runGit(["-C", adminRepoPath, "remote", "get-url", "origin"]);
  const res = await runGit(args, {
    source: mirrorPath ?? (origin?.exitCode === 0 ? origin.stdout : undefined),
  });
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to fetch admin repo at ${adminRepoPath}: ${res.stderr || res.stdout}`,
      ),
    );
  }
}

export interface EnsureWorkspaceRepoOptions {
  root: string;
  workspaceName: string;
  sourceKey: string;
  canonicalUrl: string;
  mirrorPath: string;
}

export interface EnsureWorkspaceRepoResult {
  adminRepoPath: string;
  created: boolean;
}

export async function ensureWorkspaceRepo(
  options: EnsureWorkspaceRepoOptions,
): Promise<EnsureWorkspaceRepoResult> {
  const adminRepoPath = workspaceAdminRepoPath({
    root: options.root,
    workspaceName: options.workspaceName,
    sourceKey: options.sourceKey,
  });

  if (fs.exists(adminRepoPath)) {
    return { adminRepoPath, created: false };
  }

  await fs.ensureDir(reposDir({ root: options.root }));

  // Objects stay in the central pool (.dev/git): local clone hardlinks
  // them instead of copying, so this admin bare holds refs and worktree
  // metadata only. The CLI never gc-prunes mirrors, keeping the links valid.
  const cloneRes = await runGit([
    "clone",
    "--bare",
    "--reference",
    options.mirrorPath,
    options.mirrorPath,
    adminRepoPath,
  ]);

  if (cloneRes.exitCode !== 0) {
    throw new Error(`Failed to create workspace admin repo: ${cloneRes.stderr || cloneRes.stdout}`);
  }

  await runGit(["-C", adminRepoPath, "remote", "set-url", "origin", options.canonicalUrl]);
  await runGit([
    "-C",
    adminRepoPath,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await runGit([
    "-C",
    adminRepoPath,
    "fetch",
    options.mirrorPath,
    "+refs/heads/*:refs/remotes/origin/*",
  ]);

  return { adminRepoPath, created: true };
}

export interface AdoptWorktreeOptions {
  adminRepoPath: string;
  mountPath: string;
  /** Branch name, tag, or commit the mount should point at. */
  revision: string;
  trackBranch: boolean;
}

/**
 * Re-links an existing mount directory to an admin bare that lost (or never
 * had) its worktree metadata. Rebuilds the admin-side registration, points the
 * mount at the given revision, and regenerates the index. Uncommitted file
 * edits inside the mount are preserved; staged state is not.
 */
export async function adoptWorktree(options: AdoptWorktreeOptions): Promise<void> {
  const worktreeId = basename(options.mountPath);
  const metadataDir = join(options.adminRepoPath, "worktrees", worktreeId);
  await fs.ensureDir(metadataDir);

  const gitdirFile = join(options.mountPath, ".git");
  // Git marks this file hidden on Windows; replace it so the new content is
  // writable by plain file APIs.
  await fs.removeFile(gitdirFile);
  await fs.writeText(gitdirFile, `gitdir: ${metadataDir.replace(/\\/g, "/")}\n`);
  await fs.writeText(
    join(metadataDir, "gitdir"),
    `${join(options.mountPath, ".git").replace(/\\/g, "/")}\n`,
  );
  await fs.writeText(join(metadataDir, "commondir"), "../..\n");
  const head = options.trackBranch
    ? `ref: refs/heads/${options.revision}\n`
    : `${options.revision}\n`;
  await fs.writeText(join(metadataDir, "HEAD"), head);

  await runGit(["-C", options.adminRepoPath, "worktree", "repair", options.mountPath]);
  await runGit(["-C", options.mountPath, "read-tree", "HEAD"]);
}

/** Re-links a mount whose admin bare was moved to a new location. */
export async function repairWorktreeLink(adminRepoPath: string, mountPath: string): Promise<void> {
  await runGit(["-C", adminRepoPath, "worktree", "repair", mountPath]);
}

export async function resolveDefaultBranch(adminRepoPath: string): Promise<string> {
  const symRef = await runGit(["-C", adminRepoPath, "symbolic-ref", "--short", "HEAD"]);
  if (symRef.exitCode === 0 && symRef.stdout.length > 0) {
    return symRef.stdout;
  }

  // Check if main or master exists
  const checkMain = await runGit(["-C", adminRepoPath, "rev-parse", "--verify", "refs/heads/main"]);
  if (checkMain.exitCode === 0) return "main";

  const checkMaster = await runGit([
    "-C",
    adminRepoPath,
    "rev-parse",
    "--verify",
    "refs/heads/master",
  ]);
  if (checkMaster.exitCode === 0) return "master";

  // List heads
  const listHeads = await runGit([
    "-C",
    adminRepoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (listHeads.exitCode === 0 && listHeads.stdout.length > 0) {
    const first = listHeads.stdout.split("\n")[0].trim();
    if (first) return first;
  }

  return "main";
}

/** Whether the admin repository can check out the revision without fetching. */
export async function hasRevision(
  adminRepoPath: string,
  revision: MountRevision,
): Promise<boolean> {
  const candidates =
    revision.mode === "lock"
      ? [`${revision.commit}^{commit}`]
      : revision.mode === "tag"
        ? [`refs/tags/${revision.tag}`]
        : revision.upstream && revision.upstream !== revision.branch
          ? [`refs/remotes/origin/${revision.upstream}`]
          : [`refs/heads/${revision.branch}`, `refs/remotes/origin/${revision.branch}`];
  for (const ref of candidates) {
    const res = await runGit(["-C", adminRepoPath, "rev-parse", "--verify", "--quiet", ref]);
    if (res.exitCode === 0) return true;
  }
  return false;
}

export interface AddWorktreeOptions {
  adminRepoPath: string;
  mountPath: string;
  revision: MountRevision;
}

export async function addWorktree(options: AddWorktreeOptions): Promise<{ commitSha: string }> {
  if (fs.exists(options.mountPath)) {
    throw new Error(`Worktree mount path already exists: ${options.mountPath}`);
  }

  await fs.ensureDir(join(options.mountPath, ".."));
  await runGit(["-C", options.adminRepoPath, "worktree", "prune"]);

  const args = ["-C", options.adminRepoPath, "worktree", "add"];

  if (options.revision.mode === "track") {
    if (options.revision.upstream && options.revision.upstream !== options.revision.branch) {
      args.push(
        "-b",
        options.revision.branch,
        options.mountPath,
        `origin/${options.revision.upstream}`,
      );
    } else {
      args.push(options.mountPath, options.revision.branch);
    }
  } else if (options.revision.mode === "lock") {
    args.push("--detach", options.mountPath, options.revision.commit);
  } else if (options.revision.mode === "tag") {
    args.push("--detach", options.mountPath, options.revision.tag);
  }

  let res = await runGit(args);
  if (res.exitCode !== 0 && res.stderr.includes("already registered worktree")) {
    // Retry with --force
    const forceArgs = ["-C", options.adminRepoPath, "worktree", "add", "--force"];
    if (options.revision.mode === "track") {
      if (options.revision.upstream && options.revision.upstream !== options.revision.branch) {
        forceArgs.push(
          "-b",
          options.revision.branch,
          options.mountPath,
          `origin/${options.revision.upstream}`,
        );
      } else {
        forceArgs.push(options.mountPath, options.revision.branch);
      }
    } else if (options.revision.mode === "lock") {
      forceArgs.push("--detach", options.mountPath, options.revision.commit);
    } else if (options.revision.mode === "tag") {
      forceArgs.push("--detach", options.mountPath, options.revision.tag);
    }
    res = await runGit(forceArgs);
  }

  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(`Failed to create worktree mount: ${res.stderr || res.stdout}`),
    );
  }

  if (options.revision.mode === "track") {
    await runGit([
      "-C",
      options.adminRepoPath,
      "config",
      `branch.${options.revision.branch}.remote`,
      "origin",
    ]);
    await runGit([
      "-C",
      options.adminRepoPath,
      "config",
      `branch.${options.revision.branch}.merge`,
      `refs/heads/${options.revision.upstream ?? options.revision.branch}`,
    ]);
  }

  const revRes = await runGit(["-C", options.mountPath, "rev-parse", "HEAD"]);
  if (revRes.exitCode !== 0) {
    throw new Error(`Failed to get commit SHA for worktree: ${revRes.stderr}`);
  }

  return { commitSha: revRes.stdout };
}

export interface ObservedWorktree {
  path: string;
  exists: boolean;
  isGitWorktree: boolean;
  currentRevision: {
    branch?: string;
    commitSha?: string;
    tag?: string;
  };
  isDirty: boolean;
  modifiedFiles: number;
  untrackedFiles: number;
  aheadCount: number;
  behindCount: number;
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  const res = await runGit(["-C", worktreePath, "status", "--porcelain"]);
  return res.exitCode === 0 && res.stdout.length > 0;
}

export async function currentRevision(
  worktreePath: string,
): Promise<{ branch?: string; commitSha?: string; tag?: string }> {
  const branchRes = await runGit(["-C", worktreePath, "branch", "--show-current"]);
  const branch =
    branchRes.exitCode === 0 && branchRes.stdout.length > 0 ? branchRes.stdout : undefined;

  const shaRes = await runGit(["-C", worktreePath, "rev-parse", "HEAD"]);
  const commitSha = shaRes.exitCode === 0 && shaRes.stdout.length > 0 ? shaRes.stdout : undefined;

  const tagRes = await runGit(["-C", worktreePath, "describe", "--tags", "--exact-match"]);
  const tag = tagRes.exitCode === 0 && tagRes.stdout.length > 0 ? tagRes.stdout : undefined;

  return { branch, commitSha, tag };
}

export async function worktreeAdminRepoPath(worktreePath: string): Promise<string | undefined> {
  const gitEntryPath = join(worktreePath, ".git");
  // A worktree has a .git file; a plain clone has a .git directory.
  if (!fs.exists(gitEntryPath) || (await fs.isDirectory(gitEntryPath))) return undefined;
  const gitdir = (await fs.readText(gitEntryPath)).replace(/^gitdir:\s*/, "").trim();
  return dirname(dirname(gitdir));
}

/** Resolves the canonical origin URL of a checkout that is a worktree of a
 * bare admin repo: .git file -> admin gitdir -> remote.origin.url. */
export async function worktreeOriginUrl(worktreePath: string): Promise<string | undefined> {
  const adminRepoPath = await worktreeAdminRepoPath(worktreePath);
  if (!adminRepoPath) return undefined;
  const res = await runGit(["-C", adminRepoPath, "config", "--get", "remote.origin.url"]);
  const url = res.stdout.trim();
  return url || undefined;
}

export async function inspectWorktree(worktreePath: string): Promise<ObservedWorktree> {
  if (!fs.exists(worktreePath)) {
    return {
      path: worktreePath,
      exists: false,
      isGitWorktree: false,
      currentRevision: {},
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const gitEntryPath = join(worktreePath, ".git");
  if (!fs.exists(gitEntryPath)) {
    return {
      path: worktreePath,
      exists: true,
      isGitWorktree: false,
      currentRevision: {},
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const rev = await currentRevision(worktreePath);
  const statusRes = await runGit(["-C", worktreePath, "status", "--porcelain"]);

  let modifiedFiles = 0;
  let untrackedFiles = 0;

  if (statusRes.exitCode === 0 && statusRes.stdout.length > 0) {
    const lines = statusRes.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("??")) {
        untrackedFiles++;
      } else {
        modifiedFiles++;
      }
    }
  }

  let aheadCount = 0;
  let behindCount = 0;

  if (rev.branch) {
    // Check ahead/behind against upstream or origin/<branch>
    let countRes = await runGit([
      "-C",
      worktreePath,
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    if (countRes.exitCode !== 0) {
      countRes = await runGit([
        "-C",
        worktreePath,
        "rev-list",
        "--left-right",
        "--count",
        `origin/${rev.branch}...HEAD`,
      ]);
    }

    if (countRes.exitCode === 0 && countRes.stdout.length > 0) {
      const parts = countRes.stdout.split(/\s+/);
      if (parts.length >= 2) {
        behindCount = Number.parseInt(parts[0], 10) || 0;
        aheadCount = Number.parseInt(parts[1], 10) || 0;
      }
    }
  } else if (rev.commitSha) {
    // A detached HEAD has no upstream: its local commits are the ones no
    // branch, tag or remote reaches, and a checkout would leave them behind.
    const countRes = await runGit([
      "-C",
      worktreePath,
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--branches",
      "--tags",
      "--remotes",
    ]);
    if (countRes.exitCode === 0) aheadCount = Number.parseInt(countRes.stdout, 10) || 0;
  }

  return {
    path: worktreePath,
    exists: true,
    isGitWorktree: true,
    currentRevision: rev,
    isDirty: modifiedFiles > 0 || untrackedFiles > 0,
    modifiedFiles,
    untrackedFiles,
    aheadCount,
    behindCount,
  };
}

export interface StashWorktreeResult {
  stashName: string;
  stashSha: string;
  changes: string[];
}

export async function stashWorktree(
  worktreePath: string,
  stashName: string,
): Promise<StashWorktreeResult> {
  const status = await runGit(["-C", worktreePath, "status", "--short"]);
  if (status.exitCode !== 0) {
    throw new Error(`Failed to inspect local mirror changes: ${status.stderr || status.stdout}`);
  }
  const changes = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (changes.length === 0) {
    throw new Error(`No local mirror changes found at ${worktreePath}`);
  }

  const previousStash = await runGit(["-C", worktreePath, "rev-parse", "--verify", "refs/stash"]);

  const stashed = await runGit([
    "-C",
    worktreePath,
    "stash",
    "push",
    "--include-untracked",
    "--message",
    stashName,
  ]);
  if (stashed.exitCode !== 0) {
    throw new Error(`Failed to preserve local mirror changes: ${stashed.stderr || stashed.stdout}`);
  }

  const stashSha = await runGit(["-C", worktreePath, "rev-parse", "--verify", "refs/stash"]);
  if (
    stashSha.exitCode !== 0 ||
    !stashSha.stdout ||
    (previousStash.exitCode === 0 && previousStash.stdout === stashSha.stdout)
  ) {
    throw new Error(`Mirror changes were not stored in a new recoverable stash`);
  }

  return { stashName, stashSha: stashSha.stdout, changes };
}

export interface FastForwardOptions {
  worktreePath: string;
  targetRef: string;
}

export async function fastForward(options: FastForwardOptions): Promise<void> {
  const res = await runGit(["-C", options.worktreePath, "merge", "--ff-only", options.targetRef]);
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to fast-forward worktree at ${options.worktreePath} to ${options.targetRef}: ${res.stderr || res.stdout}`,
      ),
    );
  }
}

export async function switchBranch(worktreePath: string, branch: string): Promise<void> {
  const res = await runGit(["-C", worktreePath, "checkout", branch]);
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to switch worktree at ${worktreePath} to branch '${branch}': ${res.stderr || res.stdout}`,
      ),
    );
  }
}

export async function checkoutRevision(worktreePath: string, target: string): Promise<void> {
  const res = await runGit(["-C", worktreePath, "checkout", target]);
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to checkout '${target}' in worktree at ${worktreePath}: ${res.stderr || res.stdout}`,
      ),
    );
  }
}

export async function removeWorktree(
  adminRepoPath: string,
  worktreePath: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const args = ["-C", adminRepoPath, "worktree", "remove"];
  if (options.force) {
    args.push("--force");
  }
  args.push(worktreePath);
  const res = await runGit(args);
  if (res.exitCode !== 0) {
    throw new Error(
      redactCredentials(
        `Failed to remove worktree at ${worktreePath}: ${res.stderr || res.stdout}`,
      ),
    );
  }
}

export const CANONICAL_COMMIT_GUARD = `#!/bin/sh
cat >&2 <<'EOF'
dev: commits are disabled in canonical mirrors.
Create a workspace, then edit and commit there:
  dev ws init <workspace>
  dev ws add <repository> --ws <workspace>
EOF
exit 1
`;

export async function installCanonicalCommitGuard(adminRepoPath: string): Promise<void> {
  const hooksPath = join(adminRepoPath, "hooks");
  const hookPath = join(hooksPath, "prepare-commit-msg");
  await fs.ensureDir(hooksPath);
  await fs.writeText(hookPath, CANONICAL_COMMIT_GUARD);
  await fs.makeExecutable(hookPath);
}

export async function repairLegacyCanonicalPermissions(worktreePath: string): Promise<boolean> {
  // An older version stripped write from files and directories; an earlier repair
  // restored files only, leaving directories where git cannot replace a file.
  const gitEntryMode = await fs.mode(join(worktreePath, ".git"));
  const rootMode = await fs.mode(worktreePath);
  if (gitEntryMode === undefined || rootMode === undefined) return false;
  if ((gitEntryMode & 0o200) !== 0 && (rootMode & 0o200) !== 0) return false;

  await fs.makeOwnerWritable(worktreePath);
  const tracked = await runGit(["-C", worktreePath, "ls-files", "--stage", "-z"]);
  if (tracked.exitCode !== 0) {
    throw new Error(`Failed to restore canonical file modes: ${tracked.stderr || tracked.stdout}`);
  }

  for (const entry of tracked.stdout.split("\0")) {
    const match = /^(100755) [0-9a-f]+ \d\t(.+)$/s.exec(entry);
    if (match?.[2]) {
      await fs.makeFileExecutable(join(worktreePath, match[2]));
    }
  }
  return true;
}

export async function installCanonicalCommitGuardForWorktree(worktreePath: string): Promise<void> {
  const adminRepoPath = await worktreeAdminRepoPath(worktreePath);
  if (!adminRepoPath) {
    throw new Error(`Canonical admin repository not found for ${worktreePath}`);
  }
  await repairLegacyCanonicalPermissions(worktreePath);
  await installCanonicalCommitGuard(adminRepoPath);
}

export interface EnsureCanonicalRepoOptions {
  root: string;
  sourceKey: string;
  canonicalUrl: string;
  mirrorPath: string;
}

export interface EnsureCanonicalRepoResult {
  adminRepoPath: string;
  created: boolean;
}

export async function ensureCanonicalRepo(
  options: EnsureCanonicalRepoOptions,
): Promise<EnsureCanonicalRepoResult> {
  const adminRepoPath = canonicalAdminRepoPath({
    root: options.root,
    sourceKey: options.sourceKey,
  });
  if (fs.exists(adminRepoPath)) {
    await installCanonicalCommitGuard(adminRepoPath);
    return { adminRepoPath, created: false };
  }

  await fs.ensureDir(reposDir({ root: options.root }));

  const cloneRes = await runGit([
    "clone",
    "--bare",
    "--reference",
    options.mirrorPath,
    options.mirrorPath,
    adminRepoPath,
  ]);

  if (cloneRes.exitCode !== 0) {
    throw new Error(`Failed to create canonical admin repo: ${cloneRes.stderr || cloneRes.stdout}`);
  }

  await runGit(["-C", adminRepoPath, "remote", "set-url", "origin", options.canonicalUrl]);
  await runGit([
    "-C",
    adminRepoPath,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await runGit([
    "-C",
    adminRepoPath,
    "fetch",
    options.mirrorPath,
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await installCanonicalCommitGuard(adminRepoPath);

  return { adminRepoPath, created: true };
}

export interface AddCanonicalWorktreeOptions {
  adminRepoPath: string;
  checkoutPath: string;
  branch: string;
}

export async function addCanonicalWorktree(
  options: AddCanonicalWorktreeOptions,
): Promise<{ commitSha: string }> {
  return await addWorktree({
    adminRepoPath: options.adminRepoPath,
    mountPath: options.checkoutPath,
    revision: { mode: "track", branch: options.branch },
  });
}

export async function inspectRepositories(worktreePaths: string[]): Promise<ObservedWorktree[]> {
  const results: ObservedWorktree[] = [];
  for (const path of worktreePaths) {
    results.push(await inspectWorktree(path));
  }
  return results;
}

export interface StashFastForwardOptions {
  worktreePath: string;
  targetRef: string;
}

export interface StashFastForwardResult {
  /** True when `git stash pop` hit conflicts; the stash entry is kept. */
  stashConflict: boolean;
}

/** Fast-forwards a dirty worktree: stash, fast-forward, pop. On pop
 * conflicts the stash entry stays intact for manual recovery. */
export async function stashFastForward(
  options: StashFastForwardOptions,
): Promise<StashFastForwardResult> {
  const stash = await runGit([
    "-C",
    options.worktreePath,
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "dev autostash",
  ]);
  if (stash.exitCode !== 0) {
    throw new Error(`Failed to stash changes: ${stash.stderr || stash.stdout}`);
  }

  await fastForward({ worktreePath: options.worktreePath, targetRef: options.targetRef });

  const pop = await runGit(["-C", options.worktreePath, "stash", "pop"]);
  return { stashConflict: pop.exitCode !== 0 };
}

export interface RebaseOntoOptions {
  worktreePath: string;
  targetRef: string;
}

export interface RebaseOntoResult {
  ok: boolean;
  /** Rebase output listing the conflicting files when ok is false. */
  conflicts?: string;
}

/** Rebases the worktree onto the target ref with atomic rollback: any
 * non-zero rebase exit immediately aborts, leaving the worktree untouched. */
export async function rebaseOnto(options: RebaseOntoOptions): Promise<RebaseOntoResult> {
  const res = await runGit(["-C", options.worktreePath, "rebase", options.targetRef]);
  if (res.exitCode === 0) {
    return { ok: true };
  }
  await runGit(["-C", options.worktreePath, "rebase", "--abort"]);
  return { ok: false, conflicts: `${res.stdout}\n${res.stderr}`.trim() };
}
