import { defineCommand } from "citty";
import * as workitem from "../workitem.ts";
import * as cache from "../cache.ts";
import { createAzureDevOps, parseAzureDevOpsRepositoryUrl } from "../ado.ts";
import { resolveAzureDevOpsCredential } from "../credentials.ts";
import { ui } from "../ui.ts";
import { findWorkspaceFlag, getActiveConfig, getAmbient } from "./context.ts";
import type { ProviderConfig } from "../config.ts";
import {
  CliInputError,
  CliInputRequiredError,
  parsePositiveInteger,
  resolveChoiceInput,
} from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";
import { resolveWorkspaceQueryContext } from "./workspace-input.ts";
import { reportError, reportExitCode } from "./errors.ts";

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
    limit: {
      type: "string",
      description: `Positive integer maximum results (default: ${workitem.DEFAULT_WORK_ITEM_LIST_LIMIT})`,
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const requestedLimit =
      args.limit === undefined
        ? undefined
        : parsePositiveInteger(args.limit, "--limit", "dev wi list --limit <count>");
    const { limit } = workitem.resolveWorkItemListOptions({ limit: requestedLimit });
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
            return ui.empty({
              message: !config.configPath
                ? "No dev root yet, so there are no work items to show."
                : configuredProviders.length === 0
                  ? "No Azure DevOps provider connected, so there are no work items to show."
                  : all.length === 0
                    ? "No work items saved locally yet."
                    : "No saved work items match your filters.",
              next: !config.configPath
                ? [{ command: "dev init", why: "choose where to keep your work" }]
                : configuredProviders.length === 0
                  ? [
                      {
                        command: "dev provider add ado --org <name>",
                        why: "connect the organization that holds your work items",
                      },
                    ]
                  : [
                      {
                        command: "dev wi --refresh",
                        why: "read work items from a provider and project",
                      },
                    ],
            });
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
        return reportError(
          Object.assign(
            new Error(
              `Workspace '${workspaceContext.name}' has no matching Azure DevOps projects.`,
            ),
            { details: { usage: `dev ws status --ws ${JSON.stringify(workspaceContext.name)}` } },
          ),
          args.json,
        );
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
        hint: "Read projects and work items through this connection.",
        required: {
          command: "wi list",
          field: "provider",
          usage: "dev wi --refresh [--provider <id>] [--project <name>]",
          description: "Azure DevOps provider",
        },
      });
      const provider = configuredProviders.find((candidate) => candidate.id === providerId.value);
      if (!provider) {
        return reportError(
          Object.assign(new Error(`Unknown provider '${providerId.value}'.`), {
            details: {
              kind: "provider",
              value: providerId.value,
              candidates: configuredProviders.map((provider) => provider.id),
              usage: !config.configPath
                ? "dev init"
                : configuredProviders.length > 0
                  ? "dev provider list"
                  : "dev provider add azure_devops",
            },
          }),
          args.json,
        );
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
            hint: "Read work items from this project, not the whole organization.",
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
          for (const e of errors) out += `  ⚠ ${e}\n`;
        }
        if (shown.length === 0) {
          if (out) ui.log(out.trimEnd());
          return ui.empty({
            message:
              errors.length > 0
                ? "Work items could not be read; see the provider errors above."
                : "No work items match your selection.",
            next: [
              {
                command: errors.length > 0 ? "dev doctor" : "dev wi --refresh",
                why:
                  errors.length > 0
                    ? "check tools and provider access"
                    : "choose a provider and project without these filters",
              },
            ],
          });
        } else {
          out += `Work Items (${shown.length}${filtered.length > limit ? ` of ${filtered.length}` : ""}):\n`;
          for (const item of shown) {
            out += `  #${item.id} [${item.type} / ${item.state}]: ${item.title}${item.assignedTo ? ` (${item.assignedTo})` : ""}\n`;
          }
        }
        return out.trimEnd();
      },
    });
    return reportExitCode(errors.length > 0 && shown.length === 0 ? 1 : 0);
  },
});

export const wiViewCommand = defineCommand({
  meta: {
    name: "view",
    description: "View details for a specific work item",
  },
  args: {
    id: { type: "positional", description: "Work item ID", required: false },
    project: { type: "string", description: "Limit to an Azure DevOps project" },
    provider: { type: "string", description: "Limit to a specific provider id" },
    tenant: {
      type: "string",
      description:
        "Limit to a cache namespace, as shown by `dev wi list --json` (for example dev.azure.com/<org>)",
    },
    offline: {
      type: "boolean",
      description: "Read strictly from local cache with zero network access",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const usage = "dev wi view <id> [--tenant <tenant>] [--project <name>]";
    const explicitId =
      args.id === undefined ? undefined : parsePositiveInteger(args.id, "id", usage);
    const config = getActiveConfig(args.root);
    const adoProviders = config.providers.filter(
      (p): p is Extract<ProviderConfig, { type: "azure_devops" }> => p.type === "azure_devops",
    );
    const sameTenant = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

    let provider: (typeof adoProviders)[number] | undefined;
    if (args.provider) {
      provider = adoProviders.find((p) => p.id === args.provider);
      if (!provider) {
        throw new CliInputError(
          "PROVIDER_NOT_FOUND",
          `No Azure DevOps provider with id '${args.provider}' found.`,
          {
            kind: "provider",
            value: args.provider,
            candidates: adoProviders.map((p) => p.id),
            usage: "dev provider list",
          },
        );
      }
    }
    const requestedTenant = args.tenant ? adoTenant(args.tenant) : undefined;
    const providerTenant = provider ? adoTenant(provider.organization) : undefined;
    if (requestedTenant && providerTenant && !sameTenant(requestedTenant, providerTenant)) {
      throw new CliInputError(
        "CONFLICTING_OPTIONS",
        `Conflicting provider and tenant: '${provider!.id}' belongs to '${providerTenant}', not '${requestedTenant}'.`,
        { usage: "Pass a --provider and --tenant that name the same organization, or only one." },
      );
    }
    const scopeTenant = requestedTenant ?? providerTenant;
    const inScope = (item: cache.WorkItemRecord) =>
      (!scopeTenant || sameTenant(item.tenant, scopeTenant)) &&
      (!args.project || item.project === args.project);

    const cached = (await cache.loadAllCachedWorkItems(config.root)).filter(inScope);
    let id: number;
    let matched: cache.WorkItemRecord | undefined;
    if (explicitId === undefined) {
      const choice = await resolveChoiceInput({
        choices: async () =>
          cached.map((item, index) => ({
            label: `${item.tenant}/${item.project} #${item.id} [${item.type} / ${item.state}]: ${item.title}`,
            value: String(index),
          })),
        message: "Select work item",
        hint: "Choose the work item whose details you want to inspect.",
        required: {
          command: "wi view",
          field: "id",
          usage,
          description: "Work item ID",
        },
      });
      matched = cached[Number(choice.value)];
      if (!matched) {
        throw Object.assign(new Error("Selected work item is unavailable."), {
          details: { usage: "dev wi list" },
        });
      }
      id = matched.id;
    } else {
      id = explicitId;
      const matches = cached.filter((item) => item.id === id);
      if (matches.length > 1) {
        // The same id exists in several organizations or projects: never pick one for the user.
        const tenants = [...new Set(matches.map((item) => item.tenant))];
        const byTenant = tenants.length > 1;
        const choices = byTenant ? tenants : matches.map((item) => item.project);
        throw new CliInputRequiredError({
          command: "wi view",
          field: byTenant ? "tenant" : "project",
          usage: byTenant
            ? `dev wi view ${id} --tenant <tenant>${args.project ? ` --project ${args.project}` : ""}`
            : `dev wi view ${id} --tenant ${tenants[0]} --project <name>`,
          description: byTenant
            ? `Organization for work item #${id}`
            : `Project for work item #${id}`,
          choices,
        });
      }
      matched = matches[0];
    }

    // Live reads follow the explicit provider, else the record's own organization, else the
    // explicit scope. When that still leaves several destinations, ask instead of querying
    // the first configured one.
    const tenant = matched?.tenant ?? scopeTenant;
    const project = args.project || matched?.project;
    let liveProvider: (typeof adoProviders)[number] | undefined;
    if (!args.offline) {
      const candidates = provider
        ? [provider]
        : adoProviders.filter((p) => !tenant || sameTenant(adoTenant(p.organization), tenant));
      const tenants = [...new Set(candidates.map((p) => adoTenant(p.organization).toLowerCase()))];
      if (tenants.length > 1) {
        throw new CliInputRequiredError({
          command: "wi view",
          field: "tenant",
          usage: `dev wi view ${id} --tenant <tenant> [--project <name>]`,
          description: `Organization for work item #${id}`,
          choices: [...new Set(candidates.map((p) => adoTenant(p.organization)))],
        });
      }
      // Providers on one organization differ only by default project.
      if (!project && new Set(candidates.map((p) => p.project ?? "")).size > 1) {
        throw new CliInputRequiredError({
          command: "wi view",
          field: "provider",
          usage: `dev wi view ${id} --provider <id> [--project <name>]`,
          description: `Provider for work item #${id}`,
          choices: candidates.map((p) => p.id),
        });
      }
      liveProvider = candidates[0];
    }

    let client;
    if (liveProvider) {
      try {
        const cred = await resolveAzureDevOpsCredential(config);
        client = createAzureDevOps({ organization: liveProvider.organization, token: cred.token });
      } catch {
        // offline fallback
      }
    }

    const item = client
      ? await workitem.getWorkItem({
          root: config.root,
          id,
          tenant: tenant ?? adoTenant(liveProvider!.organization),
          project: project || liveProvider!.project,
          offline: false,
          client,
        })
      : matched;

    if (!item) {
      return reportError(
        Object.assign(new Error(`Work item #${id} not found.`), {
          details: { usage: !config.configPath ? "dev init" : "dev wi list" },
        }),
        args.json,
      );
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
