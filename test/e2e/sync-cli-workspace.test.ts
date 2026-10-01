import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import * as ws from "../../src/ws.ts";

describe("contextual sync filters", () => {
  let root: string;
  let cwd: string;
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-sync-filter-"));
    await ws.init({ root, name: "sample-workspace" });
    cwd = join(root, "ws", "sample-workspace");
    errors.length = 0;
    logs.length = 0;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
  });

  afterEach(async () => {
    console.error = originalError;
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  });

  it.each(["provider", "project"])(
    "rejects --%s in a workspace with a JSON usage error",
    async (filter) => {
      const exitCode = await runCli({
        argv: ["sync", `--${filter}`, "x", "--root", root, "--json"],
        cwd,
        env: {},
        isTTY: false,
      });

      expect(exitCode).toBe(2);
      expect(JSON.parse(errors.join("\n")).error).toMatchObject({
        code: "CONFLICTING_OPTIONS",
        usage: "dev sync data --provider <id> [--project <name>]",
      });
      expect(logs).toEqual([]);
    },
  );

  it.each([
    { argv: ["sync", "data", "--provider", "x"], inside: true },
    { argv: ["sync", "--provider", "x"], inside: false },
  ])("keeps provider filters supported on $argv", async ({ argv, inside }) => {
    const exitCode = await runCli({
      argv: [...argv, "--root", root, "--json"],
      cwd: inside ? cwd : root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(errors.join("\n")).error.code).toBe("PROVIDER_NOT_FOUND");
  });
  it("keeps ordinary workspace update routing", async () => {
    const exitCode = await runCli({
      argv: ["sync", "--root", root, "--json"],
      cwd,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      action: "workspace",
      workspaceName: "sample-workspace",
      mounts: [],
      summary: { updated: 0, upToDate: 0, skipped: 0 },
    });
    expect(errors).toEqual([]);
  });

  it.each([
    { flags: ["--all"], action: "all", dataProvider: false },
    { flags: ["--offline"], action: "data", dataProvider: false },
    { flags: ["--offline"], action: "data", dataProvider: true },
  ])(
    "names the $action action for $flags with dataProvider=$dataProvider",
    async ({ flags, action, dataProvider }) => {
      if (dataProvider) {
        await writeFile(
          join(root, "dev.yaml"),
          "version: 1\nproviders:\n  - id: sample-ado\n    type: azure_devops\n    organization: example-org\n    project: sample-project\n",
        );
      }
      const exitCode = await runCli({
        argv: ["sync", ...flags, "--root", root, "--json"],
        cwd: root,
        env: {},
        isTTY: false,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(logs.join("\n")).action).toBe(action);
      expect(errors).toEqual([]);
    },
  );
});
