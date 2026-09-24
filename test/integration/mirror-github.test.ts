import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as mirror from "../../src/mirror.ts";

describe("Canonical repository GitHub smoke test (Phase 8)", () => {
  let tempRoot: string;
  const publicGithubRepo = "https://github.com/octocat/Hello-World.git";

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-repo-gh-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("adds a public GitHub repository under github.com/octocat", async () => {
    const addRes = await mirror.ensure({
      root: tempRoot,
      source: publicGithubRepo,
    });

    expect("readOnly" in addRes).toBe(false);
    expect(fs.exists(addRes.path)).toBe(true);

    // Verify canonical hierarchy for the public fixture
    expect(addRes.path.replace(/\\/g, "/")).toContain("mirrors/github.com/octocat/Hello-World");

    // Verify list
    const list = await mirror.list({ root: tempRoot });
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("Hello-World");
  }, 60000);
});
