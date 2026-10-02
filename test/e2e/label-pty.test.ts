import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiTest } from "@microsoft/tui-test";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
// The child must see a person at a terminal: drop the markers that turn prompts off.
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

describe("dev label in a real terminal", () => {
  let root: string;
  let terminal: TuiTest;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-label-pty-"));
    await writeFile(
      join(root, "dev.yaml"),
      "version: 1\nsources:\n  - url: https://github.com/example/sample-api\n",
    );
    terminal = TuiTest.ephemeral("dev-label");
  });

  afterEach(async () => {
    await terminal.closeQuiet();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("puts a label on a repository through the guided flow and confirms it", async () => {
    await terminal.run(process.execPath, [CLI, "label", "--root", root], {
      cols: 120,
      rows: 40,
      cwd: root,
      env: INTERACTIVE_ENV,
    });

    await terminal.getByText("What do you want to do").expect();
    await terminal.press("Enter");
    await terminal.getByText("Label name").expect();
    await terminal.submit("team:api");
    await terminal.getByText("Select repositories for").expect();
    await terminal.press("Tab");
    await terminal.press("Enter");
    await terminal.getByText("Select repositories to customize").expect();
    await terminal.press("Tab"); // "Continue with defaults"
    await terminal.press("Enter");
    // Mixing prompt libraries broke here on Windows with EPIPE.
    await terminal.getByText("Apply this label?").expect();
    await terminal.press("Enter");
    await terminal.waitExit({ timeout: 15_000 });

    const screen = await terminal.text({ full: true });
    expect(screen).not.toContain("EPIPE");
    expect(await readFile(join(root, "dev.yaml"), "utf8")).toContain("team:api");
  }, 60_000);
});
