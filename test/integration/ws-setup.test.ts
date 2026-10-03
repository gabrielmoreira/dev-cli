import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";

const isWin = process.platform === "win32";

/** Writes a counter file inside the mount's own directory, so its path proves the cwd. */
const countRuns = "echo ran>>setup-count.txt";
/** Writes the mount name dev handed the command, then counts the run. */
const writeMountNameAndCount = isWin
  ? "echo %DEV_MOUNT%>env-mount.txt&&echo ran>>setup-count.txt"
  : "echo $DEV_MOUNT>env-mount.txt&&echo ran>>setup-count.txt";

async function createRemote(root: string, name: string): Promise<string> {
  const remote = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await git.runGit(["init", "--bare", "-b", "main", remote]);
  await git.runGit(["init", "-b", "main", seed]);
  await git.runGit(["config", "user.name", "Setup Test"], { cwd: seed });
  await git.runGit(["config", "user.email", "setup@example.com"], { cwd: seed });
  await Bun.write(join(seed, "README.md"), `# ${name}\n`);
  await git.runGit(["add", "."], { cwd: seed });
  await git.runGit(["commit", "-m", `feat: seed ${name}`], { cwd: seed });
  await git.runGit(["remote", "add", "origin", remote], { cwd: seed });
  await git.runGit(["push", "-u", "origin", "main"], { cwd: seed });
  await rm(seed, { recursive: true, force: true });
  return remote;
}

describe("workspace setup commands", () => {
  let root: string;
  let appRemote: string;
  let wikiRemote: string;
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalWrite: typeof process.stderr.write;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-setup-"));
    appRemote = await createRemote(root, "checkout-api");
    wikiRemote = await createRemote(root, "checkout-docs");
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    originalWrite = process.stderr.write;
    stdout = [];
    stderr = [];
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.warn = (...args: unknown[]) => stderr.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  });

  async function run(argv: string[]): Promise<number> {
    stdout = [];
    stderr = [];
    return await runCli({ argv, cwd: root, env: {}, isTTY: false, stdinIsTTY: false });
  }

  async function writeConfig(body: string): Promise<void> {
    await Bun.write(join(root, "dev.yaml"), `version: 1\n${body}`);
  }

  async function runCount(workspace: string, mount: string): Promise<number> {
    const content = await readFile(join(root, "ws", workspace, mount, "setup-count.txt"), "utf8");
    return content.trim().split("\n").length;
  }

  test("runs the workset setup command in every mount once, and records it in ws.md", async () => {
    await writeConfig(`worksets:
  incident:
    description: Reproduce the checkout failure
    setup: ${writeMountNameAndCount}
    members:
      - source: ${appRemote}
        path: checkout-api
      - source: ${wikiRemote}
        path: checkout-docs
`);
    const code = await run([
      "ws",
      "init",
      "--workset",
      "incident",
      "--root",
      root,
      "--json",
      "--consent",
    ]);

    expect(code).toBe(0);
    const data = JSON.parse(stdout.join("\n"));
    expect(data.setup).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 });
    expect(
      await readFile(join(root, "ws", "incident", "checkout-api", "env-mount.txt"), "utf8").then(
        (value) => value.trim(),
      ),
    ).toBe("checkout-api");
    expect(
      await readFile(join(root, "ws", "incident", "checkout-docs", "env-mount.txt"), "utf8").then(
        (value) => value.trim(),
      ),
    ).toBe("checkout-docs");
    expect(await runCount("incident", "checkout-api")).toBe(1);
    expect(await runCount("incident", "checkout-docs")).toBe(1);

    const { manifest: stored } = await manifest.readWorkspace(
      join(root, "ws", "incident", "ws.md"),
    );
    expect(stored.mounts.map((mount) => mount.setup)).toEqual([
      writeMountNameAndCount,
      writeMountNameAndCount,
    ]);

    // A repeated init reuses the workspace, and never re-runs what it already ran.
    const again = await run([
      "ws",
      "init",
      "--workset",
      "incident",
      "--root",
      root,
      "--json",
      "--consent",
    ]);
    expect(again).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ created: false });
    expect(JSON.parse(stdout.join("\n")).setup).toBeUndefined();
    expect(await runCount("incident", "checkout-api")).toBe(1);

    // Neither does a later sync of the existing checkouts.
    const synced = await run(["ws", "update", "incident", "--root", root, "--json", "--offline"]);
    expect(synced).toBe(0);
    expect(await runCount("incident", "checkout-api")).toBe(1);
  });

  test("a member override replaces the workset command, and setup: false opts out", async () => {
    await writeConfig(`worksets:
  incident:
    setup: ${countRuns}
    members:
      - source: ${appRemote}
        path: checkout-api
      - source: ${wikiRemote}
        path: checkout-docs
        setup: false
`);
    const code = await run([
      "ws",
      "init",
      "--workset",
      "incident",
      "--root",
      root,
      "--json",
      "--consent",
    ]);

    expect(code).toBe(0);
    expect(await runCount("incident", "checkout-api")).toBe(1);
    expect(existsSync(join(root, "ws", "incident", "checkout-docs", "setup-count.txt"))).toBe(
      false,
    );

    const { manifest: stored } = await manifest.readWorkspace(
      join(root, "ws", "incident", "ws.md"),
    );
    expect(stored.mounts.map((mount) => mount.setup)).toEqual([countRuns, undefined]);
  });

  test("a failing setup leaves the other mounts running, and a rerun reports every verdict", async () => {
    const failing = "echo boom&&exit 1";
    await writeConfig(`worksets:
  incident:
    members:
      - source: ${appRemote}
        path: checkout-api
        setup: ${failing}
      - source: ${wikiRemote}
        path: checkout-docs
        setup: ${countRuns}
`);
    const init = await run([
      "ws",
      "init",
      "--workset",
      "incident",
      "--root",
      root,
      "--json",
      "--consent",
    ]);

    // The workspace is created even though one setup command failed.
    expect(init).toBe(0);
    expect(JSON.parse(stdout.join("\n")).setup).toMatchObject({
      succeeded: 1,
      failed: 1,
      skipped: 0,
      results: [
        { mount: "checkout-api", status: "failed", exitCode: 1 },
        { mount: "checkout-docs", status: "ok" },
      ],
    });
    expect(await runCount("incident", "checkout-docs")).toBe(1);

    const rerun = await run(["ws", "setup", "incident", "--root", root, "--json", "--consent"]);
    expect(rerun).toBe(4);
    expect(stdout).toEqual([]);
    const failure = JSON.parse(stderr.join("\n")).error;
    expect(failure.code).toBe("SETUP_FAILED");
    expect(
      failure.mounts.map((mount: { mount: string; status: string }) => [mount.mount, mount.status]),
    ).toEqual([
      ["checkout-api", "failed"],
      ["checkout-docs", "ok"],
    ]);
    // Every mount was attempted again, and the successful one ran a second time.
    expect(await runCount("incident", "checkout-docs")).toBe(2);
  });

  test("init without consent records the command and skips it; ws setup --consent runs it once", async () => {
    await writeConfig(`worksets:
  incident:
    setup: ${countRuns}
    members:
      - source: ${appRemote}
        path: checkout-api
`);
    const init = await run(["ws", "init", "--workset", "incident", "--root", root, "--json"]);

    expect(init).toBe(0);
    expect(JSON.parse(stdout.join("\n")).setup).toMatchObject({
      succeeded: 0,
      failed: 0,
      skipped: 1,
      results: [{ mount: "checkout-api", status: "skipped", reason: "consent_required" }],
    });
    expect(existsSync(join(root, "ws", "incident", "checkout-api", "setup-count.txt"))).toBe(false);
    const { manifest: stored } = await manifest.readWorkspace(
      join(root, "ws", "incident", "ws.md"),
    );
    expect(stored.mounts[0]?.setup).toBe(countRuns);

    const blocked = await run(["ws", "setup", "incident", "--root", root, "--json"]);
    expect(blocked).toBe(3);
    expect(JSON.parse(stderr.join("\n")).error.code).toBe("SETUP_BLOCKED");

    const consented = await run(["ws", "setup", "incident", "--root", root, "--json", "--consent"]);
    expect(consented).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ succeeded: 1, failed: 0, skipped: 0 });
    expect(await runCount("incident", "checkout-api")).toBe(1);

    // Reusing the workspace never silently re-runs setup.
    const again = await run(["ws", "init", "--workset", "incident", "--root", root, "--json"]);
    expect(again).toBe(0);
    expect(await runCount("incident", "checkout-api")).toBe(1);
  });

  test("a trusted repository runs its setup at init without --consent", async () => {
    await writeConfig(`trusted_scopes:
  - provider: local
    tenant: local
    owner: local
    repos:
      - ${appRemote}
worksets:
  incident:
    setup: ${countRuns}
    members:
      - source: ${appRemote}
        path: checkout-api
`);
    const code = await run(["ws", "init", "--workset", "incident", "--root", root, "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n")).setup).toMatchObject({
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(await runCount("incident", "checkout-api")).toBe(1);
  });

  test("direct init --setup runs and records the command, and a repeated init does not rerun it", async () => {
    const name = ws.deriveWorkspaceNameFromRepository(appRemote);
    const mountName = git.deriveDefaultMountPath(appRemote);
    const init = await run([
      "ws",
      "init",
      appRemote,
      "--root",
      root,
      "--setup",
      countRuns,
      "--json",
      "--consent",
    ]);

    expect(init).toBe(0);
    expect(JSON.parse(stdout.join("\n")).setup).toMatchObject({
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    const mountPath = join(root, "ws", name, mountName);
    expect(await runCount(name, mountName)).toBe(1);
    const { manifest: stored } = await manifest.readWorkspace(join(root, "ws", name, "ws.md"));
    expect(stored.mounts[0]?.setup).toBe(countRuns);
    expect(existsSync(mountPath)).toBe(true);

    const again = await run([
      "ws",
      "init",
      appRemote,
      "--root",
      root,
      "--setup",
      countRuns,
      "--json",
    ]);
    expect(again).toBe(0);
    expect(await runCount(name, mountName)).toBe(1);
  });

  test("workset repo flags record a per-repository command, and its absence", async () => {
    await writeConfig(`worksets:
  incident:
    setup: mise install
    members:
      - source: ${appRemote}
        path: checkout-api
`);
    const added = await run([
      "workset",
      "repo",
      "add",
      "incident",
      wikiRemote,
      "--no-setup",
      "--yes",
      "--root",
      root,
      "--json",
    ]);

    expect(added).toBe(0);
    expect(JSON.parse(stdout.join("\n")).members[1]).toMatchObject({
      source: wikiRemote,
      setup: false,
    });

    const edited = await run([
      "workset",
      "repo",
      "edit",
      "incident",
      appRemote,
      "--setup",
      "npm ci",
      "--yes",
      "--root",
      root,
      "--json",
    ]);

    expect(edited).toBe(0);
    const saved = await readFile(join(root, "dev.yaml"), "utf8");
    expect(saved).toContain("setup: npm ci");
    expect(saved).toContain("setup: false");
  });

  test("ws setup skips a mount whose checkout is missing without failing", async () => {
    await writeConfig(`worksets:
  incident:
    setup: ${countRuns}
    members:
      - source: ${appRemote}
        path: checkout-api
`);
    await run(["ws", "init", "--workset", "incident", "--root", root, "--json"]);
    await rm(join(root, "ws", "incident", "checkout-api"), { recursive: true, force: true });

    const code = await run(["ws", "setup", "incident", "--root", root, "--json", "--consent"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      succeeded: 0,
      failed: 0,
      skipped: 1,
      results: [{ mount: "checkout-api", status: "skipped", reason: "mount_missing" }],
    });
  });

  test("ws setup is a no-op success when no mount declares a command", async () => {
    await writeConfig(`worksets:
  incident:
    members:
      - source: ${appRemote}
        path: checkout-api
`);
    await run(["ws", "init", "--workset", "incident", "--root", root, "--json"]);

    const code = await run(["ws", "setup", "incident", "--root", root, "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      succeeded: 0,
      failed: 0,
      skipped: 1,
      results: [{ mount: "checkout-api", status: "skipped", reason: "no_setup" }],
    });
  });

  test("ws setup names the workspace it inferred from the current directory", async () => {
    await writeConfig(`worksets:
  incident:
    setup: ${countRuns}
    members:
      - source: ${appRemote}
        path: checkout-api
`);
    await run(["ws", "init", "--workset", "incident", "--root", root, "--json"]);
    await rm(join(root, "ws", "incident", "checkout-api", "setup-count.txt"), { force: true });

    stdout = [];
    stderr = [];
    const code = await runCli({
      argv: ["ws", "setup", "--root", root, "--json", "--consent"],
      cwd: join(root, "ws", "incident", "checkout-api"),
      env: {},
      isTTY: false,
      stdinIsTTY: false,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      workspaceName: "incident",
      succeeded: 1,
    });
    expect(await runCount("incident", "checkout-api")).toBe(1);
  });
});
