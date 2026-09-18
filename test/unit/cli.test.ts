import { describe, expect, it } from "bun:test";
import { formatHelp, formatSubHelp, runCli, type AmbientContext } from "../../src/cli.ts";

describe("CLI entrypoint (Phase 0)", () => {
  it("generates human help text by default", async () => {
    const help = await formatHelp(false);
    expect(help).toContain("dev");
    expect(help).toContain("COMMANDS");
    expect(help).toContain("ws");
    expect(help).toContain("mirror");
    expect(await formatSubHelp("ws", "init")).toContain("[NAME]");
  });

  it("generates structured JSON help when --llms is requested", async () => {
    const help = await formatHelp(true);
    const parsed = JSON.parse(help);
    expect(parsed.name).toBe("dev");
    expect(parsed.commands).toBeArray();
  });

  it("exits with 0 on --help without contacting network", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const ambient: AmbientContext = {
        argv: ["--help"],
        cwd: process.cwd(),
        env: {},
        isTTY: false,
      };
      const exitCode = await runCli(ambient);
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain(
        "Developer CLI & Workspace Engine (dev v0.0.0-development)",
      );
    } finally {
      console.log = originalLog;
    }
  });

  it("exits with 0 on empty argv (showing help)", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const ambient: AmbientContext = {
        argv: [],
        cwd: process.cwd(),
        env: {},
        isTTY: false,
      };
      const exitCode = await runCli(ambient);
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain(
        "Developer CLI & Workspace Engine (dev v0.0.0-development)",
      );
    } finally {
      console.log = originalLog;
    }
  });

  it("exits with 0 on --version", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const ambient: AmbientContext = {
        argv: ["--version"],
        cwd: process.cwd(),
        env: {},
        isTTY: false,
      };
      const exitCode = await runCli(ambient);
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain("dev v0.0.0-development");
    } finally {
      console.log = originalLog;
    }
  });

  it("verifies that .env is ignored by Git", async () => {
    const proc = Bun.spawn(["git", "check-ignore", ".env"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toBe(".env");
  });
});
