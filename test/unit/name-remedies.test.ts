import { describe, expect, it, spyOn } from "bun:test";
import * as errors from "../../src/cli/errors.ts";
import { ui } from "../../src/ui.ts";

describe("name suggestions and reachable error guidance", () => {
  it.each([
    { value: "incdent", candidates: ["incident", "other"], expected: "incident" },
    { value: "xy", candidates: ["xx"], expected: undefined },
    { value: "incident", candidates: [], expected: undefined },
    { value: "abcd", candidates: ["abxy"], expected: undefined },
  ])("uses the same bounded name rule (%j)", ({ value, candidates, expected }) => {
    expect(errors.closestName?.(value, candidates)).toBe(expected);
  });
  it.each(Object.keys(errors.EXIT_CODES).filter((code) => code.endsWith("NOT_FOUND")))(
    "renders candidates for %s without dumping help",
    (code) => {
      ui.reset();
      const stderr = spyOn(console, "error").mockImplementation(() => {});
      try {
        errors.reportError(
          Object.assign(new Error("Name was not found"), {
            code,
            details: {
              kind: "workset",
              value: "incdent",
              candidates: ["incident", "other"],
              usage: "dev workset list",
            },
          }),
        );
        const output = stderr.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("Did you mean 'incident'?");
        expect(output).toContain("↳ dev workset list");
        expect(output).not.toContain("USAGE");
      } finally {
        stderr.mockRestore();
        ui.reset();
      }
    },
  );
  it("shows at most five known names when no close match exists", () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      errors.reportError(
        Object.assign(new Error("Unknown workset"), {
          code: "WORKSET_NOT_FOUND",
          details: {
            kind: "workset",
            value: "zzzzz",
            candidates: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
          },
        }),
      );
      const output = stderr.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Known workset names: alpha, bravo, charlie, delta, echo");
      expect(output).not.toContain("foxtrot");
    } finally {
      stderr.mockRestore();
      ui.reset();
    }
  });
  it("prefers the producer's state-specific remedy over the generic table", () => {
    expect(
      errors.describeError(
        Object.assign(new Error("No worksets saved"), {
          code: "WORKSET_NOT_FOUND",
          details: {
            kind: "workset",
            value: "incident",
            candidates: [],
            usage: "dev workset manage incident",
          },
        }),
      ).nextStep,
    ).toBe("dev workset manage incident");
  });
});
