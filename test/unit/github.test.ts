import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventory, writeInventory } from "../../src/cache";
import {
  createGitHubClient,
  GitHubError,
  normalizeGitHubRepository,
  syncGitHubInventory,
  type GitHubRawRepository,
} from "../../src/github";

async function failureFrom<
  E extends Error = Error & {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
  },
>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error("expected rejection, got resolve");
}

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

  test("leaves an omitted default branch unknown", () => {
    const record = normalizeGitHubRepository({ id: 1, name: "sample-api" });
    expect(record.default_branch).toBeUndefined();
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

  test.each([
    { status: 401, headers: {}, code: "AUTH_FAILED" },
    { status: 404, headers: {}, code: "NOT_FOUND" },
    { status: 403, headers: { "x-ratelimit-remaining": "0" }, code: "RATE_LIMITED" },
    { status: 429, headers: {}, code: "RATE_LIMITED" },
    { status: 503, headers: {}, code: "NETWORK" },
    { status: 403, headers: {}, code: "FAILED" },
    { status: 422, headers: {}, code: "FAILED" },
  ])(
    "classifies HTTP $status as $code without exposing the body",
    async ({ status, headers, code }) => {
      const body = '{"message":"provider diagnostic"}\nprivate response';
      const client = createGitHubClient({
        fetch: (async (_url: string | URL | Request) =>
          new Response(body, { status, headers })) as typeof fetch,
      });
      const error = await failureFrom<GitHubError>(
        client.getRepository("example-org", "sample-api"),
      );
      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(GitHubError);
      expect(error.status).toBe(status);
      expect(error.details?.body).toBe(body);
      expect(error.message).toContain(String(status));
      expect(error.message).not.toContain("provider diagnostic");
      expect(error.message).not.toContain("private response");
      expect(error.message.split(/\r?\n/)).toHaveLength(1);
    },
  );

  test("classifies rejected requests without exposing their credentials", async () => {
    const client = createGitHubClient({
      token: "example-secret",
      fetch: (async (_url: string | URL | Request): Promise<Response> => {
        throw new Error("Authorization: Bearer example-secret");
      }) as typeof fetch,
    });
    const error = await failureFrom<GitHubError>(client.getRepository("example-org", "sample-api"));
    expect(error.code).toBe("NETWORK");
    expect(error.status).toBe(0);
    expect(error.details?.body).toBe("");
    expect(error.message).toBe("GitHub: network request failed.");
  });

  test("strips tokens, authorization headers, and URL userinfo from response details", async () => {
    const body =
      'Authorization: Bearer header-secret\nhttps://user:url-secret@example.org/repo\n{"echo":"example-secret"}';
    const client = createGitHubClient({
      token: "example-secret",
      fetch: (async (_url: string | URL | Request) =>
        new Response(body, { status: 401 })) as typeof fetch,
    });
    const error = await failureFrom<GitHubError>(client.getRepository("example-org", "sample-api"));
    expect(error.code).toBe("AUTH_FAILED");
    for (const secret of ["example-secret", "header-secret", "url-secret"]) {
      expect(error.message).not.toContain(secret);
      expect(error.details?.body).not.toContain(secret);
    }
    expect(error.details?.body).toContain("https://example.org/repo");
  });
});
