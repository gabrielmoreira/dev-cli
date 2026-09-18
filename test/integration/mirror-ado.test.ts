import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdoFixture, type AdoFixtureConfig } from "../fixtures/ado-fixture.ts";
import * as fs from "../../src/fs.ts";
import * as mirror from "../../src/mirror.ts";
import { gitPoolPath } from "../../src/paths.ts";

describe("Canonical repository Azure DevOps integration (Phase 8)", () => {
  let tempRoot: string;
  let fixture: AdoFixtureConfig;
  let extraHeader: string;

  beforeAll(async () => {
    fixture = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-repo-ado-"));
    const basic = Buffer.from(`:${fixture.pat}`).toString("base64");
    extraHeader = `http.extraheader=AUTHORIZATION: basic ${basic}`;
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("adds real Azure DevOps alpha-service as a canonical repository", async () => {
    const addRes = await mirror.add({
      root: tempRoot,
      source: fixture.gitUrl,
      branch: "main",
      extraHeader,
    });

    expect("readOnly" in addRes).toBe(false);
    expect(fs.exists(addRes.path)).toBe(true);
    expect(fs.exists(join(addRes.path, "README.md"))).toBe(true);

    // Verify central mirror and canonical admin clone
    const mirrorPath = gitPoolPath({ root: tempRoot, source: fixture.gitUrl });
    const adminRepoPath = join(tempRoot, ".dev", "repos", `${addRes.sourceKey}.git`);
    expect(fs.exists(mirrorPath)).toBe(true);
    expect(fs.exists(adminRepoPath)).toBe(true);
  }, 60000);

  it("tracks secondary Azure DevOps fixture branch as a sibling canonical worktree", async () => {
    const trackRes = await mirror.track({
      root: tempRoot,
      source: fixture.gitUrl,
      branch: "feature/payments",
      extraHeader,
    });

    expect("readOnly" in trackRes).toBe(false);
    expect(trackRes.branch).toBe("feature/payments");
    expect(fs.exists(trackRes.path)).toBe(true);
    expect(fs.exists(join(trackRes.path, "payments.ts"))).toBe(true);

    const list = await mirror.list({ root: tempRoot });
    expect(list.length).toBe(2);
    expect(list.some((r) => r.branch === "main")).toBe(true);
    expect(list.some((r) => r.branch === "feature/payments")).toBe(true);
  }, 60000);

  it("syncs Azure DevOps canonical repository with remote refresh", async () => {
    const syncRes = await mirror.sync({
      root: tempRoot,
      source: fixture.gitUrl,
      refresh: true,
      resolveExtraHeader: async () => extraHeader,
    });

    // All branches are up-to-date and clean
    expect(syncRes.skipped.length).toBeGreaterThanOrEqual(1);
    for (const skipped of syncRes.skipped) {
      expect(skipped.reason).toBe("UP_TO_DATE");
    }
  }, 60000);
});
