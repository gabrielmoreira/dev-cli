import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  return result.stdout.trim();
}
async function cli(args: string[]) {
  return run([process.execPath, cliPath, ...args, "--root", root, "--json"]);
}
async function ok(args: string[]) {
  const result = await cli(args);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function checkout(kind: "ws" | "mirror") {
  if (kind === "ws") {
    await ok(["ws", "init", "sample"]);
    await ok(["ws", "add", remote, "--ws", "sample", "--path", "repo", "--branch", "main"]);
    return join(root, "ws", "sample", "repo");
  }
  await ok(["mirror", "add", remote, "--branch", "main"]);
  return (await ok(["mirror", "track", remote, "feature"])).path as string;
}
function removeArgs(kind: "ws" | "mirror") {
  return kind === "ws"
    ? ["ws", "remove", "repo", "--ws", "sample"]
    : ["mirror", "untrack", remote, "feature"];
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "dev-remove-confirm-"));
  const home = join(temp, "home");
  root = join(temp, "root");
  remote = join(temp, "remote");
  for (const dir of [home, root, remote]) await mkdir(dir);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    DEV_ROOT: undefined,
    DEV_CWD: undefined,
  };
  await writeFile(join(root, "dev.yaml"), "providers: []\n");
  await git(["init", "-b", "main"], remote);
  await writeFile(join(remote, "file.txt"), "fixture\n");
  await git(["add", "."], remote);
  await git(["commit", "-m", "fixture"], remote);
  await git(["branch", "feature"], remote);
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const kind of ["ws", "mirror"] as const) {
  it(`${kind}: unattended removal without either flag asks for --yes`, async () => {
    const path = await checkout(kind);
    const result = await cli(removeArgs(kind));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("INTERACTION_REQUIRED");
    expect(error.usage).toContain("--yes");
    expect(error.usage).not.toContain("--force");
    expect(existsSync(path)).toBe(true);
  }, 60_000);

  it(`${kind}: --yes removes a clean checkout without force`, async () => {
    const path = await checkout(kind);
    const result = await ok([...removeArgs(kind), "--yes"]);
    expect(result.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    if (kind === "ws") {
      expect(await readFile(join(root, "ws", "sample", "ws.md"), "utf8")).not.toContain(
        "path: repo",
      );
    }
  }, 60_000);

  it(`${kind}: --yes preserves modified files and refuses`, async () => {
    const path = await checkout(kind);
    await writeFile(join(path, "file.txt"), "keep local edits\n");
    const manifest = join(root, "ws", "sample", "ws.md");
    const before = kind === "ws" ? await readFile(manifest, "utf8") : undefined;
    const result = await cli([...removeArgs(kind), "--yes"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe(kind === "ws" ? "UNSAFE_REMOVE" : "DIRTY_WORKTREE");
    expect(error.message).toContain("--force");
    expect(await readFile(join(path, "file.txt"), "utf8")).toBe("keep local edits\n");
    if (before !== undefined) expect(await readFile(manifest, "utf8")).toBe(before);
  }, 60_000);

  for (const flags of [["--force"], ["--yes", "--force"], ["--yes=false", "--force"]]) {
    it(`${kind}: ${flags.join(" ")} confirms and permits dirty removal`, async () => {
      const path = await checkout(kind);
      await writeFile(join(path, "untracked.txt"), "discard explicitly authorized\n");
      expect((await ok([...removeArgs(kind), ...flags])).removed).toBe(true);
      expect(existsSync(path)).toBe(false);
    }, 60_000);
  }
}

it("ws: --yes preserves a clean worktree with unpushed commits; force may remove it", async () => {
  const path = await checkout("ws");
  await writeFile(join(path, "file.txt"), "local commit\n");
  await git(["add", "."], path);
  await git(["commit", "-m", "local only"], path);
  const sha = await git(["rev-parse", "HEAD"], path);
  const manifest = join(root, "ws", "sample", "ws.md");
  const before = await readFile(manifest, "utf8");
  const result = await cli([...removeArgs("ws"), "--yes"]);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stderr).error).toMatchObject({ code: "UNSAFE_REMOVE", aheadCount: 1 });
  expect(await git(["rev-parse", "HEAD"], path)).toBe(sha);
  expect(await readFile(manifest, "utf8")).toBe(before);
  expect((await ok([...removeArgs("ws"), "--force"])).removed).toBe(true);
  expect(existsSync(path)).toBe(false);
}, 60_000);
