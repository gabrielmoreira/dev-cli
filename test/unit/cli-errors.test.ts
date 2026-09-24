import { describe, expect, spyOn, test } from "bun:test";
import { describeError, reportError } from "../../src/cli/errors.ts";
import { ui } from "../../src/ui.ts";

class Coded extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

describe("describeError", () => {
  test("names the way out for a known code", () => {
    const described = describeError(new Coded("WORKSPACE_NOT_FOUND", "Workspace 'x' not found"));

    expect(described.code).toBe("WORKSPACE_NOT_FOUND");
    expect(described.nextStep).toBe("dev ls");
  });

  test("fills the next step from the error's own details", () => {
    const described = describeError(
      new Coded("UNSAFE_REMOVE", "core has local commits", { path: "/dev/ws/fix/core" }),
    );

    expect(described.nextStep).toBe("git -C /dev/ws/fix/core status");
  });

  test("leaves a placeholder as syntax when the detail is missing", () => {
    const described = describeError(new Coded("UNSAFE_REMOVE", "core has local commits"));

    expect(described.nextStep).toBe("git -C <path> status");
  });

  test("offers no hint for a code nobody can act on", () => {
    const described = describeError(new Coded("SOMETHING_ODD", "it broke"));

    expect(described.code).toBe("SOMETHING_ODD");
    expect(described.nextStep).toBeUndefined();
  });

  test("handles a plain error and a non-error alike", () => {
    expect(describeError(new Error("plain")).code).toBeUndefined();
    expect(describeError("just a string").message).toBe("just a string");
  });
});

describe("reportError exit codes", () => {
  test("separates wrong usage, refusal, external failure, and the rest", () => {
    ui.reset();
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    expect(reportError(new Coded("INTERACTION_REQUIRED", "name is required"), true)).toBe(2);
    expect(reportError(new Coded("DIRTY_WORKTREE", "core has changes"), true)).toBe(3);
    expect(reportError(new Coded("AUTH_FAILED", "token rejected"), true)).toBe(4);
    expect(reportError(new Coded("WORKSPACE_NOT_FOUND", "no such workspace"), true)).toBe(1);
    expect(reportError(new Error("plain"), true)).toBe(1);
    stderr.mockRestore();
  });
});
