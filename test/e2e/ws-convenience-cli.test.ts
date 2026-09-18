import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev ws convenience CLI E2E (Phase 7)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-conv-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-conv-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "CLI Conv Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "cliconv@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello cli convenience");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("lists, duplicates and resolves paths via CLI commands", async () => {
    // 1. Initialize workspace via CLI
    const initProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "init",
        "e2e-src-ws",
        "--root",
        tempRoot,
        "--desc",
        "Primary Source WS",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // 2. Mount repository
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "e2e-src-ws",
        "--path",
        "repo-one",
        "--root",
        tempRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addProc.exited).toBe(0);

    // 3. Test ws list
    const listProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "list", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await listProc.exited).toBe(0);
    const listJson = JSON.parse(await new Response(listProc.stdout).text());
    expect(listJson).toBeArray();
    expect(listJson).toHaveLength(1);
    expect(listJson[0].name).toBe("e2e-src-ws");
    expect(listJson[0].mountCount).toBe(1);

    // 4. Test ws duplicate
    const dupProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "duplicate",
        "e2e-src-ws",
        "e2e-dup-ws",
        "--root",
        tempRoot,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await dupProc.exited).toBe(0);
    const dupJson = JSON.parse(await new Response(dupProc.stdout).text());
    expect(dupJson.sourceName).toBe("e2e-src-ws");
    expect(dupJson.targetName).toBe("e2e-dup-ws");
    expect(dupJson.mountsCount).toBe(1);

    // 5. Test ws path with explicit name
    const pathProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "path", "e2e-dup-ws", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await pathProc.exited).toBe(0);
    const pathJson = JSON.parse(await new Response(pathProc.stdout).text());
    expect(pathJson.path.replace(/\\/g, "/")).toBe(
      join(tempRoot, "ws", "e2e-dup-ws").replace(/\\/g, "/"),
    );

    // 6. Test ws path detected from cwd
    const insideWsDir = join(tempRoot, "ws", "e2e-dup-ws", "repo-one");
    const cwdPathProc = Bun.spawn(["bun", cliPath, "ws", "path", "--root", tempRoot], {
      cwd: insideWsDir,
      env: { ...process.env, DEV_CWD: insideWsDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await cwdPathProc.exited).toBe(0);
    const cwdPathOut = (await new Response(cwdPathProc.stdout).text()).trim();
    expect(cwdPathOut.replace(/\\/g, "/")).toBe(
      join(tempRoot, "ws", "e2e-dup-ws").replace(/\\/g, "/"),
    );
  });
});
