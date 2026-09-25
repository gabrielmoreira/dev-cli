import { defineCommand } from "citty";
import * as sync from "../sync.ts";
import * as ws from "../ws.ts";
import * as cache from "../cache.ts";
import * as github from "../github.ts";
import { createAzureDevOps } from "../ado.ts";
import { syncInventory } from "../inventory.ts";
import {
  resolveAzureDevOpsCredential,
  resolveExtraHeader,
  resolveGitHubCredential,
} from "../credentials.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";
import { getActiveConfig, getAmbient } from "./context.ts";
import {
  describeSkipReason,
  warnHealFailures,
  workspaceSyncOptions,
  wsUpdateCommand,
} from "./ws.ts";
import * as mirror from "../mirror.ts";
import { formatMirrorSync } from "./mirror.ts";
import type { ProviderConfig } from "../config.ts";
import { resolveChoiceInput, resolveTextInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adoTenantFromOrg(organization: string): string {
  return organization.includes("/") ? organization : `dev.azure.com/${organization}`;
}

function providerError(code: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_NOT_FOUND", message: string) {
  return Object.assign(new Error(message), { code });
}

async function syncAdoProvider(
  root: string,
  provider: Extract<ProviderConfig, { type: "azure_devops" }>,
  credential: ReturnType<typeof resolveAzureDevOpsCredential>,
  project?: string,
): Promise<
  { ok: true; result: Awaited<ReturnType<typeof syncInventory>> } | { ok: false; error: string }
> {
  const tenant = adoTenantFromOrg(provider.organization);
  let cred;
  try {
    cred = await credential;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `[${provider.id}] ${msg}` };
  }
  const client = createAzureDevOps({ organization: provider.organization, token: cred.token });
  const result = await syncInventory({
    root,
    tenant,
    client,
    project: project || provider.project,
  });
  return { ok: true, result };
}

async function syncGithubProvider(
  root: string,
  provider: Extract<ProviderConfig, { type: "github" }>,
  credential: ReturnType<typeof resolveGitHubCredential>,
): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof github.syncGitHubInventory>> }
  | { ok: false; error: string }
> {
  let token: string | undefined;
  try {
    const cred = await credential;
    token = cred.token;
  } catch {
    // proceed without token — public repos still work
  }
  const client = github.createGitHubClient({ token });
  const result = await github.syncGitHubInventory({ root, owner: provider.owner, client });
  return { ok: true, result };
}

type InventorySyncSummary = {
  providerId: string;
  tenant: string;
  total: number;
  added: number;
  updated: number;
  cachePath: string;
  repositories: cache.InventoryRecord[];
};

async function syncProviderInventories(
  config: ReturnType<typeof getActiveConfig>,
  providers: ProviderConfig[],
  project?: string,
): Promise<{ results: InventorySyncSummary[]; errors: string[] }> {
  const adoCredential = providers.some((provider) => provider.type === "azure_devops")
    ? resolveAzureDevOpsCredential(config)
    : undefined;
  const githubCredential = providers.some((provider) => provider.type === "github")
    ? resolveGitHubCredential(config)
    : undefined;

  // One provider failing (a rate limit, a revoked token) is reported; the others still land.
  const outcomes = await Promise.all(
    providers.map(async (provider) => {
      try {
        return {
          provider,
          outcome:
            provider.type === "azure_devops"
              ? await syncAdoProvider(config.root, provider, adoCredential!, project)
              : await syncGithubProvider(config.root, provider, githubCredential!),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { provider, outcome: { ok: false as const, error: `[${provider.id}] ${message}` } };
      }
    }),
  );

  const results: InventorySyncSummary[] = [];
  const errors: string[] = [];
  for (const { provider, outcome } of outcomes) {
    if (outcome.ok) {
      results.push({
        providerId: provider.id,
        tenant: outcome.result.tenant,
        total: outcome.result.total,
        added: outcome.result.added,
        updated: outcome.result.updated,
        cachePath: outcome.result.cachePath,
        repositories: outcome.result.repositories,
      });
    } else {
      errors.push(outcome.error);
    }
  }
  return { results, errors };
}

function formatInventoryResults(results: InventorySyncSummary[]): string {
  let out = "";
  for (const result of results) {
    out += `Synchronized repository inventory for '${result.tenant}': ${result.total} repositories (${result.added} added, ${result.updated} updated).\n`;
    out += `  Cache: ${result.cachePath}\n`;
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
    out += `  Canonical:     ${result.canonicalRepos.updated.length} updated, ${result.canonicalRepos.skipped.length} skipped\n`;
  }
  if (result.errors && result.errors.length > 0) {
    out += "\nWarnings/Errors:\n";
    for (const err of result.errors) out += `  - ${err}\n`;
  }
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
        data: { mode: "offline", total: cached.length, repositories: cached },
        json: args.json,
        text: `Offline mode: ${cached.length} repositories from local cache.`,
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

    const { results, errors } = await syncProviderInventories(config, providers, args.project);

    ui.result({
      data: { results, errors },
      json: args.json,
      text: () => {
        let out = formatInventoryResults(results);
        for (const error of errors) out += `\n  ⚠ ${error}`;
        return out.trim();
      },
    });

    return errors.length > 0 && results.length === 0 ? 1 : 0;
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
          mode: "offline",
          inventory: { total: inventories.length, repos: inventories },
          workItems: { total: workItems.length, items: workItems },
          pullRequests: { total: pullRequests.length, items: pullRequests },
        },
        json: args.json,
        text: () => {
          let out = "Offline Cached Data:\n";
          out += `  Repositories:  ${inventories.length}\n`;
          out += `  Work Items:    ${workItems.length}\n`;
          out += `  Pull Requests: ${pullRequests.length}`;
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
    const tenant = adoTenantFromOrg(provider.organization);

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
      data: result,
      json: args.json,
      text: () => formatDataResult(result),
    });
    return 0;
  },
});

// ---------------------------------------------------------------------------
// sync (root command — workspace-aware alias)
// ---------------------------------------------------------------------------

/**
 * Provider data for a bare `dev sync`: a provider with a project gets inventory,
 * work items, and pull requests; every other provider gets its inventory. Reads only.
 */
async function syncProvidersWithData(
  config: ReturnType<typeof getActiveConfig>,
  filter: { provider?: string; project?: string },
): Promise<{
  inventory: InventorySyncSummary[];
  data: Array<sync.SyncDataResult & { providerId: string }>;
  errors: string[];
}> {
  const providers = config.providers.filter((p) => !filter.provider || p.id === filter.provider);
  const dataProviders = providers.filter(
    (p): p is Extract<ProviderConfig, { type: "azure_devops" }> =>
      p.type === "azure_devops" && Boolean(filter.project ?? p.project),
  );
  const inventoryProviders = providers.filter((p) => !dataProviders.includes(p as never));
  const credential = dataProviders.length > 0 ? resolveAzureDevOpsCredential(config) : undefined;
  const [inventory, data] = await Promise.all([
    syncProviderInventories(config, inventoryProviders, filter.project),
    Promise.all(
      dataProviders.map(async (provider) => {
        try {
          const client = createAzureDevOps({
            organization: provider.organization,
            token: (await credential!).token,
          });
          const result = await sync.syncData({
            root: config.root,
            tenant: adoTenantFromOrg(provider.organization),
            client,
            project: filter.project ?? provider.project,
          });
          return { result: { providerId: provider.id, ...result } };
        } catch (err) {
          return { error: `[${provider.id}] ${err instanceof Error ? err.message : String(err)}` };
        }
      }),
    ),
  ]);
  return {
    inventory: inventory.results,
    data: data.flatMap((item) => item.result ?? []),
    errors: [...inventory.errors, ...data.flatMap((item) => item.error ?? [])],
  };
}

function formatProviderSync(result: {
  inventory: InventorySyncSummary[];
  data: sync.SyncDataResult[];
  errors: string[];
}): string {
  const parts = [formatInventoryResults(result.inventory), ...result.data.map(formatDataResult)];
  let out = parts.filter(Boolean).join("\n");
  for (const error of result.errors) out += `\n  ⚠ ${error}`;
  return out.trim();
}

type SyncAllStep<T> = { ok: true; result: T } | { ok: false; error: string };

async function step<T>(run: () => Promise<T>): Promise<SyncAllStep<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
    provider: { type: "string", description: "Limit provider data to one provider id" },
    project: { type: "string", description: "Azure DevOps project for provider data" },
    offline: {
      type: "boolean",
      description: "Read the local caches only, without network access",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
    ws: { type: "string", description: "Target workspace name for contextual sync" },
    // Inside a workspace, `dev sync` is `dev ws sync`: these reach it unchanged.
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
      return await syncAll(config, {
        provider: args.provider,
        project: args.project,
        json: args.json,
      });
    }

    const ambient = getAmbient();
    const wsName = args.ws || ws.detectWorkspaceFromCwd(ambient.cwd, config.root);
    if (wsName) {
      if (!args.json) ui.info(`Sync action: workspace update (${wsName}).`);
      return await runNestedCommand(wsUpdateCommand, [...rawArgs, "--ws", wsName]);
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
    const result = await syncProvidersWithData(config, {
      provider: args.provider,
      project: args.project,
    });
    ui.result({ data: result, json: args.json, text: () => formatProviderSync(result) });
    return result.errors.length > 0 && result.inventory.length === 0 && result.data.length === 0
      ? 1
      : 0;
  },
});

/** Workspaces synced at once; network still waits for each host's slot. */
const WORKSPACE_CONCURRENCY = 4;

/**
 * Everything that can be brought from remotes, in order: provider data, mirrors, then
 * each workspace. Each step reads or fetches only; nothing is pushed and no hook runs,
 * since a hook is a user command that could send data out. A failing step or
 * workspace is reported and the rest go on.
 */
async function syncAll(
  config: ReturnType<typeof getActiveConfig>,
  options: { provider?: string; project?: string; json?: boolean },
): Promise<number> {
  const started = Date.now();
  // Progress is narration: stderr, and silent under --json.
  const progress = (message: string) => {
    if (!options.json) ui.info(`↻ ${message}`);
  };

  progress("Provider data…");
  const providers =
    config.providers.length > 0
      ? await step(() =>
          syncProvidersWithData(config, { provider: options.provider, project: options.project }),
        )
      : null;

  progress("Mirrors…");
  const mirrors = await step(() =>
    mirror.sync({
      root: config.root,
      canonicalPrefix: config.canonicalPrefix,
      refresh: true,
      resolveExtraHeader: (source) => resolveExtraHeader(config, source),
    }),
  );

  // Workspaces sync side by side: each fetch waits for its host's slot
  // (host-limit.ts), and each workspace writes only its own worktrees.
  const workspaceNames = await ws.list({
    root: config.root,
    workspacePrefix: config.workspacePrefix,
  });
  if (workspaceNames.length > 0) progress(`Workspaces (${workspaceNames.length})…`);
  let finished = 0;
  const workspaces: Array<{ name: string } & SyncAllStep<ws.WorkspaceUpdateResult>> =
    await mirror.mapWithConcurrency(workspaceNames, WORKSPACE_CONCURRENCY, async ({ name }) => {
      const outcome = await step(() =>
        ws.update({
          root: config.root,
          workspacePrefix: config.workspacePrefix,
          workspaceName: name,
          refresh: true,
          resolveExtraHeader: (source) => resolveExtraHeader(config, source),
          skipHooks: true,
        }),
      );
      finished += 1;
      progress(`  ${outcome.ok ? "✓" : "✗"} ${name} (${finished}/${workspaceNames.length})`);
      return { name, ...outcome };
    });
  warnHealFailures(workspaces.flatMap((item) => (item.ok ? [item.result] : [])));

  const failures = [
    ...(providers && !providers.ok ? [`providers: ${providers.error}`] : []),
    ...(providers?.ok ? providers.result.errors.map((error) => `providers: ${error}`) : []),
    ...(!mirrors.ok ? [`mirrors: ${mirrors.error}`] : []),
    ...workspaces.flatMap((item) => (item.ok ? [] : [`workspace ${item.name}: ${item.error}`])),
  ];
  const synced =
    (providers?.ok &&
      (providers.result.inventory.length > 0 || providers.result.data.length > 0)) ||
    mirrors.ok ||
    workspaces.some((item) => item.ok);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  ui.result({
    data: {
      providers,
      mirrors,
      workspaces,
      failures,
      hooksRun: false,
      durationMs: Date.now() - started,
    },
    json: options.json,
    text: () => {
      const out: string[] = ["Providers"];
      if (!providers) out.push("  ○ none configured  ↳ dev provider add <type>");
      else if (!providers.ok) out.push(`  ✗ ${providers.error}`);
      else out.push(formatProviderSync(providers.result).replace(/^/gm, "  "));

      out.push("", "Mirrors");
      if (!mirrors.ok) out.push(`  ✗ ${mirrors.error}`);
      else out.push(...formatMirrorSync(mirrors.result).map((line) => `  ${line}`));

      out.push("", "Workspaces");
      if (workspaces.length === 0) out.push("  ○ none  ↳ dev ws init <name>");
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
  return synced ? 0 : 1;
}
