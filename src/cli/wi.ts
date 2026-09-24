import { defineCommand } from "citty";
import * as workitem from "../workitem.ts";
import * as cache from "../cache.ts";
import { createAzureDevOps, parseAzureDevOpsRepositoryUrl } from "../ado.ts";
import { resolveAzureDevOpsCredential } from "../credentials.ts";
import { ui } from "../ui.ts";
import { findWorkspaceFlag, getActiveConfig, getAmbient } from "./context.ts";
import type { ProviderConfig } from "../config.ts";
import { resolveChoiceInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";
import { resolveWorkspaceQueryContext } from "./workspace-input.ts";
import { reportError } from "./errors.ts";

function adoTenant(org: string): string {
  return org.includes("/") ? org : `dev.azure.com/${org}`;
}

export const wiListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List work items across all configured ADO providers (cached or live)",
  },
  args: {
    project: { type: "string", description: "Filter by Azure DevOps project" },
    status: { type: "string", description: "Filter by state" },
    provider: { type: "string", description: "Limit to a specific provider id" },
    ws: { type: "string", description: "Use projects from a workspace" },
    offline: {
      type: "boolean",
      description: "Read strictly from local cache with zero network access",
    },
    refresh: { type: "boolean", description: "Force fresh synchronization from remote provider" },
    limit: { type: "string", description: "Maximum number of results to show (default: 50)" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workspaceContext = await resolveWorkspaceQueryContext({
      value: args.ws || findWorkspaceFlag(getAmbient().argv),
      root: config.root,
      workspacePrefix: config.workspacePrefix,
    });
    const workspaceRepositories = (workspaceContext?.sources ?? []).flatMap((source) => {
      const parsed = parseAzureDevOpsRepositoryUrl(source);
      return parsed ? [parsed] : [];
    });
    const workspaceProjects = new Set(
      workspaceRepositories.map(
        (repository) =>
          `${adoTenant(repository.organization).toLowerCase()}/${repository.project.toLowerCase()}`,
      ),
    );
    const limit = args.limit ? parseInt(args.limit, 10) : 50;
    const shouldRefresh = Boolean(args.refresh || args.project || args.provider);

    const configuredProviders = config.providers.filter(
      (provider): provider is Extract<ProviderConfig, { type: "azure_devops" }> =>
        provider.type === "azure_devops",
    );

    if (configuredProviders.length === 0 || args.offline || !shouldRefresh) {
      // Read all cached work items, deduplicated by tenant+project+id
      const allowedTenants = new Set(
        configuredProviders
          .filter((provider) => !args.provider || provider.id === args.provider)
          .map((provider) => adoTenant(provider.organization)),
      );
      const all = await cache.loadAllCachedWorkItems(config.root);
      const filtered = all.filter(
        (item) =>
          (!args.status || item.state === args.status) &&
          (!args.project || item.project === args.project) &&
          (workspaceProjects.size === 0 ||
            workspaceProjects.has(`${item.tenant.toLowerCase()}/${item.project.toLowerCase()}`)) &&
          (!args.provider || allowedTenants.has(item.tenant)),
      );
      const shown = filtered.slice(0, limit);

      ui.result({
        data: shown,
        json: args.json,
        text: () => {
          if (shown.length === 0) {
            return configuredProviders.length > 0 && !args.offline
              ? "No cached work items found. Run 'dev wi --refresh' to select a provider and project."
              : "No work items found.";
          }
          let out = `Work Items (${shown.length}${filtered.length > limit ? ` of ${filtered.length}` : ""}):\n`;
          for (const item of shown) {
            out += `  #${item.id} [${item.type} / ${item.state}]: ${item.title}${item.assignedTo ? ` (${item.assignedTo})` : ""}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    }

    const allItems: cache.WorkItemRecord[] = [];
    const errors: string[] = [];
    let credential: Awaited<ReturnType<typeof resolveAzureDevOpsCredential>>;
    try {
      credential = await resolveAzureDevOpsCredential(config);
    } catch (error) {
      return reportError(error, args.json);
    }

    const refreshTargets: Array<{
      provider: Extract<ProviderConfig, { type: "azure_devops" }>;
      project: string;
    }> = [];

    if (workspaceContext) {
      const seen = new Set<string>();
      for (const repository of workspaceRepositories) {
        const provider = configuredProviders.find(
          (candidate) =>
            candidate.organization.toLowerCase() === repository.organization.toLowerCase() &&
            (!args.provider || candidate.id === args.provider),
        );
        if (!provider || (args.project && args.project !== repository.project)) continue;
        const key = `${provider.id}/${repository.project}`;
        if (!seen.has(key)) {
          seen.add(key);
          refreshTargets.push({ provider, project: repository.project });
        }
      }
      if (refreshTargets.length === 0) {
        ui.error(
          `Error: Workspace '${workspaceContext.name}' has no matching Azure DevOps projects.`,
        );
        return 1;
      }
    } else {
      const providerId = await resolveChoiceInput({
        value: args.provider,
        choices: async () =>
          configuredProviders.map((provider) => ({
            label: `${provider.id} — ${provider.organization}`,
            value: provider.id,
          })),
        message: "Select Azure DevOps provider",
        required: {
          command: "wi list",
          field: "provider",
          usage: "dev wi --refresh [--provider <id>] [--project <name>]",
          description: "Azure DevOps provider",
        },
      });
      const provider = configuredProviders.find((candidate) => candidate.id === providerId.value);
      if (!provider) {
        ui.error(`Error: Unknown provider '${providerId.value}'.`);
        return 1;
      }
      const tenant = adoTenant(provider.organization);
      const client = createAzureDevOps({
        organization: provider.organization,
        token: credential.token,
      });
      let project = args.project || provider.project;
      if (!project) {
        const inventory = await cache.readInventory({ root: config.root, tenant });
        const cachedProjects = [...new Set(inventory.flatMap((item) => item.project ?? []))];
        const projects =
          cachedProjects.length > 0
            ? cachedProjects
            : (await client.listProjects()).map((item) => item.name);
        project = (
          await resolveChoiceInput({
            choices: async () => projects.map((name) => ({ label: name, value: name })),
            message: "Select Azure DevOps project",
            required: {
              command: "wi list",
              field: "project",
              usage: "dev wi --refresh [--provider <id>] [--project <name>]",
              description: "Azure DevOps project",
            },
          })
        ).value;
      }
      refreshTargets.push({ provider, project });
    }

    const refreshed = await Promise.all(
      refreshTargets.map(async ({ provider, project }) => {
        const tenant = adoTenant(provider.organization);
        try {
          const client = createAzureDevOps({
            organization: provider.organization,
            token: credential.token,
          });
          return await workitem.listWorkItems({
            root: config.root,
            tenant,
            project,
            status: args.status,
            offline: false,
            refresh: true,
            client,
            limit,
          });
        } catch (error) {
          errors.push(
            `[${provider.id}/${project}] ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        }
      }),
    );
    for (const items of refreshed) allItems.push(...items);

    // Deduplicate by tenant+project+id
    const seen = new Set<string>();
    const deduped = allItems.filter((w) => {
      const key = `${w.tenant}/${w.project}/${w.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.sort((a, b) => b.id - a.id);

    const filtered = args.status ? deduped.filter((w) => w.state === args.status) : deduped;
    const shown = filtered.slice(0, limit);

    ui.result({
      data: { items: shown, errors },
      json: args.json,
      text: () => {
        let out = "";
        if (errors.length > 0) {
          for (const e of errors) out += `  Warning: ${e}\n`;
        }
        if (shown.length === 0) {
          out += "No work items found.";
        } else {
          out += `Work Items (${shown.length}${filtered.length > limit ? ` of ${filtered.length}` : ""}):\n`;
          for (const item of shown) {
            out += `  #${item.id} [${item.type} / ${item.state}]: ${item.title}${item.assignedTo ? ` (${item.assignedTo})` : ""}\n`;
          }
        }
        return out.trimEnd();
      },
    });
    return errors.length > 0 && shown.length === 0 ? 1 : 0;
  },
});

export const wiViewCommand = defineCommand({
  meta: {
    name: "view",
    description: "View details for a specific work item",
  },
  args: {
    id: { type: "positional", description: "Work item ID", required: false },
    project: { type: "string", description: "Filter by Azure DevOps project" },
    provider: { type: "string", description: "Limit to a specific provider id" },
    offline: {
      type: "boolean",
      description: "Read strictly from local cache with zero network access",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    let selected: cache.WorkItemRecord | undefined;
    let idStr = args.id;
    if (!idStr) {
      const candidates = (await cache.loadAllCachedWorkItems(config.root)).filter(
        (item) => !args.project || item.project === args.project,
      );
      const choice = await resolveChoiceInput({
        choices: async () =>
          candidates.map((item, index) => ({
            label: `#${item.id} [${item.type} / ${item.state}]: ${item.title}`,
            value: String(index),
          })),
        message: "Select work item",
        required: {
          command: "wi view",
          field: "id",
          usage: "dev wi view <id> [--project <name>]",
          description: "Work item ID",
        },
      });
      selected = candidates[Number(choice.value)];
      idStr = selected ? String(selected.id) : undefined;
    }
    if (!idStr) throw new Error("Selected work item is unavailable.");
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      ui.error(`Error: Invalid work item ID '${idStr}'.`);
      return 1;
    }

    const adoProvider = config.providers.find(
      (p): p is Extract<ProviderConfig, { type: "azure_devops" }> =>
        p.type === "azure_devops" && (!args.provider || p.id === args.provider),
    );

    const tenant =
      selected?.tenant || (adoProvider ? adoTenant(adoProvider.organization) : undefined);

    let client;
    if (!args.offline && adoProvider) {
      try {
        const cred = await resolveAzureDevOpsCredential(config);
        client = createAzureDevOps({ organization: adoProvider.organization, token: cred.token });
      } catch {
        // offline fallback
      }
    }

    const item = await workitem.getWorkItem({
      root: config.root,
      id,
      tenant,
      project: args.project || selected?.project || adoProvider?.project,
      offline: args.offline || !client,
      client,
    });

    if (!item) {
      ui.error(`Error: Work item #${id} not found.`);
      return 1;
    }

    ui.result({
      data: item,
      json: args.json,
      text: () => {
        let out = `Work Item #${item.id}: ${item.title}\n`;
        out += `  Type:        ${item.type}\n`;
        out += `  State:       ${item.state}\n`;
        out += `  Project:     ${item.project}\n`;
        if (item.assignedTo) out += `  Assigned To: ${item.assignedTo}\n`;
        if (item.author) out += `  Author:      ${item.author}\n`;
        if (item.areaPath) out += `  Area:        ${item.areaPath}\n`;
        if (item.iterationPath) out += `  Iteration:   ${item.iterationPath}\n`;
        if (item.url) out += `  URL:         ${item.url}\n`;
        if (item.description) out += `\nDescription:\n  ${item.description}\n`;
        return out.trimEnd();
      },
    });
    return 0;
  },
});

export const wiCommand = defineCommand({
  meta: {
    name: "wi",
    description: "Inspect and cache work items",
  },
  args: wiListCommand.args,
  subCommands: {
    list: wiListCommand,
    ls: wiListCommand,
    view: wiViewCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(wiCommand, rawArgs)) return;
    return await runNestedCommand(wiListCommand, rawArgs);
  },
});
