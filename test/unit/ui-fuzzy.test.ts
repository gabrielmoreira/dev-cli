import { describe, expect, test } from "bun:test";
import { fuzzyScore, rankOptions } from "../../src/ui.ts";

describe("fuzzy picker search", () => {
  test("matches non-contiguous characters in order", () => {
    expect(fuzzyScore("dvcli", "dev-cli")).toBeNumber();
    expect(fuzzyScore("xyz", "dev-cli")).toBeUndefined();
    expect(fuzzyScore("ilcvd", "dev-cli")).toBeUndefined();
  });

  test("ranks prefixes and contiguous words above separated letters", () => {
    const prefix = fuzzyScore("api", "api-gateway")!;
    const word = fuzzyScore("api", "sample-api")!;
    const separated = fuzzyScore("api", "a-p-i-misc")!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(separated);
  });

  test("matches case-insensitively", () => {
    expect(fuzzyScore("DVCLI", "dev-cli")).toBe(fuzzyScore("dvcli", "DEV-CLI"));
    expect(fuzzyScore("DVCLI", "dev-cli")).toBeNumber();
  });

  test("rewards word starts and camel-case boundaries", () => {
    for (const separator of ["/", "-", "_", ".", ":", "@", " "]) {
      expect(fuzzyScore("api", `x${separator}api`)).toBeGreaterThan(fuzzyScore("api", "xxapi")!);
    }
    expect(fuzzyScore("api", "xxApi")).toBeGreaterThan(fuzzyScore("api", "xxapi")!);
  });

  test("penalizes gaps between matches", () => {
    expect(fuzzyScore("ac", "abc")).toBeGreaterThan(fuzzyScore("ac", "abbbc")!);
  });

  test("matches every text equally for empty or whitespace queries", () => {
    expect(fuzzyScore("", "dev-cli")).toBe(0);
    expect(fuzzyScore(" \t ", "sample-api")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });

  test("ranks the best label or value match, preserves ties and empty-query order", () => {
    const options = [
      { label: "a-p-i-misc", value: "misc" },
      { label: "sample-api", value: "sample-api" },
      { label: "api-gateway", value: "gateway" },
      { label: "Backend", value: "api-service" },
      { label: "No match", value: "none" },
    ];
    expect(rankOptions("api", options)).toEqual([
      options[2]!,
      options[3]!,
      options[1]!,
      options[0]!,
    ]);
    expect(rankOptions("", options)).toEqual(options);
    expect(rankOptions(" \t ", options)).toEqual(options);
    expect(rankOptions("dvcli", [{ label: "dev-cli", value: "dev-cli" }])).toEqual([
      { label: "dev-cli", value: "dev-cli" },
    ]);
  });
});
