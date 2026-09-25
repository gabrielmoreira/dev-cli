import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runCli } from "../../src/cli";
import * as git from "../../src/git.ts";
import { ui } from "../../src/ui.ts";

const SOURCE = "https://github.com/example/docs";
const OTHER = "https://github.com/example/api";
const THIRD = "https://github.com/example/web";

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

describe("dev label CLI", () => {
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

  async function run(argv: string[], tty = false): Promise<number> {
    return await runCli({
      argv: [...argv, "--root", root],
      cwd: root,
      env: {},
      isTTY: tty,
      stdinIsTTY: tty,
    });
  }
  const readConfig = async () => parse(await Bun.file(join(root, "dev.yaml")).text());

  test("chooses the label, then the repositories, before persisting", async () => {
    const select = spyOn(ui, "select").mockResolvedValueOnce("docs:internal");
    const multiSelect = spyOn(ui, "multiSelect")
      .mockResolvedValueOnce([SOURCE])
      .mockResolvedValueOnce(["defaults"]);
    // Two refs of one repository are declared: the user picks which.
    select.mockResolvedValueOnce("1");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await run(["label", "add"], true);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources[0].labels).toBeUndefined();
    expect(config.sources[1].labels).toEqual({ "docs:internal": {} });
    for (const spy of [select, multiSelect, confirm]) spy.mockRestore();
  });

  test("uses --ref to label one declaration in a non-interactive script", async () => {
    const code = await run(["label", "add", "docs:internal", SOURCE, "--ref", "internal"]);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources[0].labels).toBeUndefined();
    expect(config.sources[1].labels).toEqual({ "docs:internal": {} });
  });

  test("rejects an ambiguous repository without --ref outside a terminal", async () => {
    const code = await run(["label", "add", "docs:public", SOURCE]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--ref");
    expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(configText());
  });

  test("declares a repository dev.yaml did not know, and reports the mirror an index label needs", async () => {
    const code = await run(["label", "add", "index:api", OTHER, "--json"]);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources[2]).toEqual({ url: OTHER, labels: { "index:api": {} } });
    const result = JSON.parse(logs.join("\n"));
    expect(result.mirror).toBe(true);
    expect(result.missingMirrors).toEqual([{ url: OTHER }]);
  });

  test("labels several repositories in one command", async () => {
    const code = await run(["label", "add", "team:docs", OTHER, THIRD]);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources.slice(2).map((s: { url: string }) => s.url)).toEqual([OTHER, THIRD]);
  });

  test("keeps a repository's fields when it is labeled again without new ones", async () => {
    await run(["label", "add", "team:docs", OTHER, "--fields", "owner=ana"]);
    await run(["label", "add", "team:docs", OTHER]);

    const config = await readConfig();
    expect(config.sources[2].labels).toEqual({ "team:docs": { owner: "ana" } });
  });

  test("takes a label off every repository with --all, and leaves other labels", async () => {
    await run(["label", "add", "team:docs", OTHER, THIRD]);
    await run(["label", "add", "docs", THIRD]);

    const code = await run(["label", "rm", "team:docs", "--all"]);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources[2].labels).toBeUndefined();
    expect(config.sources[3].labels).toEqual({ docs: {} });
  });

  test("removes a label by repository name when the repository is only in dev.yaml", async () => {
    await Bun.write(
      join(root, "dev.yaml"),
      `version: 1
label_defs:
  team:docs: {}
sources:
  - url: ${SOURCE}
    branch: master
    labels:
      team:docs: {}
`,
    );

    const code = await run(["label", "rm", "team:docs", "docs"]);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources[0].labels).toBeUndefined();
  });

  test("adds a label to a declared repository by name without an inventory", async () => {
    await Bun.write(
      join(root, "dev.yaml"),
      `version: 1
label_defs:
  team:docs: {}
sources:
  - url: ${OTHER}
    branch: main
`,
    );

    const code = await run(["label", "add", "team:docs", "api"]);

    expect(code).toBe(0);
    const config = await readConfig();
    expect(config.sources[0].labels).toEqual({ "team:docs": {} });
  });

  test("refuses an ambiguous name shared by two declared repositories outside a terminal", async () => {
    await Bun.write(
      join(root, "dev.yaml"),
      `version: 1
label_defs:
  team:docs: {}
sources:
  - url: https://github.com/acme/docs
    branch: master
  - url: https://github.com/other/docs
    branch: main
`,
    );

    const code = await run(["label", "add", "team:docs", "docs"]);

    expect(code).toBe(1);
    expect(errors.join(" ")).toContain("pass a full URL");
  });

  test("renames a label and reports where it changed", async () => {
    await run(["label", "add", "team:docs", OTHER]);

    const code = await run(["label", "rename", "team:docs", "team:writing", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ sources: 1, def: false });
    expect((await readConfig()).sources[2].labels).toEqual({ "team:writing": {} });
  });

  test("lists labels with their repositories", async () => {
    await run(["label", "add", "team:docs", OTHER]);
    logs.length = 0;

    await run(["label", "--json"]);

    expect(JSON.parse(logs.join("\n"))).toMatchObject([
      { label: "team:docs", mirror: false, sources: [{ url: OTHER }] },
    ]);
  });

  test("mirror sync creates the mirror an index label asks for, and only once", async () => {
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    await git.runGit(["init", "--bare", "-b", "main", remote]);
    await git.runGit(["init", "-b", "main", seed]);
    await Bun.write(join(seed, "README.md"), "docs\n");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "docs"], {
      cwd: seed,
    });
    await git.runGit(["push", remote, "main"], { cwd: seed });
    await run(["label", "add", "index:local", remote]);
    logs.length = 0;

    expect(await run(["mirror", "sync", "--json"])).toBe(0);
    const first = JSON.parse(logs.join("\n"));
    logs.length = 0;
    expect(await run(["mirror", "sync", "--json"])).toBe(0);
    const second = JSON.parse(logs.join("\n"));

    expect(first.labelMirrors.created).toHaveLength(1);
    expect(first.labelMirrors.created[0].labels).toEqual(["index:local"]);
    expect(await Bun.file(join(first.labelMirrors.created[0].path, "README.md")).exists()).toBe(
      true,
    );
    expect(second.labelMirrors.created).toEqual([]);
  });
});
