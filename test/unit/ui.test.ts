import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ui } from "../../src/ui";

describe("CLI UI", () => {
  let originalError: typeof console.error;

  beforeEach(() => {
    originalError = console.error;
    console.error = () => {};
    process.exitCode = 0;
  });

  afterEach(() => {
    console.error = originalError;
    process.exitCode = 0;
  });

  test("reporting an error does not mutate global process state", () => {
    ui.error("failure");

    expect(process.exitCode).toBe(0);
  });
});
