import { defineCommand } from "citty";
import { join } from "node:path";
import * as ws from "../ws.ts";
import * as herdr from "../herdr.ts";
import * as git from "../git.ts";
import * as fs from "../fs.ts";
import * as manifest from "../manifest.ts";
import { isExplicitSource, resolveInputSource } from "../inventory.ts";
import type { RuntimeConfig } from "../config.ts";
import * as cache from "../cache.ts";
import type { InventoryRecord } from "../cache.ts";
import { WorksetError, declaredLabels, labelSources } from "../workset.ts";
import { LabelError } from "../labels.ts";
import { resolveJumpTarget } from "../nav.ts";
import {
  CredentialError,
  getGitExtraHeader,
  resolveAzureDevOpsCredential,
  resolveExtraHeader,
  resolveGitHubCredential,
} from "../credentials.ts";
import { createAzureDevOps } from "../ado.ts";
import { createGitHubClient } from "../github.ts";
import * as prWorkspace from "../pr-workspace.ts";
import { CancelledError, ui } from "../ui.ts";
import { canPrompt, getActiveConfig, getAmbient } from "./context.ts";
import {
  CliInputRequiredError,
  resolveConfirmation,
  resolveDualInput,
  resolveTextInput,
} from "./input.ts";
import { resolveRepositoryInputs } from "./repository-input.ts";
import {
  matchesWorkspaceQuery,
  resolveWorkspaceInput,
  resolveWorkspaceMountInput,
  resolveWorkspaceMountScope,
} from "./workspace-input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";
import { reportError } from "./errors.ts";
function reportWorkspaceError(error: unknown, config: RuntimeConfig, json?: boolean): number {
  if (error instanceof ws.WorkspaceError && error.details) {
    if (
      (error.code === "WORKSPACE_NOT_FOUND" || error.code === "MANIFEST_NOT_FOUND") &&
      !config.configPath
    ) {
      error.message = "No dev root yet.";
      error.details.usage = "dev init";
    } else if (error.code === "MOUNT_NOT_FOUND") {
      const workspace = JSON.stringify(error.details.workspaceName);
      error.details.usage =
        Array.isArray(error.details.candidates) && error.details.candidates.length > 0
          ? `dev ws status --ws ${workspace}`
          : `dev ws add <repository> --ws ${workspace}`;
    }
  } else if (error instanceof LabelError && error.code === "LABEL_NOT_FOUND") {
    if (!config.configPath) error.message = "No dev root yet.";
    error.details.usage = !config.configPath
      ? "dev init"
      : Array.isArray(error.details.candidates) && error.details.candidates.length > 0
        ? "dev label list"
        : "dev label add <label> <repository-url>";
  }
  return reportError(error, json);
}

async function resolvePullRequestPlan(
  config: RuntimeConfig,
  value: string,
): Promise<{ plan: prWorkspace.PullRequestWorkspacePlan; extraHeader?: string } | undefined> {
  if (!prWorkspace.parsePullRequestUrl(value)) return undefined;
  let extraHeader: string | undefined;
  const plan = await prWorkspace.resolvePullRequestWorkspacePlan(value, {
    getGitHubPullRequest: async (reference) => {
      let token: string | undefined;
      try {
        token = (await resolveGitHubCredential(config)).token;
      } catch (error) {
        if (!(error instanceof CredentialError)) throw error;
      }
      return await createGitHubClient({ token }).getPullRequest(
        reference.owner,
        reference.repository,
        reference.pullRequestId,
      );
    },
    getAzureDevOpsPullRequest: async (reference) => {
      const credential = await resolveAzureDevOpsCredential(config);
      extraHeader = getGitExtraHeader(credential);
      return await createAzureDevOps({
        organization: reference.organization,
        token: credential.token,
      }).getPullRequest(reference.repository, reference.pullRequestId, {
        project: reference.project,
      });
    },
  });
  return plan ? { plan, extraHeader } : undefined;
}

/** Admin repositories the workspace could not relink before the command ran, once each. */
export function warnHealFailures(results: Array<{ healWarnings: string[] }>): void {
  for (const warning of new Set(results.flatMap((result) => result.healWarnings))) {
    ui.warn(`⚠ ${warning}`);
  }
}

/** Why a mount was left alone, in words, and the command that would move it on. */
export function describeSkipReason(
  reason: ws.UpdateSkipReason | undefined,
  workspaceName: string,
): { why: string; hint?: string } {
  switch (reason) {
    case "dirty_worktree":
      return {
        why: "uncommitted changes",
        hint: `dev ws update ${workspaceName} --autostash`,
      };
    case "ahead_commits":
      return { why: "local commits the remote does not have" };
    case "diverged_history":
      return {
        why: "local and remote history diverged",
        hint: `dev ws update ${workspaceName} --rebase`,
      };
    case "not_a_worktree":
      return { why: "the path holds files that are not this checkout; left untouched" };
    case "no_local_mirror":
      return { why: "no local mirror to check out from offline", hint: "run it without --offline" };
    case "readonly":
      return { why: "read-only mount" };
    case "not_tracking_branch":
      return { why: "pinned to a commit or tag, so there is nothing to fast-forward" };
    case "rebase_conflict":
      return { why: "rebase hit a conflict and was rolled back; resolve it by hand" };
    default:
      return { why: "skipped" };
  }
}

export const wsInitCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize a new workspace with ws.md and .local/",
  },
  args: {
    workspace: {
      type: "positional",
      description: "Workspace name, repository URI, or pull request URL",
      required: false,
    },
    desc: { type: "string", description: "Workspace description" },
    root: { type: "string", description: "Explicit dev root directory" },
    workset: { type: "string", description: "Initialize from a configured workset" },
    label: {
      type: "string",
      description: "Add every repository carrying this label (comma-separated for several)",
    },
    yes: { type: "boolean", description: "Accept the generated mount plan" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const inventory = canPrompt(ambient) ? await cache.loadAllCachedInventories(config.root) : [];
    let rawName = args.workspace;
    let suggestedName: string | undefined;
    let suggestedDescription: string | undefined;
    let mounts: PlannedMount[] = [];
    let reviewPlan = false;

    if (rawName && isExplicitSource(rawName)) {
      const resolvedPullRequest = await resolvePullRequestPlan(config, rawName);
      if (resolvedPullRequest) {
        const { plan } = resolvedPullRequest;
        mounts = [
          {
            source: plan.source,
            branch: plan.branch,
            path: plan.repository,
            extraHeader: resolvedPullRequest.extraHeader,
          },
        ];
        suggestedName = plan.workspaceName;
        suggestedDescription = plan.description;
      } else {
        mounts = [{ source: rawName, path: git.deriveDefaultMountPath(rawName) }];
        suggestedName = ws.deriveWorkspaceNameFromRepository(rawName);
      }
      rawName = undefined;
    } else if (args.workset || args.label) {
      const labels = (args.label ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      try {
        const resolved = args.workset
          ? await resolveWorksetMounts(config, args.workset, inventory)
          : undefined;
        mounts = dedupeMounts(
          [
            ...(resolved?.mounts ?? []),
            ...labels.flatMap((label) => resolveLabelMounts(config, label, inventory)),
          ],
          inventory,
        );
        suggestedDescription = resolved?.description;
      } catch (error) {
        return reportWorkspaceError(error, config, args.json);
      }
      suggestedName =
        args.workset ?? (labels.length === 1 ? labels[0]!.replaceAll(":", "-") : undefined);
      reviewPlan = canPrompt(ambient);
    } else if (!rawName && canPrompt(ambient)) {
      const labelCounts = declaredLabels(config);
      const choices = [
        { label: "Blank workspace", value: "blank" },
        { label: "Select repositories", value: "repositories" },
        ...(Object.keys(config.worksets).length > 0
          ? [{ label: "Workset", value: "workset" }]
          : []),
        ...(labelCounts.size > 0 ? [{ label: "Label", value: "label" }] : []),
      ];
      const mode = await ui.select({
        message: "How do you want to start?",
        hint: "A workset reuses a saved recipe; a repository starts from one URL.",
        options: choices,
      });
      if (mode === "repositories") {
        const selected = await resolveRepositoryInputs({
          root: config.root,
          message: "Select repositories",
          required: {
            command: "ws init",
            field: "repository",
            usage: "dev ws init <repository-uri>",
            description: "Repository",
          },
          ambient,
        });
        mounts = selected.value.map((source) => ({
          source,
          branch: inventory.find((record) => record.url === source)?.default_branch,
          path: git.deriveDefaultMountPath(source),
        }));
        if (mounts.length === 1) {
          suggestedName = ws.deriveWorkspaceNameFromRepository(mounts[0]!.source);
        }
        reviewPlan = true;
      } else if (mode === "workset") {
        const worksetName = await ui.select({
          message: "Select workset",
          hint: "Use this saved recipe to choose repositories and branches.",
          options: Object.entries(config.worksets).map(([name, workset]) => ({
            label: `${name} (${workset.members.length})${workset.description ? ` — ${workset.description}` : ""}`,
            value: name,
          })),
        });
        try {
          const resolved = await resolveWorksetMounts(config, worksetName, inventory);
          mounts = dedupeMounts(resolved.mounts, inventory);
          suggestedDescription = resolved.description;
        } catch (error) {
          return reportWorkspaceError(error, config, args.json);
        }
        suggestedName = worksetName;
        reviewPlan = true;
      } else if (mode === "label") {
        const labels = await ui.multiSelect({
          message: "Select labels",
          hint: "Each label adds its repositories as mounts in this workspace.",
          options: [...labelCounts].map(([label, count]) => ({
            label: `${label} (${count} ${count === 1 ? "repository" : "repositories"})`,
            value: label,
          })),
        });
        mounts = dedupeMounts(
          labels.flatMap((label) => resolveLabelMounts(config, label, inventory)),
          inventory,
        );
        if (labels.length === 1) suggestedName = labels[0]!.replaceAll(":", "-");
        reviewPlan = true;
      }
    }

    const name = await resolveTextInput({
      value: rawName ?? (!canPrompt(ambient) ? suggestedName : undefined),
      message: "Workspace name",
      hint: "One task folder under ws/. Enter keeps the proposed name.",
      initial: suggestedName,
      required: {
        command: "ws init",
        field: "workspace",
        usage:
          "dev ws init <workspace|repository-uri|pull-request-url> [--workset <name>] [--label <label>]",
        description: "Workspace name",
      },
      ambient,
    });
    // Init reuses an existing workspace as it is, so a typed description would be dropped.
    const exists = fs.exists(
      join(ws.deriveWorkspacePath(config.root, name.value, config.workspacePrefix), "ws.md"),
    );
    const description =
      args.desc ??
      (canPrompt(ambient) && !exists
        ? (
            await ui.text({
              message: "What is this task about?",
              hint: "Saved in ws.md for you and your agents. Enter keeps the proposal.",
              initial: suggestedDescription,
            })
          )?.trim()
        : suggestedDescription);

    if (reviewPlan && mounts.length > 0) {
      const reviewed = await reviewMountPlan(config, mounts, args.yes);
      if (!reviewed) return 0;
      mounts = reviewed;
    }
    try {
      validateMountPlan(mounts);
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }

    let initializedPath: string | undefined;
    try {
      const result = await ws.init({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        name: name.value,
        description: args.desc === undefined ? description || undefined : args.desc,
        reuseExisting: true,
        requireMatchingDescription: args.desc !== undefined,
      });
      if (result.created) initializedPath = result.path;
      const mounted: ws.WorkspaceAddResult[] = [];
      for (const mount of mounts) {
        mounted.push(
          await ws.add({
            root: config.root,
            workspacePrefix: config.workspacePrefix,
            workspaceName: result.name,
            source: mount.source,
            path: mount.path,
            branch: mount.branch,
            extraHeader: mount.extraHeader ?? (await resolveExtraHeader(config, mount.source)),
            trustedScopes: config.trustedScopes,
            globalHooks: config.hooks,
          }),
        );
      }
      warnHealFailures(mounted);

      const data =
        mounted.length === 0
          ? result
          : mounted.length === 1
            ? { ...result, mount: mounted[0] }
            : { ...result, mounts: mounted };
      ui.result({
        data,
        json: args.json,
        text: () => {
          let out = result.created
            ? `✓ Initialized workspace '${result.name}' at:\n`
            : `○ Workspace '${result.name}' already exists at:\n`;
          out += `  Directory: ${result.path}\n`;
          out += `  Task notes: ${result.manifestPath}`;
          for (const mount of mounted) {
            out +=
              mount.outcome === "already_mounted"
                ? `\n  ○ Mounted: ${mount.mountName} (already there)`
                : `\n  ✓ Mounted: ${mount.mountName}${mount.mirrorReused ? " (reused the local mirror)" : ""}`;
          }
          return out;
        },
        next: [
          { command: `dev go ${result.name}`, why: "work in this task folder" },
          ...(mounted.length === 0
            ? [
                {
                  command: `dev ws add <repository-url> --ws ${result.name}`,
                  why: "add a repository to the task",
                },
              ]
            : []),
        ],
      });
      return 0;
    } catch (error) {
      if (initializedPath && mounts.length > 0) await fs.removeDir(initializedPath);
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

interface PlannedMount {
  source: string;
  branch?: string;
  path: string;
  reason?: string;
  extraHeader?: string;
}

function renderMountPlan(title: string, mounts: PlannedMount[]): string {
  const rows = [
    ["Repository", "Branch", "Path", "Reason"],
    ...mounts.map((mount) => [
      git.deriveDefaultMountPath(mount.source),
      mount.branch ?? "unknown default",
      mount.path,
      mount.reason ?? "",
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return `${title}:\n${rows
    .map((row) =>
      row
        .map((value, column) => value.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}`;
}

function duplicateMountPath(path: string, branch: string): string {
  const suffix = branch
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${path}-${suffix || "branch"}`;
}

async function resolveWorksetMounts(
  config: RuntimeConfig,
  name: string,
  inventory: InventoryRecord[],
): Promise<{ mounts: PlannedMount[]; description?: string }> {
  const definition = config.worksets[name];
  if (!definition) {
    const candidates = Object.keys(config.worksets);
    throw new WorksetError(
      "WORKSET_NOT_FOUND",
      !config.configPath
        ? "No dev root yet."
        : candidates.length === 0
          ? "This root has no worksets yet."
          : `Unknown workset '${name}'.`,
      {
        kind: "workset",
        value: name,
        candidates,
        usage: !config.configPath
          ? "dev init"
          : candidates.length === 0
            ? canPrompt()
              ? "dev workset manage <workset>"
              : "dev workset create <workset> <repository>"
            : "dev workset list",
      },
    );
  }
  const mounts: PlannedMount[] = [];
  for (const member of definition.members) {
    if (member.label !== undefined) {
      mounts.push(...resolveLabelMounts(config, member.label, inventory, member.reason));
      continue;
    }
    const resolved = await resolveInputSource(config.root, member.source);
    if (!resolved.sourceUrl) {
      throw new Error(resolved.error ?? `Could not resolve workset source '${member.source}'.`);
    }
    mounts.push({
      source: resolved.sourceUrl,
      branch: member.ref,
      path: member.path ?? git.deriveDefaultMountPath(resolved.sourceUrl),
      reason: member.reason,
    });
  }
  return { mounts, description: definition.description };
}

function resolveLabelMounts(
  config: RuntimeConfig,
  label: string,
  inventory: InventoryRecord[],
  reason = `label ${label}`,
): PlannedMount[] {
  return labelSources(config, label).map((source) => ({
    source: source.url,
    branch:
      source.branch ??
      source.pin ??
      inventory.find((record) => record.url === source.url)?.default_branch,
    path: source.path ?? git.deriveDefaultMountPath(source.url),
    reason,
  }));
}

/** Keeps the first mount of each source, branch and path: a label may repeat a listed repository. */
function dedupeMounts(mounts: PlannedMount[], inventory: InventoryRecord[]): PlannedMount[] {
  const seen = new Set<string>();
  return mounts.filter((mount) => {
    const branch =
      mount.branch ?? inventory.find((record) => record.url === mount.source)?.default_branch;
    const key = JSON.stringify([git.normalizeSourceKey(mount.source), branch ?? null, mount.path]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateMountPlan(mounts: PlannedMount[]): void {
  const declared: manifest.MountDefinition[] = [];
  for (const mount of mounts) {
    const planned = ws.planMount({
      source: mount.source,
      path: mount.path,
      branch: mount.branch,
      existingMounts: declared,
    });
    declared.push({
      path: planned.mountName,
      source: mount.source,
      revision: planned.revision ?? { mode: "lock", commit: "HEAD" },
    });
  }
}

async function reviewMountPlan(
  config: RuntimeConfig,
  mounts: PlannedMount[],
  confirmed: boolean | undefined,
): Promise<PlannedMount[] | undefined> {
  ui.log(renderMountPlan("Selected repositories", mounts));
  const selected = await ui.multiSelect({
    message: "Select repositories to customize",
    hint: "Change branch or folder; Continue with defaults keeps the plan.",
    options: [
      { label: "Continue with defaults", value: "defaults" },
      ...mounts.map((mount, index) => ({
        label: `${git.deriveDefaultMountPath(mount.source)} (${mount.branch ?? "unknown default"} → ${mount.path})`,
        value: String(index),
      })),
    ],
  });
  for (const value of selected.filter((candidate) => candidate !== "defaults")) {
    const mount = mounts[Number(value)];
    if (!mount) continue;
    const extraHeader = await resolveExtraHeader(config, mount.source);
    const remote = await git.listRemoteBranches({ source: mount.source, extraHeader });
    if (remote.branches.length > 0) {
      mount.branch = await ui.select({
        message: `Branch for ${git.deriveDefaultMountPath(mount.source)}`,
        hint: "The mount uses this branch; (default) is the remote default branch.",
        options: remote.branches.map((branch) => ({
          label: branch === remote.defaultBranch ? `${branch} (default)` : branch,
          value: branch,
        })),
      });
    }
    mount.path =
      (await ui.text({
        message: `Workspace path for ${git.deriveDefaultMountPath(mount.source)}`,
        hint: "Folder inside this workspace. Enter keeps the proposed path.",
        initial: mount.path,
      })) ?? mount.path;
  }
  validateMountPlan(mounts);
  ui.log(renderMountPlan("Workspace plan", mounts));
  if (
    !confirmed &&
    !(await ui.confirm({
      message: "Create this workspace?",
      hint: "Yes creates the shown task folder and mounts; No changes nothing.",
      initial: true,
    }))
  )
    return undefined;
  return mounts;
}

export const wsAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Mount a repository into the workspace",
  },
  args: {
    repository: {
      type: "positional",
      description: "Repository URL, path, or a name dev knows",
      required: false,
    },
    ws: { type: "string", description: "Target workspace name" },
    path: { type: "string", description: "Mount folder name inside workspace" },
    as: { type: "string", description: "Alias for --path" },
    branch: { type: "string", description: "Branch to track" },
    tag: { type: "string", description: "Tag to pin" },
    commit: { type: "string", description: "Commit SHA to lock" },
    readonly: { type: "boolean", description: "Mount as read-only worktree" },
    consent: { type: "boolean", description: "Grant explicit consent to run repository hooks" },
    force: { type: "boolean", description: "Alias for --consent" },
    preHook: { type: "string", description: "Hook command before checkout" },
    postHook: { type: "string", description: "Hook command after checkout" },
    preCheckout: { type: "string", description: "Hook command before checkout" },
    postCheckout: { type: "string", description: "Hook command after checkout" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const inventory =
      !args.repository && canPrompt(ambient)
        ? await cache.loadAllCachedInventories(config.root)
        : [];
    const repositoryInput = await resolveRepositoryInputs({
      value: args.repository,
      root: config.root,
      message: "Select repositories",
      required: {
        command: "ws add",
        field: "repository",
        usage: "dev ws add <repository>",
        description: "Repository",
      },
    });
    const sources = repositoryInput.value;

    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws add",
      usage: "dev ws add <url|path|name> [--ws <name>]",
    });

    const mountPath = args.path || args.as;
    const preHook = args.preHook || args.preCheckout;
    const postHook = args.postHook || args.postCheckout;
    const interactivePlanning =
      !args.repository &&
      !args.branch &&
      !args.tag &&
      !args.commit &&
      !mountPath &&
      !preHook &&
      !postHook &&
      inventory.length > 0 &&
      canPrompt(ambient);
    if (
      sources.length > 1 &&
      !interactivePlanning &&
      (mountPath || args.branch || args.tag || args.commit || preHook || postHook)
    ) {
      return reportError(
        "--path, --branch, --tag, --commit, and mount hooks require a single repository.",
        args.json,
      );
    }

    try {
      const hooks =
        preHook || postHook
          ? {
              pre_checkout: preHook,
              post_checkout: postHook,
            }
          : undefined;
      const resolvedHeaders = new Map<string, string | undefined>();
      // A pull request URL is not a repository: cloning it would mint a second
      // source identity (.../pull/<id>) beside the real one. Resolve it into the
      // head repository, its branch, and the repository's own mount path.
      let plannedMounts: PlannedMount[] = [];
      for (const source of sources) {
        const resolvedPullRequest = await resolvePullRequestPlan(config, source);
        if (resolvedPullRequest) {
          const { plan } = resolvedPullRequest;
          resolvedHeaders.set(plan.source, resolvedPullRequest.extraHeader);
          plannedMounts.push({
            source: plan.source,
            branch: args.branch ?? plan.branch,
            path: mountPath ?? plan.repository,
          });
          continue;
        }
        plannedMounts.push({
          source,
          branch: args.branch,
          path: mountPath ?? git.deriveDefaultMountPath(source),
        });
      }

      if (interactivePlanning) {
        plannedMounts = plannedMounts.map((mount) => ({
          ...mount,
          branch: inventory.find((record) => record.url === mount.source)?.default_branch,
        }));
        ui.log(renderMountPlan("Selected mounts", plannedMounts));

        const selected = await ui.multiSelect({
          message: "Select mounts to customize",
          hint: "Change branch or folder; Continue with defaults keeps the plan.",
          options: [
            { label: "Continue with defaults", value: "defaults" },
            ...plannedMounts.map((mount, index) => ({
              label: `${git.deriveDefaultMountPath(mount.source)} (${mount.branch ?? "unknown default"} → ${mount.path})`,
              value: String(index),
            })),
          ],
        });
        const customizedMounts = selected
          .filter((value) => value !== "defaults")
          .map((value) => plannedMounts[Number(value)])
          .filter((mount): mount is PlannedMount => Boolean(mount));

        for (const mount of customizedMounts) {
          const extraHeader = await resolveExtraHeader(config, mount.source);
          resolvedHeaders.set(mount.source, extraHeader);
          const remote = await git.listRemoteBranches({ source: mount.source, extraHeader });
          if (remote.branches.length > 0) {
            mount.branch = await ui.select({
              message: `Branch for ${git.deriveDefaultMountPath(mount.source)}`,
              hint: "The mount uses this branch; (default) is the remote default branch.",
              options: remote.branches.map((branch) => ({
                label: branch === remote.defaultBranch ? `${branch} (default)` : branch,
                value: branch,
              })),
            });
          }
          mount.path =
            (await ui.text({
              message: `Mount path for ${git.deriveDefaultMountPath(mount.source)}`,
              hint: "Folder for this repository branch. Enter keeps the proposed path.",
              initial: mount.path,
            })) ?? mount.path;

          while (
            await ui.confirm({
              message: `Add another branch from ${git.deriveDefaultMountPath(mount.source)}?`,
              hint: "Yes adds another mount; No keeps only the branches in the plan.",
              initial: false,
            })
          ) {
            const usedBranches = new Set(
              plannedMounts
                .filter(
                  (candidate) =>
                    git.normalizeSourceKey(candidate.source) ===
                    git.normalizeSourceKey(mount.source),
                )
                .map((candidate) => candidate.branch)
                .filter((branch): branch is string => Boolean(branch)),
            );
            const availableBranches = remote.branches.filter((branch) => !usedBranches.has(branch));
            if (availableBranches.length === 0) {
              ui.warn(`No additional branches are available for ${mount.source}.`);
              break;
            }
            const branch = await ui.select({
              message: `Additional branch for ${git.deriveDefaultMountPath(mount.source)}`,
              hint: "Adds a separate mount so you can work on another branch.",
              options: availableBranches.map((candidate) => ({
                label: candidate,
                value: candidate,
              })),
            });
            const suggestedPath = duplicateMountPath(
              git.deriveDefaultMountPath(mount.source),
              branch,
            );
            const path =
              (await ui.text({
                message: `Mount path for ${git.deriveDefaultMountPath(mount.source)} (${branch})`,
                hint: "Folder for the additional branch. Enter keeps the proposed path.",
                initial: suggestedPath,
              })) ?? suggestedPath;
            const insertAt = plannedMounts.reduce(
              (last, candidate, index) =>
                git.normalizeSourceKey(candidate.source) === git.normalizeSourceKey(mount.source)
                  ? index + 1
                  : last,
              0,
            );
            plannedMounts.splice(insertAt, 0, { source: mount.source, branch, path });
          }
        }

        const workspacePath = ws.deriveWorkspacePath(
          config.root,
          workspace.value,
          config.workspacePrefix,
        );
        const current = await manifest.readWorkspace(join(workspacePath, "ws.md"));
        const declared = [...current.manifest.mounts];
        for (const mount of plannedMounts) {
          const planned = ws.planMount({
            source: mount.source,
            path: mount.path,
            branch: mount.branch,
            existingMounts: declared,
          });
          declared.push({
            path: planned.mountName,
            source: mount.source,
            revision: planned.revision ?? { mode: "lock", commit: "HEAD" },
          });
        }

        ui.log(renderMountPlan("Final mount plan", plannedMounts));
        if (
          !(await ui.confirm({
            message: "Create these mounts?",
            hint: "Yes adds the shown repository branches; No changes nothing.",
            initial: true,
          }))
        )
          return 0;
      }

      const results: ws.WorkspaceAddResult[] = [];
      for (const mount of plannedMounts) {
        results.push(
          await ws.add({
            root: config.root,
            workspacePrefix: config.workspacePrefix,
            workspaceName: workspace.value,
            source: mount.source,
            path: mount.path,
            branch: mount.branch,
            tag: args.tag,
            commit: args.commit,
            readonly: args.readonly,
            extraHeader:
              resolvedHeaders.get(mount.source) ?? (await resolveExtraHeader(config, mount.source)),
            trustedScopes: config.trustedScopes,
            explicitConsent: args.consent || args.force,
            hooks,
            globalHooks: config.hooks,
          }),
        );
      }

      ui.result({
        data: results.length === 1 ? results[0] : results,
        json: args.json,
        text: () =>
          results
            .map((result) => {
              const at = `${result.mountName} @ ${ws.describeRevision(result.revision)}`;
              if (result.outcome === "already_mounted") {
                return `○ ${at} is already mounted in '${result.workspaceName}'`;
              }
              const verb = result.outcome === "adopted" ? "Adopted existing checkout" : "Mounted";
              const reused = result.mirrorReused ? " (reused the local mirror)" : "";
              return `✓ ${verb} ${at} from ${result.source} in '${result.workspaceName}'${reused}`;
            })
            .join("\n"),
        next: [
          {
            command: `dev ws status --ws ${workspace.value}`,
            why: "inspect the task's repository branches",
          },
        ],
      });
      for (const result of results) {
        if (result.hookWarning) ui.warn(`⚠ ${result.hookWarning}`);
      }
      warnHealFailures(results);
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Compare each mount with the plan in ws.md",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: false },
    ws: {
      type: "string",
      description:
        "Target workspace name; when the positional is also given, both must name the same workspace",
    },
    refresh: { type: "boolean", description: "Fetch latest remote refs before comparing" },
    offline: { type: "boolean", description: "Read strictly from local mirror without network" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: resolveDualInput(args.workspace, args.ws, {
        command: "ws status",
        usage: "dev ws status [workspace] [--ws <name>]",
        positionalName: "workspace",
        flagName: "--ws",
      }),
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws status",
      usage: "dev ws status [workspace] [--ws <name>]",
    });

    try {
      const result = await ws.status({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        refresh: args.refresh,
        offline: args.offline,
        resolveExtraHeader: (source) => resolveExtraHeader(config, source),
      });
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = `Workspace: ${result.workspaceName}\n`;
          out += `Path:      ${result.workspacePath}\n`;
          out += `Status:    ${result.isClean ? "matches your workspace plan" : "needs attention; see each mount below"}\n\n`;
          if (result.mounts.length === 0) {
            ui.log(out.trimEnd());
            return ui.empty({
              message: `Workspace '${result.workspaceName}' has no repository mounts yet.`,
              next: [
                {
                  command: `dev ws add <repository-url> --ws ${result.workspaceName}`,
                  why: "add a repository for this task",
                },
              ],
            });
          } else {
            out += "Mounts:\n";
            for (const mount of result.mounts) {
              const sym = mount.state === "clean" ? "○" : "⚠";
              out += `  ${sym} ${mount.path} [${mount.state}]\n`;
              out += `      Repository: ${mount.source}\n`;
              if (mount.desired.revision.mode === "track") {
                out += `      Planned:  branch ${mount.desired.revision.branch}\n`;
              } else if (mount.desired.revision.mode === "lock") {
                out += `      Planned:  commit ${mount.desired.revision.commit}\n`;
              }
              if (mount.observed.exists && mount.observed.isGitWorktree) {
                out += `      Checked out: branch=${mount.observed.currentRevision.branch || "detached"} commit=${mount.observed.currentRevision.commitSha?.slice(0, 8)}\n`;
              }
              for (const msg of mount.messages) {
                out += `      Note:     ${msg}\n`;
              }
            }
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

/** What a workspace sync takes; `dev sync` forwards them unchanged inside a workspace. */
export const workspaceSyncOptions = {
  refresh: {
    type: "boolean",
    description: "Fetch remotes before fast-forwarding (default, unless --offline)",
  },
  autostash: {
    type: "boolean",
    description:
      "Stash local changes, fast-forward, then apply them back (the stash entry is kept as a backup)",
  },
  rebase: {
    type: "boolean",
    description: "Rebase diverged mounts onto the remote branch (aborts on conflict)",
  },
  "dry-run": {
    type: "boolean",
    description: "Fetch, then show the plan without changing your mounts or ws.md",
  },
  consent: { type: "boolean", description: "Grant explicit consent to run lifecycle hooks" },
  force: { type: "boolean", description: "Alias for --consent" },
} as const;

export const wsUpdateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Converge mounts to ws.md: create missing ones, fix revisions, fast-forward clean ones",
  },
  args: {
    workspace: {
      type: "positional",
      description: "Workspace name or path to ws.md",
      required: false,
    },
    ws: {
      type: "string",
      description:
        "Target workspace name; when the positional is also given, both must name the same workspace",
    },
    ...workspaceSyncOptions,
    offline: { type: "boolean", description: "Read strictly from local mirror without network" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);

    try {
      // A ws.md path selects the identity stored in its manifest, not its spelling.
      const positionalWorkspace = args.workspace?.endsWith(".md")
        ? (await manifest.readWorkspace(args.workspace)).manifest.name
        : args.workspace;
      const selectedWorkspace = resolveDualInput(positionalWorkspace, args.ws, {
        command: "ws update",
        usage: "dev ws update [workspace | path/to/ws.md] [--ws <name>]",
        positionalName: "workspace",
        flagName: "--ws",
      });
      const workspaceName = (
        await resolveWorkspaceInput({
          value: selectedWorkspace,
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          command: "ws update",
          usage: "dev ws update [workspace | path/to/ws.md] [--ws <name>]",
        })
      ).value;
      const fetching = !args.offline && args.refresh !== false;
      if (fetching && !args.json) ui.info(`↻ Fetching remotes for ${workspaceName}...`);
      const result = await ws.update({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName,
        refresh: args.refresh,
        offline: args.offline,
        autostash: args.autostash,
        rebase: args.rebase,
        dryRun: args["dry-run"],
        resolveExtraHeader: (source) => resolveExtraHeader(config, source),
        trustedScopes: config.trustedScopes,
        explicitConsent: args.consent || args.force,
        globalHooks: config.hooks,
      });
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          if (result.dryRun) {
            let plan = `Plan for ${result.workspaceName} (dry run, nothing changed${fetching ? "" : "; offline, compared with the last fetch"}):\n`;
            for (const mount of result.mounts) {
              const at = mount.revision ? ws.describeRevision(mount.revision) : "";
              const line =
                mount.action === "create"
                  ? `would create at ${at}`
                  : mount.action === "checkout"
                    ? `would check out ${at}`
                    : mount.action === "fast_forward"
                      ? "would fast-forward"
                      : mount.action === "rebase"
                        ? "would rebase onto remote"
                        : mount.action === "up_to_date"
                          ? "up to date"
                          : `would skip: ${describeSkipReason(mount.reason, result.workspaceName).why}`;
              plan += `  → ${mount.path}: ${line}\n`;
            }
            return plan.trimEnd();
          }
          let out = `Workspace: ${result.workspaceName}\n`;
          out += `Path:      ${result.workspacePath}\n`;
          out += `Summary:   ${result.summary.updated} updated, ${result.summary.upToDate} up to date, ${result.summary.skipped} skipped (${result.summary.total} total)\n`;
          if (!fetching)
            out += "Remotes:   not fetched (--offline); compared with the last fetch\n";
          if (result.hookWarning) {
            out += `Hook:      ⚠ ${result.hookWarning}\n`;
          }
          out += "\n";
          for (const mount of result.mounts) {
            if (mount.action === "create") {
              const reused = mount.mirrorReused ? ", reused the local mirror" : "";
              out += `  ✓ ${mount.path}: created at ${ws.describeRevision(mount.revision!)} (${mount.newCommit?.slice(0, 8)}${reused})\n`;
            } else if (mount.action === "checkout") {
              out += `  ✓ ${mount.path}: back on ${ws.describeRevision(mount.revision!)} (${mount.newCommit?.slice(0, 8)})\n`;
            } else if (mount.action === "fast_forward") {
              out += `  ✓ ${mount.path}: fast-forwarded (${mount.previousCommit?.slice(0, 8)} -> ${mount.newCommit?.slice(0, 8)})\n`;
            } else if (mount.action === "rebase") {
              out += `  ✓ ${mount.path}: rebased onto remote (${mount.previousCommit?.slice(0, 8)} -> ${mount.newCommit?.slice(0, 8)})\n`;
            } else if (mount.action === "up_to_date") {
              out += `  ○ ${mount.path}: up to date (${mount.newCommit?.slice(0, 8)})\n`;
            } else {
              const skip = describeSkipReason(mount.reason, result.workspaceName);
              out += `  ⚠ ${mount.path}: skipped, ${skip.why}\n`;
              if (skip.hint) out += `    ↳ ${skip.hint}\n`;
            }
            if (mount.warning) {
              out += `    ⚠ ${mount.warning}\n`;
            }
            if (mount.stash) {
              out += `    Work restored, backup retained: ${mount.stash.stashName} (${mount.stash.stashSha.slice(0, 8)})\n`;
              out += `    Recovery: ${mount.stash.recovery}\n`;
            }
          }
          return out;
        },
        next: result.dryRun
          ? undefined
          : [
              {
                command: `dev ws status --ws ${result.workspaceName}`,
                why: "inspect the task's repository state",
              },
            ],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsTrackCommand = defineCommand({
  meta: {
    name: "track",
    description: "Switch mount to track a branch tip",
  },
  args: {
    mount: { type: "positional", description: "Mount path or name", required: false },
    branchName: { type: "positional", description: "Branch to track", required: false },
    branch: { type: "string", description: "Branch to track" },
    ws: { type: "string", description: "Target workspace name" },
    "manifest-only": {
      type: "boolean",
      description: "Update ws.md without changing disk worktree",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws track",
      usage: "dev ws track [mount] [branchName] [--branch <branch>] [--ws <name>]",
    });
    const mount = await resolveWorkspaceMountInput({
      value: args.mount,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws track",
      usage: "dev ws track [mount] [branchName] [--branch <branch>] [--ws <name>]",
    });
    const branch = await resolveTextInput({
      value: args.branchName || args.branch,
      message: "Branch to track",
      hint: "The mount follows this branch on future workspace updates.",
      required: {
        command: "ws track",
        field: "branch",
        usage: "dev ws track [mount] [branchName] [--branch <branch>] [--ws <name>]",
        description: "Branch",
      },
    });

    try {
      const result = await ws.track({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        mountPath: mount.value,
        branch: branch.value,
        manifestOnly: args["manifest-only"],
      });
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          const changed = result.manifestUpdated || result.worktreeSwitched;
          let out = `${changed ? "✓" : "○"} Mount '${result.path}' ${changed ? "now tracks" : "already tracks"} branch '${result.branch}'.`;
          if (result.worktreeSwitched) {
            out += `\n✓ Switched worktree to branch '${result.branch}'.`;
          }
          return out;
        },
        next: [
          {
            command: `dev ws status --ws ${workspace.value}`,
            why: "inspect the branch now in use",
          },
        ],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsLockCommand = defineCommand({
  meta: {
    name: "lock",
    description: "Freeze mount to current disk or specified commit",
  },
  args: {
    mount: { type: "positional", description: "Mount path or name", required: false },
    all: { type: "boolean", description: "Apply to every mount in the workspace" },
    commit: { type: "string", description: "Commit SHA to lock to" },
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws lock",
      usage: "dev ws lock [mount] [--all] [--ws <name>]",
    });
    const mountPath = await resolveWorkspaceMountScope({
      value: args.mount,
      all: args.all,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws lock",
      usage: "dev ws lock [mount] [--all] [--ws <name>]",
    });

    try {
      const result = await ws.lock({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        mountPath,
        commit: args.commit,
      });
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          if (!result.changed) return "○ No revision changes required.";
          let out = "";
          for (const m of result.lockedMounts) {
            out += `✓ Mount '${m.path}' locked to commit ${m.commit.slice(0, 8)}.\n`;
          }
          return out.trimEnd();
        },
        next: [
          {
            command: `dev ws status --ws ${workspace.value}`,
            why: "inspect the pinned repository commits",
          },
        ],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsUnlockCommand = defineCommand({
  meta: {
    name: "unlock",
    description: "Unlock mount back to tracking a branch",
  },
  args: {
    mount: { type: "positional", description: "Mount path or name", required: false },
    all: { type: "boolean", description: "Apply to every mount in the workspace" },
    branchName: { type: "positional", description: "Branch to track", required: false },
    branch: { type: "string", description: "Branch to track" },
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    // With --all there is no mount, so a lone positional names the branch.
    const mountValue = args.all && !args.branchName ? undefined : args.mount;
    const branch = args.branchName || args.branch || (args.all ? args.mount : undefined);

    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws unlock",
      usage: "dev ws unlock [mount] [branchName] [--branch <branch>] [--all] [--ws <name>]",
    });
    const mountPath = await resolveWorkspaceMountScope({
      value: mountValue,
      all: args.all,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws unlock",
      usage: "dev ws unlock [mount] [branchName] [--branch <branch>] [--all] [--ws <name>]",
    });

    try {
      const result = await ws.unlock(
        {
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          workspaceName: workspace.value,
          mountPath,
          branch,
        },
        canPrompt(getAmbient())
          ? {
              ...ws.defaultDeps,
              interactions: {
                chooseUnlockBranch: async ({ adminRepoPath }) => {
                  const listed = await git.runGit([
                    "-C",
                    adminRepoPath,
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads",
                  ]);
                  if (listed.exitCode !== 0) return undefined;
                  const branches = listed.stdout.split(/\r?\n/).filter(Boolean);
                  if (branches.length === 0) return undefined;
                  try {
                    return await ui.select({
                      message: "Branch to track",
                      hint: "The mount follows this branch on future workspace updates.",
                      options: branches.map((value) => ({ label: value, value })),
                    });
                  } catch (error) {
                    if (error instanceof CancelledError) return undefined;
                    throw error;
                  }
                },
              },
            }
          : undefined,
      );
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          if (!result.changed) return "○ No revision changes required.";
          let out = "";
          for (const m of result.unlockedMounts) {
            out += `✓ Mount '${m.path}' unlocked to track branch '${m.branch}'.\n`;
          }
          return out.trimEnd();
        },
        next: [
          {
            command: `dev ws status --ws ${workspace.value}`,
            why: "inspect the tracked repository branches",
          },
        ],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsTagCommand = defineCommand({
  meta: {
    name: "tag",
    description: "Pin mount to an immutable tag",
  },
  args: {
    mount: { type: "positional", description: "Mount path or name", required: false },
    tagName: { type: "positional", description: "Tag to pin to", required: false },
    tag: { type: "string", description: "Tag to pin to" },
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws tag",
      usage: "dev ws tag [mount] [tagName] [--tag <tag>] [--ws <name>]",
    });
    const mount = await resolveWorkspaceMountInput({
      value: args.mount,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws tag",
      usage: "dev ws tag [mount] [tagName] [--tag <tag>] [--ws <name>]",
    });
    const tag = await resolveTextInput({
      value: args.tagName || args.tag,
      message: "Tag to pin",
      hint: "Keep the mount at this tag; updates no longer follow a branch.",
      required: {
        command: "ws tag",
        field: "tag",
        usage: "dev ws tag [mount] [tagName] [--tag <tag>] [--ws <name>]",
        description: "Tag",
      },
    });

    try {
      const result = await ws.tag({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        mountPath: mount.value,
        tag: tag.value,
      });
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: result.changed
          ? `✓ Mount '${result.path}' pinned to tag '${result.tag}'.`
          : `○ Mount '${result.path}' is already pinned to tag '${result.tag}'.`,
        next: [
          {
            command: `dev ws status --ws ${workspace.value}`,
            why: "inspect the pinned repository tag",
          },
        ],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsRemoveCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove mount worktree and prune from ws.md",
  },
  args: {
    mount: { type: "positional", description: "Mount path or name", required: false },
    ws: { type: "string", description: "Target workspace name" },
    yes: {
      type: "boolean",
      description:
        "Skip confirmation; refuse uncommitted changes, unpushed commits, or an unmanaged checkout",
    },
    force: {
      type: "boolean",
      description:
        "Confirm removal even with uncommitted changes, unpushed commits, or an unmanaged checkout",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);

    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws remove",
      usage: "dev ws remove <mount> [--ws <name>]",
    });
    const mount = await resolveWorkspaceMountInput({
      value: args.mount,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws remove",
      usage: "dev ws remove [mount] [--ws <name>]",
    });
    const confirmed = await resolveConfirmation({
      confirmed: args.yes || args.force,
      message: `Remove mount '${mount.value}' from workspace '${workspace.value}'?`,
      hint: "Yes removes this checkout; No leaves the workspace unchanged.",
      required: {
        command: "ws remove",
        field: "confirmation",
        usage: "dev ws remove [mount] [--ws <name>] --yes",
        description: "Explicit confirmation (--yes)",
      },
    });
    if (!confirmed) {
      ui.info("Cancelled.");
      return 0;
    }

    try {
      const result = await ws.remove({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        mountPath: mount.value,
        force: args.force,
      });
      warnHealFailures([result]);

      ui.result({
        data: result,
        json: args.json,
        text: result.removed
          ? `✓ Removed mount '${result.path}' from workspace '${workspace.value}'.`
          : `○ '${result.path}' is not mounted in workspace '${workspace.value}'.`,
        next: [
          { command: `dev ws status --ws ${workspace.value}`, why: "inspect the remaining mounts" },
        ],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List your workspaces",
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    try {
      const items = await ws.list({ root: config.root, workspacePrefix: config.workspacePrefix });

      ui.result({
        data: items,
        json: args.json,
        text: () => {
          if (items.length === 0) {
            return ui.empty({
              message: config.configPath
                ? "No workspaces created in this root yet."
                : "No dev root yet, so there are no workspaces to show.",
              next: config.configPath
                ? [{ command: "dev ws init <repository-url>", why: "start a workspace for a task" }]
                : [{ command: "dev init", why: "choose where to keep your work" }],
            });
          }
          let out = `Workspaces in ${config.root}:\nWorkspace | Mounts | Last used | Path\n`;
          for (const item of items) {
            const desc = item.description ? ` - ${item.description}` : "";
            const state = item.error ? `invalid: ${item.error.message}` : `${item.mountCount}`;
            out += `${item.name}${desc} | ${state} | ${item.lastUsedAt ?? "never"} | ${item.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsDuplicateCommand = defineCommand({
  meta: {
    name: "duplicate",
    description: "Duplicate a workspace with independent worktrees",
  },
  args: {
    from: { type: "positional", description: "Workspace to copy", required: false },
    to: { type: "positional", description: "New workspace name", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const source = await resolveWorkspaceInput({
      value: args.from,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws duplicate",
      usage: "dev ws duplicate <from> <to>",
    });
    const target = await resolveTextInput({
      value: args.to,
      message: "New workspace name",
      hint: "Create a separate task folder with the same repository plan.",
      required: {
        command: "ws duplicate",
        field: "to",
        usage: "dev ws duplicate <from> <to>",
        description: "New workspace name",
      },
    });

    try {
      const result = await ws.duplicate({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        sourceName: source.value,
        targetName: target.value,
        resolveExtraHeader: (mountSource) => resolveExtraHeader(config, mountSource),
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = `✓ Duplicated workspace '${result.sourceName}' to '${result.targetName}' (${result.mountsCount} mounts).\n`;
          out += `  Path: ${result.path}`;
          return out;
        },
        next: [{ command: `dev go ${result.targetName}`, why: "work in the new task folder" }],
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsPathCommand = defineCommand({
  meta: {
    name: "path",
    description: "Print absolute path of target or current workspace",
  },
  args: {
    workspace: { type: "positional", description: "Optional workspace name", required: false },
    ws: {
      type: "string",
      description:
        "Target workspace name; when the positional is also given, both must name the same workspace",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: resolveDualInput(args.workspace, args.ws, {
        command: "ws path",
        usage: "dev ws path [workspace] [--ws <name>]",
        positionalName: "workspace",
        flagName: "--ws",
      }),
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws path",
      usage: "dev ws path [workspace] [--ws <name>]",
    });

    try {
      const resolvedPath = ws.deriveWorkspacePath(
        config.root,
        workspace.value,
        config.workspacePrefix,
      );

      ui.result({
        data: { path: resolvedPath },
        json: args.json,
        text: () => resolvedPath,
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsGoCommand = defineCommand({
  meta: {
    name: "go",
    description: "Select a workspace and print its path for shell navigation",
  },
  args: {
    query: { type: "positional", description: "Workspace name or fuzzy query", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const query = args.query?.trim() ?? "";
    const available = await ws.list({ root: config.root, workspacePrefix: config.workspacePrefix });
    const workspaces = available
      .filter((workspace) => matchesWorkspaceQuery(workspace.name, query))
      .sort((left, right) => {
        const leftCreatedAt = left.createdAt
          ? Date.parse(left.createdAt)
          : Number.NEGATIVE_INFINITY;
        const rightCreatedAt = right.createdAt
          ? Date.parse(right.createdAt)
          : Number.NEGATIVE_INFINITY;
        return rightCreatedAt - leftCreatedAt || left.name.localeCompare(right.name);
      });

    if (workspaces.length === 0) {
      return reportError(
        new ws.WorkspaceError(
          "WORKSPACE_NOT_FOUND",
          !config.configPath
            ? "No dev root yet."
            : available.length === 0
              ? "This root has no workspaces yet."
              : `No workspace matches '${query}'.`,
          {
            kind: "workspace",
            value: query,
            candidates: available.map((workspace) => workspace.name),
            usage: !config.configPath
              ? "dev init"
              : available.length === 0
                ? "dev ws init <workspace>"
                : "dev ls",
          },
        ),
        args.json,
      );
    }

    const exact = query
      ? workspaces.find((workspace) => workspace.name.toLowerCase() === query.toLowerCase())
      : undefined;
    let selected = exact ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    if (!selected) {
      if (!canPrompt()) {
        return reportError(
          new CliInputRequiredError({
            command: "go",
            field: "query",
            usage: "dev go <query>",
            description: "An unambiguous workspace query (dev go <query>)",
            choices: workspaces.map((workspace) => workspace.name),
          }),
          args.json,
        );
      }
      const name = await ui.select({
        message: "Select workspace",
        hint: "Choose the task folder this command acts on.",
        options: workspaces.map((workspace) => ({
          label: workspace.description
            ? `${workspace.name} — ${workspace.description}`
            : workspace.name,
          value: workspace.name,
        })),
      });
      selected = workspaces.find((workspace) => workspace.name === name);
    }

    if (!selected) {
      return reportError(
        Object.assign(new Error("Selected workspace is unavailable."), {
          details: { usage: "dev ls" },
        }),
        args.json,
      );
    }

    await ws.recordUse({ root: config.root, workspaceName: selected.name });

    ui.result({
      data: selected,
      json: args.json,
      text: () => selected.path,
    });
    return 0;
  },
});

export const wsJumpCommand = defineCommand({
  meta: {
    name: "jump",
    description: "Print jump target path for shell cd integration",
  },
  args: {
    workspace: { type: "positional", description: "Optional workspace name", required: false },
    ws: {
      type: "string",
      description:
        "Target workspace name; when the positional is also given, both must name the same workspace",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: resolveDualInput(args.workspace, args.ws, {
        command: "ws jump",
        usage: "dev ws jump [workspace] [--ws <name>]",
        positionalName: "workspace",
        flagName: "--ws",
      }),
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws jump",
      usage: "dev ws jump [workspace] [--ws <name>]",
    });

    try {
      const target = await resolveJumpTarget({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
      });
      await ws.recordUse({ root: config.root, workspaceName: target.name });

      ui.result({
        data: target,
        json: args.json,
        text: () => target.path,
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsPickCommand = defineCommand({
  meta: {
    name: "pick",
    description: "Interactive picker for workspace mounts",
  },
  args: {
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const wsName = args.ws || ws.detectWorkspaceFromCwd(ambient.cwd, config.root);

    try {
      if (canPrompt(ambient)) {
        const workspace = await resolveWorkspaceInput({
          value: wsName,
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          command: "ws pick",
          usage: "dev ws pick [--ws <name>]",
        });
        const mount = await resolveWorkspaceMountInput({
          workspace: workspace.value,
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          command: "ws pick",
          usage: "dev ws pick [--ws <name>]",
        });
        ui.log(join(ws.deriveWorkspacePath(config.root, workspace.value), mount.value));
        return 0;
      }

      if (wsName) {
        const wsPath = ws.deriveWorkspacePath(config.root, wsName);
        const manifestPath = join(wsPath, "ws.md");
        if (!fs.exists(manifestPath)) {
          throw new ws.WorkspaceError(
            "MANIFEST_NOT_FOUND",
            `Manifest not found at ${manifestPath}`,
          );
        }
        const { manifest: m } = await manifest.readWorkspace(manifestPath);
        const mounts = m.mounts.map((mount) => ({
          path: mount.path,
          source: mount.source,
          revision: mount.revision,
        }));

        ui.result({
          data: { workspace: wsName, mounts },
          json: args.json,
          text: () => {
            if (mounts.length === 0)
              return ui.empty({
                message: `Workspace '${wsName}' has no repository mounts yet.`,
                next: [
                  {
                    command: `dev ws add <repository-url> --ws ${wsName}`,
                    why: "add a repository for this task",
                  },
                ],
              });
            let out = `Mounts in workspace '${wsName}':\n`;
            for (const mount of mounts) {
              const rev =
                mount.revision.mode === "track"
                  ? mount.revision.branch
                  : mount.revision.mode === "lock"
                    ? mount.revision.commit.slice(0, 8)
                    : mount.revision.tag;
              out += `  - ${mount.path} (${mount.revision.mode}: ${rev}) -> ${mount.source}\n`;
            }
            return out.trimEnd();
          },
        });
        return 0;
      }

      const items = await ws.list({ root: config.root, workspacePrefix: config.workspacePrefix });
      ui.result({
        data: items,
        json: args.json,
        text: () => {
          if (items.length === 0)
            return ui.empty({
              message: config.configPath
                ? "No workspaces created in this root yet."
                : "No dev root yet, so there are no workspaces to show.",
              next: config.configPath
                ? [{ command: "dev ws init <repository-url>", why: "start a workspace for a task" }]
                : [{ command: "dev init", why: "choose where to keep your work" }],
            });
          let out = "Workspaces:\n";
          for (const item of items) {
            const state = item.error
              ? `invalid: ${item.error.message}`
              : `${item.mountCount} mounts`;
            out += `  - ${item.name} (${state}) -> ${item.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsStartCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start or focus OMP in HerdR for a dev workspace",
  },
  args: {
    query: {
      type: "positional",
      description: "Optional workspace name or fuzzy query",
      required: false,
    },
    root: { type: "string", description: "Explicit dev root directory" },
    session: { type: "string", description: "HerdR session to target" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const workspace = await resolveWorkspaceInput({
      value: args.query,
      fuzzyValue: true,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws start",
      usage: "dev ws start [query]",
      ambient,
    });
    const workspacePath = ws.deriveWorkspacePath(
      config.root,
      workspace.value,
      config.workspacePrefix,
    );

    try {
      const interactive = canPrompt(ambient);
      const result = await herdr.startWorkspace(
        {
          workspace: workspace.value,
          path: workspacePath,
          insideHerdr: ambient.env.HERDR_ENV === "1",
          session: args.session,
        },
        interactive
          ? {
              ...herdr.defaultDeps,
              interactions: {
                chooseSession: async (sessions) =>
                  await ui.select({
                    message: "Which HerdR session?",
                    hint: "Choose the terminal session where dev starts or finds your agent.",
                    options: sessions.map((session) => ({
                      label: session.name,
                      value: session.name,
                    })),
                  }),
              },
            }
          : undefined,
      );
      await ws.recordUse({ root: config.root, workspaceName: result.workspace });
      ui.result({
        data: result,
        json: args.json,
        text: () =>
          `${result.reused ? "Focused" : "Started"} OMP '${result.agentName}' for workspace '${result.workspace}' in HerdR${result.session ? ` session '${result.session}'` : ""}.`,
      });
      // Outside HerdR, hand this terminal to its client; dev returns when it closes.
      if (interactive && !args.json && ambient.env.HERDR_ENV !== "1") {
        ui.info("↳ Opening HerdR in this terminal…");
        await herdr.openClient(result.session);
      }
      return 0;
    } catch (error) {
      return reportWorkspaceError(error, config, args.json);
    }
  },
});

export const wsCommand = defineCommand({
  meta: {
    name: "ws",
    description: "Manage task-oriented multi-repo workspaces",
  },
  args: wsStatusCommand.args,
  subCommands: {
    init: wsInitCommand,
    create: wsInitCommand,
    add: wsAddCommand,
    status: wsStatusCommand,
    update: wsUpdateCommand,
    sync: wsUpdateCommand,
    track: wsTrackCommand,
    lock: wsLockCommand,
    unlock: wsUnlockCommand,
    tag: wsTagCommand,
    remove: wsRemoveCommand,
    rm: wsRemoveCommand,
    list: wsListCommand,
    ls: wsListCommand,
    duplicate: wsDuplicateCommand,
    path: wsPathCommand,
    jump: wsJumpCommand,
    pick: wsPickCommand,
    start: wsStartCommand,
  },
  async run({ args, rawArgs }) {
    if (await hasExplicitSubcommand(wsCommand, rawArgs)) return;

    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const wsName = args.ws || ws.detectWorkspaceFromCwd(ambient.cwd, config.root);
    return wsName
      ? await runNestedCommand(wsStatusCommand, [...rawArgs, "--ws", wsName])
      : await runNestedCommand(wsListCommand, rawArgs);
  },
});
