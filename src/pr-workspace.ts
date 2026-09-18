import {
  parseAzureDevOpsPullRequestUrl,
  type AdoPullRequest,
  type AzureDevOpsPullRequestReference,
} from "./ado.ts";
import type { GitHubRawPullRequest } from "./github.ts";

export interface GitHubPullRequestReference {
  owner: string;
  repository: string;
  pullRequestId: number;
}

export type PullRequestUrlReference =
  | ({ provider: "github" } & GitHubPullRequestReference)
  | ({ provider: "azure_devops" } & AzureDevOpsPullRequestReference);

export interface PullRequestWorkspacePlan {
  provider: "github" | "azure_devops";
  pullRequestId: number;
  repository: string;
  source: string;
  branch: string;
  workspaceName: string;
  description: string;
}

export interface PullRequestWorkspaceDeps {
  getGitHubPullRequest(reference: GitHubPullRequestReference): Promise<GitHubRawPullRequest>;
  getAzureDevOpsPullRequest(reference: AzureDevOpsPullRequestReference): Promise<AdoPullRequest>;
}

export class PullRequestWorkspaceError extends Error {
  readonly code = "PULL_REQUEST_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "PullRequestWorkspaceError";
  }
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestReference | undefined {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments.length !== 4 || segments[2]?.toLowerCase() !== "pull") return undefined;
    const pullRequestId = Number(segments[3]);
    if (
      !segments[0] ||
      !segments[1] ||
      !Number.isSafeInteger(pullRequestId) ||
      pullRequestId <= 0
    ) {
      return undefined;
    }
    return { owner: segments[0], repository: segments[1], pullRequestId };
  } catch {
    return undefined;
  }
}

export function parsePullRequestUrl(value: string): PullRequestUrlReference | undefined {
  const github = parseGitHubPullRequestUrl(value);
  if (github) return { provider: "github", ...github };
  const azureDevOps = parseAzureDevOpsPullRequestUrl(value);
  return azureDevOps ? { provider: "azure_devops", ...azureDevOps } : undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function derivePullRequestWorkspaceName(
  pullRequestId: number,
  repository: string,
  branch: string,
): string {
  const prefix = `pr-${pullRequestId}-${slug(repository)}`;
  const branchSlug = slug(branch);
  if (!branchSlug) return prefix;
  const available = 64 - prefix.length - 1;
  if (available <= 0) return prefix;
  const suffix = branchSlug.slice(0, available).replace(/-+$/g, "");
  return suffix ? `${prefix}-${suffix}` : prefix;
}

function required(value: string | null | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new PullRequestWorkspaceError(message);
  return normalized;
}

export async function resolvePullRequestWorkspacePlan(
  value: string,
  deps: PullRequestWorkspaceDeps,
): Promise<PullRequestWorkspacePlan | undefined> {
  const reference = parsePullRequestUrl(value);
  if (!reference) return undefined;

  if (reference.provider === "github") {
    const pullRequest = await deps.getGitHubPullRequest(reference);
    const branch = required(
      pullRequest.head?.ref,
      `GitHub PR #${reference.pullRequestId} has no available source branch.`,
    );
    const source = required(
      pullRequest.head?.repo?.clone_url ?? pullRequest.head?.repo?.html_url,
      `GitHub PR #${reference.pullRequestId} has no available head repository.`,
    );
    return {
      provider: reference.provider,
      pullRequestId: reference.pullRequestId,
      repository: reference.repository,
      source,
      branch,
      workspaceName: derivePullRequestWorkspaceName(
        reference.pullRequestId,
        reference.repository,
        branch,
      ),
      description: `Continue PR #${reference.pullRequestId}: ${pullRequest.title}`,
    };
  }

  const pullRequest = await deps.getAzureDevOpsPullRequest(reference);
  const branch = required(
    pullRequest.sourceRefName?.replace(/^refs\/heads\//, ""),
    `Azure DevOps PR #${reference.pullRequestId} has no available source branch.`,
  );
  const source = required(
    pullRequest.forkSource?.repository?.remoteUrl ??
      pullRequest.forkSource?.repository?.webUrl ??
      pullRequest.repository?.remoteUrl ??
      pullRequest.repository?.webUrl ??
      `https://dev.azure.com/${reference.organization}/${reference.project}/_git/${reference.repository}`,
    `Azure DevOps PR #${reference.pullRequestId} has no available source repository.`,
  );
  return {
    provider: reference.provider,
    pullRequestId: reference.pullRequestId,
    repository: reference.repository,
    source,
    branch,
    workspaceName: derivePullRequestWorkspaceName(
      reference.pullRequestId,
      reference.repository,
      branch,
    ),
    description: `Continue PR #${reference.pullRequestId}: ${pullRequest.title}`,
  };
}
