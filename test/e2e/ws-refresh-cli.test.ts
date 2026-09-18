import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev ws status --refresh & --offline CLI E2E (Phase 4)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-refresh-root-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-e2e-refresh-bare-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-refresh-seed-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Status E2E"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "status-e2e@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "app.ts"), "initial");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );

    // Init workspace and add mount
    await Bun.spawn(["bun", "run", cliPath, "ws", "init", "offline-ws", "--root", tempRoot]).exited;
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
      "offline-ws",
      "--branch",
      "main",
    ]).exited;
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

  it("fails when both --refresh and --offline are supplied", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "status",
        "--ws",
        "offline-ws",
        "--root",
        tempRoot,
        "--refresh",
        "--offline",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("CONFLICTING_OPTIONS");
  });

  it("executes status with --offline successfully without accessing network", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "status",
        "--ws",
        "offline-ws",
        "--root",
        tempRoot,
        "--offline",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Workspace: offline-ws");
    expect(stdout).toContain("[clean]");
  });

  it("executes status with --refresh successfully updating tracking state", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "status",
        "--ws",
        "offline-ws",
        "--root",
        tempRoot,
        "--refresh",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Workspace: offline-ws");
  });
});
