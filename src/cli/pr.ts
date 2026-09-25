import { defineCommand } from "citty";
import * as pr from "../pr.ts";
import * as cache from "../cache.ts";
import {
  createAzureDevOps,
  parseAzureDevOpsPullRequestUrl,
  parseAzureDevOpsRepositoryUrl,
} from "../ado.ts";
import { resolveAzureDevOpsCredential, resolveExtraHeader } from "../credentials.ts";
import * as labels from "../labels.ts";
import { normalizeSourceKey } from "../git.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";
import * as ws from "../ws.ts";
import * as fs from "../fs.ts";
import { derivePullRequestWorkspaceName } from "../pr-workspace.ts";
import { findWorkspaceFlag, getActiveConfig, getAmbient } from "./context.ts";
import type { ProviderConfig } from "../config.ts";
import { resolveChoiceInput } from "./input.ts";
import { resolveRepositoryInput } from "./repository-input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";
import { resolveWorkspaceQueryContext } from "./workspace-input.ts";

function adoOrgFromProvider(provider: Extract<ProviderConfig, { type: "azure_devops" }>): string {
  return provider.organization;
}

function adoTenant(org: string): string {
  return org.includes("/") ? org : `dev.azure.com/${org}`;
}

const DEFAULT_PR_SELECTION = "mine-open";

export const prListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List open pull requests across all configured providers",
  },
  args: {
    repoPositional: { type: "positional", description: "Target repository name", required: false },
    repo: { type: "string", description: "Target repository name" },
    interactive: {
      type: "boolean",
      alias: "i",
      description: "Select one repository from the local inventory",
    },
    label: { type: "string", description: "Limit to repositories carrying a dev-cli label" },
    mine: {
      type: "boolean",
      description: "Show pull requests I wrote or am asked to review (default)",
    },
    all: { type: "boolean", description: "Show all pull requests instead of only mine" },
    status: {
      type: "string",
      description: "Status to list: open (default), completed, abandoned, or all",
    },
    provider: { type: "string", description: "Limit to a specific provider id" },
    offline: {
      type: "boolean",
      description: "Read the last synchronized pull requests from the local cache, without network",
    },
    project: { type: "string", description: "Filter by Azure DevOps project" },
    ws: { type: "string", description: "Use repositories from a workspace" },
    limit: { type: "string", description: "Show at most this many pull requests (default: all)" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const requestedRepository = args.repoPositional || args.repo;
    const requestedLabel = args.label;
    const workspaceContext = await resolveWorkspaceQueryContext({
      value: args.ws || findWorkspaceFlag(getAmbient().argv),
      root: config.root,
      workspacePrefix: config.workspacePrefix,
    });
    const statusFilter =
      (args.status as "open" | "completed" | "abandoned" | "all" | undefined) ?? "open";
    const limit = args.limit ? parseInt(args.limit, 10) : Infinity;
    const providers = config.providers.filter(
      (provider): provider is Extract<ProviderConfig, { type: "azure_devops" }> =>
        provider.type === "azure_devops" && (!args.provider || provider.id === args.provider),
    );
    const inventory = await cache.loadAllCachedInventories(config.root);

    const isDefaultMineQuery =
      !workspaceContext &&
      !requestedRepository &&
      !args.interactive &&
      !requestedLabel &&
      !args.project &&
      !args.provider &&
      !args.all &&
      statusFilter === "open";
    if (args.mine && args.all) {
      return reportError("--mine and --all cannot be used together.", args.json);
    }
    if (requestedLabel && (requestedRepository || args.interactive)) {
      return reportError(
        "--label cannot be combined with a repository or --interactive.",
        args.json,
      );
    }
    if (workspaceContext && (requestedLabel || args.interactive)) {
      return reportError("--ws cannot be combined with --label or --interactive.", args.json);
    }

    let targetUrls: string[] = workspaceContext?.sources ?? [];
    let directRepository: string | undefined;
    if (workspaceContext && requestedRepository) {
      targetUrls = targetUrls.filter(
        (source) =>
          parseAzureDevOpsRepositoryUrl(source)?.repository.toLowerCase() ===
          requestedRepository.toLowerCase(),
      );
      if (targetUrls.length === 0) {
        return reportError(
          `Repository '${requestedRepository}' is not mounted in workspace '${workspaceContext.name}'.`,
          args.json,
        );
      }
    } else if (!workspaceContext && requestedLabel) {
      const { sources } = labels.parseDeclaredSources(config.sources);
      targetUrls = [
        ...new Set(
          sources
            .filter((source) => Object.hasOwn(source.labels, requestedLabel))
            .map((source) => source.url),
        ),
      ];
      if (targetUrls.length === 0) {
        return reportError(`Label '${requestedLabel}' has no repository sources.`, args.json);
      }
    } else if (!workspaceContext && requestedRepository && !args.interactive) {
      const exactMatches = inventory.filter(
        (record) => record.name.toLowerCase() === requestedRepository.toLowerCase(),
      );
      if (exactMatches.length === 1) {
        targetUrls = [exactMatches[0].url];
      } else if (exactMatches.length === 0 && providers.length === 1) {
        directRepository = requestedRepository;
      } else {
        targetUrls = [
          (
            await resolveRepositoryInput({
              value: requestedRepository,
              root: config.root,
              message: "Select repository",
              required: {
                command: "pr list",
                field: "repository",
                usage: "dev pr [-i | --repo <name> | --label <label>]",
                description: "Repository",
              },
            })
          ).value,
        ];
      }
    } else if (!workspaceContext && args.interactive) {
      targetUrls = [
        (
          await resolveRepositoryInput({
            root: config.root,
            message: "Select repository",
            required: {
              command: "pr list",
              field: "repository",
              usage: "dev pr [-i | --repo <name> | --label <label>]",
              description: "Repository",
            },
          })
        ).value,
      ];
    }

    const targets: Array<{
      provider: Extract<ProviderConfig, { type: "azure_devops" }>;
      tenant: string;
      project?: string;
      repository: string;
      repositoryIdOrName: string;
    }> = targetUrls.flatMap((source) => {
      const record = inventory.find(
        (candidate) => normalizeSourceKey(candidate.url) === normalizeSourceKey(source),
      );
      const parsed = parseAzureDevOpsRepositoryUrl(record?.url ?? source);
      if (!parsed) return [];
      const provider = providers.find(
        (candidate) => candidate.organization.toLowerCase() === parsed.organization.toLowerCase(),
      );
      if (!provider) return [];
      return [
        {
          provider,
          tenant: adoTenant(provider.organization),
          project: record?.project ?? parsed.project,
          repository: record?.name ?? parsed.repository,
          repositoryIdOrName: record?.id ?? parsed.repository,
        },
      ];
    });
    if (directRepository && providers[0]) {
      targets.push({
        provider: providers[0],
        tenant: adoTenant(providers[0].organization),
        project: args.project ?? providers[0].project,
        repository: directRepository,
        repositoryIdOrName: directRepository,
      });
    }
    if (targetUrls.length > 0 && targets.length === 0) {
      return reportError(
        "The selected workset contains no repositories from configured ADO providers.",
        args.json,
      );
    }
    // Live by default: a cached list silently hides pull requests opened since.
    if (providers.length === 0 || args.offline) {
      const targetRepositories = new Set(targets.map((target) => target.repository));
      const allowedTenants = new Set(providers.map((provider) => adoTenant(provider.organization)));
      const cachedDefaultSelections = isDefaultMineQuery
        ? await Promise.all(
            providers.map((provider) =>
              cache.readPullRequestSelection({
                root: config.root,
                tenant: adoTenant(provider.organization),
                name: DEFAULT_PR_SELECTION,
              }),
            ),
          )
        : [];
      const all =
        cachedDefaultSelections.length > 0 &&
        cachedDefaultSelections.every((selection) => selection !== undefined)
          ? cachedDefaultSelections.flatMap((selection) => selection ?? [])
          : await cache.loadAllCachedPullRequests(config.root);
      const filtered = all.filter(
        (item) =>
          (statusFilter === "all" || item.status === statusFilter) &&
          (targetRepositories.size === 0 || targetRepositories.has(item.repository)) &&
          ((!args.provider && providers.length === 0) || allowedTenants.has(item.tenant)),
      );
      const shown = filtered.slice(0, limit);
      ui.result({
        data: shown,
        json: args.json,
        text: () => {
          if (shown.length === 0) return "No cached pull requests found.";
          let out = `Pull Requests (${shown.length}${filtered.length > limit ? ` of ${filtered.length}` : ""}):\n`;
          for (const item of shown) out += `  ${formatPullRequestLine(item)}\n`;
          return out.trimEnd();
        },
      });
      return 0;
    }

    const allPrs: cache.PullRequestRecord[] = [];
    const errors: string[] = [];
    const credential = await resolveAzureDevOpsCredential(config);

    if (targets.length > 0) {
      const results = await Promise.all(
        targets.map(async (target) => {
          try {
            const client = createAzureDevOps({
              organization: target.provider.organization,
              token: credential.token,
            });
            return await pr.syncPullRequests({
              root: config.root,
              tenant: target.tenant,
              repo: target.repository,
              repositoryIdOrName: target.repositoryIdOrName,
              project: target.project,
              status: statusFilter,
              client,
            });
          } catch (error) {
            errors.push(
              `[${target.provider.id}/${target.repository}] ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
          }
        }),
      );
      for (const result of results) {
        if (!result) continue;
        allPrs.push(...result.prs);
        if (result.truncated) {
          errors.push(
            `${result.repo} has more than ${pr.PULL_REQUEST_LIMIT} ${statusFilter} pull requests; showing the newest ${pr.PULL_REQUEST_LIMIT}.`,
          );
        }
      }
    } else {
      const results = await Promise.all(
        providers.map(async (provider) => {
          try {
            const tenant = adoTenant(adoOrgFromProvider(provider));
            const providerInventory = inventory.filter((record) => {
              const parsed = parseAzureDevOpsRepositoryUrl(record.url);
              return (
                parsed?.organization.toLowerCase() === provider.organization.toLowerCase() &&
                (!args.project || parsed.project === args.project)
              );
            });
            const configuredProject = args.project ?? provider.project;
            const projects = configuredProject
              ? [configuredProject]
              : [...new Set(providerInventory.flatMap((record) => record.project ?? []))];
            if (projects.length === 0) {
              if (args.provider) {
                throw new Error("No cached projects. Run 'dev sync inventory' first.");
              }
              if (isDefaultMineQuery) {
                await cache.writePullRequestSelection({
                  root: config.root,
                  tenant,
                  name: DEFAULT_PR_SELECTION,
                  records: [],
                });
              }
              return [];
            }
            const client = createAzureDevOps({
              organization: provider.organization,
              token: credential.token,
            });
            const records = await pr.refreshProjectPullRequests({
              root: config.root,
              tenant,
              projects,
              mine: !args.all,
              status: statusFilter,
              client,
            });
            if (isDefaultMineQuery) {
              await cache.writePullRequestSelection({
                root: config.root,
                tenant,
                name: DEFAULT_PR_SELECTION,
                records,
              });
            }
            return records;
          } catch (error) {
            errors.push(
              `[${provider.id}] ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
          }
        }),
      );
      for (const result of results) allPrs.push(...result);
    }

    const seen = new Set<string>();
    const deduped = allPrs.filter((item) => {
      const key = `${item.tenant}/${item.repository}/${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((left, right) => right.id - left.id);
    const shown = deduped.slice(0, limit);

    ui.result({
      data: { items: shown, errors },
      json: args.json,
      text: () => {
        let out = "";
        for (const error of errors) out += `  Warning: ${error}\n`;
        if (shown.length === 0) {
          out += "No pull requests found.";
        } else {
          out += `Pull Requests (${shown.length}${deduped.length > limit ? ` of ${deduped.length}` : ""}):\n`;
          for (const item of shown) out += `  ${formatPullRequestLine(item)}\n`;
        }
        return out.trimEnd();
      },
    });
    return errors.length > 0 && shown.length === 0 ? 1 : 0;
  },
});

/** A draft is marked first, so it is never mistaken for a pull request ready to review. */
function draftTag(item: cache.PullRequestRecord): string {
  return item.isDraft ? "[DRAFT] " : "";
}

function formatPullRequestLine(item: cache.PullRequestRecord): string {
  return `#${item.id} ${draftTag(item)}[${item.status}] ${item.repository}: ${item.sourceBranch} -> ${item.targetBranch}: ${item.title} (${item.author})`;
}

function checkoutSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const prCheckoutCommand = defineCommand({
  meta: {
    name: "checkout",
    description: "Create a workspace from a pull request",
  },
  args: {
    reference: { type: "positional", description: "Pull request URL or ID", required: false },
    review: { type: "boolean", description: "Create an isolated local review branch" },
    name: { type: "string", description: "Workspace name" },
    repo: { type: "string", description: "Repository name for an ambiguous ID" },
    provider: { type: "string", description: "Provider id for an ambiguous ID" },
    project: { type: "string", description: "Project name for an ambiguous ID" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const cached = await cache.loadAllCachedPullRequests(config.root);
    const inventory = await cache.loadAllCachedInventories(config.root);
    const urlReference = args.reference
      ? parseAzureDevOpsPullRequestUrl(args.reference)
      : undefined;
    let selected: cache.PullRequestRecord | undefined;

    if (urlReference) {
      selected = cached.find(
        (item) =>
          item.id === urlReference.pullRequestId &&
          item.repository === urlReference.repository &&
          item.tenant.toLowerCase() === adoTenant(urlReference.organization).toLowerCase(),
      );
    } else if (!args.reference) {
      // The picker offers open pull requests; a closed one is checked out by its id or URL.
      const open = cached.filter((item) => item.status === "open");
      const choice = await resolveChoiceInput({
        choices: async () =>
          open.map((item, index) => ({
            label: `#${item.id} ${draftTag(item)}${item.repository}: ${item.title} — ${item.author}`,
            value: String(index),
          })),
        message: "Select pull request",
        required: {
          command: "pr checkout",
          field: "reference",
          usage: "dev pr checkout [url-or-id] [--review]",
          description: "Pull request URL or ID",
        },
      });
      selected = open[Number(choice.value)];
    } else if (/^\d+$/.test(args.reference)) {
      const id = Number(args.reference);
      const matches = cached.filter(
        (item) => item.id === id && (!args.repo || item.repository === args.repo),
      );
      if (matches.length === 1) selected = matches[0];
      else if (matches.length > 1) {
        const choice = await resolveChoiceInput({
          choices: async () =>
            matches.map((item, index) => ({
              label: `#${item.id} ${draftTag(item)}${item.repository}: ${item.title}`,
              value: String(index),
            })),
          message: "Select pull request",
          required: {
            command: "pr checkout",
            field: "reference",
            usage: "dev pr checkout <id> [--repo <name>]",
            description: "Unambiguous pull request",
          },
        });
        selected = matches[Number(choice.value)];
      }
    } else if (!urlReference) {
      return reportError(`Invalid pull request reference '${args.reference}'.`, args.json);
    }

    const reference =
      urlReference ??
      (selected
        ? inventory
            .map((record) => ({ record, parsed: parseAzureDevOpsRepositoryUrl(record.url) }))
            .find(
              ({ record, parsed }) =>
                record.name === selected?.repository &&
                parsed &&
                adoTenant(parsed.organization).toLowerCase() === selected?.tenant.toLowerCase(),
            )?.parsed
        : undefined);
    const provider = config.providers.find(
      (candidate): candidate is Extract<ProviderConfig, { type: "azure_devops" }> =>
        candidate.type === "azure_devops" &&
        (!args.provider || candidate.id === args.provider) &&
        (!reference ||
          candidate.organization.toLowerCase() === reference.organization.toLowerCase()),
    );
    const pullRequestId = urlReference?.pullRequestId ?? selected?.id ?? Number(args.reference);
    const project = args.project ?? reference?.project ?? provider?.project;
    const repository = args.repo ?? reference?.repository ?? selected?.repository;
    const organization =
      provider?.organization ?? (args.provider ? undefined : reference?.organization);

    if (!selected && organization && project && repository && Number.isSafeInteger(pullRequestId)) {
      const credential = await resolveAzureDevOpsCredential(config);
      const client = createAzureDevOps({ organization, token: credential.token });
      const raw = await client.getPullRequest(repository, pullRequestId, { project });
      selected = pr.normalizeAdoPullRequest(raw, adoTenant(organization), repository);
    }
    if (!selected || !Number.isSafeInteger(pullRequestId)) {
      return reportError(
        `Pull request '${args.reference ?? ""}' could not be resolved.`,
        args.json,
      );
    }

    const sourceRecord = inventory.find((record) => {
      if (record.name !== selected?.repository) return false;
      const parsed = parseAzureDevOpsRepositoryUrl(record.url);
      if (!parsed || !reference) return true;
      return (
        parsed.organization.toLowerCase() === reference.organization.toLowerCase() &&
        parsed.project.toLowerCase() === reference.project.toLowerCase()
      );
    });
    const source =
      sourceRecord?.url ??
      (reference
        ? `https://dev.azure.com/${reference.organization}/${reference.project}/_git/${reference.repository}`
        : undefined);
    if (!source) {
      return reportError(
        `Repository '${selected.repository}' is not in the local inventory. Run 'dev sync inventory' first.`,
        args.json,
      );
    }

    const mode = args.review ? "review" : "checkout";
    const slug = checkoutSlug(selected.title) || `pr-${selected.id}`;
    const workspaceName =
      args.name ||
      derivePullRequestWorkspaceName(
        selected.id,
        selected.repository,
        selected.sourceBranch,
        mode === "review" ? "review" : "pr",
      );
    const branch = mode === "review" ? `review/${selected.id}-${slug}` : selected.sourceBranch;

    // A workspace whose mount never landed would otherwise block every retry, so an
    // existing one is reused and a workspace this run created is removed when the
    // mount fails.
    const workspace = await ws.init({
      root: config.root,
      workspacePrefix: config.workspacePrefix,
      name: workspaceName,
      description: `${mode === "review" ? "Review" : "Checkout"} PR #${selected.id}: ${selected.title}`,
      reuseExisting: true,
    });

    let mounted: ws.WorkspaceAddResult;
    try {
      mounted = await ws.add({
        root: config.root,
        workspacePrefix: config.workspacePrefix,
        workspaceName,
        source,
        branch,
        upstreamBranch: mode === "review" ? selected.sourceBranch : undefined,
        extraHeader: await resolveExtraHeader(config, source),
        trustedScopes: config.trustedScopes,
        globalHooks: config.hooks,
      });
    } catch (error) {
      if (workspace.created) await fs.removeDir(workspace.path);
      throw error;
    }

    ui.result({
      data: {
        mode,
        workspace,
        mount: mounted,
        pullRequest: selected,
      },
      json: args.json,
      text: () =>
        `${workspace.created ? "Created" : "Reused"} workspace '${workspaceName}' for PR #${selected.id}:\n  Path:   ${workspace.path}\n  Repo:   ${mounted.mountName}\n  Branch: ${branch}`,
    });
    return 0;
  },
});

export const prViewCommand = defineCommand({
  meta: {
    name: "view",
    description: "View details for a specific pull request",
  },
  args: {
    id: { type: "positional", description: "Pull request ID", required: false },
    repo: { type: "string", description: "Target repository name" },
    provider: { type: "string", description: "Limit to a specific provider id" },
    project: { type: "string", description: "Filter by Azure DevOps project" },
    offline: {
      type: "boolean",
      description: "Read strictly from local cache with zero network access",
    },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    let selected: cache.PullRequestRecord | undefined;
    let idStr = args.id;
    if (!idStr) {
      // The picker offers open pull requests; a closed one is viewed by its id or URL.
      const candidates = (await cache.loadAllCachedPullRequests(config.root)).filter(
        (item) => item.status === "open" && (!args.repo || item.repository === args.repo),
      );
      const choice = await resolveChoiceInput({
        choices: async () =>
          candidates.map((item, index) => ({
            label: `#${item.id} ${draftTag(item)}${item.repository}: ${item.title}`,
            value: String(index),
          })),
        message: "Select pull request",
        required: {
          command: "pr view",
          field: "id",
          usage: "dev pr view <id> [--repo <name>]",
          description: "Pull request ID",
        },
      });
      selected = candidates[Number(choice.value)];
      idStr = selected ? String(selected.id) : undefined;
    }
    if (!idStr) throw new Error("Selected pull request is unavailable.");
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return reportError(`Invalid pull request ID '${idStr}'.`, args.json);
    }

    // Find the first ADO provider (or the specified one)
    const providers = args.provider
      ? config.providers.filter((p) => p.id === args.provider)
      : config.providers.filter((p) => p.type === "azure_devops");

    const adoProvider = providers[0] as
      | Extract<ProviderConfig, { type: "azure_devops" }>
      | undefined;

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

    const item = await pr.getPullRequest({
      root: config.root,
      id,
      tenant,
      repo: args.repo || selected?.repository,
      offline: args.offline || !client,
      client,
      project: args.project || adoProvider?.project,
    });

    if (!item) {
      return reportError(`Pull request #${id} not found.`, args.json);
    }

    ui.result({
      data: item,
      json: args.json,
      text: () => {
        let out = `Pull Request #${item.id}: ${draftTag(item)}${item.title}\n`;
        out += `  Status:      ${item.status}${item.isDraft ? " (draft)" : ""}\n`;
        out += `  Repository:  ${item.repository}\n`;
        out += `  Author:      ${item.author}\n`;
        out += `  Branches:    ${item.sourceBranch} -> ${item.targetBranch}\n`;
        out += `  Created:     ${item.createdAt}\n`;
        if (item.url) out += `  URL:         ${item.url}\n`;
        if (item.description) out += `\nDescription:\n  ${item.description}\n`;
        return out.trimEnd();
      },
    });
    return 0;
  },
});

export const prCommand = defineCommand({
  meta: {
    name: "pr",
    description: "Inspect and cache pull requests",
  },
  args: prListCommand.args,
  subCommands: {
    list: prListCommand,
    ls: prListCommand,
    checkout: prCheckoutCommand,
    view: prViewCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(prCommand, rawArgs)) return;
    return await runNestedCommand(prListCommand, rawArgs);
  },
});
