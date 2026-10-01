import { describe, expect, test } from "bun:test";
import {
  derivePullRequestWorkspaceName,
  parseGitHubPullRequestUrl,
  resolvePullRequestWorkspacePlan,
} from "../../src/pr-workspace.ts";

describe("pull request workspace planning", () => {
  test("parses GitHub and Azure DevOps pull request URLs", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/example-org/sample-repo/pull/52")).toEqual(
      {
        owner: "example-org",
        repository: "sample-repo",
        pullRequestId: 52,
      },
    );
  });

  test("continues a GitHub pull request from its head repository and branch", async () => {
    const plan = await resolvePullRequestWorkspacePlan(
      "https://github.com/example-org/sample-repo/pull/52",
      {
        getGitHubPullRequest: async () => ({
          id: 100,
          number: 52,
          title: "Make transitions deterministic",
          state: "open",
          head: {
            ref: "feature/deterministic-transitions",
            repo: {
              name: "sample-repo-fork",
              clone_url: "https://github.com/contributor/sample-repo-fork.git",
            },
          },
          base: { ref: "main" },
        }),
        getAzureDevOpsPullRequest: async () => {
          throw new Error("unexpected Azure DevOps request");
        },
      },
    );

    expect(plan).toEqual({
      provider: "github",
      pullRequestId: 52,
      repository: "sample-repo",
      source: "https://github.com/contributor/sample-repo-fork.git",
      branch: "feature/deterministic-transitions",
      workspaceName: "pr-52-sample-repo-feature-deterministic-transitions",
      description: "Continue PR #52: Make transitions deterministic",
    });
  });

  test("continues an Azure DevOps pull request from its fork when present", async () => {
    const plan = await resolvePullRequestWorkspacePlan(
      "https://dev.azure.com/example-org/sample-project/_git/sample-api/pullrequest/101",
      {
        getGitHubPullRequest: async () => {
          throw new Error("unexpected GitHub request");
        },
        getAzureDevOpsPullRequest: async () => ({
          pullRequestId: 101,
          status: "active",
          title: "Update authentication flow",
          sourceRefName: "refs/heads/users/alice/update-auth",
          targetRefName: "refs/heads/main",
          creationDate: "2026-09-18T00:00:00Z",
          url: "https://dev.azure.com/example-org/sample-project/_apis/git/pullRequests/101",
          repository: {
            id: "target",
            name: "sample-api",
            url: "target-api-url",
            remoteUrl: "https://dev.azure.com/example-org/sample-project/_git/sample-api",
          },
          forkSource: {
            repository: {
              id: "fork",
              name: "sample-api-fork",
              url: "fork-api-url",
              remoteUrl: "https://dev.azure.com/example-org/sample-project/_git/sample-api-fork",
            },
          },
        }),
      },
    );

    expect(plan).toEqual({
      provider: "azure_devops",
      pullRequestId: 101,
      repository: "sample-api",
      source: "https://dev.azure.com/example-org/sample-project/_git/sample-api-fork",
      branch: "users/alice/update-auth",
      workspaceName: "pr-101-sample-api-users-alice-update-auth",
      description: "Continue PR #101: Update authentication flow",
    });
  });

  test("limits only the branch suffix in long suggested names", async () => {
    const plan = await resolvePullRequestWorkspacePlan(
      "https://github.com/example/short-repo/pull/7",
      {
        getGitHubPullRequest: async () => ({
          id: 7,
          number: 7,
          title: "Long branch",
          state: "open",
          head: {
            ref: "feature/this-is-a-very-long-branch-name-that-keeps-going",
            repo: {
              name: "short-repo",
              clone_url: "https://github.com/example/short-repo.git",
            },
          },
          base: { ref: "main" },
        }),
        getAzureDevOpsPullRequest: async () => {
          throw new Error("unexpected Azure DevOps request");
        },
      },
    );

    expect(plan?.workspaceName.length).toBeLessThanOrEqual(64);
    expect(plan?.workspaceName).toStartWith("pr-7-short-repo-");
  });

  /** `dev pr checkout` used to name the workspace after the PR title while
   * `dev ws add <pr-url>` named it after the branch, so the same pull request
   * produced two folders. Both callers derive the name here now. */
  test("derives one workspace name per pull request, per kind", () => {
    expect(derivePullRequestWorkspaceName(101, "sample-api", "feature/payments")).toBe(
      "pr-101-sample-api-feature-payments",
    );
    expect(derivePullRequestWorkspaceName(101, "sample-api", "feature/payments", "review")).toBe(
      "review-101-sample-api-feature-payments",
    );
  });
});
