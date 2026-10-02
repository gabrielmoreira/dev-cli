import { describe, expect, it } from "bun:test";
import { surveyErrorCodes } from "../../scripts/survey-error-codes.ts";
import { registerGlobalRoot, unregisterGlobalRoot } from "../../src/global.ts";
import { describeError, reportError } from "../../src/cli/errors.ts";
import { ui } from "../../src/ui.ts";

describe("published error tables", () => {
  it("explicitly classifies every app-owned code and its next-step policy", async () => {
    const text = await Bun.file(new URL("../../src/cli/errors.ts", import.meta.url)).text();
    const tables = new Map<string, Set<string>>();
    for (const name of ["EXIT_CODES", "NEXT_STEPS"]) {
      const body = text.match(
        new RegExp(`(?:export )?const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`),
      )?.[1];
      tables.set(
        name,
        new Set([...(body ?? "").matchAll(/^  ([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!)),
      );
    }
    expect(tables.get("EXIT_CODES")?.has("INTERACTION_REQUIRED")).toBe(true);
    const codes = await surveyErrorCodes();
    expect(codes.filter((code) => !tables.get("EXIT_CODES")?.has(code))).toEqual([]);
    expect(codes.filter((code) => !tables.get("NEXT_STEPS")?.has(code))).toEqual([]);
  });

  it("uses published usage, refusal, and network categories instead of the fallback", () => {
    const before = console.error;
    console.error = () => {};
    ui.reset();
    try {
      for (const [code, expected] of [
        ["DEFAULT_BRANCH_UNKNOWN", 2],
        ["MIRROR_PATH_COLLISION", 3],
        ["NETWORK", 4],
        ["ROOT_NOT_FOUND", 2],
        ["AUTH_FAILED", 4],
      ] as const) {
        expect(reportError(Object.assign(new Error("fixture"), { code }), true)).toBe(expected);
      }
    } finally {
      console.error = before;
      ui.reset();
    }
  });

  it("codes an alias collision as refusal without changing the registration", () => {
    const config = { roots: { fixture: { path: "/existing" } } };
    expect(registerGlobalRoot(config, { alias: "fixture", path: "/existing" })).toEqual(
      config.roots.fixture,
    );
    let error: unknown;
    try {
      registerGlobalRoot(config, { alias: "fixture", path: "/different" });
    } catch (caught) {
      error = caught;
    }
    expect(describeError(error).code).toBe("ROOT_ALIAS_EXISTS");
    const before = console.error;
    console.error = () => {};
    ui.reset();
    try {
      expect(reportError(error, true)).toBe(3);
    } finally {
      console.error = before;
      ui.reset();
    }
    expect(config.roots.fixture.path.replaceAll("\\", "/").endsWith("/existing")).toBe(true);
  });

  it("codes an unknown root as usage without removing another root", () => {
    const config = { roots: { fixture: { path: "/existing" } } };
    let error: unknown;
    try {
      unregisterGlobalRoot(config, "missing");
    } catch (caught) {
      error = caught;
    }
    expect(describeError(error).code).toBe("ROOT_NOT_FOUND");
    expect(config.roots.fixture).toEqual({ path: "/existing" });
  });
});
