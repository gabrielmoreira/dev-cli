import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCommandHelp } from "../../src/cli/index.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
describe("not-found remedies exist in the erroring state", () => {
  let home: string;
  let root: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "dev-remedy-state-"));
    root = join(home, "dev");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function run(args: readonly string[], json = false) {
    const p = Bun.spawn(
      [Bun.which("bun")!, CLI, "--root", root, ...args, ...(json ? ["--json"] : [])],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          DEV_ROOT: root,
          DEV_CWD: home,
          CI: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { stdout, stderr, code };
  }
  async function setup() {
    expect((await run(["init", root, "--alias", "base"], true)).code).toBe(0);
    await Bun.write(
      join(root, "dev.yaml"),
      "version: 1\nsources:\n  - url: https://github.com/example/api\n    labels:\n      incident: {}\n  - url: https://github.com/example/docs\nworksets:\n  incident:\n    members:\n      - source: https://github.com/example/api\n  other:\n    members:\n      - source: https://github.com/example/docs\nproviders:\n  - id: incident\n    type: github\n    owner: example\n  - id: other\n    type: github\n    owner: other\n",
    );
    expect((await run(["ws", "init", "incident"], true)).code).toBe(0);
    expect((await run(["ws", "init", "other"], true)).code).toBe(0);
    expect((await run(["root", "add", root, "--alias", "incident"], true)).code).toBe(0);
  }
  it.each([
    {
      args: ["workset", "show", "incdent"],
      code: "WORKSET_NOT_FOUND",
      kind: "workset",
      next: "dev workset list",
      remedy: ["workset", "list"],
    },
    {
      args: ["go", "incidnet"],
      code: "WORKSPACE_NOT_FOUND",
      kind: "workspace",
      next: "dev ls",
      remedy: ["ls"],
    },
    {
      args: ["label", "rm", "incdent", "--all"],
      code: "LABEL_NOT_FOUND",
      kind: "label",
      next: "dev label list",
      remedy: ["label", "list"],
    },
    {
      args: ["sync", "inventory", "--provider", "incdent"],
      code: "PROVIDER_NOT_FOUND",
      kind: "provider",
      next: "dev provider list",
      remedy: ["provider", "list"],
    },
    {
      args: ["root", "remove", "incdent"],
      code: "ROOT_NOT_FOUND",
      kind: "root",
      next: "dev roots",
      remedy: ["roots"],
    },
    {
      args: ["pr", "list", "--label", "incdent"],
      code: "ERROR",
      kind: "label",
      next: "dev label list",
      remedy: ["label", "list"],
    },
  ])(
    "offers a registered remedy that runs without new setup (%j)",
    async ({ args, code, kind, next, remedy }) => {
      await setup();
      const failure = await run(args);
      expect(failure.code).not.toBe(0);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toContain("Did you mean 'incident'?");
      expect(failure.stderr).toContain(`↳ ${next}`);
      expect(failure.stderr).not.toContain("USAGE");
      const structured = await run(args, true);
      expect(JSON.parse(structured.stderr).error).toMatchObject({
        code,
        details: {
          kind,
          value: kind === "workspace" ? "incidnet" : "incdent",
          candidates: expect.arrayContaining(["incident"]),
        },
      });
      expect(await formatCommandHelp([...remedy])).toContain("USAGE");
      const recovery = await run(remedy, true);
      expect(recovery.code).toBe(0);
      expect(recovery.stderr).toBe("");
    },
  );
  it.each(
    [
      ["label", "add"],
      ["workset", "show", "missing"],
      ["go", "missing"],
      ["sync", "inventory"],
    ].map((args) => ({ args })),
  )("offers init when there is no root (%j)", async ({ args }) => {
    const failure = await run(args);
    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain("No dev root yet");
    expect(failure.stderr).toContain("↳ dev init");
    expect(failure.stderr).not.toContain("dev sync inventory");
    expect((await run(["init"], true)).code).toBe(0);
  });
  it("does not tell a provider-free root to sync repositories", async () => {
    expect((await run(["init", root], true)).code).toBe(0);
    const failure = await run(["workset", "create", "incident", "missing"], true);
    expect(failure.code).toBe(2);
    const error = JSON.parse(failure.stderr).error;
    expect(error.nextStep).not.toContain("dev sync inventory");
    expect(error.details).toMatchObject({ kind: "repository", value: "missing", candidates: [] });
    expect(
      (
        await run(
          ["workset", "create", "incident", "https://github.com/example/api", "--yes"],
          true,
        )
      ).code,
    ).toBe(0);
  });
  it.each([
    {
      args: ["workset", "show", "missing"],
      remedy: ["workset", "create", "incident", "https://github.com/example/api", "--yes"],
    },
    { args: ["go", "missing"], remedy: ["ws", "init", "incident"] },
  ])("offers a create command when none exist (%j)", async ({ args, remedy }) => {
    expect((await run(["init", root], true)).code).toBe(0);
    const failure = await run(args, true);
    expect(failure.code).not.toBe(0);
    expect(JSON.parse(failure.stderr).error.nextStep.split(" ").slice(0, 3)).toEqual([
      "dev",
      ...remedy.slice(0, 2),
    ]);
    expect(await formatCommandHelp(remedy.slice(0, 2))).toContain("USAGE");
    expect((await run(remedy, true)).code).toBe(0);
  });
  it("shows the available workspace values with the missing-input usage", async () => {
    await setup();
    const failure = await run(["ws", "status"]);
    expect(failure.code).toBe(2);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("Known workspace values: incident, other");
    expect(failure.stderr).toContain("see workspace names with dev ls");
    expect((await run(["ls"], true)).code).toBe(0);
  });
  it("offers root setup for an explicit workspace operation outside a root", async () => {
    const failure = await run(["ws", "status", "incident"], true);
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.stderr).error).toMatchObject({
      message: "No dev root yet.",
      nextStep: "dev init",
      details: { kind: "workspace", value: "incident", candidates: [] },
    });
    expect((await run(["init"], true)).code).toBe(0);
  });
  it("offers root initialization when registration targets an uninitialized directory", async () => {
    const failure = await run(["root", "add", root], true);
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.stderr).error.nextStep).toBe(`dev init ${JSON.stringify(root)}`);
    expect((await run(["init", root], true)).code).toBe(0);
    expect((await run(["root", "add", root], true)).code).toBe(0);
  });
  it("offers unattended creation when the interactive manager cannot run", async () => {
    expect((await run(["init", root], true)).code).toBe(0);
    const failure = await run(["workset", "manage"], true);
    expect(failure.code).toBe(1);
    expect(
      (
        await run(
          ["workset", "create", "incident", "https://github.com/example/api", "--yes"],
          true,
        )
      ).code,
    ).toBe(0);
  });
});
