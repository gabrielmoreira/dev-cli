import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import * as fs from "./fs.ts";
import * as git from "./git.ts";
import { gitPoolPath, workspaceAdminRepoPath, workspacePath, workspacesDir } from "./paths.ts";
import * as manifest from "./manifest.ts";
import * as shell from "./shell.ts";
import * as trust from "./trust.ts";
import type { TrustedScope, GlobalHooksConfig } from "./config.ts";

export class WorkspaceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }
}

export interface WorkspaceInitInput {
  root: string;
  workspacePrefix?: string;
  name: string;
  description?: string;
  from?: string;
}

export interface WorkspaceInitResult {
  name: string;
  path: string;
  manifestPath: string;
  localPath: string;
  createdAt: string;
}

export interface WorkspaceAddInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  source: string;
  path?: string;
  branch?: string;
  upstreamBranch?: string;
  tag?: string;
  commit?: string;
  readonly?: boolean;
  extraHeader?: string;
  trustedScopes?: TrustedScope[];
  explicitConsent?: boolean;
  hooks?: manifest.MountHooks;
  globalHooks?: GlobalHooksConfig;
}

export interface WorkspaceAddResult {
  /** mounted: checked out now; adopted: an existing checkout was declared; already_mounted: nothing to do. */
  outcome: "mounted" | "adopted" | "already_mounted";
  /** True when the checkout came from a mirror already in the local pool, so nothing was cloned. */
  mirrorReused?: boolean;
  workspaceName: string;
  mountPath: string;
  mountName: string;
  source: string;
  sourceKey: string;
  revision: manifest.MountRevision;
  commitSha: string;
  readonly: boolean;
  hookWarning?: string;
}

export type MountState =
  | "clean"
  | "dirty"
  | "missing"
  | "wrong_revision"
  | "ahead"
  | "behind"
  | "diverged"
  | "untracked_mount";

export interface MountStatusVerdict {
  path: string;
  source: string;
  desired: {
    revision: manifest.MountRevision;
    readonly: boolean;
  };
  observed: git.ObservedWorktree;
  state: MountState;
  messages: string[];
}

export interface WorkspaceStatusResult {
  workspaceName: string;
  workspacePath: string;
  manifestPath: string;
  isClean: boolean;
  mounts: MountStatusVerdict[];
}

export interface WorkspaceDeps {
  fs: typeof fs;
  manifest: typeof manifest;
  git: typeof git;
  shell: typeof shell;
  trust: typeof trust;
}

const defaultDeps: WorkspaceDeps = {
  fs,
  manifest,
  git,
  shell,
  trust,
};

const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateWorkspaceName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Workspace name cannot be empty" };
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Workspace name cannot be empty" };
  }

  if (trimmed === "." || trimmed === "..") {
    return { valid: false, error: "Workspace name cannot be '.' or '..'" };
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { valid: false, error: "Workspace name cannot contain path separators" };
  }

  if (!WORKSPACE_NAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: `Workspace name '${trimmed}' contains invalid characters. Must start with alphanumeric and contain only letters, numbers, hyphens, underscores, or dots.`,
    };
  }

  return { valid: true };
}

export function deriveWorkspaceNameFromRepository(source: string): string {
  const trimmed = source.trim();
  const isLocal =
    /^file:/i.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/");
  const identity = trust.parseSourceIdentity(trimmed);
  const provider =
    identity.provider === "github"
      ? "gh"
      : identity.provider === "azure_devops"
        ? "ado"
        : identity.provider;
  const parts = isLocal
    ? ["local", git.deriveDefaultMountPath(trimmed)]
    : [provider, identity.owner, identity.repo];
  return parts
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("-");
}

function assertSafeMountPath(path: string): string {
  const trimmed = path.trim();
  const segments = trimmed.split(/[\\/]/);
  if (
    !trimmed ||
    isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new WorkspaceError("INVALID_MOUNT_PATH", `Invalid mount path: '${path}'`);
  }
  return trimmed;
}

function assertSafeManifestMountPaths(workspaceManifest: manifest.WorkspaceManifest): void {
  for (const mount of workspaceManifest.mounts) assertSafeMountPath(mount.path);
}

export function deriveWorkspacePath(root: string, name: string, workspacePrefix?: string): string {
  return workspacePath({ root, workspaceName: name, workspacePrefix });
}

export async function loadWorkspaceContext(
  root: string,
  workspaceName: string,
  deps: WorkspaceDeps = defaultDeps,
  workspacePrefix?: string,
): Promise<{
  workspacePath: string;
  manifestPath: string;
  manifest: manifest.WorkspaceManifest;
  body?: string;
}> {
  const workspacePath = deriveWorkspacePath(root, workspaceName, workspacePrefix);
  if (!deps.fs.exists(workspacePath)) {
    throw new WorkspaceError(
      "WORKSPACE_NOT_FOUND",
      `Workspace '${workspaceName}' not found at ${workspacePath}`,
      { workspaceName, path: workspacePath },
    );
  }

  const manifestPath = join(workspacePath, "ws.md");
  if (!deps.fs.exists(manifestPath)) {
    throw new WorkspaceError(
      "MANIFEST_NOT_FOUND",
      `Workspace manifest not found at ${manifestPath}`,
      { manifestPath },
    );
  }

  const { manifest: currentManifest, body } = await deps.manifest.readWorkspace(manifestPath);
  assertSafeManifestMountPaths(currentManifest);

  await healWorkspaceAdmins({
    root,
    workspacePath,
    workspaceName,
    manifest: currentManifest,
    deps,
  });

  return {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  };
}
/**
 * Keeps mount worktrees linked to their admin bares, which live under
 * .dev/repos/<workspace>/ (checkouts only inside the workspace directory).
 * Handles an admin that vanished (recreated from the pool, existing mount
 * directories re-adopted at their manifest revision). Best effort per
 * source: on failure the normal operation error surfaces later.
 */
async function healWorkspaceAdmins(params: {
  root: string;
  workspacePath: string;
  workspaceName: string;
  manifest: manifest.WorkspaceManifest;
  deps: WorkspaceDeps;
}): Promise<void> {
  const { root, workspacePath, workspaceName, manifest, deps } = params;
  if (manifest.mounts.length === 0) return;

  const mountsBySource = new Map<string, manifest.MountDefinition[]>();
  for (const mount of manifest.mounts) {
    const sourceKey = deps.git.normalizeSourceKey(mount.source);
    const group = mountsBySource.get(sourceKey) ?? [];
    group.push(mount);
    mountsBySource.set(sourceKey, group);
  }

  for (const [sourceKey, mounts] of mountsBySource) {
    const adminRepoPath = workspaceAdminRepoPath({ root, workspaceName, sourceKey });
    if (deps.fs.exists(adminRepoPath)) continue;

    try {
      const mirrorPath = gitPoolPath({ root, source: mounts[0].source });
      if (!deps.fs.exists(mirrorPath)) {
        // Mirror vanished too: rebuild it from the canonical source. Public
        // and SSH sources recover automatically; authenticated HTTPS sources
        // need the mirror restored by a normal sync first.
        await deps.git.ensureMirror({ root, source: mounts[0].source });
      }

      await deps.git.ensureWorkspaceRepo({
        root,
        workspaceName,
        sourceKey,
        canonicalUrl: deps.git.stripCredentialsFromUrl(mounts[0].source),
        mirrorPath,
      });
      for (const mount of mounts) {
        const revision = mount.revision;
        const trackBranch = revision.mode === "track";
        const head =
          revision.mode === "track"
            ? revision.branch
            : revision.mode === "tag"
              ? revision.tag
              : revision.commit;
        await deps.git.adoptWorktree({
          adminRepoPath,
          mountPath: join(workspacePath, mount.path),
          revision: head,
          trackBranch,
        });
      }
    } catch (err) {
      console.error("[heal]", err);
      // Best effort: leave the broken state for the actual operation to
      // report a precise domain error.
    }
  }
}

export function findMountOrThrow(
  currentManifest: manifest.WorkspaceManifest,
  mountPath: string,
): { mount: manifest.MountDefinition; index: number } {
  const index = currentManifest.mounts.findIndex((m) => m.path === mountPath);
  if (index < 0) {
    throw new WorkspaceError(
      "MOUNT_NOT_FOUND",
      `Mount '${mountPath}' not found in workspace manifest`,
    );
  }
  return { mount: currentManifest.mounts[index], index };
}

export function validateMountHookTrust(params: {
  sourceUrl: string;
  hookName: string;
  mountHook?: string;
  globalHook?: string;
  trustedScopes?: TrustedScope[];
  explicitConsent?: boolean;
  deps: WorkspaceDeps;
}) {
  const resolved = params.deps.trust.resolveHookExecution({
    sourceUrl: params.sourceUrl,
    hookName: params.hookName,
    mountHook: params.mountHook,
    globalHook: params.globalHook,
    trustedScopes: params.trustedScopes,
    explicitConsent: params.explicitConsent,
  });

  if (params.mountHook && !resolved.allowed && resolved.reason === "untrusted_blocked") {
    throw new WorkspaceError(
      "UNTRUSTED_HOOK_BLOCKED",
      `Execution of ${params.hookName} hook blocked for untrusted repository '${params.sourceUrl}'. Explicit consent is required.`,
      { source: params.sourceUrl, hookName: params.hookName },
    );
  }
  return resolved;
}

export async function executeHook(params: {
  command?: string;
  allowed: boolean;
  cwd: string;
  env: Record<string, string>;
  hookName: string;
  throwOnFailure?: boolean;
  deps: WorkspaceDeps;
}): Promise<{ exitCode: number; warning?: string }> {
  if (!params.allowed || !params.command) {
    return { exitCode: 0 };
  }

  const res = await params.deps.shell.runHook(params.command, {
    cwd: params.cwd,
    env: params.env,
  });

  if (res.exitCode !== 0) {
    const output = (res.stderr || res.stdout).trim();
    const errorMsg = `${params.hookName} hook failed with exit code ${res.exitCode}${output ? `: ${output}` : ""}`;
    if (params.throwOnFailure) {
      throw new WorkspaceError("HOOK_FAILED", errorMsg, {
        exitCode: res.exitCode,
        output: res.stderr || res.stdout,
      });
    }
    return { exitCode: res.exitCode, warning: errorMsg };
  }

  return { exitCode: 0 };
}

/** Same ref: mode and target equal, and an upstream only when both name one. */
function sameRevision(a: manifest.MountRevision, b: manifest.MountRevision): boolean {
  if (a.mode === "track" && b.mode === "track") {
    return a.branch === b.branch && (a.upstream ?? b.upstream) === (b.upstream ?? a.upstream);
  }
  if (a.mode === "tag" && b.mode === "tag") return a.tag === b.tag;
  if (a.mode === "lock" && b.mode === "lock") return a.commit === b.commit;
  return false;
}

export function describeRevision(revision: manifest.MountRevision): string {
  return revision.mode === "track"
    ? revision.branch
    : revision.mode === "tag"
      ? `tag ${revision.tag}`
      : `commit ${revision.commit.slice(0, 8)}`;
}

export function planMount(input: {
  source: string;
  path?: string;
  branch?: string;
  upstreamBranch?: string;
  tag?: string;
  commit?: string;
  readonly?: boolean;
  existingMounts: manifest.MountDefinition[];
}): {
  mountName: string;
  revision?: manifest.MountRevision;
  readonly: boolean;
  /** Set when this exact mount (source, ref and path) is already declared. */
  declared?: manifest.MountDefinition;
} {
  if (!input.source || input.source.trim().length === 0) {
    throw new WorkspaceError("INVALID_SOURCE", "Repository source URL or specifier is required");
  }

  const mountName = assertSafeMountPath(
    input.path && input.path.trim().length > 0
      ? input.path
      : git.deriveDefaultMountPath(input.source),
  );

  let revision: manifest.MountRevision | undefined;
  if (input.commit) {
    revision = { mode: "lock", commit: input.commit.trim() };
  } else if (input.tag) {
    revision = { mode: "tag", tag: input.tag.trim() };
  } else if (input.branch) {
    revision = {
      mode: "track",
      branch: input.branch.trim(),
      upstream: input.upstreamBranch?.trim(),
    };
  }

  // Identity is source + ref + path. An omitted ref asks for "this source here",
  // which any declared ref satisfies.
  const sourceKey = git.normalizeSourceKey(input.source);
  const declared = input.existingMounts.find((m) => m.path === mountName);
  if (declared) {
    if (
      git.normalizeSourceKey(declared.source) === sourceKey &&
      (!revision || sameRevision(declared.revision, revision))
    ) {
      return {
        mountName,
        revision: declared.revision,
        readonly: Boolean(declared.readonly),
        declared,
      };
    }
    throw new WorkspaceError(
      "MOUNT_ALREADY_EXISTS",
      `Mount path '${mountName}' is already declared for ${declared.source} @ ${describeRevision(declared.revision)}`,
      { mountName },
    );
  }

  const branch = input.branch?.trim();
  const sameBranch =
    branch &&
    input.existingMounts.find(
      (mount) =>
        git.normalizeSourceKey(mount.source) === sourceKey &&
        mount.revision.mode === "track" &&
        mount.revision.branch === branch,
    );
  if (sameBranch) {
    throw new WorkspaceError(
      "BRANCH_ALREADY_MOUNTED",
      `Branch '${branch}' of this repository is already mounted at '${sameBranch.path}'. Git checks out a branch in one place only: mount another branch, or pin a commit with --commit.`,
      { branch, source: input.source, mountName: sameBranch.path },
    );
  }

  return {
    mountName,
    revision,
    readonly: Boolean(input.readonly),
  };
}

export async function init(
  input: WorkspaceInitInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<WorkspaceInitResult> {
  const nameValidation = validateWorkspaceName(input.name);
  if (!nameValidation.valid) {
    throw new WorkspaceError(
      "INVALID_WORKSPACE_NAME",
      nameValidation.error ?? "Invalid workspace name",
      {
        name: input.name,
      },
    );
  }

  const name = input.name.trim();
  const workspacePath = deriveWorkspacePath(input.root, name, input.workspacePrefix);

  if (deps.fs.exists(workspacePath)) {
    throw new WorkspaceError(
      "WORKSPACE_ALREADY_EXISTS",
      `Workspace directory already exists at ${workspacePath}`,
      {
        name,
        path: workspacePath,
      },
    );
  }

  const localPath = join(workspacePath, ".local");
  await deps.fs.ensureDir(workspacePath);
  await deps.fs.ensureDir(localPath);

  const createdAt = new Date().toISOString();
  const initialManifest: manifest.WorkspaceManifest = {
    version: 1,
    name,
    created_at: createdAt,
    description: input.description,
    mounts: [],
  };

  const manifestPath = join(workspacePath, "ws.md");
  await deps.manifest.writeWorkspace(manifestPath, initialManifest);

  return {
    name,
    path: workspacePath,
    manifestPath,
    localPath,
    createdAt,
  };
}

export async function add(
  input: WorkspaceAddInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<WorkspaceAddResult> {
  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);

  // Validate mount plan without I/O
  const plan = planMount({
    source: input.source,
    path: input.path,
    branch: input.branch,
    upstreamBranch: input.upstreamBranch,
    tag: input.tag,
    commit: input.commit,
    readonly: input.readonly,
    existingMounts: currentManifest.mounts,
  });

  const mountPath = join(workspacePath, plan.mountName);
  const canonicalSource = deps.git.stripCredentialsFromUrl(input.source);
  const sourceKey = deps.git.normalizeSourceKey(input.source);
  const onDisk = deps.fs.exists(mountPath);
  const expectedAdminRepoPath = workspaceAdminRepoPath({
    root: input.root,
    workspaceName: input.workspaceName,
    sourceKey,
  });

  // Already so: this exact mount is declared and checked out at its revision.
  if (plan.declared && onDisk) {
    const observed = await observeAdoptableWorktree({
      mountPath,
      expectedAdminRepoPath,
      requested: plan.declared.revision,
      deps,
    });
    if (!observed) {
      throw new WorkspaceError(
        "MOUNT_ALREADY_EXISTS",
        `'${plan.mountName}' is declared in ws.md, but ${mountPath} is not its checkout at ${describeRevision(plan.declared.revision)}`,
        { mountPath, source: plan.declared.source },
      );
    }
    return {
      outcome: "already_mounted",
      workspaceName: input.workspaceName,
      mountPath,
      mountName: plan.mountName,
      source: plan.declared.source,
      sourceKey,
      revision: plan.declared.revision,
      commitSha: observed.commitSha,
      readonly: plan.readonly,
    };
  }

  // A directory the manifest does not mention: adopt it only when it is this
  // workspace's own checkout of the source at the requested ref (what an
  // interrupted `ws add` leaves behind). Anything else is someone's data.
  let adopted: { revision: manifest.MountRevision; commitSha: string } | undefined;
  if (!plan.declared && onDisk) {
    adopted = await observeAdoptableWorktree({
      mountPath,
      expectedAdminRepoPath,
      requested: plan.revision,
      deps,
    });
    if (!adopted) {
      throw new WorkspaceError(
        "MOUNT_PATH_EXISTS_ON_DISK",
        `${mountPath} already exists and is not this workspace's checkout of ${canonicalSource}`,
        { mountPath, source: canonicalSource },
      );
    }
  }

  // A declared mount being checked out again runs the hooks ws.md declares.
  const hooks = input.hooks ?? plan.declared?.hooks;

  // Pre-validate hook trust before any side effects
  const preCheckout = validateMountHookTrust({
    sourceUrl: input.source,
    hookName: "pre_checkout",
    mountHook: hooks?.pre_checkout,
    trustedScopes: input.trustedScopes,
    explicitConsent: input.explicitConsent,
    deps,
  });

  const postCheckout = validateMountHookTrust({
    sourceUrl: input.source,
    hookName: "post_checkout",
    mountHook: hooks?.post_checkout,
    trustedScopes: input.trustedScopes,
    explicitConsent: input.explicitConsent,
    deps,
  });

  let revision: manifest.MountRevision;
  let commitSha: string;
  let hookWarning: string | undefined;
  let createdWorktree: { adminRepoPath: string } | undefined;
  let mirrorReused: boolean | undefined;
  if (adopted) {
    ({ revision, commitSha } = adopted);
  } else {
    // Execute pre_checkout hook if resolved and allowed
    await executeHook({
      command: preCheckout.command,
      allowed: preCheckout.allowed,
      cwd: workspacePath,
      env: {
        DEV_ROOT: input.root,
        DEV_WORKSPACE: input.workspaceName,
        DEV_MOUNT_PATH: mountPath,
        DEV_SOURCE: canonicalSource,
        DEV_REVISION: input.branch || input.tag || input.commit || "HEAD",
      },
      hookName: "pre_checkout",
      throwOnFailure: true,
      deps,
    });

    // 1. Ensure central bare mirror
    const mirror = await deps.git.ensureMirror({
      root: input.root,
      source: input.source,
      extraHeader: input.extraHeader,
    });
    mirrorReused = !mirror.created;

    // 2. Ensure private workspace admin bare clone
    const admin = await deps.git.ensureWorkspaceRepo({
      root: input.root,
      workspaceName: input.workspaceName,
      sourceKey: mirror.sourceKey,
      canonicalUrl: canonicalSource,
      mirrorPath: mirror.mirrorPath,
    });

    // 3. Resolve revision
    revision = plan.revision ?? {
      mode: "track",
      branch: await deps.git.resolveDefaultBranch(admin.adminRepoPath),
    };

    // 4. Create worktree mount
    ({ commitSha } = await deps.git.addWorktree({
      adminRepoPath: admin.adminRepoPath,
      mountPath,
      revision,
    }));
    createdWorktree = { adminRepoPath: admin.adminRepoPath };

    // Post-checkout hook execution
    const postCheckoutRes = await executeHook({
      command: postCheckout.command,
      allowed: postCheckout.allowed,
      cwd: mountPath,
      env: {
        DEV_ROOT: input.root,
        DEV_WORKSPACE: input.workspaceName,
        DEV_MOUNT_PATH: mountPath,
        DEV_SOURCE: canonicalSource,
        DEV_REVISION:
          revision.mode === "track"
            ? revision.branch
            : revision.mode === "lock"
              ? revision.commit
              : revision.tag,
      },
      hookName: "post_checkout",
      throwOnFailure: false,
      deps,
    });
    hookWarning = postCheckoutRes.warning;
  }

  // 5. Update ws.md manifest, unless the mount was already declared and only
  // its checkout was missing.
  if (!plan.declared) {
    const newMount: manifest.MountDefinition = {
      path: plan.mountName,
      source: canonicalSource,
      readonly: plan.readonly ? true : undefined,
      revision,
      hooks: input.hooks,
    };

    currentManifest.mounts.push(newMount);
    try {
      await deps.manifest.writeWorkspace(manifestPath, currentManifest, body);
    } catch (error) {
      // The worktree exists but the manifest does not mention it. Remove the one
      // this run created, so the next `dev ws add` starts from a clean state.
      if (createdWorktree) {
        await deps.git
          .removeWorktree(createdWorktree.adminRepoPath, mountPath, { force: true })
          .catch(() => {});
      }
      throw error;
    }
  }

  // 6. Execute post_add hook if configured
  const postAdd = validateMountHookTrust({
    sourceUrl: input.source,
    hookName: "post_add",
    mountHook: input.hooks?.post_add,
    globalHook: input.globalHooks?.post_add,
    trustedScopes: input.trustedScopes,
    explicitConsent: input.explicitConsent,
    deps,
  });

  const postAddRes = await executeHook({
    command: postAdd.command,
    allowed: postAdd.allowed,
    cwd: mountPath,
    env: {
      DEV_ROOT: input.root,
      DEV_WORKSPACE: input.workspaceName,
      DEV_WORKSPACE_PATH: deriveWorkspacePath(
        input.root,
        input.workspaceName,
        input.workspacePrefix,
      ),
      DEV_MOUNT: plan.mountName,
      DEV_MOUNT_PATH: mountPath,
      DEV_SOURCE: canonicalSource,
      DEV_REVISION:
        revision.mode === "track"
          ? revision.branch
          : revision.mode === "lock"
            ? revision.commit
            : revision.tag,
    },
    hookName: "post_add",
    throwOnFailure: false,
    deps,
  });
  if (postAddRes.warning) {
    hookWarning = hookWarning ? `${hookWarning}; ${postAddRes.warning}` : postAddRes.warning;
  }

  return {
    outcome: adopted ? "adopted" : "mounted",
    mirrorReused,
    workspaceName: input.workspaceName,
    mountPath,
    mountName: plan.mountName,
    source: canonicalSource,
    sourceKey,
    revision,
    commitSha,
    readonly: plan.readonly,
    hookWarning,
  };
}

/**
 * The revision of an existing directory when it is a worktree of the expected
 * admin repository at the requested ref; undefined for anything else.
 */
async function observeAdoptableWorktree(params: {
  mountPath: string;
  expectedAdminRepoPath: string;
  requested?: manifest.MountRevision;
  deps: WorkspaceDeps;
}): Promise<{ revision: manifest.MountRevision; commitSha: string } | undefined> {
  const { mountPath, expectedAdminRepoPath, requested, deps } = params;
  const adminRepoPath = await deps.git.worktreeAdminRepoPath(mountPath);
  if (!adminRepoPath || resolve(adminRepoPath) !== resolve(expectedAdminRepoPath)) return undefined;

  const observed = await deps.git.currentRevision(mountPath);
  if (!observed.commitSha) return undefined;
  const commitSha = observed.commitSha;

  if (!requested) {
    return observed.branch
      ? { revision: { mode: "track", branch: observed.branch }, commitSha }
      : undefined;
  }
  const matches =
    requested.mode === "track"
      ? observed.branch === requested.branch
      : requested.mode === "tag"
        ? observed.tag === requested.tag
        : commitSha.startsWith(requested.commit);
  return matches ? { revision: requested, commitSha } : undefined;
}

export function compareWorkspace(
  desiredMounts: manifest.MountDefinition[],
  observedMounts: Record<string, git.ObservedWorktree>,
): MountStatusVerdict[] {
  return desiredMounts.map((desired) => {
    const observed = observedMounts[desired.path] ?? {
      path: desired.path,
      exists: false,
      isGitWorktree: false,
      currentRevision: {},
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };

    const messages: string[] = [];
    let state: MountState = "clean";

    if (!observed.exists || !observed.isGitWorktree) {
      state = "missing";
      messages.push("Mount directory does not exist or is not a git worktree");
    } else if (observed.isDirty) {
      state = "dirty";
      messages.push(
        `Worktree has uncommitted changes (${observed.modifiedFiles} modified, ${observed.untrackedFiles} untracked)`,
      );
    } else {
      if (desired.revision.mode === "track") {
        if (observed.currentRevision.branch !== desired.revision.branch) {
          state = "wrong_revision";
          messages.push(
            `Expected branch '${desired.revision.branch}', but observed '${observed.currentRevision.branch || observed.currentRevision.commitSha || "unknown"}'`,
          );
        }
      } else if (desired.revision.mode === "lock") {
        if (
          !observed.currentRevision.commitSha ||
          !observed.currentRevision.commitSha.startsWith(desired.revision.commit)
        ) {
          state = "wrong_revision";
          messages.push(
            `Expected commit '${desired.revision.commit}', but observed '${observed.currentRevision.commitSha || "unknown"}'`,
          );
        }
      } else if (desired.revision.mode === "tag") {
        if (observed.currentRevision.tag !== desired.revision.tag) {
          state = "wrong_revision";
          messages.push(
            `Expected tag '${desired.revision.tag}', but observed '${observed.currentRevision.tag || "none"}'`,
          );
        }
      }

      if (state === "clean") {
        if (observed.aheadCount > 0 && observed.behindCount > 0) {
          state = "diverged";
          messages.push(
            `Diverged from upstream: ahead ${observed.aheadCount}, behind ${observed.behindCount}`,
          );
        } else if (observed.behindCount > 0) {
          state = "behind";
          messages.push(`Behind upstream by ${observed.behindCount} commit(s)`);
        } else if (observed.aheadCount > 0) {
          state = "ahead";
          messages.push(`Ahead of upstream by ${observed.aheadCount} commit(s)`);
        }
      }
    }

    return {
      path: desired.path,
      source: desired.source,
      desired: {
        revision: desired.revision,
        readonly: Boolean(desired.readonly),
      },
      observed,
      state,
      messages,
    };
  });
}

export interface WorkspaceStatusInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  refresh?: boolean;
  offline?: boolean;
  resolveExtraHeader?: (source: string) => Promise<string | undefined>;
}

export async function status(
  input: WorkspaceStatusInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<WorkspaceStatusResult> {
  if (input.refresh && input.offline) {
    throw new WorkspaceError(
      "CONFLICTING_OPTIONS",
      "Cannot specify both --refresh and --offline for workspace status",
    );
  }

  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);

  // If refresh requested and not offline, fetch from remotes
  if (input.refresh && !input.offline) {
    for (const mount of currentManifest.mounts) {
      const sourceKey = deps.git.normalizeSourceKey(mount.source);
      const mirrorPath = gitPoolPath({ root: input.root, source: mount.source });
      const adminRepoPath = workspaceAdminRepoPath({
        root: input.root,
        workspaceName: input.workspaceName,
        sourceKey,
      });

      if (deps.fs.exists(mirrorPath)) {
        await deps.git.fetchMirror({
          mirrorPath,
          resolveExtraHeader: input.resolveExtraHeader,
        });
      }

      if (deps.fs.exists(adminRepoPath)) {
        await deps.git.fetchAdminRepo(adminRepoPath, mirrorPath);
      }
    }
  }

  const observedMap: Record<string, git.ObservedWorktree> = {};
  for (const mount of currentManifest.mounts) {
    const mountPath = join(workspacePath, mount.path);
    observedMap[mount.path] = await deps.git.inspectWorktree(mountPath);
  }

  const mounts = compareWorkspace(currentManifest.mounts, observedMap);
  const isClean = mounts.every((m) => m.state === "clean");

  return {
    workspaceName: input.workspaceName,
    workspacePath,
    manifestPath,
    isClean,
    mounts,
  };
}

export type UpdateAction =
  | "create"
  | "checkout"
  | "fast_forward"
  | "rebase"
  | "up_to_date"
  | "skipped";

export type UpdateSkipReason =
  | "dirty_worktree"
  | "ahead_commits"
  | "diverged_history"
  | "not_a_worktree"
  | "no_local_mirror"
  | "readonly"
  | "not_tracking_branch"
  | "rebase_conflict";

export interface PlannedMountUpdate {
  path: string;
  source: string;
  branch?: string;
  action: UpdateAction;
  targetRef?: string;
  reason?: UpdateSkipReason;
  /** The declared revision a create or checkout converges to. */
  revision?: manifest.MountRevision;
  /** Set on fast_forward plans created from a dirty worktree. */
  autostash?: boolean;
}

export function planWorkspaceUpdate(
  mounts: manifest.MountDefinition[],
  statusList: MountStatusVerdict[],
  options: {
    autostash?: boolean;
    rebase?: boolean;
    /** Offline: sources with no mirror on disk, so no mount of theirs can be created. */
    missingMirrors?: Set<string>;
  } = {},
): PlannedMountUpdate[] {
  const statusByPath = new Map(statusList.map((s) => [s.path, s]));

  return mounts.map((mount) => {
    const status = statusByPath.get(mount.path);

    // Declared but absent: create it, readonly or not. A directory that is there
    // but is not a worktree is someone's data, so it is never touched.
    if (!status || status.state === "missing") {
      const occupied = status?.observed.exists === true;
      return {
        path: mount.path,
        source: mount.source,
        branch: mount.revision.mode === "track" ? mount.revision.branch : undefined,
        ...(occupied
          ? { action: "skipped" as const, reason: "not_a_worktree" as const }
          : options.missingMirrors?.has(mount.source)
            ? { action: "skipped" as const, reason: "no_local_mirror" as const }
            : { action: "create" as const, revision: mount.revision }),
      };
    }

    if (mount.readonly) {
      return {
        path: mount.path,
        source: mount.source,
        branch: mount.revision?.mode === "track" ? mount.revision.branch : undefined,
        action: "skipped",
        reason: "readonly",
      };
    }

    if (status.state === "dirty") {
      const trackBranch = mount.revision?.mode === "track" ? mount.revision.branch : undefined;
      const upstreamBranch =
        mount.revision?.mode === "track"
          ? (mount.revision.upstream ?? mount.revision.branch)
          : undefined;
      const targetRef = upstreamBranch ? `refs/remotes/origin/${upstreamBranch}` : undefined;
      if (options.autostash && trackBranch && targetRef && (status.observed.behindCount ?? 0) > 0) {
        return {
          path: mount.path,
          source: mount.source,
          branch: trackBranch,
          action: "fast_forward",
          targetRef,
          autostash: true,
        };
      }
      return {
        path: mount.path,
        source: mount.source,
        branch: trackBranch,
        action: "skipped",
        reason: "dirty_worktree",
      };
    }

    if (status.state === "ahead") {
      return {
        path: mount.path,
        source: mount.source,
        branch: mount.revision?.mode === "track" ? mount.revision.branch : undefined,
        action: "skipped",
        reason: "ahead_commits",
      };
    }

    if (status.state === "diverged") {
      const trackBranch = mount.revision?.mode === "track" ? mount.revision.branch : undefined;
      const upstreamBranch =
        mount.revision?.mode === "track"
          ? (mount.revision.upstream ?? mount.revision.branch)
          : undefined;
      const observedBranch = status.observed.currentRevision?.branch;
      const branch = trackBranch ?? observedBranch;
      const targetRef = upstreamBranch ? `refs/remotes/origin/${upstreamBranch}` : undefined;
      if (options.rebase && branch && targetRef) {
        return {
          path: mount.path,
          source: mount.source,
          branch,
          action: "rebase",
          targetRef,
        };
      }
      return {
        path: mount.path,
        source: mount.source,
        branch: trackBranch,
        action: "skipped",
        reason: "diverged_history",
      };
    }

    // Status reports wrong_revision only for a clean worktree, so the checkout
    // cannot overwrite uncommitted work. Commits only this checkout holds (on
    // a detached HEAD, or unpushed on another branch) keep it where it is.
    if (status.state === "wrong_revision") {
      if ((status.observed.aheadCount ?? 0) > 0) {
        return {
          path: mount.path,
          source: mount.source,
          branch: mount.revision.mode === "track" ? mount.revision.branch : undefined,
          action: "skipped",
          reason: "ahead_commits",
        };
      }
      return {
        path: mount.path,
        source: mount.source,
        branch: mount.revision.mode === "track" ? mount.revision.branch : undefined,
        action: "checkout",
        revision: mount.revision,
      };
    }

    const branch =
      mount.revision?.mode === "track"
        ? mount.revision.branch
        : status.observed.currentRevision?.branch;
    const upstreamBranch =
      mount.revision?.mode === "track"
        ? (mount.revision.upstream ?? mount.revision.branch)
        : branch;
    const behindCount = status.observed.behindCount ?? 0;

    if (behindCount > 0) {
      const targetRef = upstreamBranch ? `refs/remotes/origin/${upstreamBranch}` : undefined;
      if (!targetRef) {
        return {
          path: mount.path,
          source: mount.source,
          branch,
          action: "skipped",
          reason: "not_tracking_branch",
        };
      }
      return {
        path: mount.path,
        source: mount.source,
        branch,
        action: "fast_forward",
        targetRef,
      };
    }

    return {
      path: mount.path,
      source: mount.source,
      branch,
      action: "up_to_date",
    };
  });
}

export function validateUpdatePlan(plan: PlannedMountUpdate[]): void {
  for (const item of plan) {
    if (
      (item.action === "fast_forward" || item.action === "rebase") &&
      (!item.targetRef || item.targetRef.trim() === "")
    ) {
      throw new WorkspaceError(
        "INVALID_UPDATE_PLAN",
        `Mount '${item.path}' is planned for ${item.action} but lacks a valid targetRef`,
        { path: item.path },
      );
    }
  }
}

export interface WorkspaceUpdateInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  refresh?: boolean;
  offline?: boolean;
  /** Stash uncommitted changes before fast-forwarding and pop them after. */
  autostash?: boolean;
  /** Rebase diverged mounts onto the remote branch with atomic rollback. */
  rebase?: boolean;
  /** Observe and plan only: return what would happen and change nothing. */
  dryRun?: boolean;
  resolveExtraHeader?: (source: string) => Promise<string | undefined>;
  trustedScopes?: TrustedScope[];
  explicitConsent?: boolean;
  globalHooks?: GlobalHooksConfig;
}

export interface MountUpdateResult {
  path: string;
  source: string;
  action: UpdateAction;
  previousCommit?: string;
  newCommit?: string;
  reason?: UpdateSkipReason;
  /** The declared revision a create or checkout converged to. */
  revision?: manifest.MountRevision;
  /** On create: the checkout came from a mirror already in the local pool. */
  mirrorReused?: boolean;
  /** Non-fatal condition reported to the user (e.g. stash pop conflict). */
  warning?: string;
}

export interface WorkspaceUpdateResult {
  workspaceName: string;
  workspacePath: string;
  /** True when the mounts are a plan that was not executed. */
  dryRun: boolean;
  mounts: MountUpdateResult[];
  summary: {
    total: number;
    updated: number;
    upToDate: number;
    skipped: number;
  };
  hookWarning?: string;
}

function revisionTarget(revision: manifest.MountRevision): string {
  return revision.mode === "track"
    ? revision.branch
    : revision.mode === "lock"
      ? revision.commit
      : revision.tag;
}

/** Checks out a mount declared in ws.md that is missing from disk, with its hooks. */
interface CheckoutHooks {
  preCheckout: ReturnType<typeof validateMountHookTrust>;
  postCheckout: ReturnType<typeof validateMountHookTrust>;
}

/** Throws UNTRUSTED_HOOK_BLOCKED before anything is created. */
function resolveCheckoutHooks(
  mount: manifest.MountDefinition,
  input: WorkspaceUpdateInput,
  deps: WorkspaceDeps,
): CheckoutHooks {
  const trustHook = (hookName: "pre_checkout" | "post_checkout") =>
    validateMountHookTrust({
      sourceUrl: mount.source,
      hookName,
      mountHook: mount.hooks?.[hookName],
      trustedScopes: input.trustedScopes,
      explicitConsent: input.explicitConsent,
      deps,
    });
  return { preCheckout: trustHook("pre_checkout"), postCheckout: trustHook("post_checkout") };
}

async function createDeclaredMount(params: {
  input: WorkspaceUpdateInput;
  workspacePath: string;
  mount: manifest.MountDefinition;
  hooks: CheckoutHooks;
  deps: WorkspaceDeps;
}): Promise<{ commitSha: string; mirrorReused: boolean; hookWarning?: string }> {
  const { input, workspacePath, mount, deps } = params;
  const { preCheckout, postCheckout } = params.hooks;
  const mountPath = join(workspacePath, mount.path);
  const hookEnv = {
    DEV_ROOT: input.root,
    DEV_WORKSPACE: input.workspaceName,
    DEV_MOUNT_PATH: mountPath,
    DEV_SOURCE: mount.source,
    DEV_REVISION: revisionTarget(mount.revision),
  };

  await executeHook({
    command: preCheckout.command,
    allowed: preCheckout.allowed,
    cwd: workspacePath,
    env: hookEnv,
    hookName: "pre_checkout",
    throwOnFailure: true,
    deps,
  });

  const mirror = await deps.git.ensureMirror({
    root: input.root,
    source: mount.source,
    extraHeader: await input.resolveExtraHeader?.(mount.source),
  });
  const { mirrorPath, sourceKey } = mirror;
  const { adminRepoPath } = await deps.git.ensureWorkspaceRepo({
    root: input.root,
    workspaceName: input.workspaceName,
    sourceKey,
    canonicalUrl: mount.source,
    mirrorPath,
  });
  const { commitSha } = await deps.git.addWorktree({
    adminRepoPath,
    mountPath,
    revision: mount.revision,
  });

  const postCheckoutRes = await executeHook({
    command: postCheckout.command,
    allowed: postCheckout.allowed,
    cwd: mountPath,
    env: hookEnv,
    hookName: "post_checkout",
    throwOnFailure: false,
    deps,
  });
  return { commitSha, mirrorReused: !mirror.created, hookWarning: postCheckoutRes.warning };
}

export async function update(
  input: WorkspaceUpdateInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<WorkspaceUpdateResult> {
  // Step 1: Observe current status (handling refresh or offline as requested)
  const statusRes = await status(
    {
      root: input.root,
      workspaceName: input.workspaceName,
      refresh: input.refresh,
      offline: input.offline,
      resolveExtraHeader: input.resolveExtraHeader,
    },
    deps,
  );

  const manifestPath = join(statusRes.workspacePath, "ws.md");
  const { manifest: currentManifest } = await deps.manifest.readWorkspace(manifestPath);

  // Offline, a mount can only be created from a mirror already on disk.
  const missingMirrors = input.offline
    ? new Set(
        currentManifest.mounts
          .map((mount) => mount.source)
          .filter((source) => !deps.fs.exists(gitPoolPath({ root: input.root, source }))),
      )
    : undefined;

  // Step 2: Plan
  const plan = planWorkspaceUpdate(currentManifest.mounts, statusRes.mounts, {
    autostash: input.autostash,
    rebase: input.rebase,
    missingMirrors,
  });

  // Step 3: Validate, including the hooks of every mount about to be created,
  // so an untrusted hook stops the run before anything changes.
  validateUpdatePlan(plan);
  const mountByPath = new Map(currentManifest.mounts.map((mount) => [mount.path, mount]));
  const createHooks = new Map(
    plan
      .filter((item) => item.action === "create")
      .map((item) => [item.path, resolveCheckoutHooks(mountByPath.get(item.path)!, input, deps)]),
  );

  if (input.dryRun) {
    const current = new Map(statusRes.mounts.map((m) => [m.path, m.observed.currentRevision]));
    return {
      workspaceName: input.workspaceName,
      workspacePath: statusRes.workspacePath,
      dryRun: true,
      mounts: plan.map((item) => ({
        path: item.path,
        source: item.source,
        action: item.action,
        reason: item.reason,
        revision: item.revision,
        previousCommit: current.get(item.path)?.commitSha,
      })),
      summary: {
        total: plan.length,
        updated: plan.filter((i) => i.action !== "up_to_date" && i.action !== "skipped").length,
        upToDate: plan.filter((i) => i.action === "up_to_date").length,
        skipped: plan.filter((i) => i.action === "skipped").length,
      },
    };
  }

  // Step 4: Mutate (execute fast-forwards)
  const mountResults: MountUpdateResult[] = [];
  let updatedCount = 0;
  let upToDateCount = 0;
  let skippedCount = 0;

  for (const item of plan) {
    const statusForMount = statusRes.mounts.find((m) => m.path === item.path);
    const prevCommit = statusForMount?.observed.currentRevision?.commitSha;

    if (item.action === "create") {
      const mount = mountByPath.get(item.path)!;
      const created = await createDeclaredMount({
        input,
        workspacePath: statusRes.workspacePath,
        mount,
        hooks: createHooks.get(item.path)!,
        deps,
      });
      mountResults.push({
        path: item.path,
        source: item.source,
        action: "create",
        revision: mount.revision,
        mirrorReused: created.mirrorReused,
        newCommit: created.commitSha,
        warning: created.hookWarning,
      });
      updatedCount++;
    } else if (item.action === "checkout") {
      const worktreePath = join(statusRes.workspacePath, item.path);
      const revision = item.revision!;
      if (revision.mode === "track") {
        await deps.git.switchBranch(worktreePath, revision.branch);
      } else {
        await deps.git.checkoutRevision(worktreePath, revisionTarget(revision));
      }
      const reinspected = await deps.git.inspectWorktree(worktreePath);
      mountResults.push({
        path: item.path,
        source: item.source,
        action: "checkout",
        revision,
        previousCommit: prevCommit,
        newCommit: reinspected.currentRevision?.commitSha,
      });
      updatedCount++;
    } else if (item.action === "fast_forward") {
      const worktreePath = join(statusRes.workspacePath, item.path);
      let warning: string | undefined;
      if (item.autostash) {
        const stashResult = await deps.git.stashFastForward({
          worktreePath,
          targetRef: item.targetRef!,
        });
        if (stashResult.stashConflict) {
          warning =
            "Stash pop had conflicts; the fast-forward succeeded and your changes were kept safe in the stash entry.";
        }
      } else {
        await deps.git.fastForward({ worktreePath, targetRef: item.targetRef! });
      }
      const reinspected = await deps.git.inspectWorktree(worktreePath);
      mountResults.push({
        path: item.path,
        source: item.source,
        action: "fast_forward",
        previousCommit: prevCommit,
        newCommit: reinspected.currentRevision?.commitSha,
        warning,
      });
      updatedCount++;
    } else if (item.action === "rebase") {
      const worktreePath = join(statusRes.workspacePath, item.path);
      const rebaseResult = await deps.git.rebaseOnto({
        worktreePath,
        targetRef: item.targetRef!,
      });
      if (rebaseResult.ok) {
        const reinspected = await deps.git.inspectWorktree(worktreePath);
        mountResults.push({
          path: item.path,
          source: item.source,
          action: "rebase",
          previousCommit: prevCommit,
          newCommit: reinspected.currentRevision?.commitSha,
        });
        updatedCount++;
      } else {
        mountResults.push({
          path: item.path,
          source: item.source,
          action: "skipped",
          reason: "rebase_conflict",
          previousCommit: prevCommit,
          warning: rebaseResult.conflicts,
        });
        skippedCount++;
      }
    } else if (item.action === "up_to_date") {
      mountResults.push({
        path: item.path,
        source: item.source,
        action: "up_to_date",
        previousCommit: prevCommit,
        newCommit: prevCommit,
      });
      upToDateCount++;
    } else {
      mountResults.push({
        path: item.path,
        source: item.source,
        action: "skipped",
        reason: item.reason,
        previousCommit: prevCommit,
      });
      skippedCount++;
    }
  }

  let hookWarning: string | undefined;
  if (updatedCount > 0 && input.globalHooks?.post_sync) {
    const postSync = deps.trust.resolveHookExecution({
      sourceUrl: "",
      hookName: "post_sync",
      globalHook: input.globalHooks.post_sync,
      trustedScopes: input.trustedScopes,
      explicitConsent: input.explicitConsent ?? true,
    });

    if (postSync.allowed && postSync.command) {
      const hookEnv = {
        DEV_ROOT: input.root,
        DEV_WORKSPACE: input.workspaceName,
        DEV_WORKSPACE_PATH: statusRes.workspacePath,
      };

      const res = await deps.shell.runHook(postSync.command, {
        cwd: statusRes.workspacePath,
        env: hookEnv,
      });

      if (res.exitCode !== 0) {
        const output = (res.stderr || res.stdout).trim();
        hookWarning = `post_sync hook failed with exit code ${res.exitCode}${output ? `: ${output}` : ""}`;
      }
    }
  }

  return {
    workspaceName: input.workspaceName,
    workspacePath: statusRes.workspacePath,
    dryRun: false,
    mounts: mountResults,
    summary: {
      total: currentManifest.mounts.length,
      updated: updatedCount,
      upToDate: upToDateCount,
      skipped: skippedCount,
    },
    hookWarning,
  };
}

export type { ObservedWorktree } from "./git.ts";

export function transitionRevision(
  mount: manifest.MountDefinition,
  revision: manifest.MountRevision,
): manifest.MountDefinition {
  return {
    ...mount,
    revision,
  };
}

export interface WorkspaceTrackInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  mountPath: string;
  branch: string;
  manifestOnly?: boolean;
}

export async function track(
  input: WorkspaceTrackInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<{ path: string; branch: string; manifestUpdated: boolean; worktreeSwitched: boolean }> {
  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);
  const { index: mountIndex } = findMountOrThrow(currentManifest, input.mountPath);

  const worktreePath = join(workspacePath, input.mountPath);
  let worktreeSwitched = false;

  if (!input.manifestOnly && deps.fs.exists(worktreePath)) {
    const observed = await deps.git.inspectWorktree(worktreePath);
    if (observed.isDirty) {
      throw new WorkspaceError(
        "DIRTY_WORKTREE",
        `Cannot switch branch: worktree '${input.mountPath}' has uncommitted changes`,
      );
    }
    await deps.git.switchBranch(worktreePath, input.branch);
    worktreeSwitched = true;
  }

  currentManifest.mounts[mountIndex] = transitionRevision(currentManifest.mounts[mountIndex], {
    mode: "track",
    branch: input.branch,
  });

  await deps.manifest.writeWorkspace(manifestPath, currentManifest, body);

  return {
    path: input.mountPath,
    branch: input.branch,
    manifestUpdated: true,
    worktreeSwitched,
  };
}

export interface WorkspaceLockInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  mountPath?: string;
  commit?: string;
}

export async function lock(
  input: WorkspaceLockInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<{ lockedMounts: { path: string; commit: string }[] }> {
  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);
  const targetMounts = input.mountPath
    ? [findMountOrThrow(currentManifest, input.mountPath).mount]
    : currentManifest.mounts;

  const lockedResults: { path: string; commit: string }[] = [];

  for (const mount of targetMounts) {
    const worktreePath = join(workspacePath, mount.path);
    let commitSha = input.commit;
    if (!commitSha) {
      const observed = await deps.git.inspectWorktree(worktreePath);
      commitSha = observed.currentRevision?.commitSha;
      if (!commitSha) {
        throw new WorkspaceError(
          "CANNOT_DETERMINE_COMMIT",
          `Cannot determine commit for mount '${mount.path}'`,
        );
      }
    }

    const idx = currentManifest.mounts.findIndex((m) => m.path === mount.path);
    currentManifest.mounts[idx] = transitionRevision(mount, {
      mode: "lock",
      commit: commitSha,
    });
    lockedResults.push({ path: mount.path, commit: commitSha });
  }

  await deps.manifest.writeWorkspace(manifestPath, currentManifest, body);
  return { lockedMounts: lockedResults };
}

export interface WorkspaceUnlockInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  mountPath?: string;
  branch?: string;
}

export async function unlock(
  input: WorkspaceUnlockInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<{ unlockedMounts: { path: string; branch: string }[] }> {
  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);
  const targetMounts = input.mountPath
    ? [findMountOrThrow(currentManifest, input.mountPath).mount]
    : currentManifest.mounts;

  const unlockedResults: { path: string; branch: string }[] = [];

  for (const mount of targetMounts) {
    const worktreePath = join(workspacePath, mount.path);
    let targetBranch = input.branch;
    if (!targetBranch) {
      const observed = await deps.git.inspectWorktree(worktreePath);
      targetBranch = observed.currentRevision?.branch || "main";
    }

    if (deps.fs.exists(worktreePath)) {
      await deps.git.switchBranch(worktreePath, targetBranch);
    }

    const idx = currentManifest.mounts.findIndex((m) => m.path === mount.path);
    currentManifest.mounts[idx] = transitionRevision(mount, {
      mode: "track",
      branch: targetBranch,
    });
    unlockedResults.push({ path: mount.path, branch: targetBranch });
  }

  await deps.manifest.writeWorkspace(manifestPath, currentManifest, body);
  return { unlockedMounts: unlockedResults };
}

export interface WorkspaceTagInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  mountPath: string;
  tag: string;
}

export async function tag(
  input: WorkspaceTagInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<{ path: string; tag: string }> {
  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);
  const { index: mountIndex } = findMountOrThrow(currentManifest, input.mountPath);

  const worktreePath = join(workspacePath, input.mountPath);
  if (deps.fs.exists(worktreePath)) {
    const observed = await deps.git.inspectWorktree(worktreePath);
    if (observed.isDirty) {
      throw new WorkspaceError(
        "DIRTY_WORKTREE",
        `Cannot tag mount '${input.mountPath}': worktree has uncommitted changes`,
      );
    }
    await deps.git.checkoutRevision(worktreePath, input.tag);
  }

  currentManifest.mounts[mountIndex] = transitionRevision(currentManifest.mounts[mountIndex], {
    mode: "tag",
    tag: input.tag,
  });

  await deps.manifest.writeWorkspace(manifestPath, currentManifest, body);
  return { path: input.mountPath, tag: input.tag };
}

export interface WorkspaceRemoveInput {
  root: string;
  workspacePrefix?: string;
  workspaceName: string;
  mountPath: string;
  force?: boolean;
}
export async function remove(
  input: WorkspaceRemoveInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<{ path: string; removed: boolean }> {
  const {
    workspacePath,
    manifestPath,
    manifest: currentManifest,
    body,
  } = await loadWorkspaceContext(input.root, input.workspaceName, deps, input.workspacePrefix);
  const { mount, index: mountIndex } = findMountOrThrow(currentManifest, input.mountPath);
  const worktreePath = join(workspacePath, assertSafeMountPath(mount.path));

  if (deps.fs.exists(worktreePath)) {
    const observed = await deps.git.inspectWorktree(worktreePath);
    if (!input.force) {
      if (observed.isDirty) {
        throw new WorkspaceError(
          "UNSAFE_REMOVE",
          `Cannot remove mount '${input.mountPath}': worktree has uncommitted changes. Use --force to override.`,
          { path: input.mountPath, isDirty: true },
        );
      }
      if (observed.aheadCount > 0) {
        throw new WorkspaceError(
          "UNSAFE_REMOVE",
          `Cannot remove mount '${input.mountPath}': worktree has unpushed commits. Use --force to override.`,
          { path: input.mountPath, aheadCount: observed.aheadCount },
        );
      }
    }

    const sourceKey = deps.git.normalizeSourceKey(mount.source);
    const adminRepoPath = workspaceAdminRepoPath({
      root: input.root,
      workspaceName: input.workspaceName,
      sourceKey,
    });
    if (deps.fs.exists(adminRepoPath)) {
      try {
        await deps.git.removeWorktree(adminRepoPath, worktreePath, { force: input.force });
      } catch {
        await deps.fs.removeDir(worktreePath);
      }
    } else {
      await deps.fs.removeDir(worktreePath);
    }
  }

  currentManifest.mounts.splice(mountIndex, 1);
  await deps.manifest.writeWorkspace(manifestPath, currentManifest, body);

  return { path: input.mountPath, removed: true };
}

export function planDuplication(
  sourceManifest: manifest.WorkspaceManifest,
  targetName: string,
): manifest.WorkspaceManifest {
  const validation = validateWorkspaceName(targetName);
  if (!validation.valid) {
    throw new WorkspaceError(
      "INVALID_WORKSPACE_NAME",
      validation.error || "Invalid workspace name",
    );
  }

  return {
    version: sourceManifest.version,
    name: targetName.trim(),
    created_at: new Date().toISOString(),
    description: sourceManifest.description,
    mounts: sourceManifest.mounts.map((m) => ({
      path: m.path,
      source: m.source,
      readonly: m.readonly,
      revision: { ...m.revision },
      hooks: m.hooks ? { ...m.hooks } : undefined,
    })),
  };
}

export function detectWorkspaceFromCwd(
  cwd: string,
  root: string,
  workspacePrefix?: string,
): string | undefined {
  const wsDir = workspacesDir({ root, workspacePrefix });
  const rel = relative(wsDir, cwd);
  if (!rel || rel.startsWith("..") || rel === "") {
    return undefined;
  }
  const parts = rel.split(/[\\/]/);
  return parts[0] || undefined;
}

export function resolveWorkspacePath(input: {
  root: string;
  workspacePrefix?: string;
  workspaceName?: string;
  cwd?: string;
}): string {
  if (input.workspaceName && input.workspaceName.trim().length > 0) {
    return deriveWorkspacePath(input.root, input.workspaceName.trim(), input.workspacePrefix);
  }

  if (input.cwd) {
    const detected = detectWorkspaceFromCwd(input.cwd, input.root, input.workspacePrefix);
    if (detected) {
      return deriveWorkspacePath(input.root, detected, input.workspacePrefix);
    }
  }

  throw new WorkspaceError(
    "WORKSPACE_NOT_FOUND",
    "Target workspace could not be determined. Provide workspace name or run from inside a workspace.",
  );
}

export interface WorkspaceListItem {
  name: string;
  path: string;
  createdAt?: string;
  description?: string;
  mountCount: number;
}

export async function list(
  input: { root: string; workspacePrefix?: string },
  deps: WorkspaceDeps = defaultDeps,
): Promise<WorkspaceListItem[]> {
  const wsDir = workspacesDir({ root: input.root, workspacePrefix: input.workspacePrefix });
  if (!deps.fs.exists(wsDir)) {
    return [];
  }

  const entries = await deps.fs.listDirs(wsDir);
  const items: WorkspaceListItem[] = [];

  for (const name of entries) {
    const wsPath = join(wsDir, name);
    const manifestPath = join(wsPath, "ws.md");
    if (deps.fs.exists(manifestPath)) {
      try {
        const { manifest } = await deps.manifest.readWorkspace(manifestPath);
        items.push({
          name: manifest.name,
          path: wsPath,
          createdAt: manifest.created_at,
          description: manifest.description,
          mountCount: manifest.mounts.length,
        });
      } catch {
        items.push({
          name,
          path: wsPath,
          mountCount: 0,
        });
      }
    }
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export interface WorkspaceDuplicateInput {
  root: string;
  workspacePrefix?: string;
  sourceName: string;
  targetName: string;
  resolveExtraHeader?: (source: string) => Promise<string | undefined>;
}

export interface WorkspaceDuplicateResult {
  sourceName: string;
  targetName: string;
  path: string;
  mountsCount: number;
}

export async function duplicate(
  input: WorkspaceDuplicateInput,
  deps: WorkspaceDeps = defaultDeps,
): Promise<WorkspaceDuplicateResult> {
  const sourcePath = deriveWorkspacePath(input.root, input.sourceName, input.workspacePrefix);
  const sourceManifestPath = join(sourcePath, "ws.md");
  if (!deps.fs.exists(sourceManifestPath)) {
    throw new WorkspaceError(
      "WORKSPACE_NOT_FOUND",
      `Source workspace '${input.sourceName}' not found at ${sourcePath}`,
    );
  }

  const targetPath = deriveWorkspacePath(input.root, input.targetName, input.workspacePrefix);
  if (deps.fs.exists(targetPath)) {
    throw new WorkspaceError(
      "WORKSPACE_ALREADY_EXISTS",
      `Target workspace directory already exists at ${targetPath}`,
    );
  }

  const { manifest: sourceManifest, body } = await deps.manifest.readWorkspace(sourceManifestPath);
  assertSafeManifestMountPaths(sourceManifest);
  const targetManifest = planDuplication(sourceManifest, input.targetName);

  await deps.fs.ensureDir(targetPath);
  await deps.fs.ensureDir(join(targetPath, ".local"));

  for (const mount of targetManifest.mounts) {
    const mountPath = join(targetPath, mount.path);
    const { mirrorPath, sourceKey } = await deps.git.ensureMirror({
      root: input.root,
      source: mount.source,
      extraHeader: await input.resolveExtraHeader?.(mount.source),
    });

    const { adminRepoPath } = await deps.git.ensureWorkspaceRepo({
      root: input.root,
      workspaceName: targetManifest.name,
      sourceKey,
      canonicalUrl: mount.source,
      mirrorPath,
    });

    await deps.git.addWorktree({
      adminRepoPath,
      mountPath,
      revision: mount.revision,
    });
  }

  const targetManifestPath = join(targetPath, "ws.md");
  await deps.manifest.writeWorkspace(targetManifestPath, targetManifest, body);

  return {
    sourceName: input.sourceName,
    targetName: targetManifest.name,
    path: targetPath,
    mountsCount: targetManifest.mounts.length,
  };
}
