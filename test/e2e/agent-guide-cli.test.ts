import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RESOURCES, HELP_NEXT_STEPS } from "../../src/agentGuide.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const SKILL_PATH = join(import.meta.dir, "..", "..", "skills", "dev", "SKILL.md");

/** Every marker the CLI treats as an agent's shell, so each case is deterministic. */
const AGENT_MARKERS = [
  "AI_AGENT",
  "AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
];

describe("agent surfaces", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "dev-agent-guide-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(args: readonly string[], extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CI: "1",
      DEV_ROOT: undefined,
      DEV_CWD: undefined,
      NO_COLOR: "1",
    };
    for (const marker of AGENT_MARKERS) env[marker] = undefined;
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: home,
      env: { ...env, ...extra } as Record<string, string>,
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

  it("prints the repository's skill file", async () => {
    const file = await Bun.file(SKILL_PATH).text();
    const human = await run(["skill"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.trimEnd()).toBe(file.trimEnd());
  });

  it("answers the skill as JSON with its frontmatter fields", async () => {
    const file = await Bun.file(SKILL_PATH).text();
    const { stdout, exitCode } = await run(["skill", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("dev");
    expect(parsed.description).toContain("dev root");
    expect(parsed.content.trimEnd()).toBe(file.trimEnd());
  });

  it("keeps the skill answer under --quiet and keeps JSON parseable", async () => {
    const file = await Bun.file(SKILL_PATH).text();
    const quiet = await run(["skill", "--quiet"]);
    expect(quiet.stdout.trimEnd()).toBe(file.trimEnd());
    const quietJson = await run(["skill", "--json", "--quiet"]);
    expect(JSON.parse(quietJson.stdout).name).toBe("dev");
  });

  it("carries the same resources in --llms as the help block", async () => {
    const llms = JSON.parse((await run(["--help", "--llms"])).stdout);
    expect(llms.resources).toEqual(AGENT_RESOURCES);
    expect(llms.resources.length).toBeGreaterThan(0);
  });

  it("shows the agent block in human help only under an agent's shell", async () => {
    const agent = await run(["--help"], { CLAUDECODE: "1" });
    expect(agent.exitCode).toBe(0);
    expect(agent.stdout).toContain("Are you an AI?");
    for (const { action } of AGENT_RESOURCES) expect(agent.stdout).toContain(action);

    const human = await run(["--help"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).not.toContain("Are you an AI?");
    expect(human.stdout).toContain("Use dev <command> --help");
  });

  it("never leaks the agent block into JSON help or a command result", async () => {
    const jsonHelp = await run(["--help", "--llms"], { CLAUDECODE: "1" });
    expect(jsonHelp.stdout).not.toContain("Are you an AI?");
    expect(() => JSON.parse(jsonHelp.stdout)).not.toThrow();

    const result = await run(["skill", "--json"], { CLAUDECODE: "1" });
    expect(result.stdout).not.toContain("Are you an AI?");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("ends the help of each mapped command with its next step", async () => {
    for (const [path, next] of Object.entries(HELP_NEXT_STEPS)) {
      const help = await run([...path.split(" "), "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain(`next: ${next}`);
    }
  });
});
