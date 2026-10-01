import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventory, writeInventory } from "../../src/cache";
import {
  createGitHubClient,
  normalizeGitHubRepository,
  syncGitHubInventory,
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

  test("reads all repository pages before replacing inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-cli-github-pages-"));
    try {
      const existing = {
        id: "old",
        name: "removed-repository",
        url: "https://github.com/example-org/removed-repository.git",
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "2026-10-01T00:00:00Z",
      };
      await writeInventory({ root, tenant: "github.com/example-org", records: [existing] });
      const page = (start: number, count: number) =>
        Array.from({ length: count }, (_, offset) => {
          const id = start + offset;
          return {
            id,
            name: `sample-repo-${id}`,
            full_name: `example-org/sample-repo-${id}`,
            clone_url: `https://github.com/example-org/sample-repo-${id}.git`,
            default_branch: "main",
          };
        });
      const fetchPage = (async (url: string | URL | Request) => {
        const pageNumber = Number(new URL(String(url)).searchParams.get("page") ?? "1");
        const body = pageNumber === 1 ? page(0, 100) : page(100, 50);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const client = createGitHubClient({ token: "example-token", fetch: fetchPage });

      const result = await syncGitHubInventory({
        root,
        owner: "example-org",
        client,
        now: () => "2026-10-01T00:00:00Z",
      });
      const saved = await readInventory({ root, tenant: "github.com/example-org" });

      expect(result.total).toBe(150);
      expect(result.removed).toBe(1);
      expect(saved.map((repository) => repository.name)).toContain("sample-repo-149");
      expect(saved).toHaveLength(150);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
