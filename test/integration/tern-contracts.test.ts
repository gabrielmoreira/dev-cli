import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { resolveConfig } from "../../src/config.ts";
import { ui } from "../../src/ui.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dev-tern-contract-"));
  await Bun.write(
    join(root, "dev.yaml"),
    "# Keep this root note\nversion: 1\nplugins:\n  qmd:\n    command: qmd\n",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const run = (argv: string[]) =>
  runCli({
    argv: [...argv, "--root", root, "--json", "--non-interactive"],
    cwd: root,
    env: {},
    isTTY: false,
  });

test("saving a complete workset draft preserves unrelated root configuration", async () => {
  const definition = {
    description: "Review the API",
    setup: "echo setup",
    members: [
      {
        source: "https://example.invalid/api.git",
        ref: "main",
        path: "api",
        reason: "implementation",
        setup: false as const,
      },
    ],
  };
  expect(
    await run(["workset", "save", "review", "--definition-json", JSON.stringify(definition)]),
  ).toBe(0);
  expect(resolveConfig({ rootFlag: root, cwd: root, env: {} }).worksets.review).toEqual(definition);
  expect(await Bun.file(join(root, "dev.yaml")).text()).toContain("# Keep this root note");
});

test("reviewing explicit mount inputs does not create workspace files", async () => {
  const before = await Bun.file(join(root, "dev.yaml")).text();
  const mounts = [{ source: "https://example.invalid/api.git", branch: "main", path: "api" }];
  expect(
    await run(["ws", "init", "review", "--mounts-json", JSON.stringify(mounts), "--dry-run"]),
  ).toBe(0);
  expect(await Bun.file(join(root, "ws", "review", "ws.md")).exists()).toBe(false);
  expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(before);
});

test.each(["{", JSON.stringify({ members: [{}] })])(
  "invalid workset draft %s returns a usage error without changing dev.yaml",
  async (definition) => {
    const before = await Bun.file(join(root, "dev.yaml")).text();
    expect(await run(["workset", "save", "bad-draft", "--definition-json", definition])).toBe(2);
    expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(before);
  },
);

test("a blank workset name returns a usage error without changing dev.yaml", async () => {
  const before = await Bun.file(join(root, "dev.yaml")).text();
  expect(
    await run([
      "workset",
      "save",
      "   ",
      "--definition-json",
      JSON.stringify({ members: [{ source: "https://example.invalid/api.git" }] }),
    ]),
  ).toBe(2);
  expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(before);
});

test.each(["{", "{}", "[{}]"])(
  "invalid mount plan %s returns a usage error before creating workspace files",
  async (mounts) => {
    const before = await Bun.file(join(root, "dev.yaml")).text();
    expect(await run(["ws", "init", "invalid", "--mounts-json", mounts])).toBe(2);
    expect(await Bun.file(join(root, "ws", "invalid", "ws.md")).exists()).toBe(false);
    expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(before);
  },
);

test("renaming a workset onto an existing name leaves dev.yaml unchanged", async () => {
  await Bun.write(
    join(root, "dev.yaml"),
    "# Keep this root note\nversion: 1\nworksets:\n  first:\n    members:\n      - source: https://example.invalid/first.git\n  second:\n    members:\n      - source: https://example.invalid/second.git\n",
  );
  const before = await Bun.file(join(root, "dev.yaml")).text();
  expect(
    await run([
      "workset",
      "save",
      "second",
      "--original",
      "first",
      "--definition-json",
      JSON.stringify({ members: [{ source: "https://example.invalid/first.git" }] }),
    ]),
  ).not.toBe(0);
  expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(before);
});

test("duplicate and overlapping mount paths are rejected before workspace creation", async () => {
  const before = await Bun.file(join(root, "dev.yaml")).text();
  for (const paths of [
    ["repo", "repo"],
    ["repo", "repo/nested"],
  ]) {
    const mounts = paths.map((path, index) => ({
      source: `https://example.invalid/${index}.git`,
      branch: "main",
      path,
    }));
    const workspace = `collision-${paths.length}-${paths[1]!.replaceAll("/", "-")}`;
    expect(await run(["ws", "init", workspace, "--mounts-json", JSON.stringify(mounts)])).toBe(3);
    expect(await Bun.file(join(root, "ws", workspace, "ws.md")).exists()).toBe(false);
    expect(await Bun.file(join(root, "dev.yaml")).text()).toBe(before);
  }
});

test("reviewed mounts preserve reasons and distinguish inherited, custom and skipped setup", async () => {
  const result = spyOn(ui, "result").mockImplementation(() => {});
  try {
    const mounts = [
      { source: "https://example.invalid/api.git", path: "api", reason: "Implementation" },
      { source: "https://example.invalid/docs.git", path: "docs", setup: false },
      { source: "https://example.invalid/tools.git", path: "tools", setup: "echo custom" },
    ];
    expect(
      await run([
        "ws",
        "init",
        "setup-review",
        "--mounts-json",
        JSON.stringify(mounts),
        "--setup",
        "echo inherited",
        "--dry-run",
      ]),
    ).toBe(0);
    expect(result.mock.calls.at(-1)?.[0].data).toEqual(
      expect.objectContaining({
        mounts: [
          {
            source: mounts[0]!.source,
            path: "api",
            reason: "Implementation",
            setup: "echo inherited",
          },
          { source: mounts[1]!.source, path: "docs" },
          { source: mounts[2]!.source, path: "tools", setup: "echo custom" },
        ],
      }),
    );
    expect(await Bun.file(join(root, "ws", "setup-review", "ws.md")).exists()).toBe(false);
  } finally {
    result.mockRestore();
  }
});
