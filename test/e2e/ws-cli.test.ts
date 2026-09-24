import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as manifest from "../../src/manifest.ts";
import * as git from "../../src/git.ts";

describe("dev ws init E2E (Phase 1)", () => {
  let tempRoot: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-root-"));
    const bareRemotePath = join(tempRoot, "quick-source.git");
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-quick-seed-"));
    await git.runGit(["init", "--bare", "-b", "main", bareRemotePath]);
    await git.runGit(["init", "-b", "main", seedDir]);
    await git.runGit(["config", "user.name", "Quick Workspace Test"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "quick@example.com"], { cwd: seedDir });
    await Bun.write(join(seedDir, "README.md"), "# quick workspace\n");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: seed quick workspace"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });
    await rm(seedDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("initializes a workspace end-to-end via CLI process", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "init",
        "e2e-feature",
        "--root",
        tempRoot,
        "--desc",
        "E2E test description",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Initialized workspace 'e2e-feature'");

    const wsDir = join(tempRoot, "ws", "e2e-feature");
    const manifestPath = join(wsDir, "ws.md");
    const localDir = join(wsDir, ".local");

    expect(fs.exists(wsDir)).toBe(true);
    expect(fs.exists(manifestPath)).toBe(true);
    expect(fs.exists(localDir)).toBe(true);

    const parsed = await manifest.readWorkspace(manifestPath);
    expect(parsed.manifest.name).toBe("e2e-feature");
    expect(parsed.manifest.description).toBe("E2E test description");
    expect(parsed.manifest.mounts).toEqual([]);
  });

  it("supports --json flag for machine-readable output", async () => {
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "json-feature", "--root", tempRoot, "--json"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("json-feature");
    expect(parsed.path).toContain("json-feature");
    expect(parsed.manifestPath).toContain("ws.md");
  });

  it("creates a workspace and mounts an explicit repository source in one command", async () => {
    const source = join(tempRoot, "quick-source.git");
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", source, "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.name).toBe("local-quick-source");
    expect(result.mount.mountName).toBe("quick-source");
    expect(fs.exists(join(tempRoot, "ws", "local-quick-source", "quick-source"))).toBe(true);
  });

  it("refuses with exit 3 when the workspace already exists", async () => {
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "e2e-feature", "--root", tempRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(3);
    expect(stderr).toContain("↳ dev go e2e-feature");
  });

  it("exits 2 when the workspace name is omitted", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "ws", "init", "--root", tempRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Workspace name is required");
  });
});
