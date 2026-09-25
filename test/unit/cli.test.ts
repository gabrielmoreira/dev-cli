import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCommandHelp,
  formatHelp,
  normalizeCliArgs,
  runCli,
  type AmbientContext,
} from "../../src/cli.ts";

describe("CLI entrypoint (Phase 0)", () => {
  it("generates human help text by default", async () => {
    const help = await formatHelp(false);
    expect(help).toContain("dev");
    expect(help).toContain("COMMANDS");
    expect(help).toContain("ws");
    expect(help).toContain("mirror");
    expect(await formatCommandHelp(["ws", "init"])).toContain("[NAME]");
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

  it("exits 2 with a structured code when sync inventory has no provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-cli-noprov-"));
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    // `dev init` registers the root in $HOME/.dev.toml, never the developer's registry.
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    console.log = () => {};
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const ambient = { cwd: root, env: {}, isTTY: false };
      expect(await runCli({ ...ambient, argv: ["init", "--root", root, "--json"] })).toBe(0);
      const exitCode = await runCli({
        ...ambient,
        argv: ["sync", "inventory", "--root", root, "--json"],
      });
      expect(exitCode).toBe(2);
      expect(JSON.parse(errors.join("\n")).error.code).toBe("PROVIDER_NOT_CONFIGURED");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalProfile;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a pull request URL as dev ws init, with or without ws", () => {
    const url = "https://dev.azure.com/org/project/_git/repo/pullrequest/18747";
    expect(normalizeCliArgs([url])).toEqual(["ws", "init", url]);
    expect(normalizeCliArgs(["ws", url, "--json"])).toEqual(["ws", "init", url, "--json"]);
    expect(normalizeCliArgs(["ws", "https://dev.azure.com/org/project/_git/repo"])).toEqual([
      "ws",
      "https://dev.azure.com/org/project/_git/repo",
    ]);
  });
});
