import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("CLI help through pipes", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-help-cli-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(args: readonly string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DEV_ROOT: root,
        DEV_CWD: root,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        CI: "",
        NO_COLOR: "",
        TEST: "",
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it.each([
    { args: [], usage: "USAGE dev" },
    { args: ["--help"], usage: "USAGE dev" },
    { args: ["-h"], usage: "USAGE dev" },
    { args: ["help"], usage: "USAGE dev" },
    { args: ["help", "ws", "add"], usage: "USAGE dev ws add" },
    { args: ["ws", "add", "https://example.test/api.git", "--help"], usage: "USAGE dev ws add" },
    { args: ["--root", "ws", "ws", "add", "--help"], usage: "USAGE dev ws add" },
    { args: ["help", "ws", "add", "--root", "ws"], usage: "USAGE dev ws add" },
    { args: ["help", "shell-init", "--runner", "mise"], usage: "USAGE dev shell-init" },
  ])("renders plain valid help without executing a leaf (%j)", async ({ args, usage }) => {
    const result = await run(args);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(usage);
    expect(result.stdout).toBe(Bun.stripANSI(result.stdout));
  });

  it.each([
    { args: ["help", "no-such-command"], word: "no-such-command", next: "dev --help" },
    { args: ["help", "ws", "no-such-command"], word: "no-such-command", next: "dev ws --help" },
    { args: ["ws", "no-such-command", "--help"], word: "no-such-command", next: "dev ws --help" },
    { args: ["help", "ws", "strat"], word: "strat", next: "dev ws start --help" },
    { args: ["ws", "strat", "--help"], word: "strat", next: "dev ws start --help" },
    { args: ["help", "ws", "add", "typo"], word: "typo", next: "dev ws add --help" },
    { args: ["help", "ws", "--", "--json"], word: "--json", next: "dev ws --help" },
  ])("reports unknown help path as human usage failure (%j)", async ({ args, word, next }) => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unknown command: '${word}'`);
    expect(result.stderr).toContain(`↳ ${next}`);
  });

  it.each([
    { args: ["help", "ws", "strat", "--json"] },
    { args: ["ws", "strat", "--help", "--json=true"] },
  ])("retains the 1.2 semantic JSON error channel (%j)", async ({ args }) => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("\u001b[");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "UNKNOWN_COMMAND",
      command: "strat",
      usage: "dev ws start --help",
      nextStep: "dev ws start --help",
    });
  });

  it("keeps ordinary JSON failures ANSI-free under forced color", async () => {
    const result = await run(["shell-init", "nope", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("\u001b[");
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("preserves human stderr errors and successful answers under forced color", async () => {
    const failure = await run(["shell-init", "nope"]);
    expect(failure.exitCode).toBe(2);
    expect(failure.stdout).toBe("");
    expect(Bun.stripANSI(failure.stderr)).toContain("nope");
    const success = await run(["--version", "--json"]);
    expect(success.exitCode).toBe(0);
    expect(success.stderr).toBe("");
    expect(success.stdout).not.toContain("\u001b[");
    expect(typeof JSON.parse(success.stdout).version).toBe("string");
  });

  it("keeps the full --llms schema independent of human ANSI policy", async () => {
    const result = await run(["--help", "--llms"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const schema = JSON.parse(result.stdout);
    expect(schema.name).toBe("dev");
    expect(
      schema.commands.find((command: { name: string }) => command.name === "ws"),
    ).toBeDefined();
    expect(schema.exitCodes[2]).toContain("usage");
  });

  it("teaches concepts and orders command groups before their definitions", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    const titles = [
      "Start here",
      "Repositories and knowledge",
      "Pull requests and work items",
      "Setup",
      "Concepts",
    ];
    let previous = -1;
    for (const title of titles) {
      const position = result.stdout.indexOf(title);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(result.stdout).toContain("workspace: A folder for one task:");
    expect(result.stdout).toContain("Use dev <command> --help");
  });

  it("assigns each registered command and alias to exactly one group", async () => {
    const result = await run(["--help", "--llms"]);
    const schema = JSON.parse(result.stdout);
    expect(schema.groups).toBeArray();
    expect(schema.concepts).toHaveLength(8);
    const grouped = schema.groups.flatMap((group: { commands: string[] }) => group.commands);
    const canonical = schema.commands.map((command: { name: string }) => command.name);
    expect([...grouped].sort()).toEqual([...canonical].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(
      schema.commands.find((command: { name: string }) => command.name === "wi").aliases,
    ).toContain("workitem");
  });

  it("requires ls and rm aliases for every list and remove command at every depth", async () => {
    const result = await run(["--help", "--llms"]);
    expect(result.exitCode).toBe(0);
    interface Command {
      name: string;
      aliases?: string[];
      subcommands?: Command[];
    }
    const gaps: string[] = [];
    function check(commands: Command[], parent: string) {
      for (const command of commands) {
        const path = `${parent} ${command.name}`;
        const short = command.name === "list" ? "ls" : command.name === "remove" ? "rm" : undefined;
        if (short && !command.aliases?.includes(short)) gaps.push(`${path} needs ${short}`);
        check(command.subcommands ?? [], path);
      }
    }
    check(JSON.parse(result.stdout).commands, "dev");
    expect(gaps).toEqual([]);
  });

  it("keeps the published concept definitions in README and reference in sync", async () => {
    const result = await run(["--help", "--llms"]);
    const schema = JSON.parse(result.stdout);
    const readme = await Bun.file(new URL("../../README.md", import.meta.url)).text();
    const reference = await Bun.file(new URL("../../docs/commands.md", import.meta.url)).text();
    const block = (text: string) =>
      text.match(/<!-- concepts:start -->[\s\S]*?<!-- concepts:end -->/)?.[0];
    expect(block(readme)).toBeDefined();
    expect(block(readme)).toBe(block(reference));
    for (const concept of schema.concepts) {
      expect(block(readme)).toContain(concept.job);
      expect(block(readme)).toContain(concept.contrast);
    }
  });
});
