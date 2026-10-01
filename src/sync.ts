import { createAzureDevOps, type AzureDevOpsClient } from "./ado";
import * as inventory from "./inventory";
import type { InventorySyncResult } from "./inventory";
import { syncInventory } from "./inventory";
import * as workitem from "./workitem";
import type { WorkItemSyncResult } from "./workitem";
import * as pr from "./pr";
import type { PrSyncResult } from "./pr";
import * as mirror from "./mirror";
import type { MirrorSyncResult } from "./mirror";
import type * as cache from "./cache";
import type { ProviderConfig, RuntimeConfig } from "./config";
import {
  resolveAzureDevOpsCredential,
  resolveExtraHeader,
  resolveGitHubCredential,
} from "./credentials";
import * as github from "./github";
import * as labels from "./labels";
import * as ws from "./ws";

export interface SyncDataInput {
  root: string;
  tenant: string;
  client: AzureDevOpsClient;
  project?: string;
  repos?: string[];
  syncCanonical?: boolean;
  now?: () => string;
}

export interface SyncDataResult {
  tenant: string;
  project?: string;
  inventory: InventorySyncResult;
  workItems?: WorkItemSyncResult;
  pullRequests: PrSyncResult[];
  /** Repositories the provider reports as disabled; their pull requests cannot be read. */
  skippedDisabled: string[];
  canonicalRepos?: MirrorSyncResult;
  errors?: string[];
  timestamp: string;
}

export interface SyncDataDeps {
  inventory: {
    syncInventory: typeof inventory.syncInventory;
  };
  workitem: {
    syncWorkItems: typeof workitem.syncWorkItems;
  };
  pr: {
    syncPullRequests: typeof pr.syncPullRequests;
  };
  mirror?: {
    sync: typeof mirror.sync;
  };
}

const defaultDeps: SyncDataDeps = {
  inventory,
  workitem,
  pr,
  mirror,
};

/**
 * Combined offline data synchronization use case.
 * Orchestrates repository inventory, work items, pull requests,
 * and optional canonical repository mirror synchronization.
 */
export async function syncData(
  input: SyncDataInput,
  deps: SyncDataDeps = defaultDeps,
): Promise<SyncDataResult> {
  const timestamp = input.now ? input.now() : new Date().toISOString();
  const errors: string[] = [];

  // 1. Synchronize repository inventory
  const invResult = await deps.inventory.syncInventory({
    root: input.root,
    tenant: input.tenant,
    client: input.client,
    project: input.project,
    now: () => timestamp,
  });

  // 2. Synchronize work items (if project is scoped or discovered)
  let wiResult: WorkItemSyncResult | undefined;
  const targetProject = input.project || invResult.fetched[0]?.project;
  if (targetProject) {
    try {
      wiResult = await deps.workitem.syncWorkItems({
        root: input.root,
        tenant: input.tenant,
        project: targetProject,
        client: input.client,
        now: () => timestamp,
      });
    } catch (err) {
      errors.push(`Work item sync error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Synchronize pull requests for the repositories this run fetched. The merged
  // cache also holds other projects, which the project-scoped PR API cannot see.
  const pullRequests: PrSyncResult[] = [];
  const skippedDisabled: string[] = [];
  let targetRepos: string[] = [];

  if (input.repos && input.repos.length > 0) {
    targetRepos = input.repos;
  } else {
    for (const record of invResult.fetched) {
      if (targetProject && record.project && record.project !== targetProject) continue;
      if (record.disabled) skippedDisabled.push(record.name);
      else targetRepos.push(record.name);
    }
  }

  const prOutcomes = await Promise.all(
    targetRepos.map(async (repoName) => {
      try {
        return {
          result: await deps.pr.syncPullRequests({
            root: input.root,
            tenant: input.tenant,
            repo: repoName,
            client: input.client,
            project: targetProject,
            // Listings show open pull requests; closed ones are read only when asked for.
            status: "open",
            now: () => timestamp,
          }),
        };
      } catch (err) {
        return {
          error: `Pull request sync error for ${repoName}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );
  for (const outcome of prOutcomes) {
    if (outcome.error !== undefined) errors.push(outcome.error);
    else pullRequests.push(outcome.result);
  }

  // 4. Optionally synchronize canonical reference repositories and mirrors
  let canonicalRepos: MirrorSyncResult | undefined;
  if (input.syncCanonical && deps.mirror) {
    try {
      canonicalRepos = await deps.mirror.sync({
        root: input.root,
        refresh: true,
      });
    } catch (err) {
      errors.push(
        `Canonical repositories sync error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    tenant: input.tenant,
    project: targetProject,
    inventory: invResult,
    workItems: wiResult,
    pullRequests,
    skippedDisabled,
    canonicalRepos,
    errors: errors.length > 0 ? errors : undefined,
    timestamp,
  };
}

export function adoTenantFromOrg(organization: string): string {
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

export type InventorySyncSummary = {
  providerId: string;
  tenant: string;
  total: number;
  added: number;
  updated: number;
  cachePath: string;
  repositories: cache.InventoryRecord[];
};

export async function syncProviderInventories(
  config: RuntimeConfig,
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

/**
 * Provider data for a bare `dev sync`: a provider with a project gets inventory,
 * work items, and pull requests; every other provider gets its inventory. Reads only.
 */
export async function syncProvidersWithData(
  config: RuntimeConfig,
  filter: { provider?: string; project?: string },
): Promise<{
  inventory: InventorySyncSummary[];
  data: Array<SyncDataResult & { providerId: string }>;
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
          const result = await syncData({
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

export type RootSyncStep<T> = { ok: true; result: T } | { ok: false; error: string; code: string };

async function step<T>(run: () => Promise<T>): Promise<RootSyncStep<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code:
        err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "FAILED",
    };
  }
}

type RootMirrorResult = Awaited<ReturnType<typeof mirror.sync>> & {
  labelMirrors: Awaited<ReturnType<typeof labels.ensureLabelMirrors>>;
};

type RootProviderResult = Awaited<ReturnType<typeof syncProvidersWithData>>;

export interface SyncRootResult {
  phases: {
    providers: RootSyncStep<RootProviderResult> | null;
    mirrors: RootSyncStep<RootMirrorResult>;
    workspaces: Array<{ name: string } & RootSyncStep<ws.WorkspaceUpdateResult>>;
  };
  failures: { component: string; code: string; message: string }[];
}

export type SyncRootProgress =
  | { kind: "phase"; phase: "providers" | "mirrors" }
  | { kind: "phase"; phase: "workspaces"; total: number }
  | { kind: "workspace"; name: string; ok: boolean; done: number; total: number };

/** Workspaces synced at once; network still waits for each host's slot. */
const WORKSPACE_CONCURRENCY = 4;

/**
 * Everything that can be brought from remotes, in order: provider data, mirrors, then
 * each workspace. Each step reads or fetches only; nothing is pushed and no hook runs,
 * since a hook is a user command that could send data out. A failing step or
 * workspace is reported and the rest go on.
 */
export async function syncRoot(
  config: RuntimeConfig,
  options: {
    provider?: string;
    project?: string;
    onProgress?: (event: SyncRootProgress) => void;
  },
): Promise<SyncRootResult> {
  options.onProgress?.({ kind: "phase", phase: "providers" });
  const providers =
    config.providers.length > 0
      ? await step(() =>
          syncProvidersWithData(config, { provider: options.provider, project: options.project }),
        )
      : null;

  options.onProgress?.({ kind: "phase", phase: "mirrors" });
  const mirrors = await step(async () => {
    // Labels that keep repositories mirrored get their missing mirrors first.
    const labelMirrors = await labels.ensureLabelMirrors(config, {
      resolveExtraHeader: (source) => resolveExtraHeader(config, source),
    });
    const synced = await mirror.sync({
      root: config.root,
      canonicalPrefix: config.canonicalPrefix,
      refresh: true,
      resolveExtraHeader: (source) => resolveExtraHeader(config, source),
    });
    return { ...synced, labelMirrors };
  });

  // Workspaces sync side by side: each fetch waits for its host's slot
  // (host-limit.ts), and each workspace writes only its own worktrees.
  const workspaceNames = await ws.list({
    root: config.root,
    workspacePrefix: config.workspacePrefix,
  });
  if (workspaceNames.length > 0) {
    options.onProgress?.({ kind: "phase", phase: "workspaces", total: workspaceNames.length });
  }
  let finished = 0;
  const workspaces: Array<{ name: string } & RootSyncStep<ws.WorkspaceUpdateResult>> =
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
      options.onProgress?.({
        kind: "workspace",
        name,
        ok: outcome.ok,
        done: finished,
        total: workspaceNames.length,
      });
      return { name, ...outcome };
    });

  const failures: SyncRootResult["failures"] = [
    ...(providers && !providers.ok
      ? [{ component: "providers", code: providers.code, message: providers.error }]
      : []),
    ...(providers?.ok
      ? providers.result.errors.map((error) => ({
          component: "providers",
          code: "FAILED",
          message: error,
        }))
      : []),
    ...(!mirrors.ok ? [{ component: "mirrors", code: mirrors.code, message: mirrors.error }] : []),
    ...(mirrors.ok
      ? mirrors.result.refreshFailures.map(({ path, reason }) => ({
          component: "mirrors",
          code: "FAILED",
          message: `${path}: ${reason}`,
        }))
      : []),
    ...(mirrors.ok
      ? mirrors.result.labelMirrors.failures.map(({ url, reason }) => ({
          component: "mirrors",
          code: "FAILED",
          message: `${url}: ${reason}`,
        }))
      : []),
    ...workspaces.flatMap((item) =>
      item.ok
        ? []
        : [{ component: `workspace ${item.name}`, code: item.code, message: item.error }],
    ),
  ].map((failure) => ({ ...failure, message: failure.message.split(/\r?\n/)[0]! }));
  return { phases: { providers, mirrors, workspaces }, failures };
}
