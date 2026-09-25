/**
 * Azure DevOps REST API Client
 *
 * Implements direct REST integration for repository inventory discovery.
 * Boundary rule: Provider clients receive credentials and MUST NOT discover them themselves.
 */

import { withHostLimit } from "./host-limit";

export interface AdoProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  visibility?: string;
}

export interface AdoRepository {
  id: string;
  name: string;
  url: string;
  remoteUrl?: string;
  webUrl?: string;
  defaultBranch?: string;
  description?: string;
  size?: number;
  isDisabled?: boolean;
  project?: {
    id: string;
    name: string;
    description?: string;
    lastUpdateTime?: string;
  };
}

export type AzureDevOpsErrorCode = "AUTH_FAILED" | "NOT_FOUND" | "API_ERROR";

export class AzureDevOpsError extends Error {
  readonly code: AzureDevOpsErrorCode;
  readonly status: number;

  constructor(code: AzureDevOpsErrorCode, message: string, status: number) {
    super(message);
    this.name = "AzureDevOpsError";
    this.code = code;
    this.status = status;
  }
}

/** Azure DevOps wraps errors in JSON; its `message` field is the part a person can act on. */
function readableErrorBody(body: string): string {
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  } catch {}
  return body;
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CreateAzureDevOpsOptions {
  organization: string;
  token: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchFn?: FetchFn;
  fetch?: FetchFn;
}

export interface AdoWorkItemReference {
  id: number;
  url: string;
}

export interface AdoWorkItem {
  id: number;
  rev?: number;
  url: string;
  fields: {
    "System.Id"?: number;
    "System.Title": string;
    "System.WorkItemType": string;
    "System.State": string;
    "System.TeamProject"?: string;
    "System.AreaPath"?: string;
    "System.IterationPath"?: string;
    "System.Description"?: string;
    "System.CreatedDate"?: string;
    "System.ChangedDate"?: string;
    "System.CreatedBy"?: { displayName?: string; uniqueName?: string };
    "System.AssignedTo"?: { displayName?: string; uniqueName?: string };
    [key: string]: unknown;
  };
}

export interface AdoPullRequestRepository {
  id: string;
  name: string;
  url?: string;
  remoteUrl?: string;
  webUrl?: string;
  project?: { id: string; name: string };
}

export interface AdoPullRequest {
  pullRequestId: number;
  codeReviewId?: number;
  status: string;
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  isDraft?: boolean;
  creationDate: string;
  url: string;
  createdBy?: {
    displayName: string;
    uniqueName?: string;
    imageUrl?: string;
  };
  repository?: AdoPullRequestRepository;
  forkSource?: {
    repository?: AdoPullRequestRepository;
  };
}

export interface AdoIdentity {
  id: string;
  displayName: string;
  uniqueName?: string;
}

export interface AzureDevOpsRepositoryReference {
  organization: string;
  project: string;
  repository: string;
}

export function parseAzureDevOpsRepositoryUrl(
  source: string,
): AzureDevOpsRepositoryReference | undefined {
  try {
    const url = new URL(source);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
    if (gitIndex < 1 || !segments[gitIndex + 1]) return undefined;
    const organization = url.hostname.toLowerCase().endsWith(".visualstudio.com")
      ? url.hostname.slice(0, -".visualstudio.com".length)
      : segments[0];
    const project = segments[gitIndex - 1];
    if (!organization || !project) return undefined;
    return { organization, project, repository: segments[gitIndex + 1] };
  } catch {
    return undefined;
  }
}

export interface AzureDevOpsPullRequestReference extends AzureDevOpsRepositoryReference {
  pullRequestId: number;
}

export function parseAzureDevOpsPullRequestUrl(
  value: string,
): AzureDevOpsPullRequestReference | undefined {
  const repository = parseAzureDevOpsRepositoryUrl(value);
  if (!repository) return undefined;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    const marker = segments.findIndex((segment) => segment.toLowerCase() === "pullrequest");
    const pullRequestId = marker >= 0 ? Number(segments[marker + 1]) : NaN;
    return Number.isSafeInteger(pullRequestId) && pullRequestId > 0
      ? { ...repository, pullRequestId }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ListProjectPullRequestsOptions {
  reviewerId?: string;
  creatorId?: string;
  repositoryId?: string;
  status?: "active" | "completed" | "abandoned" | "all";
  /** Most pull requests to read, newest first; omitted reads every page. */
  limit?: number;
}

export interface ListPullRequestsOptions {
  project?: string;
  status?: "active" | "completed" | "abandoned" | "all";
  /** Most pull requests to read, newest first; omitted reads every page. */
  limit?: number;
}

/** Azure DevOps returns at most this many pull requests per request. */
const PULL_REQUEST_PAGE_SIZE = 100;

export interface AzureDevOpsClient {
  listProjects(): Promise<AdoProject[]>;
  listRepositories(project?: string): Promise<AdoRepository[]>;
  getCurrentUser(): Promise<AdoIdentity>;
  listProjectPullRequests(
    project: string | undefined,
    options?: ListProjectPullRequestsOptions,
  ): Promise<AdoPullRequest[]>;
  listPullRequests(
    repositoryIdOrName: string,
    options?: ListPullRequestsOptions,
  ): Promise<AdoPullRequest[]>;
  getPullRequest(
    repositoryIdOrName: string,
    pullRequestId: number | string,
    options?: { project?: string },
  ): Promise<AdoPullRequest>;
  queryWorkItems(
    wiql: string,
    options?: { project?: string; top?: number },
  ): Promise<AdoWorkItemReference[]>;
  getWorkItems(ids: number[], options?: { project?: string }): Promise<AdoWorkItem[]>;
  getWorkItem(id: number | string, options?: { project?: string }): Promise<AdoWorkItem>;
}

export function createAzureDevOps(options: CreateAzureDevOpsOptions): AzureDevOpsClient {
  const organization = options.organization?.trim();
  const token = options.token?.trim();

  if (!organization) {
    throw new Error("Azure DevOps organization is required");
  }
  if (!token) {
    throw new Error("Azure DevOps authentication token is required");
  }

  const baseUrl = (options.baseUrl || "https://dev.azure.com").replace(/\/+$/, "");
  const apiVersion = options.apiVersion || "7.0";
  const fetchFn = options.fetchFn || options.fetch || fetch;

  const basicHeader = `Basic ${Buffer.from(`:${token}`).toString("base64")}`;

  async function request<T>(endpointPath: string, init?: RequestInit): Promise<T> {
    const url = `${baseUrl}/${encodeURIComponent(organization)}/${endpointPath}`;

    let response: Response;
    try {
      response = await withHostLimit(url, () =>
        fetchFn(url, {
          method: init?.method || "GET",
          headers: {
            Authorization: basicHeader,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...init?.headers,
          },
          body: init?.body,
        }),
      );
    } catch (networkError) {
      throw new AzureDevOpsError(
        "API_ERROR",
        `Network error connecting to Azure DevOps: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
        0,
      );
    }

    if (!response.ok) {
      const status = response.status;
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {}

      // Redact token from any error output
      const sanitizedBody = readableErrorBody(
        bodyText.replace(new RegExp(token, "g"), "[REDACTED]"),
      );

      if (status === 401 || status === 403) {
        throw new AzureDevOpsError(
          "AUTH_FAILED",
          `Authentication failed for Azure DevOps organization '${organization}': ${sanitizedBody || status}`,
          status,
        );
      }

      if (status === 404) {
        throw new AzureDevOpsError(
          "NOT_FOUND",
          `Resource not found on Azure DevOps: ${sanitizedBody || status}`,
          status,
        );
      }

      throw new AzureDevOpsError(
        "API_ERROR",
        `Azure DevOps API error (${status}): ${sanitizedBody || response.statusText}`,
        status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (parseError) {
      throw new AzureDevOpsError(
        "API_ERROR",
        `Failed to parse Azure DevOps response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        response.status,
      );
    }
  }

  /** Reads newest-first pages until the provider runs out or `limit` is reached. */
  async function readPullRequestPages(
    path: string,
    query: URLSearchParams,
    limit?: number,
  ): Promise<AdoPullRequest[]> {
    const results: AdoPullRequest[] = [];
    while (limit === undefined || results.length < limit) {
      const top = Math.min(PULL_REQUEST_PAGE_SIZE, (limit ?? Infinity) - results.length);
      query.set("$top", String(top));
      query.set("$skip", String(results.length));
      const page = (await request<{ value?: AdoPullRequest[] }>(`${path}?${query}`)).value ?? [];
      results.push(...page);
      if (page.length < top) break;
    }
    return results;
  }

  return {
    async listProjects(): Promise<AdoProject[]> {
      const data = await request<{ value: AdoProject[]; count: number }>(
        `_apis/projects?api-version=${encodeURIComponent(apiVersion)}`,
      );
      return data.value || [];
    },

    async listRepositories(project?: string): Promise<AdoRepository[]> {
      const path = project
        ? `${encodeURIComponent(project)}/_apis/git/repositories?api-version=${encodeURIComponent(apiVersion)}`
        : `_apis/git/repositories?api-version=${encodeURIComponent(apiVersion)}`;

      const data = await request<{ value: AdoRepository[]; count: number }>(path);
      return data.value || [];
    },

    async getCurrentUser(): Promise<AdoIdentity> {
      const data = await request<{ authenticatedUser?: AdoIdentity }>(
        `_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1`,
      );
      if (!data.authenticatedUser?.id) {
        throw new AzureDevOpsError(
          "API_ERROR",
          "Azure DevOps did not return the authenticated user identity",
          200,
        );
      }
      return data.authenticatedUser;
    },

    /** Pull requests of one project, or of the whole organization when project is undefined. */
    async listProjectPullRequests(
      project: string | undefined,
      opts?: ListProjectPullRequestsOptions,
    ): Promise<AdoPullRequest[]> {
      const query = new URLSearchParams({ "api-version": apiVersion });
      if (opts?.reviewerId) query.set("searchCriteria.reviewerId", opts.reviewerId);
      if (opts?.creatorId) query.set("searchCriteria.creatorId", opts.creatorId);
      if (opts?.repositoryId) query.set("searchCriteria.repositoryId", opts.repositoryId);
      if (opts?.status) query.set("searchCriteria.status", opts.status);
      return await readPullRequestPages(
        `${project ? `${encodeURIComponent(project)}/` : ""}_apis/git/pullrequests`,
        query,
        opts?.limit,
      );
    },

    async listPullRequests(
      repositoryIdOrName: string,
      opts?: ListPullRequestsOptions,
    ): Promise<AdoPullRequest[]> {
      let resolvedRepo = repositoryIdOrName;
      let resolvedProject = opts?.project;

      if (!resolvedProject && !/^[0-9a-fA-F-]{36}$/.test(repositoryIdOrName)) {
        try {
          const allRepos = await this.listRepositories();
          const match = allRepos.find(
            (r) => r.name.toLowerCase() === repositoryIdOrName.toLowerCase(),
          );
          if (match) {
            resolvedRepo = match.id;
            resolvedProject = match.project?.name;
          }
        } catch {
          // Ignore and attempt direct query
        }
      }

      const repoPath = resolvedProject
        ? `${encodeURIComponent(resolvedProject)}/_apis/git/repositories/${encodeURIComponent(resolvedRepo)}`
        : `_apis/git/repositories/${encodeURIComponent(resolvedRepo)}`;

      const query = new URLSearchParams({ "api-version": apiVersion });
      if (opts?.status) query.set("searchCriteria.status", opts.status);
      return await readPullRequestPages(`${repoPath}/pullrequests`, query, opts?.limit);
    },

    async getPullRequest(
      repositoryIdOrName: string,
      pullRequestId: number | string,
      opts?: { project?: string },
    ): Promise<AdoPullRequest> {
      let resolvedRepo = repositoryIdOrName;
      let resolvedProject = opts?.project;

      if (!resolvedProject && !/^[0-9a-fA-F-]{36}$/.test(repositoryIdOrName)) {
        try {
          const allRepos = await this.listRepositories();
          const match = allRepos.find(
            (r) => r.name.toLowerCase() === repositoryIdOrName.toLowerCase(),
          );
          if (match) {
            resolvedRepo = match.id;
            resolvedProject = match.project?.name;
          }
        } catch {
          // Ignore and attempt direct query
        }
      }

      const repoPath = resolvedProject
        ? `${encodeURIComponent(resolvedProject)}/_apis/git/repositories/${encodeURIComponent(resolvedRepo)}`
        : `_apis/git/repositories/${encodeURIComponent(resolvedRepo)}`;

      const path = `${repoPath}/pullrequests/${encodeURIComponent(String(pullRequestId))}?api-version=${encodeURIComponent(apiVersion)}`;
      return await request<AdoPullRequest>(path);
    },

    async queryWorkItems(
      wiql: string,
      opts?: { project?: string; top?: number },
    ): Promise<AdoWorkItemReference[]> {
      const projectPath = opts?.project ? `${encodeURIComponent(opts.project)}/` : "";
      const query = new URLSearchParams({ "api-version": apiVersion });
      if (opts?.top !== undefined) {
        query.set("$top", String(Math.max(1, Math.floor(opts.top))));
      }
      const path = `${projectPath}_apis/wit/wiql?${query}`;
      const data = await request<{ workItems: AdoWorkItemReference[] }>(path, {
        method: "POST",
        body: JSON.stringify({ query: wiql }),
      });
      return data.workItems || [];
    },

    async getWorkItems(ids: number[], opts?: { project?: string }): Promise<AdoWorkItem[]> {
      if (ids.length === 0) return [];
      const projectPath = opts?.project ? `${encodeURIComponent(opts.project)}/` : "";
      const chunkSize = 200;
      const results: AdoWorkItem[] = [];
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const idsParam = chunk.join(",");
        const path = `${projectPath}_apis/wit/workitems?ids=${encodeURIComponent(idsParam)}&$expand=all&api-version=${encodeURIComponent(apiVersion)}`;
        const data = await request<{ value: AdoWorkItem[] }>(path);
        if (data.value) {
          results.push(...data.value);
        }
      }
      return results;
    },

    async getWorkItem(id: number | string, opts?: { project?: string }): Promise<AdoWorkItem> {
      const projectPath = opts?.project ? `${encodeURIComponent(opts.project)}/` : "";
      const path = `${projectPath}_apis/wit/workitems/${encodeURIComponent(String(id))}?$expand=all&api-version=${encodeURIComponent(apiVersion)}`;
      return await request<AdoWorkItem>(path);
    },
  };
}
