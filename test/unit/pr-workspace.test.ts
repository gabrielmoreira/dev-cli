import { describe, expect, test } from "bun:test";
import {
  parseGitHubPullRequestUrl,
  resolvePullRequestWorkspacePlan,
} from "../../src/pr-workspace.ts";

describe("pull request workspace planning", () => {
  test("parses GitHub and Azure DevOps pull request URLs", () => {
    expect(
      parseGitHubPullRequestUrl("https://github.com/gabrielmoreira/tiny-asl-machine/pull/52"),
    ).toEqual({
      owner: "gabrielmoreira",
      repository: "tiny-asl-machine",
      pullRequestId: 52,
    });
  });

  test("continues a GitHub pull request from its head repository and branch", async () => {
    const plan = await resolvePullRequestWorkspacePlan(
      "https://github.com/gabrielmoreira/tiny-asl-machine/pull/52",
      {
        getGitHubPullRequest: async () => ({
          id: 100,
          number: 52,
          title: "Make transitions deterministic",
          state: "open",
          head: {
            ref: "feature/deterministic-transitions",
            repo: {
              name: "tiny-asl-machine-fork",
              clone_url: "https://github.com/contributor/tiny-asl-machine-fork.git",
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
      repository: "tiny-asl-machine",
      source: "https://github.com/contributor/tiny-asl-machine-fork.git",
      branch: "feature/deterministic-transitions",
      workspaceName: "pr-52-tiny-asl-machine-feature-deterministic-transitions",
      description: "Continue PR #52: Make transitions deterministic",
    });
  });

  test("continues an Azure DevOps pull request from its fork when present", async () => {
    const plan = await resolvePullRequestWorkspacePlan(
      "https://dev.azure.com/nn-apps/retail-app/_git/retail-app-bff-monorepo/pullrequest/18637",
      {
        getGitHubPullRequest: async () => {
          throw new Error("unexpected GitHub request");
        },
        getAzureDevOpsPullRequest: async () => ({
          pullRequestId: 18637,
          status: "active",
          title: "Update authentication flow",
          sourceRefName: "refs/heads/users/gabriel/update-auth",
          targetRefName: "refs/heads/main",
          creationDate: "2026-09-18T00:00:00Z",
          url: "https://dev.azure.com/nn-apps/retail-app/_apis/git/pullRequests/18637",
          repository: {
            id: "target",
            name: "retail-app-bff-monorepo",
            url: "target-api-url",
            remoteUrl: "https://dev.azure.com/nn-apps/retail-app/_git/retail-app-bff-monorepo",
          },
          forkSource: {
            repository: {
              id: "fork",
              name: "retail-app-bff-fork",
              url: "fork-api-url",
              remoteUrl: "https://dev.azure.com/nn-apps/retail-app/_git/retail-app-bff-fork",
            },
          },
        }),
      },
    );

    expect(plan).toEqual({
      provider: "azure_devops",
      pullRequestId: 18637,
      repository: "retail-app-bff-monorepo",
      source: "https://dev.azure.com/nn-apps/retail-app/_git/retail-app-bff-fork",
      branch: "users/gabriel/update-auth",
      workspaceName: "pr-18637-retail-app-bff-monorepo-users-gabriel-update-auth",
      description: "Continue PR #18637: Update authentication flow",
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
});
