import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("missing worktree ref CLI", () => {
  let root: string;
  let remote: string;
  let env: Record<string, string | undefined>;
  async function run(command: string[]) {
    const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-ref-input-"));
    remote = join(root, "remote.git");
    const seed = join(root, "seed");
    env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      DEV_ROOT: root,
      DEV_CWD: root,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      CI: "1",
    };
    await Bun.write(join(root, "dev.yaml"), "version: 1\n");
    for (const command of [
      ["git", "init", "-b", "main", seed],
      [
        "git",
        "-C",
        seed,
        "-c",
        "user.name=Test Author",
        "-c",
        "user.email=test@example.org",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      ["git", "clone", "--bare", seed, remote],
      [process.execPath, CLI, "ws", "init", "fixture", "--json"],
    ])
      expect((await run(command)).exitCode).toBe(0);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it("still checks out a valid branch", async () => {
    const result = await run([
      process.execPath,
      CLI,
      "ws",
      "add",
      remote,
      "--ws",
      "fixture",
      "--branch",
      "main",
      "--path",
      "valid",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const revision = await run([
      "git",
      "-C",
      join(root, "ws", "fixture", "valid"),
      "branch",
      "--show-current",
    ]);
    expect(revision.stdout.trim()).toBe("main");
  });
  it("names the ref and source in a human usage error", async () => {
    const result = await run([
      process.execPath,
      CLI,
      "ws",
      "add",
      remote,
      "--ws",
      "fixture",
      "--branch",
      "missing-ref",
      "--path",
      "bad-human",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`Ref 'missing-ref' not found in ${remote}.`);
    expect(result.stderr).toContain("↳ git ls-remote --heads --tags");
    expect(result.stderr).toContain(remote);
  });
  it("retains structured ref and source alongside diagnostics", async () => {
    const result = await run([
      process.execPath,
      CLI,
      "ws",
      "add",
      remote,
      "--ws",
      "fixture",
      "--branch",
      "missing-ref",
      "--path",
      "bad-json",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "REF_NOT_FOUND",
      ref: "missing-ref",
      source: remote,
    });
  });
});
