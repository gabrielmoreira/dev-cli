import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(process.cwd(), "src", "cli.ts");
let temp: string;
let remote: string;
let env: Record<string, string | undefined>;

async function run(args: string[], cwd = temp) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function cli(root: string, args: string[]) {
  return run([process.execPath, cliPath, ...args, "--root", root, "--json"]);
}
async function ok(root: string, args: string[]) {
  const result = await cli(root, args);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function workspace(id: string) {
  const root = join(temp, id);
  await mkdir(root);
  await writeFile(join(root, "dev.yaml"), "providers: []\n");
  await ok(root, ["ws", "init", "sample"]);
  await ok(root, ["ws", "add", remote, "--ws", "sample", "--path", "repo", "--branch", "main"]);
  return root;
}
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "dev-revision-flags-"));
  const home = join(temp, "home");
  await mkdir(home);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    CI: "1",
    DEV_ROOT: undefined,
    DEV_CWD: undefined,
  };
  remote = join(temp, "remote");
  await mkdir(remote);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
  ]) {
    const result = await run(["git", ...args], remote);
    expect(result.code, result.stderr).toBe(0);
  }
  await writeFile(join(remote, "file.txt"), "fixture\n");
  for (const args of [
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["branch", "feature"],
    ["tag", "v1"],
  ]) {
    const result = await run(["git", ...args], remote);
    expect(result.code, result.stderr).toBe(0);
  }
}, 30_000);
afterAll(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("mirror track accepts --branch and retains positional branch", async () => {
  const root = await workspace("mirror-track");
  await ok(root, ["mirror", "add", remote]);
  const flagged = await ok(root, ["mirror", "track", remote, "--branch", "feature"]);
  expect(flagged.branch).toBe("feature");
  expect(existsSync(flagged.path)).toBe(true);
  const positional = await ok(root, ["mirror", "track", remote, "feature"]);
  expect(positional.path).toBe(flagged.path);
  expect(positional.created).toBe(false);
}, 30_000);
it("mirror untrack accepts --branch and removes only the secondary checkout", async () => {
  const root = await workspace("mirror-untrack");
  const canonical = await ok(root, ["mirror", "add", remote]);
  const tracked = await ok(root, ["mirror", "track", remote, "feature"]);
  await ok(root, ["mirror", "untrack", remote, "--branch", "feature", "--yes"]);
  expect(existsSync(tracked.path)).toBe(false);
  expect(existsSync(canonical.path)).toBe(true);
}, 30_000);
it("ws track accepts --branch and retains positional branch", async () => {
  const root = await workspace("ws-track");
  const control = await ok(root, ["ws", "track", "repo", "main", "--ws", "sample"]);
  expect(control.branch).toBe("main");
  const flagged = await ok(root, ["ws", "track", "repo", "--branch", "feature", "--ws", "sample"]);
  expect(flagged.branch).toBe("feature");
}, 30_000);
it("ws unlock accepts --branch for one mount and --all, and retains the lone positional shorthand", async () => {
  const root = await workspace("ws-unlock");
  await ok(root, ["ws", "lock", "repo", "--ws", "sample"]);
  const one = await ok(root, ["ws", "unlock", "repo", "--branch", "feature", "--ws", "sample"]);
  expect(one.unlockedMounts.map((mount: { branch: string }) => mount.branch)).toEqual(["feature"]);
  await ok(root, ["ws", "lock", "--all", "--ws", "sample"]);
  const all = await ok(root, ["ws", "unlock", "--all", "--branch", "main", "--ws", "sample"]);
  expect(all.unlockedMounts.map((mount: { branch: string }) => mount.branch)).toEqual(["main"]);
  await ok(root, ["ws", "lock", "--all", "--ws", "sample"]);
  const shorthand = await ok(root, ["ws", "unlock", "--all", "feature", "--ws", "sample"]);
  expect(shorthand.unlockedMounts.map((mount: { branch: string }) => mount.branch)).toEqual([
    "feature",
  ]);
}, 30_000);
it("ws tag accepts --tag and retains positional tag", async () => {
  const root = await workspace("ws-tag");
  const flagged = await ok(root, ["ws", "tag", "repo", "--tag", "v1", "--ws", "sample"]);
  expect(flagged.tag).toBe("v1");
  const control = await ok(root, ["ws", "tag", "repo", "v1", "--ws", "sample"]);
  expect(control.tag).toBe("v1");
  expect(control.changed).toBe(false);
}, 30_000);
for (const [group, verb, legacy] of [
  ["mirror", "track", "branchFlag"],
  ["mirror", "untrack", "branchFlag"],
  ["ws", "track", "branchFlag"],
  ["ws", "unlock", "branchFlag"],
  ["ws", "tag", "tagFlag"],
]) {
  for (const spelling of [
    legacy!,
    legacy!.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()),
  ]) {
    it(group + " " + verb + " rejects removed --" + spelling, async () => {
      const result = await cli(temp, [group!, verb!, "--" + spelling, "feature"]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("UNKNOWN_OPTION");
    });
  }
}
