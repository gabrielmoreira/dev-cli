import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev ws update & ws sync CLI E2E (Phase 5)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-update-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "CLI Seed Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "cli-seed@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "v1");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: v1 commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/dirty"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "dirty.txt"), "dirty base");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: dirty base"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/dirty"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("safely fast-forwards clean mount and skips dirty mount via CLI process", async () => {
    // 1. Initialize workspace via CLI
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "sync-e2e-ws", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // 2. Mount clean repo via CLI
    const addCleanProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "sync-e2e-ws",
        "--path",
        "clean-mount",
        "--branch",
        "main",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addCleanProc.exited).toBe(0);

    // 3. Mount dirty repo via CLI
    const addDirtyProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "sync-e2e-ws",
        "--path",
        "dirty-mount",
        "--branch",
        "feature/dirty",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addDirtyProc.exited).toBe(0);

    // 4. Advance remote main branch
    const advancerDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-adv-"));
    try {
      await git.runGit(["clone", bareRemotePath, advancerDir]);
      await git.runGit(["config", "user.name", "Advancer"], { cwd: advancerDir });
      await git.runGit(["config", "user.email", "adv@example.com"], { cwd: advancerDir });
      await fs.writeText(join(advancerDir, "new-feature.txt"), "new content");
      await git.runGit(["add", "."], { cwd: advancerDir });
      await git.runGit(["commit", "-m", "feat: new remote commit"], { cwd: advancerDir });
      await git.runGit(["push", "origin", "main"], { cwd: advancerDir });
    } finally {
      await rm(advancerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      );
    }

    // 5. Make dirty-mount dirty
    const dirtyFile = join(tempRoot, "ws", "sync-e2e-ws", "dirty-mount", "dirty.txt");
    await fs.writeText(dirtyFile, "uncommitted changes on dirty mount");

    // 6. Run dev ws update with --refresh and --json
    const updateProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "update",
        "sync-e2e-ws",
        "--refresh",
        "--json",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const updateStdout = await new Response(updateProc.stdout).text();
    expect(await updateProc.exited).toBe(0);

    const updateJson = JSON.parse(updateStdout);
    expect(updateJson.summary.updated).toBe(1);
    expect(updateJson.summary.skipped).toBe(1);

    const cleanRes = updateJson.mounts.find((m: { path: string }) => m.path === "clean-mount");
    expect(cleanRes.action).toBe("fast_forward");

    const dirtyRes = updateJson.mounts.find((m: { path: string }) => m.path === "dirty-mount");
    expect(dirtyRes.action).toBe("skipped");
    expect(dirtyRes.reason).toBe("dirty_worktree");

    // Verify uncommitted changes preserved
    expect(await fs.readText(dirtyFile)).toBe("uncommitted changes on dirty mount");

    // 7. Test dev ws sync shortcut alias works identically
    const syncProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "sync", "sync-e2e-ws", "--json", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    const syncStdout = await new Response(syncProc.stdout).text();
    expect(await syncProc.exited).toBe(0);

    const syncJson = JSON.parse(syncStdout);
    expect(syncJson.summary.upToDate).toBe(1);
    expect(syncJson.summary.skipped).toBe(1);
  });
});
