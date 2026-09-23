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
import { ui } from "../ui.ts";
import { canPrompt, getActiveConfig, getAmbient } from "./context.ts";
import { resolveConfirmation, resolveTextInput } from "./input.ts";
import { resolveRepositoryInputs } from "./repository-input.ts";
import {
  matchesWorkspaceQuery,
  resolveWorkspaceInput,
  resolveWorkspaceMountInput,
  resolveWorkspaceMountScope,
} from "./workspace-input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

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
export const wsInitCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize a new workspace with ws.md and .local/",
  },
  args: {
    name: {
      type: "positional",
      description: "Workspace name, repository URI, or pull request URL",
      required: false,
    },
    desc: { type: "string", description: "Workspace description" },
    root: { type: "string", description: "Explicit dev root directory" },
    workset: { type: "string", description: "Initialize from a configured workset" },
    yes: { type: "boolean", description: "Accept the generated mount plan" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const inventory = canPrompt(ambient) ? await cache.loadAllCachedInventories(config.root) : [];
    let rawName = args.name;
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
    } else if (args.workset) {
      const resolved = await resolveWorksetMounts(config, args.workset);
      if ("error" in resolved) {
        ui.error(`Error: ${resolved.error}`);
        return 1;
      }
      mounts = resolved.mounts;
      suggestedName = args.workset;
      suggestedDescription = resolved.description;
      reviewPlan = canPrompt(ambient);
    } else if (!rawName && canPrompt(ambient)) {
      const choices = [
        { label: "Blank workspace", value: "blank" },
        { label: "Select repositories", value: "repositories" },
        ...(Object.keys(config.worksets).length > 0
          ? [{ label: "Workset", value: "workset" }]
          : []),
      ];
      const mode = await ui.select("How do you want to start?", choices);
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
        const worksetName = await ui.select(
          "Select workset",
          Object.entries(config.worksets).map(([name, workset]) => ({
            label: `${name} (${workset.members.length})${workset.description ? ` — ${workset.description}` : ""}`,
            value: name,
          })),
        );
        const resolved = await resolveWorksetMounts(config, worksetName);
        if ("error" in resolved) {
          ui.error(`Error: ${resolved.error}`);
          return 1;
        }
        mounts = resolved.mounts;
        suggestedName = worksetName;
        suggestedDescription = resolved.description;
        reviewPlan = true;
      }
    }

    const name = await resolveTextInput({
      value: rawName ?? (!canPrompt(ambient) ? suggestedName : undefined),
      message: "Workspace name",
      initial: suggestedName,
      required: {
        command: "ws init",
        field: "name",
        usage: "dev ws init <name|repository-uri|pull-request-url> [--workset <name>]",
        description: "Workspace name",
      },
      ambient,
    });
    const description =
      args.desc ??
      (canPrompt(ambient)
        ? (await ui.text("Workspace description (optional)", suggestedDescription))?.trim()
        : suggestedDescription);

    if (reviewPlan && mounts.length > 0) {
      const reviewed = await reviewMountPlan(config, mounts, args.yes);
      if (!reviewed) return 0;
      mounts = reviewed;
    }
    try {
      validateMountPlan(mounts);
    } catch (error) {
      ui.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    let initializedPath: string | undefined;
    try {
      const result = await ws.init({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        name: name.value,
        description: description || undefined,
      });
      initializedPath = result.path;
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
          let out = `Initialized workspace '${result.name}' at:\n`;
          out += `  Directory: ${result.path}\n`;
          out += `  Manifest:  ${result.manifestPath}`;
          for (const mount of mounted) out += `\n  Mounted:   ${mount.mountName}`;
          return out;
        },
      });
      return 0;
    } catch (error) {
      if (initializedPath && mounts.length > 0) await fs.removeDir(initializedPath);
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
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
      mount.branch ?? "(remote default)",
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
): Promise<{ mounts: PlannedMount[]; description?: string } | { error: string }> {
  const workset = config.worksets[name];
  if (!workset) return { error: `Unknown workset '${name}'.` };
  const mounts: PlannedMount[] = [];
  for (const member of workset.members) {
    const resolved = await resolveInputSource(config.root, member.source);
    if (!resolved.sourceUrl) {
      return { error: resolved.error ?? `Could not resolve workset source '${member.source}'.` };
    }
    mounts.push({
      source: resolved.sourceUrl,
      branch: member.ref,
      path: member.path ?? git.deriveDefaultMountPath(resolved.sourceUrl),
      reason: member.reason,
    });
  }
  return { mounts, description: workset.description };
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
  const selected = await ui.multiSelect("Select repositories to customize", [
    { label: "Continue with defaults", value: "defaults" },
    ...mounts.map((mount, index) => ({
      label: `${git.deriveDefaultMountPath(mount.source)} (${mount.branch ?? "remote default"} → ${mount.path})`,
      value: String(index),
    })),
  ]);
  for (const value of selected.filter((candidate) => candidate !== "defaults")) {
    const mount = mounts[Number(value)];
    if (!mount) continue;
    const extraHeader = await resolveExtraHeader(config, mount.source);
    const remote = await git.listRemoteBranches({ source: mount.source, extraHeader });
    if (remote.branches.length > 0) {
      mount.branch = await ui.select(
        `Branch for ${git.deriveDefaultMountPath(mount.source)}`,
        remote.branches.map((branch) => ({
          label: branch === remote.defaultBranch ? `${branch} (default)` : branch,
          value: branch,
        })),
      );
    }
    mount.path =
      (await ui.text(
        `Workspace path for ${git.deriveDefaultMountPath(mount.source)}`,
        mount.path,
      )) ?? mount.path;
  }
  validateMountPlan(mounts);
  ui.log(renderMountPlan("Workspace plan", mounts));
  if (!confirmed && !(await ui.confirm("Create this workspace?", true))) return undefined;
  return mounts;
}

export const wsAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Mount a repository into the workspace",
  },
  args: {
    source: {
      type: "positional",
      description: "Repository URL, path, or inventory name",
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
      !args.source && canPrompt(ambient) ? await cache.loadAllCachedInventories(config.root) : [];
    const repositoryInput = await resolveRepositoryInputs({
      value: args.source,
      root: config.root,
      message: "Select repositories",
      required: {
        command: "ws add",
        field: "source",
        usage: "dev ws add <url|path|name>",
        description: "Repository source",
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
      !args.source &&
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
      ui.error(
        "Error: --path, --branch, --tag, --commit, and mount hooks require a single repository.",
      );
      return 1;
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

        const selected = await ui.multiSelect("Select mounts to customize", [
          { label: "Continue with defaults", value: "defaults" },
          ...plannedMounts.map((mount, index) => ({
            label: `${git.deriveDefaultMountPath(mount.source)} (${mount.branch ?? "remote default"} → ${mount.path})`,
            value: String(index),
          })),
        ]);
        const customizedMounts = selected
          .filter((value) => value !== "defaults")
          .map((value) => plannedMounts[Number(value)])
          .filter((mount): mount is PlannedMount => Boolean(mount));

        for (const mount of customizedMounts) {
          const extraHeader = await resolveExtraHeader(config, mount.source);
          resolvedHeaders.set(mount.source, extraHeader);
          const remote = await git.listRemoteBranches({ source: mount.source, extraHeader });
          if (remote.branches.length > 0) {
            mount.branch = await ui.select(
              `Branch for ${git.deriveDefaultMountPath(mount.source)}`,
              remote.branches.map((branch) => ({
                label: branch === remote.defaultBranch ? `${branch} (default)` : branch,
                value: branch,
              })),
            );
          }
          mount.path =
            (await ui.text(
              `Mount path for ${git.deriveDefaultMountPath(mount.source)}`,
              mount.path,
            )) ?? mount.path;

          while (
            await ui.confirm(
              `Add another branch from ${git.deriveDefaultMountPath(mount.source)}?`,
              false,
            )
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
            const branch = await ui.select(
              `Additional branch for ${git.deriveDefaultMountPath(mount.source)}`,
              availableBranches.map((candidate) => ({ label: candidate, value: candidate })),
            );
            const suggestedPath = duplicateMountPath(
              git.deriveDefaultMountPath(mount.source),
              branch,
            );
            const path =
              (await ui.text(
                `Mount path for ${git.deriveDefaultMountPath(mount.source)} (${branch})`,
                suggestedPath,
              )) ?? suggestedPath;
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
        if (!(await ui.confirm("Create these mounts?", true))) return 0;
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
              let out = `Mounted repository '${result.mountName}' in workspace '${result.workspaceName}':\n`;
              out += `  Mount Path: ${result.mountPath}\n`;
              out += `  Source:     ${result.source}\n`;
              out += `  Revision:   ${result.revision.mode} (${result.commitSha.slice(0, 8)})`;
              if (result.hookWarning) out += `\n  Warning:    ${result.hookWarning}`;
              return out;
            })
            .join("\n"),
      });
      for (const result of results) {
        if (result.hookWarning) ui.warn(`  Warning:    ${result.hookWarning}`);
      }
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  },
});

export const wsStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Inspect Desired vs Observed workspace status",
  },
  args: {
    target: { type: "positional", description: "Workspace name", required: false },
    ws: { type: "string", description: "Target workspace name" },
    refresh: { type: "boolean", description: "Fetch latest remote refs before comparing" },
    offline: { type: "boolean", description: "Read strictly from local mirror without network" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.ws || args.target,
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

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = `Workspace: ${result.workspaceName}\n`;
          out += `Path:      ${result.workspacePath}\n`;
          out += `Status:    ${result.isClean ? "clean" : "diverged / changes detected"}\n\n`;
          if (result.mounts.length === 0) {
            out += "  No mounts declared in workspace.";
          } else {
            out += "Mounts:\n";
            for (const mount of result.mounts) {
              const sym = mount.state === "clean" ? "✔" : mount.state === "dirty" ? "●" : "✖";
              out += `  ${sym} ${mount.path} [${mount.state}]\n`;
              out += `      Source:   ${mount.source}\n`;
              if (mount.desired.revision.mode === "track") {
                out += `      Desired:  branch ${mount.desired.revision.branch}\n`;
              } else if (mount.desired.revision.mode === "lock") {
                out += `      Desired:  commit ${mount.desired.revision.commit}\n`;
              }
              if (mount.observed.exists && mount.observed.isGitWorktree) {
                out += `      Observed: branch=${mount.observed.currentRevision.branch || "detached"} commit=${mount.observed.currentRevision.commitSha?.slice(0, 8)}\n`;
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
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  },
});

export const wsUpdateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Safely fast-forward clean workspace mounts",
  },
  args: {
    target: { type: "positional", description: "Workspace name or target mount", required: false },
    ws: { type: "string", description: "Target workspace name" },
    refresh: { type: "boolean", description: "Fetch latest remote refs before fast-forwarding" },
    offline: { type: "boolean", description: "Read strictly from local mirror without network" },
    autostash: {
      type: "boolean",
      description: "Stash uncommitted changes, fast-forward, then pop the stash",
    },
    rebase: {
      type: "boolean",
      description: "Rebase diverged mounts onto the remote branch (aborts on conflict)",
    },
    consent: { type: "boolean", description: "Grant explicit consent to run lifecycle hooks" },
    force: { type: "boolean", description: "Alias for --consent" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.ws || args.target,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws update",
      usage: "dev ws update [workspace] [--ws <name>]",
    });

    try {
      const result = await ws.update({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        refresh: args.refresh,
        offline: args.offline,
        autostash: args.autostash,
        rebase: args.rebase,
        resolveExtraHeader: (source) => resolveExtraHeader(config, source),
        trustedScopes: config.trustedScopes,
        explicitConsent: args.consent || args.force,
        globalHooks: config.hooks,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = `Workspace: ${result.workspaceName}\n`;
          out += `Path:      ${result.workspacePath}\n`;
          out += `Summary:   ${result.summary.updated} updated, ${result.summary.upToDate} up to date, ${result.summary.skipped} skipped (${result.summary.total} total)\n`;
          if (result.hookWarning) {
            out += `Warning:   ${result.hookWarning}\n`;
          }
          out += "\n";
          for (const mount of result.mounts) {
            if (mount.action === "fast_forward") {
              out += `  ✔ ${mount.path}: fast-forwarded (${mount.previousCommit?.slice(0, 8)} -> ${mount.newCommit?.slice(0, 8)})\n`;
            } else if (mount.action === "rebase") {
              out += `  ✔ ${mount.path}: rebased onto remote (${mount.previousCommit?.slice(0, 8)} -> ${mount.newCommit?.slice(0, 8)})\n`;
            } else if (mount.action === "up_to_date") {
              out += `  ✔ ${mount.path}: up to date (${mount.newCommit?.slice(0, 8)})\n`;
            } else {
              out += `  ⚠ ${mount.path}: skipped [${mount.reason}]\n`;
            }
            if (mount.warning) {
              out += `    warning: ${mount.warning}\n`;
            }
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
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
    branch: { type: "positional", description: "Branch to track", required: false },
    branchFlag: { type: "string", description: "Branch to track" },
    ws: { type: "string", description: "Target workspace name" },
    manifestOnly: { type: "boolean", description: "Update ws.md without changing disk worktree" },
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
      usage: "dev ws track [mount] [branch] [--ws <name>]",
    });
    const mount = await resolveWorkspaceMountInput({
      value: args.mount,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws track",
      usage: "dev ws track [mount] [branch] [--ws <name>]",
    });
    const branch = await resolveTextInput({
      value: args.branch || args.branchFlag,
      message: "Branch to track",
      required: {
        command: "ws track",
        field: "branch",
        usage: "dev ws track [mount] [branch] [--ws <name>]",
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
        manifestOnly: args.manifestOnly,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = `Mount '${result.path}' is now tracking branch '${result.branch}'.`;
          if (result.worktreeSwitched) {
            out += `\nSwitched worktree to branch '${result.branch}'.`;
          }
          return out;
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = "";
          for (const m of result.lockedMounts) {
            out += `Mount '${m.path}' locked to commit ${m.commit.slice(0, 8)}.\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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
    branch: { type: "positional", description: "Branch to track", required: false },
    branchFlag: { type: "string", description: "Branch to track" },
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const branch = args.branch || args.branchFlag;

    const workspace = await resolveWorkspaceInput({
      value: args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws unlock",
      usage: "dev ws unlock [mount] [branch] [--all] [--ws <name>]",
    });
    const mountPath = await resolveWorkspaceMountScope({
      value: args.mount,
      all: args.all,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws unlock",
      usage: "dev ws unlock [mount] [branch] [--all] [--ws <name>]",
    });

    try {
      const result = await ws.unlock({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName: workspace.value,
        mountPath,
        branch,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = "";
          for (const m of result.unlockedMounts) {
            out += `Mount '${m.path}' unlocked to track branch '${m.branch}'.\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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
    tag: { type: "positional", description: "Tag to pin to", required: false },
    tagFlag: { type: "string", description: "Tag to pin to" },
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
      usage: "dev ws tag [mount] [tag] [--ws <name>]",
    });
    const mount = await resolveWorkspaceMountInput({
      value: args.mount,
      workspace: workspace.value,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws tag",
      usage: "dev ws tag [mount] [tag] [--ws <name>]",
    });
    const tag = await resolveTextInput({
      value: args.tag || args.tagFlag,
      message: "Tag to pin",
      required: {
        command: "ws tag",
        field: "tag",
        usage: "dev ws tag [mount] [tag] [--ws <name>]",
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

      ui.result({
        data: result,
        json: args.json,
        text: () => `Mount '${result.path}' pinned to tag '${result.tag}'.`,
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
    }
  },
});

export const wsUpCommand = defineCommand({
  meta: {
    name: "up",
    description: "Materialize and reconcile mounts declared in ws.md",
  },
  args: {
    target: { type: "positional", description: "Workspace name or path to ws.md", required: false },
    ws: { type: "string", description: "Target workspace name" },
    consent: { type: "boolean", description: "Grant explicit consent to run repository hooks" },
    force: { type: "boolean", description: "Alias for --consent" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const target = args.target;

    let manifestPath: string | undefined;
    let workspaceName: string | undefined;

    if (target?.endsWith(".md")) {
      manifestPath = target;
    } else {
      workspaceName = (
        await resolveWorkspaceInput({
          value: args.ws || target,
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          command: "ws up",
          usage: "dev ws up [name | path/to/ws.md]",
        })
      ).value;
    }

    try {
      const result = await ws.up({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName,
        manifestPath,
        resolveExtraHeader: (source) => resolveExtraHeader(config, source),
        trustedScopes: config.trustedScopes,
        explicitConsent: args.consent || args.force,
        globalHooks: config.hooks,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          let out = `Reconciled workspace '${result.workspaceName}':\n`;
          for (const m of result.reconciled) {
            out += `  ${m.action === "created" ? "✔ created" : "✔ exists"}: ${m.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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
    force: { type: "boolean", description: "Force removal of dirty worktree" },
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
      confirmed: args.force,
      message: `Remove mount '${mount.value}' from workspace '${workspace.value}'?`,
      required: {
        command: "ws remove",
        field: "confirmation",
        usage: "dev ws remove [mount] [--ws <name>] --force",
        description: "Explicit confirmation (--force)",
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

      ui.result({
        data: result,
        json: args.json,
        text: () => `Removed mount '${result.path}' from workspace '${workspace.value}'.`,
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
    }
  },
});

export const wsListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all workspaces in $DEV_ROOT/ws/",
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
            return "No workspaces found.";
          }
          let out = `Workspaces in ${config.root}:\n`;
          for (const item of items) {
            const desc = item.description ? ` - ${item.description}` : "";
            out += `  ${item.name} (${item.mountCount} mounts)${desc}\n`;
            out += `    path: ${item.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
    }
  },
});

export const wsDuplicateCommand = defineCommand({
  meta: {
    name: "duplicate",
    description: "Duplicate a workspace with independent worktrees",
  },
  args: {
    source: { type: "positional", description: "Source workspace name", required: false },
    target: { type: "positional", description: "Target workspace name", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const source = await resolveWorkspaceInput({
      value: args.source,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws duplicate",
      usage: "dev ws duplicate <source> <target>",
    });
    const target = await resolveTextInput({
      value: args.target,
      message: "New workspace name",
      required: {
        command: "ws duplicate",
        field: "target",
        usage: "dev ws duplicate <source> <target>",
        description: "Target workspace name",
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
          let out = `Duplicated workspace '${result.sourceName}' to '${result.targetName}' (${result.mountsCount} mounts).\n`;
          out += `  Path: ${result.path}`;
          return out;
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
    }
  },
});

export const wsPathCommand = defineCommand({
  meta: {
    name: "path",
    description: "Print absolute path of target or current workspace",
  },
  args: {
    name: { type: "positional", description: "Optional workspace name", required: false },
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.name || args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws path",
      usage: "dev ws path [name] [--ws <name>]",
    });

    try {
      const resolvedPath = ws.deriveWorkspacePath(config.root, workspace.value);

      ui.result({
        data: { path: resolvedPath },
        json: args.json,
        text: () => resolvedPath,
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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
    candidates: {
      type: "boolean",
      description: "Print matching workspace candidates for shell integration",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const query = args.query?.trim() ?? "";
    const workspaces = (
      await ws.list({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
      })
    )
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
      ui.error(query ? `Error: No workspace matches '${query}'.` : "Error: No workspaces found.");
      return 1;
    }

    if (args.candidates) {
      ui.log(workspaces.map((workspace) => workspace.path).join("\n"));
      return 0;
    }

    const exact = query
      ? workspaces.find((workspace) => workspace.name.toLowerCase() === query.toLowerCase())
      : undefined;
    let selected = exact ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    if (!selected) {
      if (!canPrompt(getAmbient())) {
        ui.error("Error: Multiple workspaces match. Run 'dev go' from an interactive shell.");
        return 1;
      }
      const name = await ui.select(
        "Select workspace",
        workspaces.map((workspace) => ({
          label: workspace.description
            ? `${workspace.name} — ${workspace.description}`
            : workspace.name,
          value: workspace.name,
        })),
      );
      selected = workspaces.find((workspace) => workspace.name === name);
    }

    if (!selected) {
      ui.error("Error: Selected workspace is unavailable.");
      return 1;
    }

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
    name: { type: "positional", description: "Optional workspace name", required: false },
    ws: { type: "string", description: "Target workspace name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspace = await resolveWorkspaceInput({
      value: args.name || args.ws,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws jump",
      usage: "dev ws jump [name] [--ws <name>]",
    });

    try {
      const target = resolveJumpTarget({
        root: config.root,
        workspaceName: workspace.value,
      });

      ui.result({
        data: target,
        json: args.json,
        text: () => target.path,
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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
          let out = "Workspaces:\n";
          for (const item of items) {
            out += `  - ${item.name} (${item.mountCount} mounts) -> ${item.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof ws.WorkspaceError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
    }
  },
});

export const wsStartCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start or focus OMP in HerdR for a dev workspace",
  },
  args: {
    name: {
      type: "positional",
      description: "Optional workspace name or fuzzy query",
      required: false,
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const workspace = await resolveWorkspaceInput({
      value: args.name,
      fuzzyValue: true,
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      command: "ws start",
      usage: "dev ws start [name]",
      ambient,
    });
    const workspacePath = ws.deriveWorkspacePath(
      config.root,
      workspace.value,
      config.workspacePrefix,
    );

    try {
      const result = await herdr.startWorkspace({
        workspace: workspace.value,
        path: workspacePath,
        insideHerdr: ambient.env.HERDR_ENV === "1",
        openClient:
          ambient.env.HERDR_ENV !== "1" && ambient.isTTY && ambient.stdinIsTTY && !args.json,
      });
      ui.result({
        data: result,
        json: args.json,
        text: () =>
          `${result.reused ? "Focused" : "Started"} OMP '${result.agentName}' for workspace '${result.workspace}' in HerdR.`,
      });
      return 0;
    } catch (error) {
      ui.error(
        error instanceof herdr.HerdrError
          ? `Error [${error.code}]: ${error.message}`
          : `Error: ${error}`,
      );
      return 1;
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
    up: wsUpCommand,
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
