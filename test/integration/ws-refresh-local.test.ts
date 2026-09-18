import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as ws from "../../src/ws.ts";

describe("Local workspace refresh & offline guarantee (Phase 4)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  let seedDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-refresh-root-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-refresh-bare-"));
    seedDir = await mkdtemp(join(tmpdir(), "dev-cli-refresh-seed-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Refresh Tester"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "refresh@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "commit 1");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: commit 1"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
    await rm(bareRemotePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => {});
    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("distinguishes local status from refreshed upstream state and guarantees offline isolation", async () => {
    // 1. Initialize workspace and mount repository
    await ws.init({ root: tempRoot, name: "sync-ws" });
    await ws.add({
      root: tempRoot,
      workspaceName: "sync-ws",
      source: bareRemotePath,
      branch: "main",
    });

    // 2. Advance remote from seed clone
    await fs.writeText(join(seedDir, "file.txt"), "commit 2 (remote advance)");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: commit 2 upstream"], { cwd: seedDir });
    await git.runGit(["push", "origin", "main"], { cwd: seedDir });

    // 3. Normal status (default): MUST NOT contact remote or fetch
    const localStatus = await ws.status({
      root: tempRoot,
      workspaceName: "sync-ws",
    });
    expect(localStatus.mounts[0].state).toBe("clean");
    expect(localStatus.mounts[0].observed.behindCount).toBe(0);

    // 4. Offline status: MUST NOT contact remote
    const offlineStatus = await ws.status({
      root: tempRoot,
      workspaceName: "sync-ws",
      offline: true,
    });
    expect(offlineStatus.mounts[0].state).toBe("clean");
    expect(offlineStatus.mounts[0].observed.behindCount).toBe(0);

    // 5. Refreshed status: Contacts remote and detects new upstream commit
    const refreshedStatus = await ws.status({
      root: tempRoot,
      workspaceName: "sync-ws",
      refresh: true,
    });
    expect(refreshedStatus.mounts[0].state).toBe("behind");
    expect(refreshedStatus.mounts[0].observed.behindCount).toBe(1);
    expect(refreshedStatus.mounts[0].messages[0]).toContain("Behind upstream by 1 commit(s)");
  });
});
