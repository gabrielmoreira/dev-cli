import { afterAll, beforeAll, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../../src/git.ts";

// `dev qmd sync` is dev's own command: one JSON answer, coded failures.
// `dev qmd x` hands every word after `x` to qmd; `dev qmd search` reads its
// own arguments and hands qmd only what follows `--`.

const cliPath = join(process.cwd(), "src", "cli.ts");
let temp: string;
let home: string;
let remote: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "dev-qmd-contract-"));
  home = join(temp, "home");
  remote = join(temp, "remote");
  await mkdir(home);
  await mkdir(remote);
  await git.runGit(["init", "-b", "main"], { cwd: remote });
  await git.runGit(["config", "user.name", "Test"], { cwd: remote });
  await git.runGit(["config", "user.email", "test@example.com"], { cwd: remote });
  await writeFile(join(remote, "file.txt"), "fixture\n");
  await git.runGit(["add", "."], { cwd: remote });
  await git.runGit(["commit", "-m", "fixture"], { cwd: remote });
}, 30_000);

afterAll(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A dev root whose qmd is a script that logs its arguments and echoes them as JSON. */
async function fixture(id: string, withLabel = false) {
  const root = join(temp, id);
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "qmd-plan.ts"),
    [
      'import { appendFile } from "node:fs/promises";',
      "const args = Bun.argv.slice(2);",
      'await appendFile(process.env.QMD_PLAN_CALLS!, JSON.stringify(args) + "\\n");',
      'if (args.join(" ") === process.env.QMD_PLAN_FAIL) { process.stderr.write("fixture failure\\n"); process.exit(7); }',
      'if (process.env.QMD_PLAN_RAW_FAIL === "1") { process.stdout.write("raw answer\\n"); process.stderr.write("raw failure\\n"); process.exit(7); }',
      'if (!["collection", "update", "embed"].includes(args[0]!)) process.stdout.write(JSON.stringify({ args, scope: process.env.QMD_CONFIG_DIR }) + "\\n");',
      "",
    ].join("\n"),
  );
  let command = join(bin, "qmd-plan");
  if (process.platform === "win32") {
    command = join(bin, "qmd-plan.cmd");
    await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0qmd-plan.ts" %*\r\n`);
  } else {
    await writeFile(
      command,
      `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "qmd-plan.ts")}" "$@"\n`,
    );
    await chmod(command, 0o755);
  }
  await writeFile(
    join(root, "dev.yaml"),
    [
      "plugins:",
      "  qmd:",
      `    command: ${JSON.stringify(command)}`,
      "    config_dir: scoped",
      ...(withLabel
        ? [
            "label_defs:",
            '  "index:demo": {}',
            "sources:",
            `  - url: ${JSON.stringify(remote)}`,
            "    branch: main",
            "    labels:",
            '      "index:demo": {}',
          ]
        : []),
      "",
    ].join("\n"),
  );
  return { root, calls, scope: join(root, ".dev", "plugins", "qmd") };
}

async function dev(
  args: string[],
  f: { root: string; calls: string },
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: options.cwd ?? temp,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      CI: "1",
      DEV_ROOT: undefined,
      DEV_CWD: undefined,
      PATH: process.env.PATH,
      QMD_PLAN_CALLS: f.calls,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function calls(file: string): Promise<string[][]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

it("qmd sync --json answers with one structured result", async () => {
  const f = await fixture("sync-success", true);
  const result = await dev(["qmd", "sync", "--no-embed", "--root", f.root, "--json"], f);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    exitCode: 0,
    labels: [{ label: "index:demo", collections: 1 }],
    warnings: [],
  });
  expect(await calls(f.calls)).toContainEqual(["update"]);
  expect(await calls(f.calls)).not.toContainEqual(["embed"]);
}, 60_000);

for (const step of ["collection list", "update", "embed"]) {
  it(`qmd sync reports a failed ${step} as QMD_FAILED, exit 4`, async () => {
    const f = await fixture(`sync-fail-${step.replaceAll(" ", "-")}`, true);
    const result = await dev(["qmd", "sync", "--root", f.root, "--json"], f, {
      env: { QMD_PLAN_FAIL: step },
    });
    expect(result.code, result.stderr).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "QMD_FAILED",
      step,
      args: step.split(" "),
      exitCode: 7,
    });
  }, 60_000);
}

it("qmd x hands qmd every word after x, dev's own flags included", async () => {
  const f = await fixture("x-verbatim");
  const words = ["status", "--root", "elsewhere", "--ws", "other", "--json", "--help", "--version"];
  const result = await dev(["--root", f.root, "qmd", "x", ...words, "--", "--llms"], f);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ args: [...words, "--", "--llms"], scope: f.scope });
});

it("qmd x finds the dev root from the working directory, not from qmd's --root", async () => {
  const f = await fixture("x-cwd-root");
  const result = await dev(["qmd", "x", "status", "--root", "elsewhere"], f, { cwd: f.root });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    args: ["status", "--root", "elsewhere"],
    scope: f.scope,
  });
});

it("qmd x keeps qmd's output streams and exit status on failure", async () => {
  const f = await fixture("x-fail");
  const result = await dev(["--root", f.root, "qmd", "x", "status"], f, {
    env: { QMD_PLAN_RAW_FAIL: "1" },
  });
  expect(result.code).toBe(7);
  expect(result.stdout).toBe("raw answer\n");
  expect(result.stderr).toBe("raw failure\n");
});

it("qmd search hands qmd only the words after --", async () => {
  const f = await fixture("search-extras");
  const result = await dev(
    ["qmd", "search", "sample", "--root", f.root, "--", "-n", "5", "-c", "index:demo"],
    f,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    args: ["search", "sample", "-n", "5", "-c", "index:demo"],
    scope: f.scope,
  });
});

it("qmd search --json asks qmd for JSON", async () => {
  const f = await fixture("search-json");
  const result = await dev(["qmd", "search", "sample", "--root", f.root, "--json"], f);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    args: ["search", "sample", "--json"],
    scope: f.scope,
  });
});

it("qmd search refuses a qmd option before -- and names the boundary", async () => {
  const f = await fixture("search-boundary");
  const result = await dev(["qmd", "search", "sample", "-n", "5", "--root", f.root, "--json"], f);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatchObject({ code: "UNKNOWN_OPTION", option: "-n" });
  expect(await calls(f.calls)).toEqual([]);
});
