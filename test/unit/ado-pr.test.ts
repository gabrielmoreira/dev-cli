import { describe, expect, test } from "bun:test";
import { createAzureDevOps, AzureDevOpsError, type FetchFn } from "../../src/ado";

describe("Azure DevOps PR Client (Phase 12)", () => {
  test("listPullRequests queries repository pull requests with status filter", async () => {
    let capturedUrl = "";

    const mockFetch: FetchFn = async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          count: 1,
          value: [
            {
              pullRequestId: 101,
              status: "active",
              title: "Implement feature payments",
              description: "PR description",
              sourceRefName: "refs/heads/feature/payments",
              targetRefName: "refs/heads/main",
              creationDate: "2026-09-14T20:00:00Z",
              url: "https://dev.azure.com/my-org/p1/_apis/git/repositories/alpha/pullRequests/101",
              createdBy: { displayName: "Dev User" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetchFn: mockFetch,
    });

    const prs = await client.listPullRequests("alpha", { project: "p1", status: "active" });

    expect(capturedUrl).toContain("/p1/_apis/git/repositories/alpha/pullrequests");
    expect(capturedUrl).toContain("searchCriteria.status=active");
    expect(prs).toHaveLength(1);
    expect(prs[0].pullRequestId).toBe(101);
    expect(prs[0].title).toBe("Implement feature payments");
  });

  test("getPullRequest queries single pull request by ID", async () => {
    let capturedUrl = "";

    const mockFetch: FetchFn = async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          pullRequestId: 101,
          status: "active",
          title: "Implement feature payments",
          sourceRefName: "refs/heads/feature/payments",
          targetRefName: "refs/heads/main",
          creationDate: "2026-09-14T20:00:00Z",
          url: "https://dev.azure.com/my-org/_apis/git/repositories/alpha/pullRequests/101",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetchFn: mockFetch,
    });

    const pr = await client.getPullRequest("alpha", 101);

    expect(capturedUrl).toContain("_apis/git/repositories/alpha/pullrequests/101");
    expect(pr.pullRequestId).toBe(101);
  });

  test("throws structured error on 404 PR not found", async () => {
    const mockFetch: FetchFn = async () => new Response("Not Found", { status: 404 });

    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetchFn: mockFetch,
    });

    await expect(client.getPullRequest("alpha", 999)).rejects.toThrow(AzureDevOpsError);
  });
});
