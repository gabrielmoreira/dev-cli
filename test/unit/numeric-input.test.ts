import { describe, expect, it } from "bun:test";
import { parsePositiveInteger } from "../../src/cli/input.ts";
import { describeError } from "../../src/cli/errors.ts";

describe("positive numeric input", () => {
  it.each([
    { value: "5", expected: 5 },
    { value: "005", expected: 5 },
    { value: "9007199254740991", expected: Number.MAX_SAFE_INTEGER },
  ])("accepts the complete decimal value $value", ({ value, expected }) => {
    expect(parsePositiveInteger(value, "--limit", "dev pr list --limit <count>")).toBe(expected);
  });

  it.each(["0", "-3", "abc", "5x", "1.5", "", " 5", "5 ", "+5", "1e2", "0x5", "9007199254740992"])(
    "rejects invalid numeric input '%s' without coercion",
    (value) => {
      let error: unknown;
      try {
        parsePositiveInteger(value, "--limit", "dev pr list --limit <count>");
      } catch (caught) {
        error = caught;
      }
      expect(describeError(error)).toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { field: "--limit", value, usage: "dev pr list --limit <count>" },
      });
      expect(describeError(error).message).toContain("--limit");
    },
  );
});
