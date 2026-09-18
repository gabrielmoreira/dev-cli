import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev ws hook execution and trust model CLI E2E (Phase 16)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-trust-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-trust-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-e2e-trust-bare-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello cli trust hooks");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "initial commit"], { cwd: seedDir });
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

  it("blocks untrusted hook without explicit consent via CLI", async () => {
    // 1. Init workspace
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "ws-cli-block", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // 2. Attempt to add untrusted repo with pre-hook without consent
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        "https://github.com/evil/malicious.git",
        "--root",
        tempRoot,
        "--ws",
        "ws-cli-block",
        "--pre-hook",
        "echo pwned",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await addProc.exited;
    const stderr = await new Response(addProc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("UNTRUSTED_HOOK_BLOCKED");
  });

  it("allows untrusted hook when --consent flag is provided", async () => {
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "ws-cli-consent", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    const markerFile = join(tempRoot, "cli-consent-marker.txt");
    const cmd = `echo ran > ${markerFile}`;

    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--root",
        tempRoot,
        "--ws",
        "ws-cli-consent",
        "--as",
        "consent-mount",
        "--pre-hook",
        cmd,
        "--consent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await addProc.exited;
    expect(exitCode).toBe(0);
    expect(fs.exists(markerFile)).toBe(true);
  });

  it("fails mount when pre-checkout hook exits with error", async () => {
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "ws-cli-fail-pre", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    const isWin = process.platform === "win32";
    const failCmd = isWin ? "cmd.exe /c exit 5" : "sh -c 'exit 5'";

    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--root",
        tempRoot,
        "--ws",
        "ws-cli-fail-pre",
        "--as",
        "failing-mount",
        "--pre-hook",
        failCmd,
        "--consent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await addProc.exited;
    const stderr = await new Response(addProc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("HOOK_FAILED");

    // Mount directory must not exist
    const mountPath = join(tempRoot, "ws", "ws-cli-fail-pre", "failing-mount");
    expect(fs.exists(mountPath)).toBe(false);
  });

  it("warns on post-checkout hook failure without aborting mount", async () => {
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "ws-cli-warn-post", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    const isWin = process.platform === "win32";
    const failCmd = isWin ? "cmd.exe /c exit 3" : "sh -c 'exit 3'";

    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--root",
        tempRoot,
        "--ws",
        "ws-cli-warn-post",
        "--as",
        "post-warning-mount",
        "--post-hook",
        failCmd,
        "--consent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await addProc.exited;
    const stderr = await new Response(addProc.stderr).text();
    const stdout = await new Response(addProc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout + stderr).toContain("post_checkout hook failed");

    // Mount directory exists and is valid worktree
    const mountPath = join(tempRoot, "ws", "ws-cli-warn-post", "post-warning-mount");
    expect(fs.exists(mountPath)).toBe(true);

    const observed = await git.inspectWorktree(mountPath);
    expect(observed.isGitWorktree).toBe(true);
  });
});
