import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev ws revision lifecycle & reconciliation CLI E2E (Phase 6)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-rev-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-rev-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "CLI Rev Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "clirev@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello cli");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await git.runGit(["tag", "v2.0.0"], { cwd: seedDir });
    await git.runGit(["push", "origin", "v2.0.0"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/cli-rev"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "feature.txt"), "feature data");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: feature data"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/cli-rev"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("exercises full revision lifecycle via CLI commands", async () => {
    // 1. Initialize workspace via CLI
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "e2e-rev-ws", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // 2. Mount repository
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "e2e-rev-ws",
        "--path",
        "service-x",
        "--branch",
        "main",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addProc.exited).toBe(0);

    // 3. Lock mount to current commit
    const lockProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "lock",
        "service-x",
        "--ws",
        "e2e-rev-ws",
        "--json",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const lockStdout = await new Response(lockProc.stdout).text();
    expect(await lockProc.exited).toBe(0);
    const lockJson = JSON.parse(lockStdout);
    expect(lockJson.lockedMounts).toHaveLength(1);
    expect(lockJson.lockedMounts[0].commit).toBeDefined();

    // 4. Unlock back to branch feature/cli-rev
    const unlockProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "unlock",
        "service-x",
        "feature/cli-rev",
        "--ws",
        "e2e-rev-ws",
        "--json",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await unlockProc.exited).toBe(0);

    // 5. Pin to tag v2.0.0
    const tagProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "tag",
        "service-x",
        "v2.0.0",
        "--ws",
        "e2e-rev-ws",
        "--json",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await tagProc.exited).toBe(0);

    // 6. Track branch main again
    const trackProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "track",
        "service-x",
        "main",
        "--ws",
        "e2e-rev-ws",
        "--json",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await trackProc.exited).toBe(0);

    // 7. Manually delete worktree from disk and restore via dev ws up
    const worktreePath = join(tempRoot, "ws", "e2e-rev-ws", "service-x");
    await fs.removeDir(worktreePath);
    expect(fs.exists(worktreePath)).toBe(false);

    const upProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "up", "e2e-rev-ws", "--json", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    const upStdout = await new Response(upProc.stdout).text();
    expect(await upProc.exited).toBe(0);
    const upJson = JSON.parse(upStdout);
    expect(upJson.reconciled).toHaveLength(1);
    expect(upJson.reconciled[0].action).toBe("created");
    expect(fs.exists(worktreePath)).toBe(true);

    // 8. Remove mount safely
    const rmProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "remove",
        "service-x",
        "--force",
        "--ws",
        "e2e-rev-ws",
        "--json",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await rmProc.exited).toBe(0);
    expect(fs.exists(worktreePath)).toBe(false);
  });
});
