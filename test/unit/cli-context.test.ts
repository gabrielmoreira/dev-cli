import { describe, expect, test } from "bun:test";
import { canPrompt, getAmbient, setAmbient } from "../../src/cli/context";
import { ui } from "../../src/ui.ts";

describe("CLI prompt eligibility", () => {
  test("allows prompts only when stdin and stdout are interactive", () => {
    expect(
      canPrompt({
        argv: [],
        cwd: "/workspace",
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(true);

    expect(
      canPrompt({
        argv: [],
        cwd: "/workspace",
        env: {},
        isTTY: true,
        stdinIsTTY: false,
      }),
    ).toBe(false);
  });

  test("disables prompts for JSON output", () => {
    expect(
      canPrompt({
        argv: ["ws", "init", "--json"],
        cwd: "/workspace",
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(false);
  });

  test("disables prompts when non-interactive mode is explicit", () => {
    expect(
      canPrompt({
        argv: ["ws", "init", "--non-interactive"],
        cwd: "/workspace",
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(false);
  });

  test("disables prompts in continuous integration", () => {
    expect(
      canPrompt({
        argv: ["ws", "init"],
        cwd: "/workspace",
        env: { CI: "true" },
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(false);
  });

  test("disables prompts under a coding agent, even in a terminal", () => {
    for (const env of [{ AGENT: "1" }, { AI_AGENT: "cursor-cli" }, { CLAUDECODE: "1" }]) {
      expect(
        canPrompt({ argv: ["ws", "add"], cwd: "/workspace", env, isTTY: true, stdinIsTTY: true }),
      ).toBe(false);
    }
  });

  test.each(["json", "non-interactive"])(
    "applies %s boolean spellings to prompt policy",
    (name) => {
      const ambient = { cwd: "/workspace", env: {}, isTTY: true, stdinIsTTY: true };
      expect(canPrompt({ ...ambient, argv: [] })).toBe(true);
      expect(canPrompt({ ...ambient, argv: [`--${name}=false`] })).toBe(true);
      expect(canPrompt({ ...ambient, argv: [`--no-${name}`] })).toBe(true);
      expect(canPrompt({ ...ambient, argv: [`--${name}`] })).toBe(false);
      expect(canPrompt({ ...ambient, argv: [`--${name}=true`] })).toBe(false);
      expect(canPrompt({ ...ambient, argv: ["--", `--${name}`] })).toBe(true);
    },
  );

  test("applies quiet boolean spellings to narration without hiding answers", () => {
    const originalAmbient = getAmbient();
    const originalError = console.error;
    const originalLog = console.log;
    const narration: string[] = [];
    const answers: string[] = [];
    console.error = (value: string) => narration.push(value);
    console.log = (value: string) => answers.push(value);
    try {
      setAmbient({ argv: ["--quiet=false"], cwd: "/workspace", env: {}, isTTY: false });
      ui.info("visible");
      expect(narration).toEqual(["visible"]);
      setAmbient({ argv: ["--quiet=true"], cwd: "/workspace", env: {}, isTTY: false });
      ui.info("hidden");
      ui.result({ data: "answer", text: "answer" });
      expect(narration).toEqual(["visible"]);
      expect(answers).toEqual(["answer"]);
    } finally {
      console.error = originalError;
      console.log = originalLog;
      setAmbient(originalAmbient);
    }
  });
});
