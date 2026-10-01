import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as credentials from "../../src/credentials";
import * as github from "../../src/github";
import * as inventory from "../../src/inventory";
import * as workitem from "../../src/workitem";
import * as pr from "../../src/pr";
import * as mirror from "../../src/mirror";
import * as labels from "../../src/labels";
import * as ws from "../../src/ws";
import { GitError } from "../../src/git";
import { resolveConfig } from "../../src/config";
import { syncProviderInventories, syncRoot } from "../../src/sync";

const restorers: Array<() => void> = [];
function restoreLater(spy: { mockRestore(): void }) {
  restorers.push(() => spy.mockRestore());
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dev-sync-failure-"));
});
afterEach(async () => {
  for (const restore of restorers.splice(0).reverse()) restore();
  await rm(root, { recursive: true, force: true });
});

describe("nested sync failure codes", () => {
  test("provider failures retain semantic codes while healthy inventory lands in order", async () => {
    const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });
    config.providers = [
      { id: "limited", type: "github", owner: "limited" },
      { id: "healthy", type: "github", owner: "healthy" },
      { id: "missing-credential", type: "azure_devops", organization: "sample-org" },
    ];
    restoreLater(
      spyOn(credentials, "resolveGitHubCredential").mockResolvedValue({
        kind: "token",
        token: "fixture",
        source: "config",
      }),
    );
    restoreLater(
      spyOn(credentials, "resolveAzureDevOpsCredential").mockRejectedValue(
        new credentials.CredentialError("CREDENTIAL_NOT_AVAILABLE", "Sign in to the provider"),
      ),
    );
    restoreLater(
      spyOn(github, "syncGitHubInventory").mockImplementation(async ({ owner }) => {
        if (owner === "limited") {
          throw new github.GitHubError("RATE_LIMITED", "Try after the rate limit resets", {
            status: 429,
            details: { body: "" },
          });
        }
        return {
          tenant: owner,
          total: 1,
          added: 1,
          updated: 0,
          removed: 0,
          cachePath: "healthy.jsonl",
          repositories: [],
          fetched: [],
        };
      }),
    );

    const result = await syncProviderInventories(config, config.providers);

    expect(result.results.map((item) => item.providerId)).toEqual(["healthy"]);
    expect(result.errors).toEqual([
      {
        providerId: "limited",
        phase: "inventory",
        code: "RATE_LIMITED",
        message: "[limited] Try after the rate limit resets",
      },
      {
        providerId: "missing-credential",
        phase: "credential",
        code: "CREDENTIAL_NOT_AVAILABLE",
        message: "[missing-credential] Sign in to the provider",
      },
    ]);
  });

  test("root aggregates nested data, refresh, label and exception skips without business skips", async () => {
    const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });
    config.providers = [
      { id: "sample", type: "azure_devops", organization: "sample-org", project: "sample-project" },
    ];
    restoreLater(
      spyOn(credentials, "resolveAzureDevOpsCredential").mockResolvedValue({
        kind: "pat",
        token: "fixture",
        source: "config",
      }),
    );
    restoreLater(
      spyOn(inventory, "syncInventory").mockResolvedValue({
        tenant: "dev.azure.com/sample-org",
        total: 2,
        added: 2,
        updated: 0,
        removed: 0,
        cachePath: "inventory.jsonl",
        repositories: [],
        fetched: ["failed", "healthy"].map((name) => ({
          id: name,
          name,
          project: "sample-project",
          url: `https://example.org/${name}`,
          default_branch: "main",
          description: "",
          last_changed: "",
          syncedAt: "",
        })),
      }),
    );
    restoreLater(
      spyOn(workitem, "syncWorkItems").mockRejectedValue(
        new credentials.CredentialError("CREDENTIAL_NOT_AVAILABLE", "Refresh the provider session"),
      ),
    );
    restoreLater(
      spyOn(pr, "syncPullRequests").mockImplementation(async ({ tenant, repo }) => {
        if (repo === "failed") {
          throw new github.GitHubError("RATE_LIMITED", "Try later", {
            status: 429,
            details: { body: "" },
          });
        }
        return {
          tenant,
          repo,
          total: 1,
          added: 1,
          updated: 0,
          cachePath: "pr.jsonl",
          prs: [],
          truncated: false,
        };
      }),
    );
    restoreLater(
      spyOn(labels, "ensureLabelMirrors").mockResolvedValue({
        created: [],
        failures: [
          {
            url: "https://example.org/missing",
            code: "AUTH_FAILED",
            reason: "Sign in before cloning",
          },
        ],
      }),
    );
    restoreLater(
      spyOn(mirror, "sync").mockResolvedValue({
        updated: [],
        stashed: [],
        trace: { totalMs: 0, stages: [], slowestItems: [] },
        refreshFailures: [
          { path: "pool.git", code: "NOT_FOUND", reason: "Remote repository is missing" },
        ],
        skipped: [
          {
            path: "failed-checkout",
            branch: "main",
            status: "skipped",
            code: "REF_NOT_FOUND",
            reason: "FAST_FORWARD_FAILED: Branch is missing",
          },
          { path: "healthy-checkout", branch: "main", status: "skipped", reason: "UP_TO_DATE" },
        ],
      }),
    );
    restoreLater(spyOn(ws, "list").mockResolvedValue([]));

    const result = await syncRoot(config, {});

    expect(result.phases.providers?.ok).toBe(true);
    if (!result.phases.providers?.ok) throw new Error("provider phase unexpectedly failed");
    expect(result.phases.providers.result.data[0].pullRequests.map((item) => item.repo)).toEqual([
      "healthy",
    ]);
    expect(result.phases.providers.result.data[0].errors).toEqual([
      {
        phase: "workItems",
        code: "CREDENTIAL_NOT_AVAILABLE",
        message: "Work item sync error: Refresh the provider session",
      },
      {
        phase: "pullRequests",
        repository: "failed",
        code: "RATE_LIMITED",
        message: "Pull request sync error for failed: Try later",
      },
    ]);
    expect(result.failures).toEqual([
      {
        component: "providers",
        code: "CREDENTIAL_NOT_AVAILABLE",
        message: "[sample] Work item sync error: Refresh the provider session",
      },
      {
        component: "providers",
        code: "RATE_LIMITED",
        message: "[sample] Pull request sync error for failed: Try later",
      },
      {
        component: "mirrors",
        code: "NOT_FOUND",
        message: "pool.git: Remote repository is missing",
      },
      {
        component: "mirrors",
        code: "AUTH_FAILED",
        message: "https://example.org/missing: Sign in before cloning",
      },
      {
        component: "mirrors",
        code: "REF_NOT_FOUND",
        message: "failed-checkout: FAST_FORWARD_FAILED: Branch is missing",
      },
    ]);
  });

  test("label mirror clone failures retain codes and later successful mirrors", async () => {
    const config = resolveConfig({ rootFlag: root, cwd: root, env: {} });
    config.sources = [
      { url: "https://example.org/failed", labels: { "index:docs": {} } },
      { url: "https://example.org/healthy", labels: { "index:docs": {} } },
    ];
    restoreLater(
      spyOn(mirror, "ensure").mockImplementation(async ({ source }) => {
        if (source.endsWith("failed")) {
          throw new GitError("AUTH_FAILED", "Sign in before cloning", { args: [], stderr: "" });
        }
        return {
          sourceKey: "healthy",
          canonicalUrl: source,
          branch: "main",
          path: "healthy-checkout",
          created: true,
        };
      }),
    );

    const result = await labels.ensureLabelMirrors(config);

    expect(result.failures).toEqual([
      { url: "https://example.org/failed", code: "AUTH_FAILED", reason: "Sign in before cloning" },
    ]);
    expect(result.created).toEqual([
      {
        url: "https://example.org/healthy",
        branch: "main",
        path: "healthy-checkout",
        labels: ["index:docs"],
      },
    ]);
  });
});
