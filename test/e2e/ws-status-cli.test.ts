import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev ws status CLI E2E (Phase 3)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-status-root-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-e2e-status-bare-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-seed-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Status E2E"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "status-e2e@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "app.ts"), "console.log('e2e');");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

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

  it("checks status via CLI, detects clean then dirty when file is modified", async () => {
    // 1. Initialize workspace
    await Bun.spawn(["bun", "run", cliPath, "ws", "init", "diagnose-ws", "--root", tempRoot])
      .exited;

    // 2. Add mount
    await Bun.spawn([
      "bun",
      "run",
      cliPath,
      "ws",
      "add",
      bareRemotePath,
      "--root",
      tempRoot,
      "--ws",
      "diagnose-ws",
      "--branch",
      "main",
    ]).exited;

    // 3. Check status when clean
    const statusProc1 = Bun.spawn(
      ["bun", "run", cliPath, "ws", "status", "--root", tempRoot, "--ws", "diagnose-ws"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout1 = await new Response(statusProc1.stdout).text();
    const exit1 = await statusProc1.exited;

    expect(exit1).toBe(0);
    expect(stdout1).toContain("Status:    clean");
    expect(stdout1).toContain("[clean]");

    // 4. Modify file to make worktree dirty
    const mountDir = join(
      tempRoot,
      "ws",
      "diagnose-ws",
      git.deriveDefaultMountPath(bareRemotePath),
    );
    await fs.writeText(join(mountDir, "app.ts"), "console.log('modified');");

    // 5. Check status again -> must detect dirty
    const statusProc2 = Bun.spawn(
      ["bun", "run", cliPath, "ws", "status", "--root", tempRoot, "--ws", "diagnose-ws"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout2 = await new Response(statusProc2.stdout).text();
    const exit2 = await statusProc2.exited;

    expect(exit2).toBe(0);
    expect(stdout2).toContain("Status:    diverged / changes detected");
    expect(stdout2).toContain("[dirty]");

    // 6. Test JSON mode
    const jsonProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "status", "--root", tempRoot, "--ws", "diagnose-ws", "--json"],
      { stdout: "pipe" },
    );
    const jsonStdout = await new Response(jsonProc.stdout).text();
    const jsonParsed = JSON.parse(jsonStdout);

    expect(jsonParsed.workspaceName).toBe("diagnose-ws");
    expect(jsonParsed.isClean).toBe(false);
    expect(jsonParsed.mounts[0].state).toBe("dirty");

    // 7. Test shortcut 'dev status' inside workspace cwd
    const shortcutProc = Bun.spawn(["bun", "run", cliPath, "status", "--root", tempRoot], {
      cwd: join(tempRoot, "ws", "diagnose-ws"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const shortcutStdout = await new Response(shortcutProc.stdout).text();
    const shortcutExit = await shortcutProc.exited;

    expect(shortcutExit).toBe(0);
    expect(shortcutStdout).toContain("Workspace: diagnose-ws");
    expect(shortcutStdout).toContain("[dirty]");
  });
});
