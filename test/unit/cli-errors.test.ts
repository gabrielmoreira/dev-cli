import { describe, expect, spyOn, test } from "bun:test";
import { describeError, reportError } from "../../src/cli/errors.ts";
import { ui } from "../../src/ui.ts";
import { parseGlobalToml } from "../../src/global.ts";

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

  test("normalizes citty unknown commands to usage errors with actionable help", () => {
    const error = new Coded("E_UNKNOWN_COMMAND", "Unknown command missing", {
      usage: "dev ws --help",
    });
    expect(describeError(error)).toMatchObject({
      code: "UNKNOWN_COMMAND",
      nextStep: "dev ws --help",
    });
    expect(describeError(new Coded("E_UNKNOWN_COMMAND", "Unknown command missing")).nextStep).toBe(
      "dev --help",
    );
    ui.reset();
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(reportError(error, true)).toBe(2);
    } finally {
      stderr.mockRestore();
    }
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

  test("reports invalid registry TOML as actionable usage failure without exposing its contents", () => {
    let error: unknown;
    const path = "/fixture/.dev.toml";
    try {
      parseGlobalToml(
        String.raw`private_value = "private-registry-value"
path = "C:\Users\Example\dev"`,
        path,
      );
    } catch (caught) {
      error = caught;
    }
    ui.reset();
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(reportError(error, true)).toBe(2);
      const output = stderr.mock.calls.map(([message]) => message).join("\n");
      const result = JSON.parse(output);
      expect(result.error.code).toBe("INVALID_GLOBAL_TOML");
      expect(result.error.path).toBe(path);
      expect(result.error.message).toContain(path);
      expect(result.error.message).toMatch(/forward slashes/i);
      expect(result.error.message).toMatch(/TOML escaping/i);
      expect(result.error.nextStep).toContain(path);
      expect(result.error).not.toHaveProperty("cause");
      expect(output).not.toContain("private-registry-value");
    } finally {
      stderr.mockRestore();
    }
  });
});
