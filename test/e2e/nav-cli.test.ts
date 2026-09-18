import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev navigation, shell-init, and help CLI E2E (Phase 17)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-nav-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-nav-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-e2e-nav-bare-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello navigation e2e");
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

  it("dev --help outputs human-friendly ANSI help", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Developer CLI & Workspace Engine (dev v0.0.0-development)");
    expect(stdout).toContain("COMMANDS");
    expect(stdout).toContain("shell-init");
  });

  it("dev --help --llms outputs structured JSON orientation schema", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "--help", "--llms"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.name).toBe("dev");
    expect(schema.commands.some((c: { name: string }) => c.name === "ws")).toBe(true);
    expect(schema.commands.some((c: { name: string }) => c.name === "shell-init")).toBe(true);
  });

  it("dev shell-init outputs shell integration scripts", async () => {
    const bashProc = Bun.spawn(["bun", "run", cliPath, "shell-init", "bash"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await bashProc.exited).toBe(0);
    const bashOutput = await new Response(bashProc.stdout).text();
    expect(bashOutput).toContain("dev() {");
    expect(bashOutput).toContain("ws() {");

    const psProc = Bun.spawn(["bun", "run", cliPath, "shell-init", "powershell"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await psProc.exited).toBe(0);
    const psOutput = await new Response(psProc.stdout).text();
    expect(psOutput).toContain("function dev {");
    expect(psOutput).toContain("function ws {");
  });

  it("resolves workspace path and jump target", async () => {
    // 1. Initialize workspace
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "nav-target", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // 2. dev ws path nav-target
    const pathProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "path", "nav-target", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await pathProc.exited).toBe(0);
    const pathOutput = (await new Response(pathProc.stdout).text()).trim();
    expect(pathOutput.replace(/\\/g, "/")).toContain("ws/nav-target");

    // 3. dev ws jump nav-target
    const jumpProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "jump", "nav-target", "--root", tempRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await jumpProc.exited).toBe(0);
    const jumpOutput = (await new Response(jumpProc.stdout).text()).trim();
    expect(jumpOutput.replace(/\\/g, "/")).toContain("ws/nav-target");
  });

  it("supports dev ws pick and dev ws default contextual behavior", async () => {
    // 1. Outside workspace: dev ws lists workspaces
    const wsListProc = Bun.spawn(["bun", "run", cliPath, "ws", "--root", tempRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await wsListProc.exited).toBe(0);
    const wsListOutput = await new Response(wsListProc.stdout).text();
    expect(wsListOutput).toContain("nav-target");

    // 2. dev ws pick outside workspace with --json
    const pickOutsideProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "pick", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await pickOutsideProc.exited).toBe(0);
    const pickOutsideJson = JSON.parse(await new Response(pickOutsideProc.stdout).text());
    expect(Array.isArray(pickOutsideJson)).toBe(true);
    expect(pickOutsideJson.some((w: { name: string }) => w.name === "nav-target")).toBe(true);

    // 3. Add a mount into nav-target
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
        "nav-target",
        "--as",
        "my-mount",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addProc.exited).toBe(0);

    // 4. Inside workspace: dev ws pick --ws nav-target --json
    const pickInsideProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "pick", "--root", tempRoot, "--ws", "nav-target", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await pickInsideProc.exited).toBe(0);
    const pickInsideJson = JSON.parse(await new Response(pickInsideProc.stdout).text());
    expect(pickInsideJson.workspace).toBe("nav-target");
    expect(pickInsideJson.mounts.some((m: { path: string }) => m.path === "my-mount")).toBe(true);

    // 5. mirror pick
    const repoPickProc = Bun.spawn(
      ["bun", "run", cliPath, "mirror", "pick", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await repoPickProc.exited).toBe(0);
    const repoPickJson = JSON.parse(await new Response(repoPickProc.stdout).text());
    expect(repoPickJson).toBeDefined();
  });
});
