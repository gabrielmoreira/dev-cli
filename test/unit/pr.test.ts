import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeAdoPullRequest,
  mapAdoPrStatus,
  mergePullRequestRecords,
  syncPullRequests,
  refreshProjectPullRequests,
  type PullRequestRecord,
} from "../../src/pr";
import { writePullRequests, readPullRequests, resolvePrCachePath } from "../../src/cache";
import type { AdoPullRequest, AzureDevOpsClient } from "../../src/ado";

describe("Pull Request Orchestration and Normalization (Phase 12)", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-pr-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("mapAdoPrStatus maps ADO status strings to canonical states", () => {
    expect(mapAdoPrStatus("active")).toBe("open");
    expect(mapAdoPrStatus("completed")).toBe("completed");
    expect(mapAdoPrStatus("abandoned")).toBe("abandoned");
    expect(mapAdoPrStatus("unknown")).toBe("open");
  });

  test("normalizeAdoPullRequest converts ADO PR to canonical PullRequestRecord", () => {
    const raw: AdoPullRequest = {
      pullRequestId: 42,
      status: "active",
      title: "Add payments integration",
      description: "Detailed description",
      sourceRefName: "refs/heads/feature/payments",
      targetRefName: "refs/heads/main",
      creationDate: "2026-09-14T20:00:00Z",
      url: "https://dev.azure.com/my-org/p1/_apis/git/repositories/alpha/pullRequests/42",
      isDraft: false,
      createdBy: {
        displayName: "Alice Dev",
        uniqueName: "alice@example.com",
      },
    };

    const record = normalizeAdoPullRequest(
      raw,
      "dev.azure.com/my-org",
      "alpha-service",
      "2026-09-14T21:00:00Z",
    );

    expect(record.id).toBe(42);
    expect(record.title).toBe("Add payments integration");
    expect(record.description).toBe("Detailed description");
    expect(record.status).toBe("open");
    expect(record.sourceBranch).toBe("feature/payments");
    expect(record.targetBranch).toBe("main");
    expect(record.author).toBe("Alice Dev");
    expect(record.repository).toBe("alpha-service");
    expect(record.tenant).toBe("dev.azure.com/my-org");
    expect(record.syncedAt).toBe("2026-09-14T21:00:00Z");
  });

  test("a pull request links to its browser page, not the REST resource", () => {
    const listed: AdoPullRequest = {
      pullRequestId: 7,
      status: "active",
      title: "t",
      sourceRefName: "refs/heads/f",
      targetRefName: "refs/heads/main",
      creationDate: "2026-09-14T20:00:00Z",
      url: "https://dev.azure.com/my-org/0f1e/_apis/git/repositories/9a8b/pullRequests/7",
      repository: { id: "9a8b", name: "alpha service", project: { id: "0f1e", name: "Pay Ments" } },
    };
    expect(normalizeAdoPullRequest(listed, "t", "r").url).toBe(
      "https://dev.azure.com/my-org/Pay%20Ments/_git/alpha%20service/pullrequest/7",
    );

    const read = {
      ...listed,
      repository: { id: "9a8b", name: "a", webUrl: "https://dev.azure.com/my-org/P/_git/a" },
    };
    expect(normalizeAdoPullRequest(read, "t", "r").url).toBe(
      "https://dev.azure.com/my-org/P/_git/a/pullrequest/7",
    );

    // Without a project to name, the REST URL is still a working link for scripts.
    const bare = { ...listed, repository: { id: "9a8b", name: "a" } };
    expect(normalizeAdoPullRequest(bare, "t", "r").url).toBe(listed.url);
  });

  test("mergePullRequestRecords updates existing records and appends new", () => {
    const existing: PullRequestRecord[] = [
      {
        id: 1,
        title: "PR One",
        description: "",
        status: "open",
        sourceBranch: "feat-1",
        targetBranch: "main",
        author: "Dev",
        url: "https://example.com/1",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        isDraft: false,
        repository: "alpha",
        tenant: "tenant-1",
        syncedAt: "2026-01-01",
      },
    ];

    const incoming: PullRequestRecord[] = [
      {
        id: 1, // updated status
        title: "PR One - Completed",
        description: "",
        status: "completed",
        sourceBranch: "feat-1",
        targetBranch: "main",
        author: "Dev",
        url: "https://example.com/1",
        createdAt: "2026-01-01",
        updatedAt: "2026-09-14",
        isDraft: false,
        repository: "alpha",
        tenant: "tenant-1",
        syncedAt: "2026-09-14",
      },
      {
        id: 2, // new
        title: "PR Two",
        description: "",
        status: "open",
        sourceBranch: "feat-2",
        targetBranch: "main",
        author: "Dev",
        url: "https://example.com/2",
        createdAt: "2026-09-14",
        updatedAt: "2026-09-14",
        isDraft: false,
        repository: "alpha",
        tenant: "tenant-1",
        syncedAt: "2026-09-14",
      },
    ];

    const merged = mergePullRequestRecords(existing, incoming);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(2); // sorted descending by ID
    expect(merged[1].id).toBe(1);
    expect(merged[1].status).toBe("completed");
  });

  test("writePullRequests and readPullRequests roundtrip via cache", async () => {
    const records: PullRequestRecord[] = [
      {
        id: 10,
        title: "PR 10",
        description: "Test description",
        status: "open",
        sourceBranch: "b1",
        targetBranch: "main",
        author: "User",
        url: "https://example.com/10",
        createdAt: "2026-09-14T20:00:00Z",
        updatedAt: "2026-09-14T20:00:00Z",
        isDraft: false,
        repository: "alpha-service",
        tenant: "dev.azure.com/example-org",
        syncedAt: "2026-09-14T21:00:00Z",
      },
    ];

    const cachePath = await writePullRequests({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      repo: "alpha-service",
      records,
    });

    const expectedPath = resolvePrCachePath(tempRoot, "dev.azure.com/example-org", "alpha-service");
    expect(cachePath).toBe(expectedPath);

    const read = await readPullRequests({
      root: tempRoot,
      tenant: "dev.azure.com/example-org",
      repo: "alpha-service",
    });

    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(records[0]);
  });

  test("syncPullRequests orchestrates fetch, merge, and cache persistence", async () => {
    const fakeClient: Pick<AzureDevOpsClient, "listPullRequests" | "getPullRequest"> = {
      listPullRequests: async () => [
        {
          pullRequestId: 100,
          status: "active",
          title: "Feature X",
          sourceRefName: "refs/heads/feat-x",
          targetRefName: "refs/heads/main",
          creationDate: "2026-09-14T20:00:00Z",
          url: "https://dev.azure.com/org/p/_apis/git/repositories/alpha/pullRequests/100",
        },
      ],
      getPullRequest: async () => {
        throw new Error("not implemented");
      },
    };

    const result = await syncPullRequests({
      root: tempRoot,
      tenant: "dev.azure.com/my-org",
      repo: "alpha-service",
      client: fakeClient,
    });

    expect(result.total).toBe(1);
    expect(result.added).toBe(1);
    expect(result.prs[0].id).toBe(100);
    expect(result.prs[0].status).toBe("open");

    const cached = await readPullRequests({
      root: tempRoot,
      tenant: "dev.azure.com/my-org",
      repo: "alpha-service",
    });

    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe(100);
  });

  test("an open-only sync drops cached open pull requests that were closed since", async () => {
    const active = (pullRequestId: number, isDraft = false) => ({
      pullRequestId,
      status: "active",
      title: `PR ${pullRequestId}`,
      isDraft,
      creationDate: "2026-09-14T20:00:00Z",
      url: `https://dev.azure.com/org/p/_apis/git/pullRequests/${pullRequestId}`,
    });
    let open = [active(1), active(2)];
    const client = {
      listPullRequests: async () => open,
    } as unknown as Pick<AzureDevOpsClient, "listPullRequests" | "getPullRequest">;
    const input = { root: tempRoot, tenant: "t", repo: "r", status: "open" as const, client };

    await syncPullRequests(input);
    open = [active(2, true)];
    const result = await syncPullRequests(input);

    const cached = await readPullRequests({ root: tempRoot, tenant: "t", repo: "r" });
    expect(cached.map((pr) => pr.id)).toEqual([2]);
    expect(cached[0].isDraft).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test("refreshes distinct projects for pull requests the user wrote or reviews, once each", async () => {
    const calls: Array<{ project: string; creatorId?: string; reviewerId?: string }> = [];
    const fakeClient: Pick<AzureDevOpsClient, "getCurrentUser" | "listProjectPullRequests"> = {
      getCurrentUser: async () => ({ id: "reviewer-1", displayName: "Current User" }),
      listProjectPullRequests: async (project, options) => {
        calls.push({ project, creatorId: options?.creatorId, reviewerId: options?.reviewerId });
        return project === "Payments"
          ? [
              {
                pullRequestId: 42,
                status: "active",
                title: "Review payment change",
                sourceRefName: "refs/heads/feature",
                targetRefName: "refs/heads/main",
                creationDate: "2026-09-16T00:00:00Z",
                url: "https://dev.azure.com/org/Payments/_apis/git/repositories/repo-1/pullRequests/42",
                repository: { id: "repo-1", name: "payments-api" },
              },
            ]
          : [];
      },
    };

    const records = await refreshProjectPullRequests({
      root: tempRoot,
      tenant: "dev.azure.com/org",
      projects: ["Payments", "Identity", "Payments"],
      mine: true,
      status: "open",
      client: fakeClient,
    });

    expect(calls).toEqual([
      { project: "Payments", creatorId: "reviewer-1", reviewerId: undefined },
      { project: "Payments", creatorId: undefined, reviewerId: "reviewer-1" },
      { project: "Identity", creatorId: "reviewer-1", reviewerId: undefined },
      { project: "Identity", creatorId: undefined, reviewerId: "reviewer-1" },
    ]);
    expect(records.map((record) => record.repository)).toEqual(["payments-api"]);
    expect(
      await readPullRequests({ root: tempRoot, tenant: "dev.azure.com/org", repo: "payments-api" }),
    ).toHaveLength(1);
  });

  test("closed asks the provider for every status and keeps only completed and abandoned", async () => {
    const statuses: Array<string | undefined> = [];
    const raw = (pullRequestId: number, status: string): AdoPullRequest => ({
      pullRequestId,
      status,
      title: `PR ${pullRequestId}`,
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      creationDate: "2026-09-16T00:00:00Z",
      url: `https://dev.azure.com/org/P/_apis/git/repositories/r/pullRequests/${pullRequestId}`,
      repository: { id: "r", name: "repo" },
    });
    const client: Pick<AzureDevOpsClient, "getCurrentUser" | "listProjectPullRequests"> = {
      getCurrentUser: async () => ({ id: "me", displayName: "Me" }),
      listProjectPullRequests: async (_project, options) => {
        statuses.push(options?.status);
        return [raw(3, "active"), raw(2, "completed"), raw(1, "abandoned")];
      },
    };

    const records = await refreshProjectPullRequests({
      root: tempRoot,
      tenant: "dev.azure.com/org",
      projects: ["P"],
      mine: false,
      status: "closed",
      client,
    });

    expect(statuses).toEqual(["all"]);
    expect(records.map((record) => [record.id, record.status])).toEqual([
      [2, "completed"],
      [1, "abandoned"],
    ]);
  });
});
