import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../../src/git.ts";
import * as mirror from "../../src/mirror.ts";
import * as ws from "../../src/ws.ts";

const cliPath = join(import.meta.dir, "../../src/cli.ts");

describe("root sync failures", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("keeps a broken mirror refresh in the partial result and exits 1", async () => {
    root = await mkdtemp(join(tmpdir(), "dev-sync-root-"));
    await Bun.write(join(root, "dev.yaml"), "providers: []\n");
    const seed = join(root, "seed");
    const healthyRemote = join(root, "healthy.git");
    const brokenRemote = join(root, "broken.git");
    for (const args of [
      ["init", "--bare", "-b", "main", healthyRemote],
      ["init", "--bare", "-b", "main", brokenRemote],
      ["init", "-b", "main", seed],
    ]) {
      expect((await git.runGit(args)).exitCode).toBe(0);
    }
    await Bun.write(join(seed, "sample.txt"), "initial\n");
    for (const args of [
      ["config", "user.name", "user"],
      ["config", "user.email", "user@example.org"],
      ["add", "."],
      ["commit", "-m", "initial"],
      ["push", healthyRemote, "main"],
      ["push", brokenRemote, "main"],
    ]) {
      expect((await git.runGit(args, { cwd: seed })).exitCode).toBe(0);
    }
    const healthy = await mirror.ensure({ root, source: healthyRemote, branch: "main" });
    const broken = await mirror.ensure({ root, source: brokenRemote, branch: "main" });
    const initialRevision = await git.currentRevision(broken.path);
    await ws.init({ root, name: "sample-workspace" });
    await ws.init({ root, name: "broken-workspace" });
    await ws.add({
      root,
      workspaceName: "broken-workspace",
      source: brokenRemote,
      path: "sample-api",
      branch: "main",
    });
    await Bun.write(join(seed, "sample.txt"), "updated\n");
    for (const args of [
      ["add", "."],
      ["commit", "-m", "update"],
      ["push", healthyRemote, "main"],
    ]) {
      expect((await git.runGit(args, { cwd: seed })).exitCode).toBe(0);
    }
    const updatedRevision = await git.currentRevision(seed);
    await rm(brokenRemote, { recursive: true, force: true });

    const jsonRun = Bun.spawn(
      [process.execPath, cliPath, "sync", "--all", "--root", root, "--json"],
      {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root, DEV_CWD: root, CI: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      jsonRun.exited,
      new Response(jsonRun.stdout).text(),
      new Response(jsonRun.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.providers).toBeNull();
    expect(data.mirrors.ok).toBe(true);
    const refreshFailures = data.mirrors.result.refreshFailures;
    expect(refreshFailures).toEqual([
      expect.objectContaining({ path: expect.stringContaining("broken.git") }),
    ]);
    expect(data.failures).toEqual([
      ...refreshFailures.map(({ path, reason }: { path: string; reason: string }) => ({
        component: "mirrors",
        code: "FAILED",
        message: `${path}: ${reason}`.split(/\r?\n/)[0],
      })),
      {
        component: "workspace broken-workspace",
        code: "NOT_FOUND",
        message: "Git mirror fetch failed.",
      },
    ]);
    expect(data.workspaces).toEqual([
      expect.objectContaining({ name: "broken-workspace", ok: false }),
      expect.objectContaining({ name: "sample-workspace", ok: true }),
    ]);
    expect(await git.currentRevision(healthy.path)).toEqual(updatedRevision);
    expect(await git.currentRevision(broken.path)).toEqual(initialRevision);
    expect(data.hooksRun).toBe(false);
    expect(stderr).toBe("");

    const humanRun = Bun.spawn([process.execPath, cliPath, "sync", "--all", "--root", root], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, DEV_CWD: root, CI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [humanExitCode, humanStdout, humanStderr] = await Promise.all([
      humanRun.exited,
      new Response(humanRun.stdout).text(),
      new Response(humanRun.stderr).text(),
    ]);
    expect(humanExitCode, `${humanStdout}\n${humanStderr}`).toBe(1);
  }, 30_000);
});
