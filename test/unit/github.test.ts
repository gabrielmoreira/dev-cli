import { describe, expect, test } from "bun:test";
import {
  createGitHubClient,
  normalizeGitHubRepository,
  normalizeGitHubPullRequest,
  type GitHubRawRepository,
  type GitHubRawPullRequest,
} from "../../src/github";

describe("GitHub Client and Normalization (Phase 15)", () => {
  test("normalizeGitHubRepository converts GitHub API payload to canonical InventoryRecord", () => {
    const raw: GitHubRawRepository = {
      id: 987654,
      name: "tiny-ops",
      full_name: "example-owner/tiny-ops",
      html_url: "https://github.com/example-owner/tiny-ops",
      clone_url: "https://github.com/example-owner/tiny-ops.git",
      default_branch: "main",
      description: "TypeScript-first operation graph runtime",
      pushed_at: "2026-09-14T10:00:00Z",
      updated_at: "2026-09-14T12:00:00Z",
    };

    const record = normalizeGitHubRepository(raw, "2026-09-15T12:00:00Z");

    expect(record.id).toBe("987654");
    expect(record.name).toBe("tiny-ops");
    expect(record.url).toBe("https://github.com/example-owner/tiny-ops.git");
    expect(record.default_branch).toBe("main");
    expect(record.description).toBe("TypeScript-first operation graph runtime");
    expect(record.last_changed).toBe("2026-09-14T10:00:00Z");
    expect(record.syncedAt).toBe("2026-09-15T12:00:00Z");
  });

  test("normalizeGitHubPullRequest converts GitHub PR payload to canonical PullRequestRecord", () => {
    const openRaw: GitHubRawPullRequest = {
      id: 111,
      number: 42,
      title: "Add operation graph compiler",
      state: "open",
      merged_at: null,
      html_url: "https://github.com/example-owner/tiny-ops/pull/42",
      head: { ref: "feature/compiler", sha: "abc1234" },
      base: { ref: "main", sha: "def5678" },
      user: { login: "example-owner" },
      created_at: "2026-09-10T14:00:00Z",
      updated_at: "2026-09-11T16:00:00Z",
    };

    const openRecord = normalizeGitHubPullRequest(openRaw, "tiny-ops", "2026-09-15T12:00:00Z");
    expect(openRecord.id).toBe(42);
    expect(openRecord.title).toBe("Add operation graph compiler");
    expect(openRecord.status).toBe("open");
    expect(openRecord.sourceBranch).toBe("feature/compiler");
    expect(openRecord.targetBranch).toBe("main");
    expect(openRecord.author).toBe("example-owner");
    expect(openRecord.tenant).toBe("github.com");
    expect(openRecord.repository).toBe("tiny-ops");

    const mergedRaw: GitHubRawPullRequest = {
      ...openRaw,
      number: 43,
      state: "closed",
      merged_at: "2026-09-12T10:00:00Z",
    };
    const mergedRecord = normalizeGitHubPullRequest(mergedRaw, "tiny-ops", "2026-09-15T12:00:00Z");
    expect(mergedRecord.status).toBe("completed");

    const abandonedRaw: GitHubRawPullRequest = {
      ...openRaw,
      number: 44,
      state: "closed",
      merged_at: null,
    };
    const abandonedRecord = normalizeGitHubPullRequest(
      abandonedRaw,
      "tiny-ops",
      "2026-09-15T12:00:00Z",
    );
    expect(abandonedRecord.status).toBe("abandoned");
  });

  test("createGitHubClient sends proper Authorization and User-Agent headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(JSON.stringify([{ id: 1, name: "repo-a", default_branch: "main" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = createGitHubClient({
      token: "example-token",
      fetch: customFetch,
    });

    const repos = await client.listRepositories("example-owner");
    expect(capturedUrl).toContain("https://api.github.com/users/example-owner/repos");
    expect(capturedHeaders["Authorization"]).toBe("Bearer example-token");
    expect(capturedHeaders["User-Agent"]).toBe("dev-cli");
    expect(repos.length).toBe(1);
    expect(repos[0].name).toBe("repo-a");
  });
});
