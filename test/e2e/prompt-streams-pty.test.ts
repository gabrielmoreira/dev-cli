import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TuiTest } from "@microsoft/tui-test";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const UI = pathToFileURL(join(import.meta.dir, "..", "..", "src", "ui.ts")).href;
const INTERACTIVE_ENV = {
  CI: "",
  GITHUB_ACTIONS: "",
  AI_AGENT: "",
  AGENT: "",
  CLAUDECODE: "",
  CLAUDE_CODE: "",
  CURSOR_AGENT: "",
  GEMINI_CLI: "",
  CODEX_SANDBOX: "",
};

describe("prompts with captured stdout", () => {
  let root: string;
  let terminal: TuiTest;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-prompt-streams-"));
    await writeFile(join(root, "dev.yaml"), "version: 1\n");
    terminal = TuiTest.ephemeral("dev-prompt-streams");
  });

  afterEach(async () => {
    await terminal.closeQuiet();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function environment() {
    return {
      ...process.env,
      ...INTERACTIVE_ENV,
      HOME: root,
      USERPROFILE: root,
      DEV_ROOT: root,
      DEV_CWD: root,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  async function capture(args: string[]) {
    const target = join(root, "captured.json");
    const driver = `
      const child = Bun.spawn(${JSON.stringify([process.execPath, ...args])}, {
        stdin: "inherit", stdout: "pipe", stderr: "inherit",
      });
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      await Bun.write(${JSON.stringify(target)}, JSON.stringify({ stdout, exitCode }));
      console.log("CAPTURE_DONE");
      await Bun.stdin.stream().getReader().read();
      process.exit(exitCode);
    `;
    await terminal.run(process.execPath, ["-e", driver], {
      cols: 120,
      rows: 40,
      cwd: root,
      env: environment(),
    });
  }

  async function captured(): Promise<{ stdout: string; exitCode: number }> {
    await terminal.getByText("CAPTURE_DONE").expect();
    await terminal.press("Enter");
    await terminal.waitExit({ timeout: 15_000 });
    return JSON.parse(await readFile(join(root, "captured.json"), "utf8"));
  }

  it("renders all four real prompt adapters outside the answer stream", async () => {
    const driver = `
      const { ui } = await import(${JSON.stringify(UI)});
      const name = await ui.text({ message: "Name", hint: "Name the fixture value." });
      const options = [{ label: "alpha", value: "alpha" }, { label: "beta", value: "beta" }];
      const one = await ui.select({ message: "Choose one", hint: "Pick one fixture value.", options });
      const many = await ui.multiSelect({ message: "Choose many", hint: "Pick the fixture values to keep.", options });
      const confirmed = await ui.confirm({ message: "Apply?", hint: "Yes returns your selection; No declines it.", initial: true });
      ui.result({ data: { name, one, many, confirmed }, json: true });
    `;
    await capture(["-e", driver]);
    await terminal.getByText("Name").expect();
    await terminal.submit("fixture-name");
    await terminal.getByText("Choose one").expect();
    await terminal.type("beta");
    await terminal.press("Enter");
    await terminal.getByText("Choose many").expect();
    await terminal.press("Tab");
    await terminal.press("Enter");
    await terminal.getByText("Apply?").expect();
    await terminal.press("Enter");
    const result = await captured();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: "fixture-name",
      one: "beta",
      many: ["alpha"],
      confirmed: true,
    });
  }, 60_000);

  it.each(["go", "ws path"])(
    "keeps %s navigation answer path-only",
    async (command) => {
      for (const name of ["alpha", "beta"]) {
        const child = Bun.spawn(
          [process.execPath, CLI, "ws", "init", name, "--root", root, "--json"],
          {
            cwd: root,
            env: { ...environment(), CI: "1" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        expect(JSON.parse(stdout).name).toBe(name);
      }
      await capture([CLI, ...command.split(" "), "--root", root]);
      await terminal.getByText("Select workspace").expect();
      await terminal.type("beta");
      await terminal.press("Enter");
      const result = await captured();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${join(root, "ws", "beta")}\n`);
    },
    60_000,
  );
});
