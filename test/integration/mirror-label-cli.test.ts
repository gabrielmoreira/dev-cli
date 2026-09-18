import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runCli } from "../../src/cli";
import { ui } from "../../src/ui.ts";

const SOURCE = "https://github.com/example/docs";

function configText(): string {
  return `version: 1
label_defs:
  docs:public: {}
  docs:internal: {}
sources:
  - url: ${SOURCE}
    branch: master
  - url: ${SOURCE}
    branch: internal
`;
}

describe("mirror label CLI", () => {
  let root: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-label-"));
    await Bun.write(join(root, "dev.yaml"), configText());
    originalLog = console.log;
    originalError = console.error;
    logs = [];
    errors = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  });

  test("selects sources and a label interactively before persisting", async () => {
    const multiSelect = spyOn(ui, "multiSelect").mockResolvedValueOnce(["1"]);
    const select = spyOn(ui, "select").mockResolvedValueOnce("docs:internal");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["mirror", "label", "add", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = parse(await Bun.file(join(root, "dev.yaml")).text());
    expect(config.sources[0].labels).toBeUndefined();
    expect(config.sources[1].labels).toEqual({ "docs:internal": {} });
    expect(logs.join("\n")).toContain("docs:internal");
    expect(logs.join("\n")).toContain("internal");

    multiSelect.mockRestore();
    select.mockRestore();
    confirm.mockRestore();
  });

  test("uses --ref to label one declaration in a non-interactive script", async () => {
    const code = await runCli({
      argv: [
        "mirror",
        "label",
        "add",
        SOURCE,
        "docs:internal",
        "--ref",
        "internal",
        "--root",
        root,
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const config = parse(await Bun.file(join(root, "dev.yaml")).text());
    expect(config.sources[0].labels).toBeUndefined();
    expect(config.sources[1].labels).toEqual({ "docs:internal": {} });
  });

  test("rejects an ambiguous URL without --ref outside a terminal", async () => {
    const code = await runCli({
      argv: ["mirror", "label", "add", SOURCE, "docs:public", "--root", root],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("matches multiple declared refs");
    expect(errors.join("\n")).toContain("--ref");
    expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(configText());
  });
});
