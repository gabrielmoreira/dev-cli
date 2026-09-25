import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  findUnknownOption,
  formatCommandHelp,
  runCli,
  suggestCommand,
  type AmbientContext,
} from "../../src/cli.ts";

describe("subcommand help (UX)", () => {
  it("renders positional and option rows from the args schema", async () => {
    const out = await formatCommandHelp(["ws", "update"]);
    expect(out).toContain("dev ws update");
    expect(out).toContain("Converge mounts to ws.md");
    expect(out).toContain("USAGE dev ws update [OPTIONS] [TARGET]");
    expect(out).toContain("--autostash");
    expect(out).toContain("--rebase");
    expect(out).toContain("--ws");
  });

  it("suggests the command a mistyped or misplaced word most likely meant", async () => {
    expect(await suggestCommand(["ws", "strat"])).toBe("dev ws start");
    expect(await suggestCommand(["lock"])).toBe("dev ws lock");
    expect(await suggestCommand(["zq"])).toBeUndefined();
  });

  it("rejects an option no command on the path declares, and suggests the near one", async () => {
    expect(await findUnknownOption(["sync", "--dryrun"])).toEqual({
      option: "--dryrun",
      command: "dev sync",
      suggestion: "--dry-run",
    });
    expect(await findUnknownOption(["ws", "add", "src", "--path=x", "--bogus"])).toMatchObject({
      option: "--bogus",
      command: "dev ws add",
      suggestion: undefined,
    });
  });

  it("accepts values, negations, globals, parent hand-offs and passthrough", async () => {
    // `--root ws` is a value, not the ws command.
    expect(await findUnknownOption(["--root", "ws", "ws", "ls", "--json"])).toBeUndefined();
    expect(await findUnknownOption(["sync", "--no-refresh", "--dryRun"])).toBeUndefined();
    expect(await findUnknownOption(["ws", "ls", "-q", "--non-interactive"])).toBeUndefined();
    // `dev pr` hands off to its list command, whose options count.
    expect(await findUnknownOption(["pr", "--all", "--status", "closed"])).toBeUndefined();
    expect(await findUnknownOption(["qmd", "x", "--whatever", "-n", "5"])).toBeUndefined();
    expect(await findUnknownOption(["nosuchcommand", "--bogus"])).toBeUndefined();
  });

  it("renders ws start as the HerdR OMP entrypoint", async () => {
    const out = await formatCommandHelp(["ws", "start"]);

    expect(out).toContain("dev ws start");
    expect(out).toContain("Start or focus OMP in HerdR for a dev workspace");
    expect(out).toContain("[NAME]");
  });

  describe("dev ws <sub> --help routes to subcommand help", () => {
    let logs: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
      logs = [];
      originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
    });

    afterEach(() => {
      console.log = originalLog;
    });

    it("shows ws add help, not top-level help", async () => {
      const ambient: AmbientContext = {
        argv: ["ws", "add", "--help"],
        cwd: process.cwd(),
        env: {},
        isTTY: false,
      };
      const exitCode = await runCli(ambient);
      expect(exitCode).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("dev ws add");
      expect(out).not.toContain("dev - Developer CLI & Workspace Engine");
    });
  });
});
