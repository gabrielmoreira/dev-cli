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
});
