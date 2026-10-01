import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as paths from "../../src/paths.ts";
import { planCanonicalCheckout } from "../../src/mirror.ts";

async function failureFrom(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected rejection, got resolve");
}

describe("derived path containment", () => {
  const root = resolve(tmpdir(), "sample-project-root");
  const checkout = {
    root,
    source: "https://example.org/sample-project/sample-api.git",
    branch: "main",
    defaultBranch: "main",
  };

  it("rejects escaping source, alias, prefix, workspace, and cache paths", async () => {
    const targets = [
      () => paths.gitPoolPath({ root, source: "https://example.org/../../../../outside.git" }),
      () => planCanonicalCheckout({ ...checkout, alias: "../../../../outside" }),
      () => planCanonicalCheckout({ ...checkout, canonicalPrefix: "../../../../outside" }),
      () => paths.workspacePath({ root, workspaceName: "../../../../outside" }),
      () => paths.workspacesDir({ root, workspacePrefix: "../outside" }),
      () => paths.checkoutsDir({ root, canonicalPrefix: "../outside" }),
      () => paths.canonicalAdminRepoPath({ root, sourceKey: "../../../../outside" }),
      () =>
        paths.workspaceAdminRepoPath({
          root,
          workspaceName: "../../../../outside",
          sourceKey: "sample",
        }),
      () =>
        paths.workspaceAdminRepoPath({
          root,
          workspaceName: "sample",
          sourceKey: "../../../../../outside",
        }),
      () => paths.inventoryCachePath({ root, segments: ["../../../../outside"] }),
      () => paths.prsCachePath({ root, segments: [], repo: "../../../../outside" }),
      () => paths.workItemsCachePath({ root, tenantSegments: [], project: "../../../../outside" }),
    ];
    for (const target of targets) {
      const error = await failureFrom(Promise.resolve().then(() => target()));
      expect(error.code).toBe("PATH_OUTSIDE_ROOT");
      expect(error).toMatchObject({ details: { root, target: expect.any(String) } });
    }
  });

  it("rejects absolute outside-root prefixes before planning checkouts", async () => {
    const outside = resolve(root, "..", "outside");
    for (const target of [
      () => paths.workspacesDir({ root, workspacePrefix: outside }),
      () => paths.checkoutsDir({ root, canonicalPrefix: outside }),
      () => planCanonicalCheckout({ ...checkout, canonicalPrefix: outside }),
    ]) {
      const error = await failureFrom(Promise.resolve().then(() => target()));
      expect(error.code).toBe("PATH_OUTSIDE_ROOT");
    }
  });

  it("preserves nested in-root paths and directories starting with two dots", () => {
    expect(paths.workspacePath({ root, workspaceName: "a" })).toBe(join(root, "ws", "a"));
    expect(
      planCanonicalCheckout({ ...checkout, canonicalPrefix: "mirrors/x/y" }).absolutePath,
    ).toBe(join(root, "mirrors", "x", "y", "example.org", "sample-project", "sample-api"));
    expect(paths.workspacesDir({ root, workspacePrefix: "..foo" })).toBe(join(root, "..foo"));
  });
});
