import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

describe("Workspace status local Git integration (Phase 3)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-ws-status-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-status-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-status-bare-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Status Tester"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "tester@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "status test content");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: base commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/alt"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "alt.txt"), "alt content");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: alt commit"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/alt"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/dirty"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "dirty-base.txt"), "dirty base");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: dirty base commit"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/dirty"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
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
  });

  it("accurately detects clean, dirty, wrong revision, and missing mounts", async () => {
    // 1. Initialize workspace
    await ws.init({ root: tempRoot, name: "my-status-ws" });

    // 2. Add clean mount
    await ws.add({
      root: tempRoot,
      workspaceName: "my-status-ws",
      source: bareRemotePath,
      path: "mount-clean",
      branch: "main",
    });

    // 3. Add mount that we will make dirty
    await ws.add({
      root: tempRoot,
      workspaceName: "my-status-ws",
      source: bareRemotePath,
      path: "mount-dirty",
      branch: "feature/dirty",
    });
    // Create an uncommitted file
    await fs.writeText(
      join(tempRoot, "ws", "my-status-ws", "mount-dirty", "dirty.txt"),
      "uncommitted",
    );

    // 4. Add mount that we will switch to wrong revision
    await ws.add({
      root: tempRoot,
      workspaceName: "my-status-ws",
      source: bareRemotePath,
      path: "mount-wrong",
      branch: "feature/alt",
    });
    // Detach HEAD to an older commit or switch branch
    await git.runGit([
      "-C",
      join(tempRoot, "ws", "my-status-ws", "mount-wrong"),
      "checkout",
      "--detach",
      "HEAD~1",
    ]);

    // 5. Add a declared mount in ws.md whose directory does not exist on disk
    const wsDir = join(tempRoot, "ws", "my-status-ws");
    const manifestPath = join(wsDir, "ws.md");
    const { manifest: currentManifest, body } = await manifest.readWorkspace(manifestPath);
    currentManifest.mounts.push({
      path: "mount-missing",
      source: bareRemotePath,
      revision: { mode: "track", branch: "main" },
    });
    await manifest.writeWorkspace(manifestPath, currentManifest, body);

    // Run ws.status
    const statusResult = await ws.status({
      root: tempRoot,
      workspaceName: "my-status-ws",
    });

    expect(statusResult.isClean).toBe(false);
    expect(statusResult.mounts.length).toBe(4);

    const cleanMount = statusResult.mounts.find((m) => m.path === "mount-clean")!;
    expect(cleanMount.state).toBe("clean");

    const dirtyMount = statusResult.mounts.find((m) => m.path === "mount-dirty")!;
    expect(dirtyMount.state).toBe("dirty");

    const wrongMount = statusResult.mounts.find((m) => m.path === "mount-wrong")!;
    expect(wrongMount.state).toBe("wrong_revision");

    const missingMount = statusResult.mounts.find((m) => m.path === "mount-missing")!;
    expect(missingMount.state).toBe("missing");
  });
});
