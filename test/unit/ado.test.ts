import { describe, expect, test } from "bun:test";
import {
  createAzureDevOps,
  AzureDevOpsError,
  parseAzureDevOpsPullRequestUrl,
  parseAzureDevOpsRepositoryUrl,
  type FetchFn,
} from "../../src/ado";

describe("Azure DevOps REST Client", () => {
  test("fails if organization or token is missing", () => {
    expect(() => createAzureDevOps({ organization: "", token: "pat123" })).toThrow(/organization/i);
    expect(() => createAzureDevOps({ organization: "my-org", token: "" })).toThrow(/token/i);
  });

  test("parses Azure DevOps repository URLs into query context", () => {
    expect(
      parseAzureDevOpsRepositoryUrl(
        "https://dev.azure.com/example-org/retail-app/_git/retail-app-bff-monorepo",
      ),
    ).toEqual({
      organization: "example-org",
      project: "retail-app",
      repository: "retail-app-bff-monorepo",
    });
    expect(
      parseAzureDevOpsRepositoryUrl(
        "https://example-org.visualstudio.com/retail-app/_git/retail-app-bff-monorepo",
      ),
    ).toEqual({
      organization: "example-org",
      project: "retail-app",
      repository: "retail-app-bff-monorepo",
    });
  });

  test("parses an Azure DevOps pull request URL", () => {
    expect(
      parseAzureDevOpsPullRequestUrl(
        "https://dev.azure.com/example-org/retail-app/_git/retail-app/pullrequest/18432",
      ),
    ).toEqual({
      organization: "example-org",
      project: "retail-app",
      repository: "retail-app",
      pullRequestId: 18432,
    });
  });

  test("listProjects sends authenticated GET and returns projects", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: FetchFn = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) || {};

      return new Response(
        JSON.stringify({
          count: 2,
          value: [
            {
              id: "p1",
              name: "project-one",
              description: "First project",
              state: "wellFormed",
            },
            {
              id: "p2",
              name: "project-two",
              state: "wellFormed",
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

    const projects = await client.listProjects();

    expect(capturedUrl).toContain("https://dev.azure.com/my-org/_apis/projects");
    const expectedAuth = `Basic ${Buffer.from(":secret-token").toString("base64")}`;
    expect(capturedHeaders["Authorization"]).toBe(expectedAuth);
    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe("project-one");
    expect(projects[1].name).toBe("project-two");
  });

  test("listRepositories queries all repos across organization", async () => {
    let capturedUrl = "";

    const mockFetch: FetchFn = async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          count: 1,
          value: [
            {
              id: "r1",
              name: "core-service",
              url: "https://dev.azure.com/my-org/p1/_apis/git/repositories/r1",
              webUrl: "https://dev.azure.com/my-org/p1/_git/core-service",
              defaultBranch: "refs/heads/main",
              project: { id: "p1", name: "p1" },
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

    const repos = await client.listRepositories();
    expect(capturedUrl).toContain("https://dev.azure.com/my-org/_apis/git/repositories");
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("core-service");
  });

  test("listRepositories queries specific project when provided", async () => {
    let capturedUrl = "";

    const mockFetch: FetchFn = async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          count: 1,
          value: [
            {
              id: "r2",
              name: "payments",
              url: "https://dev.azure.com/my-org/billing/_apis/git/repositories/r2",
              webUrl: "https://dev.azure.com/my-org/billing/_git/payments",
              defaultBranch: "refs/heads/main",
              project: { id: "p2", name: "billing" },
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

    const repos = await client.listRepositories("billing");
    expect(capturedUrl).toContain("https://dev.azure.com/my-org/billing/_apis/git/repositories");
    expect(repos[0].name).toBe("payments");
  });

  test("gets the authenticated user identity", async () => {
    let capturedUrl = "";
    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetchFn: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({ authenticatedUser: { id: "user-123", displayName: "Current User" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    expect(await client.getCurrentUser()).toEqual({ id: "user-123", displayName: "Current User" });
    expect(capturedUrl).toContain("/_apis/connectionData");
  });

  test("limits WIQL results at the Azure API boundary", async () => {
    let capturedUrl = "";
    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetchFn: async (input) => {
        capturedUrl = String(input);
        return Response.json({ workItems: [] });
      },
    });

    await client.queryWorkItems("SELECT [System.Id] FROM WorkItems", {
      project: "retail-app",
      top: 50,
    });

    expect(new URL(capturedUrl).searchParams.get("$top")).toBe("50");
  });

  test("lists project pull requests assigned to a reviewer", async () => {
    let capturedUrl = "";
    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetchFn: async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({ count: 0, value: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(
      await client.listProjectPullRequests("payments", {
        reviewerId: "user-123",
        repositoryId: "repo-456",
        status: "active",
      }),
    ).toEqual([]);
    expect(capturedUrl).toContain("/payments/_apis/git/pullrequests?");
    expect(capturedUrl).toContain("searchCriteria.reviewerId=user-123");
    expect(capturedUrl).toContain("searchCriteria.repositoryId=repo-456");
    expect(capturedUrl).toContain("searchCriteria.status=active");
  });

  test("throws structured error on 401 unauthorized without leaking token", async () => {
    const mockFetch: FetchFn = async () => {
      return new Response("Unauthorized error details", { status: 401 });
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "super-secret-pat-12345",
      fetchFn: mockFetch,
    });

    let thrownError: unknown = null;
    try {
      await client.listProjects();
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(AzureDevOpsError);
    const adoErr = thrownError as AzureDevOpsError;
    expect(adoErr.code).toBe("AUTH_FAILED");
    expect(adoErr.status).toBe(401);
    expect(adoErr.message).not.toContain("super-secret-pat-12345");
  });

  test("throws structured error on 404 not found", async () => {
    const mockFetch: FetchFn = async () => {
      return new Response("Project not found", { status: 404 });
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "pat",
      fetchFn: mockFetch,
    });

    await expect(client.listRepositories("non-existent")).rejects.toThrow(AzureDevOpsError);
  });
});
