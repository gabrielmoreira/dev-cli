import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdoFixture, type AdoFixtureConfig } from "../fixtures/ado-fixture.ts";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

describe("Azure DevOps workspace status refresh integration (Phase 4)", () => {
  let tempRoot: string;
  let fixture: AdoFixtureConfig;

  beforeAll(async () => {
    fixture = await ensureAdoFixture();
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-ado-refresh-root-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("detects remote Azure DevOps commits when refreshed and remains local by default", async () => {
    const basic = Buffer.from(`:${fixture.pat}`).toString("base64");
    const extraHeader = `http.extraheader=AUTHORIZATION: basic ${basic}`;

    // 1. Initialize workspace and mount alpha-service feature/payments branch
    await ws.init({ root: tempRoot, name: "ado-sync-ws" });
    await ws.add({
      root: tempRoot,
      workspaceName: "ado-sync-ws",
      source: fixture.gitUrl,
      branch: "feature/payments",
      extraHeader,
    });

    // 2. Advance remote feature/payments branch via temporary seed clone
    const seedDir = await mkdtemp(join(tmpdir(), "ado-advancer-"));
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
      await git.runGit(["config", "user.name", "ADO Refresh Advancer"], { cwd: seedDir });
      await git.runGit(["config", "user.email", "ado-advancer@example.com"], { cwd: seedDir });

      await fs.writeText(join(seedDir, "advance.txt"), `advanced at ${Date.now()}`);
      await git.runGit(["add", "."], { cwd: seedDir });
      await git.runGit(["commit", "-m", "feat: advance feature/payments upstream"], {
        cwd: seedDir,
      });
      await git.runGit(["-c", extraHeader, "push", "origin", "feature/payments"], { cwd: seedDir });
    } finally {
      await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
    }

    // 3. Normal status without refresh: MUST stay local and clean
    const localStatus = await ws.status({
      root: tempRoot,
      workspaceName: "ado-sync-ws",
    });
    expect(localStatus.mounts[0].state).toBe("clean");
    expect(localStatus.mounts[0].observed.behindCount).toBe(0);

    // 4. Refreshed status: Contacts Azure DevOps and detects upstream change
    const refreshedStatus = await ws.status({
      root: tempRoot,
      workspaceName: "ado-sync-ws",
      refresh: true,
      resolveExtraHeader: async () => extraHeader,
    });
    expect(refreshedStatus.mounts[0].state).toBe("behind");
    expect(refreshedStatus.mounts[0].observed.behindCount).toBeGreaterThanOrEqual(1);
  }, 60000);
});
