import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";

describe("dev doctor & hardware CLI E2E (Phase 18)", () => {
  let tempRoot: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-doctor-root-"));
    await fs.ensureDir(join(tempRoot, ".dev"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("dev doctor outputs human-readable diagnostic report", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "doctor", "--root", tempRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Diagnostic Report");
    expect(stdout).toContain("Status:");
    expect(stdout).toContain("git:");
    expect(stdout).toContain("bun:");
  });

  it("dev doctor --json outputs structured diagnostic JSON", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "doctor", "--root", tempRoot, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBeDefined();
    expect(parsed.root.path).toBe(tempRoot);
    expect(parsed.root.exists).toBe(true);
    expect(parsed.root.hasDevDir).toBe(true);
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect(parsed.tools.some((t: { name: string }) => t.name === "git")).toBe(true);
    expect(parsed.tools.some((t: { name: string }) => t.name === "bun")).toBe(true);
  });

  it("dev hardware outputs human-readable hardware profile and model recommendations", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "hardware"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hardware Profile");
    expect(stdout).toContain("Platform:");
    expect(stdout).toContain("Architecture:");
    expect(stdout).toContain("Memory:");
    expect(stdout).toContain("Profile:");
    expect(stdout).toContain("Recommended Tier:");
  });

  it("dev hardware --json outputs structured hardware report JSON", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "hardware", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.platform).toBeDefined();
    expect(parsed.arch).toBeDefined();
    expect(parsed.cpu).toBeDefined();
    expect(parsed.memory).toBeDefined();
    expect(parsed.profile).toBeDefined();
    expect(parsed.recommendations).toBeDefined();
    expect(parsed.recommendations.recommendedModelTier).toBeDefined();
  });
});
