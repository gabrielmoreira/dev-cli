import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiTest } from "@microsoft/tui-test";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const CONFIG =
  "version: 1\nworksets:\n  alpha:\n    members:\n      - source: https://github.com/example/alpha\n  beta:\n    members:\n      - source: https://github.com/example/beta\n";

describe("missing CLI input", () => {
  let root: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-missing-input-"));
    await writeFile(join(root, "dev.yaml"), CONFIG);
    env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      DEV_ROOT: root,
      DEV_CWD: root,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      CI: "1",
    };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(args: readonly string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: root,
      env,
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

  it("still shows an explicitly selected workset", async () => {
    const result = await run(["workset", "show", "alpha", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: "alpha",
      members: [{ source: "https://github.com/example/alpha" }],
    });
    expect(result.stderr).toBe("");
  });

  it.each([
    { args: ["label", "add"], usage: "dev label add <label> <repository...>" },
    { args: ["label", "add", "team:api"], usage: "dev label add <label> <repository...>" },
    { args: ["workset", "show"], usage: "dev workset show <name>" },
    { args: ["qmd", "search"], usage: "dev qmd search <query>" },
    { args: ["qmd", "x"], usage: "dev qmd x <args>" },
    { args: ["ws", "add"], usage: "dev ws add <url|path|name>" },
    { args: ["workset", "create"], usage: "dev workset create [name] [repository]" },
  ])("reports missing input and its remedy for $args", async ({ args, usage }) => {
    const json = await run([...args, "--json"]);
    expect(json.exitCode).toBe(2);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr).error).toMatchObject({
      code: "INTERACTION_REQUIRED",
      usage,
      nextStep: usage,
    });
    const human = await run(args);
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain(`↳ ${usage}\n`);
  });

  it("selects a workset in a real terminal without changing config", async () => {
    const terminal = TuiTest.ephemeral("dev-workset-show");
    try {
      await terminal.run(process.execPath, [CLI, "workset", "show", "--root", root], {
        cols: 120,
        rows: 40,
        cwd: root,
        env: {
          ...env,
          CI: "",
          GITHUB_ACTIONS: "",
          AI_AGENT: "",
          AGENT: "",
          CLAUDECODE: "",
          CLAUDE_CODE: "",
          CURSOR_AGENT: "",
          GEMINI_CLI: "",
          CODEX_SANDBOX: "",
        },
      });
      await terminal.getByText("Select workset").expect({ timeout: 5_000 });
      await terminal.press("Enter");
      await terminal.waitExit({ timeout: 15_000 });
      expect(await terminal.text({ full: true })).toContain("alpha");
      expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(CONFIG);
    } finally {
      await terminal.closeQuiet();
    }
  }, 30_000);
});
