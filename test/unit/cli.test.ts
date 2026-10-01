import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCommandHelp,
  formatHelp,
  normalizeCliArgs,
  runCli,
  type AmbientContext,
} from "../../src/cli.ts";
import { generateShellInit } from "../../src/nav.ts";

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
      expect(logs.join("\n")).toBe("dev v0.0.0-development");
    } finally {
      console.log = originalLog;
    }
  });

  it("prints one version JSON document", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      expect(
        await runCli({
          argv: ["--version", "--json"],
          cwd: process.cwd(),
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toEqual({ version: "0.0.0-development" });
    } finally {
      console.log = originalLog;
    }
  });

  it("prints one shell-init JSON document", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      expect(
        await runCli({
          argv: ["shell-init", "bash", "--json"],
          cwd: process.cwd(),
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toEqual({
        shell: "bash",
        script: generateShellInit("bash"),
      });
    } finally {
      console.log = originalLog;
    }
  });

  it.each(["sync", ""])("prints one qmd %s JSON document", async (subcommand) => {
    const root = await mkdtemp(join(tmpdir(), "dev-cli-qmd-json-"));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      expect(
        await runCli({
          argv: ["qmd", ...(subcommand ? [subcommand] : []), "--root", root, "--json"],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toEqual({ exitCode: 0 });
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies .env is ignored by this repository, not global Git config", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "sample-project-git-ignore-"));
    const globalIgnore = join(fixture, "global-ignore");
    const globalConfig = join(fixture, "gitconfig");
    try {
      await writeFile(globalIgnore, ".env\n");
      await writeFile(
        globalConfig,
        `[core]\n\texcludesFile = ${globalIgnore.replaceAll("\\", "/")}\n`,
      );
      const proc = Bun.spawn(["git", "-c", "core.excludesFile=", "check-ignore", "-v", ".env"], {
        cwd: process.cwd(),
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = (await new Response(proc.stdout).text()).trim().replaceAll("\\", "/");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/(?:^|\/)\.gitignore:\d+:\.env\s+\.env$/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
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
