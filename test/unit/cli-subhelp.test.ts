import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatSubHelp, runCli, type AmbientContext } from "../../src/cli.ts";

describe("subcommand help (UX)", () => {
  it("renders positional and option rows from the args schema", async () => {
    const out = await formatSubHelp("ws", "update");
    expect(out).toContain("dev ws update");
    expect(out).toContain("Safely fast-forward clean workspace mounts");
    expect(out).toContain("USAGE dev ws update [OPTIONS] [TARGET]");
    expect(out).toContain("--autostash");
    expect(out).toContain("--rebase");
    expect(out).toContain("--ws");
  });

  it("renders ws start as the HerdR OMP entrypoint", async () => {
    const out = await formatSubHelp("ws", "start");

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
