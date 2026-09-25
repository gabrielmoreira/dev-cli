import { describe, expect, test } from "bun:test";
import {
  createGitHubClient,
  normalizeGitHubRepository,
  type GitHubRawRepository,
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
