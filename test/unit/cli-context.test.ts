import { describe, expect, test } from "bun:test";
import { canPrompt } from "../../src/cli/context";

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
});
