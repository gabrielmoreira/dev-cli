import { describe, expect, it } from "bun:test";
import { join } from "node:path";

describe("CLI Process E2E (Phase 0)", () => {
  const cliPath = join(process.cwd(), "src", "cli.ts");

  it("spawns CLI process with --help and exits with 0", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Developer CLI & Workspace Engine (dev v0.0.0-development)");
    expect(stderr).toBe("");
  });

  it("spawns CLI process with --version and exits with 0", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("dev v0.0.0-development");
  });

  it("fails with exit code 1 on unknown command", async () => {
    const proc = Bun.spawn(["bun", "run", cliPath, "nonexistent-cmd"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command: 'nonexistent-cmd'");
  });
});
