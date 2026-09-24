import { defineCommand } from "citty";
import * as sync from "../sync.ts";
import * as ws from "../ws.ts";
import * as cache from "../cache.ts";
import * as github from "../github.ts";
import { createAzureDevOps } from "../ado.ts";
import { syncInventory } from "../inventory.ts";
import { resolveAzureDevOpsCredential, resolveGitHubCredential } from "../credentials.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";
import { getActiveConfig, getAmbient } from "./context.ts";
import { wsUpdateCommand } from "./ws.ts";
import type { ProviderConfig } from "../config.ts";
import { resolveChoiceInput, resolveTextInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adoTenantFromOrg(organization: string): string {
  return organization.includes("/") ? organization : `dev.azure.com/${organization}`;
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
      ui.error(
        args.provider
          ? `No provider with id '${args.provider}' found. Run 'dev provider list' to see configured providers.`
          : "No providers configured. Run 'dev provider add <type>' to register one.",
      );
      return 1;
    }

    const results: Array<{
      providerId: string;
      tenant: string;
      total: number;
      added: number;
      updated: number;
      cachePath: string;
      repositories: cache.InventoryRecord[];
    }> = [];
    const errors: string[] = [];
    const adoCredential = providers.some((provider) => provider.type === "azure_devops")
      ? resolveAzureDevOpsCredential(config)
      : undefined;
    const githubCredential = providers.some((provider) => provider.type === "github")
      ? resolveGitHubCredential(config)
      : undefined;

    const outcomes = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        outcome:
          provider.type === "azure_devops"
            ? await syncAdoProvider(config.root, provider, adoCredential!, args.project)
            : await syncGithubProvider(config.root, provider, githubCredential!),
      })),
    );

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

    ui.result({
      data: { results, errors },
      json: args.json,
      text: () => {
        let out = "";
        for (const result of results) {
          out += `Synchronized repository inventory for '${result.tenant}': ${result.total} repositories (${result.added} added, ${result.updated} updated).\n`;
          out += `  Cache: ${result.cachePath}\n`;
        }
        for (const error of errors) {
          out += `  Warning: ${error}\n`;
        }
        return out.trimEnd();
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
      ui.error("No Azure DevOps providers configured for data sync. Run 'dev provider add ado'.");
      return 1;
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
      ui.error(`No Azure DevOps provider with id '${providerChoice.value}' found.`);
      return 1;
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
      text: () => {
        let out = `Data synchronization complete for ${tenant} (${result.timestamp}):\n`;
        out += `  Repositories:  ${result.inventory.total} (added ${result.inventory.added}, updated ${result.inventory.updated})\n`;
        if (result.workItems) {
          out += `  Work Items:    ${result.workItems.total} (added ${result.workItems.added}, updated ${result.workItems.updated})\n`;
        }
        const prTotal = result.pullRequests.reduce((acc, pr) => acc + pr.total, 0);
        const prAdded = result.pullRequests.reduce((acc, pr) => acc + pr.added, 0);
        const prUpdated = result.pullRequests.reduce((acc, pr) => acc + pr.updated, 0);
        out += `  Pull Requests: ${prTotal} across ${result.pullRequests.length} repositories (added ${prAdded}, updated ${prUpdated})\n`;
        if (result.canonicalRepos) {
          out += `  Canonical:     ${result.canonicalRepos.updated.length} updated, ${result.canonicalRepos.skipped.length} skipped\n`;
        }
        if (result.errors && result.errors.length > 0) {
          out += "\nWarnings/Errors:\n";
          for (const err of result.errors) {
            out += `  - ${err}\n`;
          }
        }
        return out.trimEnd();
      },
    });
    return 0;
  },
});

// ---------------------------------------------------------------------------
// sync (root command — workspace-aware alias)
// ---------------------------------------------------------------------------

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Synchronize workspace or offline cache from remote providers",
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
    ws: { type: "string", description: "Target workspace name for contextual sync" },
  },
  subCommands: {
    inventory: syncInventoryCommand,
    data: syncDataCommand,
  },
  async run({ args, rawArgs }) {
    if (await hasExplicitSubcommand(syncCommand, rawArgs)) return;

    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    const wsName = args.ws || ws.detectWorkspaceFromCwd(ambient.cwd, config.root);
    if (wsName) {
      if (!args.json) ui.info(`Sync action: workspace update (${wsName}).`);
      return await runNestedCommand(wsUpdateCommand, [...rawArgs, "--ws", wsName]);
    }
    if (!args.json) ui.info("Sync action: provider inventory.");
    return await runNestedCommand(syncInventoryCommand, rawArgs);
  },
});
