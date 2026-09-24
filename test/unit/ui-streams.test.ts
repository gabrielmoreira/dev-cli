import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ui } from "../../src/ui.ts";

describe("ui stream discipline", () => {
  let out: string[];
  let err: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    out = [];
    err = [];
    originalLog = console.log;
    originalError = console.error;
    originalWarn = console.warn;
    console.log = (...args: unknown[]) => {
      out.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      err.push(args.join(" "));
    };
    console.warn = (...args: unknown[]) => {
      err.push(args.join(" "));
    };
    ui.reset();
    ui.setQuiet(false);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    ui.reset();
  });

  test("narration goes to stderr and never to stdout", () => {
    ui.info("resolving branches");
    ui.success("created core");
    ui.warn("mirror is stale");
    ui.error("something failed");

    expect(out).toEqual([]);
    expect(err).toEqual([
      "resolving branches",
      "created core",
      "mirror is stale",
      "something failed",
    ]);
  });

  test("the answer goes to stdout", () => {
    ui.log("/dev/ws/payment-fix/core");
    ui.json({ ok: true });
    ui.result({ data: { path: "x" }, text: "rendered text" });
    ui.result({ data: { path: "x" }, json: true });

    expect(err).toEqual([]);
    expect(out).toEqual([
      "/dev/ws/payment-fix/core",
      '{\n  "ok": true\n}',
      "rendered text",
      '{\n  "path": "x"\n}',
    ]);
  });

  test("a captured stdout carries only the answer", () => {
    ui.info("Sync action: workspace update (payment-fix).");
    ui.log("/dev/ws/payment-fix");

    expect(out.join("\n")).toBe("/dev/ws/payment-fix");
  });
});
