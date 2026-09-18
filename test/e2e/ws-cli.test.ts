import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as manifest from "../../src/manifest.ts";

describe("dev ws init E2E (Phase 1)", () => {
  let tempRoot: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-root-"));
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

  it("fails and exits with code 1 when workspace already exists", async () => {
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "e2e-feature", "--root", tempRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("WORKSPACE_ALREADY_EXISTS");
  });

  it("fails and exits with code 1 when workspace name is omitted", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "ws", "init", "--root", tempRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Workspace name is required");
  });
});
