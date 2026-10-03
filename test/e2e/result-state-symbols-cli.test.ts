import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspace } from "../../src/manifest.ts";

const cliPath = join(process.cwd(), "src", "cli.ts");
let temp: string;
let root: string;
let remote: string;
let env: Record<string, string | undefined>;
async function run(argv: string[], cwd = temp) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function git(args: string[], cwd: string) {
  const result = await run(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
}
async function cli(args: string[], json = false) {
  const result = await run([
    process.execPath,
    cliPath,
    ...args,
    "--root",
    root,
    ...(json ? ["--json"] : []),
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result;
}
async function mount() {
  await cli(["ws", "init", "sample"], true);
  await cli(["ws", "add", remote, "--ws", "sample", "--path", "repo", "--branch", "main"], true);
  return join(root, "ws", "sample", "repo");
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "dev-state-symbols-"));
  root = join(temp, "root");
  remote = join(temp, "remote");
  const home = join(temp, "home");
  for (const path of [root, remote, home]) await mkdir(path);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    DEV_ROOT: undefined,
    DEV_CWD: undefined,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  await writeFile(join(root, "dev.yaml"), "providers: []\n");
  await git(["init", "-b", "main"], remote);
  await writeFile(join(remote, "file.txt"), "fixture\n");
  await git(["add", "."], remote);
  await git(["commit", "-m", "fixture"], remote);
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("status marks clean as a fact and local changes as a caveat without turning observation into failure", async () => {
  const path = await mount();
  const before = await readFile(join(root, "ws", "sample", "ws.md"), "utf8");
  const clean = await cli(["ws", "status", "--ws", "sample"]);
  expect(clean.stdout).toMatch(/^  ○ repo \[clean\]$/m);
  expect(clean.stderr).toBe("");
  expect(
    JSON.parse((await cli(["ws", "status", "--ws", "sample"], true)).stdout).mounts[0].state,
  ).toBe("clean");
  await writeFile(join(path, "untracked.txt"), "keep local work\n");
  const dirty = await cli(["ws", "status", "--ws", "sample"]);
  expect(dirty.stdout).toMatch(/^  ⚠ repo \[dirty\]$/m);
  expect(dirty.stdout).not.toMatch(/^  [✓✗] repo/m);
  expect(dirty.stderr).toBe("");
  expect(
    JSON.parse((await cli(["ws", "status", "--ws", "sample"], true)).stdout).mounts[0].state,
  ).toBe("dirty");
  expect(await readFile(join(path, "untracked.txt"), "utf8")).toBe("keep local work\n");
  expect(await readFile(join(root, "ws", "sample", "ws.md"), "utf8")).toBe(before);
}, 60_000);

it("completed removal and already-absent repeat use different outcome marks while JSON remains undecorated", async () => {
  const path = await mount();
  const args = ["ws", "remove", "repo", "--ws", "sample", "--yes"];
  const removed = await cli(args);
  expect(removed.stdout.trimStart().startsWith("✓ ")).toBe(true);
  expect(existsSync(path)).toBe(false);
  const manifestPath = join(root, "ws", "sample", "ws.md");
  expect((await readWorkspace(manifestPath)).manifest.mounts).toEqual([]);
  const before = await readFile(manifestPath, "utf8");
  const absent = await cli(args);
  expect(absent.stdout.trimStart().startsWith("○ ")).toBe(true);
  const json = JSON.parse((await cli(args, true)).stdout);
  expect(json).toMatchObject({ path: "repo", removed: false });
  expect(await readFile(manifestPath, "utf8")).toBe(before);
  expect(absent.stderr).toBe("");
}, 60_000);
