import { describe, expect, test } from "bun:test";
import { createAzureDevOps, type FetchFn } from "../../src/ado";

describe("Azure DevOps Work Item Client (Phase 13)", () => {
  test("queryWorkItems sends WIQL query and returns work item references", async () => {
    let requestedUrl = "";
    let requestedBody = "";

    const fakeFetch: FetchFn = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body || "");
      return new Response(
        JSON.stringify({
          workItems: [
            { id: 101, url: "https://dev.azure.com/org/_apis/wit/workItems/101" },
            { id: 102, url: "https://dev.azure.com/org/_apis/wit/workItems/102" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetch: fakeFetch,
    });

    const result = await client.queryWorkItems(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
      { project: "core-proj" },
    );

    expect(requestedUrl).toContain("my-org/core-proj/_apis/wit/wiql");
    expect(requestedBody).toContain("SELECT [System.Id]");
    expect(result.length).toBe(2);
    expect(result[0].id).toBe(101);
    expect(result[1].id).toBe(102);
  });

  test("getWorkItems retrieves multiple work items with expanded fields", async () => {
    let requestedUrl = "";

    const fakeFetch: FetchFn = async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          value: [
            {
              id: 101,
              url: "https://dev.azure.com/org/_apis/wit/workItems/101",
              fields: {
                "System.Id": 101,
                "System.Title": "Implement idempotency keys",
                "System.WorkItemType": "Issue",
                "System.State": "Active",
                "System.TeamProject": "core-proj",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetch: fakeFetch,
    });

    const items = await client.getWorkItems([101], { project: "core-proj" });
    expect(requestedUrl).toContain("ids=101");
    expect(requestedUrl).toContain("$expand=all");
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(101);
    expect(items[0].fields["System.Title"]).toBe("Implement idempotency keys");
  });

  test("getWorkItem retrieves single work item by ID", async () => {
    let requestedUrl = "";

    const fakeFetch: FetchFn = async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          id: 101,
          url: "https://dev.azure.com/org/_apis/wit/workItems/101",
          fields: {
            "System.Id": 101,
            "System.Title": "Implement idempotency keys",
            "System.WorkItemType": "Issue",
            "System.State": "Active",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = createAzureDevOps({
      organization: "my-org",
      token: "secret-token",
      fetch: fakeFetch,
    });

    const item = await client.getWorkItem(101, { project: "core-proj" });
    expect(requestedUrl).toContain("core-proj/_apis/wit/workitems/101");
    expect(item.id).toBe(101);
    expect(item.fields["System.Title"]).toBe("Implement idempotency keys");
  });
});
