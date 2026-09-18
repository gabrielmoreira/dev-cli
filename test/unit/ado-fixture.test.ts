import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ensureAdoFixture, getAdoFixtureConfig } from "../fixtures/ado-fixture.ts";

const originalFetch = globalThis.fetch;
const fixtureEnvironment = {
  AZURE_DEVOPS_FIXTURE_PAT: "test-pat",
  AZURE_DEVOPS_FIXTURE_ORGANIZATION: "example-org",
  AZURE_DEVOPS_FIXTURE_PROJECT: "example-project",
  AZURE_DEVOPS_FIXTURE_REPOSITORY: "example-repository",
  AZURE_DEVOPS_FIXTURE_ALLOW_WRITES: "true",
} as const;
const originalEnvironment = new Map<string, string | undefined>();

describe("Azure DevOps fixture setup", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(fixtureEnvironment)) {
      originalEnvironment.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(fixtureEnvironment)) {
      const value = originalEnvironment.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnvironment.clear();
  });

  test("loads an explicitly configured fixture from environment variables without a .env file", () => {
    expect(getAdoFixtureConfig()).toEqual({
      organization: "example-org",
      project: "example-project",
      repoName: "example-repository",
      gitUrl: "https://dev.azure.com/example-org/example-project/_git/example-repository",
      pat: "test-pat",
    });
  });

  test("rejects fixture writes without explicit environment confirmation", async () => {
    delete process.env.AZURE_DEVOPS_FIXTURE_ALLOW_WRITES;
    const request = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ id: "unexpected" }), {
        preconnect: globalThis.fetch.preconnect,
      }),
    );

    await expect(ensureAdoFixture()).rejects.toThrow("AZURE_DEVOPS_FIXTURE_ALLOW_WRITES=true");
    expect(request).not.toHaveBeenCalled();
  });

  test("queries the exact stable work-item title before creating it", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/refs?")) {
        return Response.json({
          value: [{ name: "refs/heads/main" }, { name: "refs/heads/feature/payments" }],
        });
      }
      if (url.includes("/pullrequests?")) {
        return Response.json({
          value: [{ pullRequestId: 7, sourceRefName: "refs/heads/feature/payments" }],
        });
      }
      if (url.includes("/_apis/wit/wiql?")) {
        return Response.json({ workItems: [{ id: 42 }] });
      }
      return Response.json({ id: "repository" });
    }) as typeof fetch);

    const fixture = await ensureAdoFixture();
    const wiqlRequest = requests.find((entry) => entry.url.includes("/_apis/wit/wiql?"));
    const wiqlBody = JSON.parse(String(wiqlRequest?.init?.body)) as { query: string };
    expect(wiqlBody.query).toContain(
      "[System.Title] = 'Implement payment processing webhook idempotency'",
    );
    expect(
      requests.some(
        (entry) => entry.url.includes("/workitems/$Issue") && entry.init?.method === "POST",
      ),
    ).toBe(false);
    expect(fixture.workItemId).toBe(42);
  });
});
