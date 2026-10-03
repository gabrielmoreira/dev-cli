import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiTest } from "@microsoft/tui-test";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
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

describe("first-run prompt context in a real terminal", () => {
  let home: string;
  let terminal: TuiTest;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "dev-context-pty-"));
    terminal = TuiTest.ephemeral("dev-context");
  });
  afterEach(async () => {
    await terminal.closeQuiet();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it("explains where work lives and what declining a provider means", async () => {
    await terminal.run(Bun.which("bun")!, [CLI, "init"], {
      cols: 120,
      rows: 40,
      cwd: home,
      env: { ...INTERACTIVE_ENV, HOME: home, USERPROFILE: home, DEV_CWD: home, DEV_ROOT: "" },
    });
    await terminal
      .getByText("Your dev root: workspaces, mirrors and settings live here.")
      .expect({ timeout: 5000 });
    await terminal.press("Enter");
    await terminal.getByText("Skip to use URLs.").expect({ timeout: 5000 });
    await terminal.press("Right");
    await terminal.press("Enter");
    await terminal.waitExit({ timeout: 15000 });
    const screen = await terminal.text({ full: true });
    expect(screen).not.toContain("EPIPE");
    expect(await readFile(join(home, "dev", "dev.yaml"), "utf8")).not.toContain("github:");
  }, 30000);
});
