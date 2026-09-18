import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdoFixture, type AdoFixtureConfig } from "../fixtures/ado-fixture.ts";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

describe("Azure DevOps workspace safe update integration (Phase 5)", () => {
  let tempRoot: string;
  let fixture: AdoFixtureConfig;

  beforeAll(async () => {
    fixture = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-ado-update-root-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("fast-forwards a workspace mount from real Azure DevOps remote when new commits exist", async () => {
    const basic = Buffer.from(`:${fixture.pat}`).toString("base64");
    const extraHeader = `http.extraheader=AUTHORIZATION: basic ${basic}`;

    // 1. Initialize workspace and mount alpha-service feature/payments branch
    await ws.init({ root: tempRoot, name: "ado-up-ws" });
    await ws.add({
      root: tempRoot,
      workspaceName: "ado-up-ws",
      source: fixture.gitUrl,
      branch: "feature/payments",
      extraHeader,
    });

    // 2. Advance remote feature/payments branch via temporary seed clone
    const seedDir = await mkdtemp(join(tmpdir(), "ado-update-advancer-"));
    const uniqueFile = `update-${Date.now()}.txt`;
    try {
      await git.runGit([
        "clone",
        "-c",
        extraHeader,
        "--branch",
        "feature/payments",
        fixture.gitUrl,
        seedDir,
      ]);
      await git.runGit(["config", "user.name", "ADO Update Advancer"], { cwd: seedDir });
      await git.runGit(["config", "user.email", "ado-updater@example.com"], { cwd: seedDir });

      await fs.writeText(join(seedDir, uniqueFile), `unique content ${Date.now()}`);
      await git.runGit(["add", "."], { cwd: seedDir });
      await git.runGit(["commit", "-m", "feat: advance feature/payments for update test"], {
        cwd: seedDir,
      });
      await git.runGit(["-c", extraHeader, "push", "origin", "feature/payments"], {
        cwd: seedDir,
      });
    } finally {
      await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
    }

    // 3. Execute safe update with refresh
    const updateResult = await ws.update({
      root: tempRoot,
      workspaceName: "ado-up-ws",
      refresh: true,
      resolveExtraHeader: async () => extraHeader,
    });

    expect(updateResult.summary.total).toBe(1);
    expect(updateResult.summary.updated).toBe(1);
    expect(updateResult.summary.skipped).toBe(0);

    const mountRes = updateResult.mounts[0];
    expect(mountRes.action).toBe("fast_forward");
    expect(mountRes.newCommit).not.toBe(mountRes.previousCommit);

    // 4. Verify file exists in mount worktree
    const updatedFilePath = join(tempRoot, "ws", "ado-up-ws", "alpha-service", uniqueFile);
    expect(fs.exists(updatedFilePath)).toBe(true);
  }, 60000);
});
