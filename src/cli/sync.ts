import { defineCommand } from "citty";
import * as sync from "../sync.ts";
import * as ws from "../ws.ts";
import * as cache from "../cache.ts";
import { createAzureDevOps } from "../ado.ts";
import { resolveAzureDevOpsCredential, resolveExtraHeader } from "../credentials.ts";
import { ui } from "../ui.ts";
import { reportError, reportExitCode } from "./errors.ts";
import { getActiveConfig, getAmbient } from "./context.ts";
import { describeSkipReason, warnHealFailures, workspaceSyncOptions } from "./ws.ts";
import { formatLabelMirrors, formatMirrorSync } from "./mirror.ts";
import type { ProviderConfig } from "../config.ts";
import { resolveChoiceInput, resolveTextInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function providerError(code: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_NOT_FOUND", message: string) {
  return Object.assign(new Error(message), { code });
}

function formatInventoryResults(results: sync.InventorySyncSummary[]): string {
  let out = "";
  for (const result of results) {
    out += `✓ Listed ${result.total} repositories from '${result.tenant}' (${result.added} added, ${result.updated} updated).\n`;
    out += "↳ dev ws init  choose repositories for a task\n";
  }
  return out.trimEnd();
}

function formatDataResult(result: sync.SyncDataResult): string {
  let out = `Data synchronization complete for ${result.tenant}${result.project ? ` / ${result.project}` : ""} (${result.timestamp}):\n`;
  out += `  Repositories:  ${result.inventory.total} (added ${result.inventory.added}, updated ${result.inventory.updated}, removed ${result.inventory.removed})\n`;
  if (result.workItems) {
    out += `  Work Items:    ${result.workItems.total} (added ${result.workItems.added}, updated ${result.workItems.updated})\n`;
  }
  const prTotal = result.pullRequests.reduce((acc, pr) => acc + pr.total, 0);
  const prAdded = result.pullRequests.reduce((acc, pr) => acc + pr.added, 0);
  const prUpdated = result.pullRequests.reduce((acc, pr) => acc + pr.updated, 0);
  out += `  Pull Requests: ${prTotal} across ${result.pullRequests.length} repositories (added ${prAdded}, updated ${prUpdated})\n`;
  if (result.skippedDisabled.length > 0) {
    out += `  ○ ${result.skippedDisabled.length} repositories are disabled in Azure DevOps; their pull requests were skipped\n`;
  }
  if (result.canonicalRepos) {
    out += `  Mirrors:      ${result.canonicalRepos.updated.length} reference copies updated, ${result.canonicalRepos.skipped.length} skipped\n`;
  }
  if (result.errors && result.errors.length > 0) {
    out += "\nWarnings/Errors:\n";
    for (const err of result.errors) out += `  - ${err.message}\n`;
  }
  out += "\n↳ dev pr  see pull requests\n↳ dev wi  see saved work items\n";
  return out.trimEnd();
}

// ---------------------------------------------------------------------------
// sync inventory
// ---------------------------------------------------------------------------

export const syncInventoryCommand = defineCommand({
  meta: {
    name: "inventory",
    description: "Synchronize repository inventory from all configured providers",
  },
  args: {
    provider: { type: "string", description: "Limit sync to a specific provider id" },
    project: { type: "string", description: "Scope ADO inventory sync to a specific project" },
    offline: {
      type: "boolean",
      description: "Read strictly from local cache without network access",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);

    if (args.offline) {
      const cached = await cache.loadAllCachedInventories(config.root);
      ui.result({
        data: { action: "data", mode: "offline", total: cached.length, repositories: cached },
        json: args.json,
        text: () =>
          cached.length > 0
            ? `Offline: ${cached.length} repositories saved locally.\n↳ dev ws init  choose repositories for a task`
            : ui.empty({
                message: !config.configPath
                  ? "No dev root yet, so there are no repositories saved locally."
                  : "No repositories saved locally; --offline does not read providers.",
                next: !config.configPath
                  ? [{ command: "dev init", why: "choose where to keep your work" }]
                  : config.providers.length === 0
                    ? [
                        {
                          command: "dev provider add",
                          why: "connect GitHub or Azure DevOps, or use a repository URL",
                        },
                      ]
                    : [
                        {
                          command: "dev sync inventory",
                          why: "read repositories from your providers",
                        },
                      ],
              }),
      });
      return 0;
    }

    const providers = args.provider
      ? config.providers.filter((p) => p.id === args.provider)
      : config.providers;

    if (providers.length === 0) {
      return reportError(
        args.provider
          ? providerError("PROVIDER_NOT_FOUND", `No provider with id '${args.provider}' found.`)
          : providerError("PROVIDER_NOT_CONFIGURED", "No providers configured."),
        args.json,
      );
    }

    const { results, errors } = await sync.syncProviderInventories(config, providers, args.project);

    ui.result({
      data: { action: "data", results, errors },
      json: args.json,
      text: () => {
        let out = formatInventoryResults(results);
        for (const error of errors) out += `\n  ⚠ ${error.message}`;
        return out.trim();
      },
    });

    // citty drops a nested command's return value, so report the exit code explicitly.
    const failed = errors.length > 0 && results.length === 0;
    if (failed) reportExitCode(1);
    return failed ? 1 : 0;
  },
});

// ---------------------------------------------------------------------------
// sync data
// ---------------------------------------------------------------------------

export const syncDataCommand = defineCommand({
  meta: {
    name: "data",
    description: "Synchronize inventory, work items, and pull requests in one operation",
  },
  args: {
    provider: { type: "string", description: "Limit sync to a specific provider id" },
    project: { type: "string", description: "Filter by Azure DevOps project" },
    repos: { type: "string", description: "Comma-separated list of repos for PR synchronization" },
    canonical: {
      type: "boolean",
      description: "Also synchronize canonical reference repositories",
    },
    offline: { type: "boolean", description: "Read from cache without network access" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);

    if (args.offline) {
      const inventories = await cache.loadAllCachedInventories(config.root);
      const workItems = await cache.loadAllCachedWorkItems(config.root);
      const pullRequests = await cache.loadAllCachedPullRequests(config.root);

      ui.result({
        data: {
          action: "data",
          mode: "offline",
          inventory: { total: inventories.length, repos: inventories },
          workItems: { total: workItems.length, items: workItems },
          pullRequests: { total: pullRequests.length, items: pullRequests },
        },
        json: args.json,
        text: () => {
          if (inventories.length + workItems.length + pullRequests.length === 0)
            return ui.empty({
              message: !config.configPath
                ? "No dev root yet, so there is no saved provider data."
                : "No provider data saved locally; --offline does not read providers.",
              next: !config.configPath
                ? [{ command: "dev init", why: "choose where to keep your work" }]
                : config.providers.length === 0
                  ? [{ command: "dev provider add", why: "connect GitHub or Azure DevOps" }]
                  : [{ command: "dev sync", why: "read current data from your providers" }],
            });
          let out = "Saved provider data (--offline, not refreshed):\n";
          out += `  ${inventories.length} repositories\n`;
          out += `  ${workItems.length} work items\n`;
          out += `  ${pullRequests.length} pull requests\n`;
          out +=
            config.providers.length > 0
              ? "↳ dev sync  read current data from your providers"
              : "↳ dev provider add  connect a provider to refresh this data";
          return out;
        },
      });
      return 0;
    }

    // Find first ADO provider for sync data (which requires project scope)
    const adoProviders = config.providers.filter(
      (p): p is Extract<ProviderConfig, { type: "azure_devops" }> =>
        p.type === "azure_devops" && (!args.provider || p.id === args.provider),
    );

    if (adoProviders.length === 0) {
      return reportError(
        args.provider
          ? providerError(
              "PROVIDER_NOT_FOUND",
              `No Azure DevOps provider with id '${args.provider}' found.`,
            )
          : providerError("PROVIDER_NOT_CONFIGURED", "No Azure DevOps providers configured."),
        args.json,
      );
    }

    const providerChoice = await resolveChoiceInput({
      value: args.provider,
      choices: async () =>
        adoProviders.map((provider) => ({
          label: `${provider.id} (${provider.organization}${provider.project ? ` / ${provider.project}` : ""})`,
          value: provider.id,
        })),
      message: "Select Azure DevOps provider",
      hint: "Read projects and work items through this connection.",
      required: {
        command: "sync data",
        field: "provider",
        usage: "dev sync data --provider <id> [--project <name>]",
        description: "Azure DevOps provider",
      },
    });
    const provider = adoProviders.find((candidate) => candidate.id === providerChoice.value);
    if (!provider) {
      return reportError(
        providerError(
          "PROVIDER_NOT_FOUND",
          `No Azure DevOps provider with id '${providerChoice.value}' found.`,
        ),
        args.json,
      );
    }
    const tenant = sync.adoTenantFromOrg(provider.organization);

    const cachedProjects = [
      ...new Set(
        (await cache.loadAllCachedInventories(config.root))
          .map((record) => record.project)
          .filter((project): project is string => Boolean(project)),
      ),
    ];
    let project: string;
    if (args.project || provider.project) {
      project = (
        await resolveTextInput({
          value: args.project,
          defaultValue: provider.project,
          message: "Azure DevOps project",
          hint: "Read work items from this project using your az session.",
          required: {
            command: "sync data",
            field: "project",
            usage: "dev sync data --provider <id> --project <name>",
            description: "Azure DevOps project",
          },
        })
      ).value;
    } else if (cachedProjects.length > 0) {
      project = (
        await resolveChoiceInput({
          choices: async () => cachedProjects.map((value) => ({ label: value, value })),
          message: "Select Azure DevOps project",
          hint: "Read work items from this project, not the whole organization.",
          required: {
            command: "sync data",
            field: "project",
            usage: "dev sync data --provider <id> --project <name>",
            description: "Azure DevOps project",
          },
        })
      ).value;
    } else {
      project = (
        await resolveTextInput({
          message: "Azure DevOps project",
          hint: "Read work items from this project using your az session.",
          required: {
            command: "sync data",
            field: "project",
            usage: "dev sync data --provider <id> --project <name>",
            description: "Azure DevOps project",
          },
        })
      ).value;
    }
    const repos = args.repos
      ? args.repos
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    let cred;
    try {
      cred = await resolveAzureDevOpsCredential(config);
    } catch (err) {
      return reportError(err, args.json);
    }

    const client = createAzureDevOps({ organization: provider.organization, token: cred.token });
    const result = await sync.syncData({
      root: config.root,
      tenant,
      client,
      project,
      repos,
      syncCanonical: args.canonical,
    });

    ui.result({
      data: { action: "data", ...result },
      json: args.json,
      text: () => formatDataResult(result),
    });
    return 0;
  },
});

// ---------------------------------------------------------------------------
// sync (root command — workspace-aware alias)
// ---------------------------------------------------------------------------

function formatProviderSync(result: {
  inventory: sync.InventorySyncSummary[];
  data: sync.SyncDataResult[];
  errors: sync.ProviderSyncFailure[];
}): string {
  const parts = [formatInventoryResults(result.inventory), ...result.data.map(formatDataResult)];
  let out = parts.filter(Boolean).join("\n");
  for (const error of result.errors) out += `\n  ⚠ ${error.message}`;
  return out.trim();
}

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync the current workspace; outside one, sync provider inventory plus work items and pull requests of each provider's configured project",
  },
  args: {
    all: {
      type: "boolean",
      description:
        "Sync everything, in or out of a workspace: provider data, mirrors, and every workspace. Reads from remotes only and runs no hooks",
    },
    provider: {
      type: "string",
      description: "Limit provider data to one provider id (outside a workspace or with --all)",
    },
    project: {
      type: "string",
      description: "Azure DevOps project for provider data (outside a workspace or with --all)",
    },
    offline: {
      type: "boolean",
      description: "Read the local caches only, without network access",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
    ws: { type: "string", description: "Target workspace name for contextual sync" },
    // Inside a workspace, `dev sync` is the root shortcut for workspace update.
    ...workspaceSyncOptions,
  },
  subCommands: {
    inventory: syncInventoryCommand,
    data: syncDataCommand,
  },
  async run({ args, rawArgs }) {
    if (await hasExplicitSubcommand(syncCommand, rawArgs)) return;

    const config = getActiveConfig(args.root);
    // Options that only a single workspace sync honours.
    const workspaceOnly = (["dry-run", "autostash", "rebase", "consent", "force"] as const).find(
      (flag) => args[flag],
    );
    if (args.all) {
      const conflicting = args.ws ? "ws" : args.offline ? "offline" : workspaceOnly;
      if (conflicting) {
        return reportError(
          new ws.WorkspaceError(
            "CONFLICTING_OPTIONS",
            `--all syncs every workspace from remotes and runs no hook; it does not take --${conflicting}.`,
          ),
          args.json,
        );
      }
      if (args.provider && !config.providers.some((p) => p.id === args.provider)) {
        return reportError(
          providerError("PROVIDER_NOT_FOUND", `No provider with id '${args.provider}' found.`),
          args.json,
        );
      }
      const started = Date.now();
      // Progress is narration: stderr, and silent under --json.
      const progress = (message: string) => {
        if (!args.json) ui.info(`↻ ${message}`);
      };
      const result = await sync.syncRoot(config, {
        provider: args.provider,
        project: args.project,
        onProgress: args.json
          ? undefined
          : (event) => {
              if (event.kind === "workspace") {
                progress(`  ${event.ok ? "✓" : "✗"} ${event.name} (${event.done}/${event.total})`);
              } else if (event.phase === "providers") {
                progress("Provider data…");
              } else if (event.phase === "mirrors") {
                progress("Mirrors…");
              } else if (event.phase === "workspaces") {
                progress(`Workspaces (${event.total})…`);
              }
            },
      });
      const { providers, mirrors, workspaces } = result.phases;
      const { failures } = result;
      warnHealFailures(workspaces.flatMap((item) => (item.ok ? [item.result] : [])));
      const durationMs = Date.now() - started;
      const seconds = (durationMs / 1000).toFixed(1);
      ui.result({
        data: {
          action: "all",
          providers,
          mirrors,
          workspaces,
          failures,
          hooksRun: false,
          durationMs,
        },
        json: args.json,
        text: () => {
          const out: string[] = ["Providers"];
          if (!providers)
            out.push(
              "  ○ No provider connected; repository URLs still work.",
              config.configPath
                ? "  ↳ dev provider add  connect GitHub or Azure DevOps"
                : "  ↳ dev init  choose where to keep your work",
            );
          else if (!providers.ok) out.push(`  ✗ ${providers.error}`);
          else out.push(formatProviderSync(providers.result).replace(/^/gm, "  "));

          out.push("", "Mirrors");
          if (!mirrors.ok) out.push(`  ✗ ${mirrors.error}`);
          else {
            out.push(
              ...[
                ...formatLabelMirrors(mirrors.result.labelMirrors),
                ...formatMirrorSync(mirrors.result),
              ].map((line) => `  ${line}`),
            );
          }

          out.push("", "Workspaces");
          if (workspaces.length === 0)
            out.push(
              "  ○ No workspaces created yet.",
              config.configPath
                ? "  ↳ dev ws init <repository-url>  start a task workspace"
                : "  ↳ dev init  choose where to keep your work",
            );
          for (const item of workspaces) {
            if (!item.ok) {
              out.push(`  ✗ ${item.name}: ${item.error}`);
              continue;
            }
            const { updated, upToDate, skipped } = item.result.summary;
            const counts = [
              updated > 0 ? `${updated} updated` : "",
              upToDate > 0 ? `${upToDate} up to date` : "",
              skipped > 0 ? `${skipped} skipped` : "",
            ].filter(Boolean);
            out.push(
              `  ${skipped > 0 ? "⚠" : updated > 0 ? "✓" : "○"} ${item.name}: ${counts.join(", ") || "no mounts"}`,
            );
            if (item.result.mounts.length === 0)
              out.push(
                `  ↳ dev ws add <repository-url> --ws ${item.name}  add a repository for this task`,
              );
            for (const mount of item.result.mounts) {
              if (mount.action !== "skipped") continue;
              const skip = describeSkipReason(mount.reason, item.name);
              out.push(`    ${mount.path}: ${skip.why}`);
              if (skip.hint) out.push(`    ↳ ${skip.hint}`);
            }
          }

          out.push(
            "",
            `${failures.length > 0 ? "⚠" : "✓"} Done in ${seconds}s. Read from remotes only; nothing was sent, and no hook ran.`,
          );
          return out.join("\n");
        },
      });
      if (failures.length > 0) reportExitCode(1);
      return failures.length > 0 ? 1 : 0;
    }

    const ambient = getAmbient();
    const wsName = args.ws || ws.detectWorkspaceFromCwd(ambient.cwd, config.root);
    if (wsName) {
      if (args.provider !== undefined || args.project !== undefined) {
        return reportError(
          new ws.WorkspaceError(
            "CONFLICTING_OPTIONS",
            "--provider and --project apply to provider data, not a workspace sync. Run 'dev sync data --provider <id> [--project <name>]'.",
            { usage: "dev sync data --provider <id> [--project <name>]" },
          ),
          args.json,
        );
      }
      if (!args.json) ui.info(`Sync action: workspace update (${wsName}).`);
      try {
        const fetching = !args.offline && args.refresh !== false;
        if (fetching && !args.json) ui.info(`↻ Fetching remotes for ${wsName}...`);
        const result = await ws.update({
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          workspaceName: wsName,
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
          data: { action: "workspace", ...result },
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
            return out.trimEnd();
          },
        });
        return 0;
      } catch (error) {
        return reportError(error, args.json);
      }
    }
    // Outside a workspace these would be ignored, and the inventory sync has no
    // dry run: never let a preview start a real sync.
    if (workspaceOnly) {
      return reportError(
        new ws.WorkspaceError(
          "CONFLICTING_OPTIONS",
          `--${workspaceOnly} applies to a workspace sync. Run it inside a workspace, or pass --ws <name>.`,
        ),
        args.json,
      );
    }
    const hasDataProvider = config.providers.some(
      (p) =>
        p.type === "azure_devops" &&
        (!args.provider || p.id === args.provider) &&
        Boolean(args.project ?? p.project),
    );
    if (!hasDataProvider) {
      if (!args.json) ui.info("Sync action: provider inventory.");
      return await runNestedCommand(syncInventoryCommand, rawArgs);
    }
    if (args.offline) {
      if (!args.json) ui.info("Sync action: cached provider data (offline).");
      return await runNestedCommand(syncDataCommand, rawArgs);
    }

    if (!args.json) {
      ui.info(
        "Sync action: provider inventory, plus work items and pull requests of configured projects.",
      );
    }
    const result = await sync.syncProvidersWithData(config, {
      provider: args.provider,
      project: args.project,
    });
    ui.result({
      data: { action: "data", ...result },
      json: args.json,
      text: () => formatProviderSync(result),
    });
    return reportExitCode(
      result.errors.length > 0 && result.inventory.length === 0 && result.data.length === 0 ? 1 : 0,
    );
  },
});
