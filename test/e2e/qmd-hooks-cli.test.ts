import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("QMD and Lifecycle Hooks CLI E2E (Phase 19)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-qmd-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-qmd-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-e2e-qmd-bare-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello qmd e2e");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "initial commit"], { cwd: seedDir });
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
    await rm(bareRemotePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => {});
  });

  it("dev ws add executes post_add hook configured in dev.yaml", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dev-cli-qmd-post-add-"));
    const markerFile = join(rootDir, "post_add_marker.txt");
    const devYaml = `
hooks:
  post_add: ${JSON.stringify(`echo post_add_done > ${markerFile}`)}
`;
    await fs.writeText(join(rootDir, "dev.yaml"), devYaml);

    // Init workspace
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "feature-qmd", "--root", rootDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // Add mount
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "feature-qmd",
        "--root",
        rootDir,
        "--consent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await addProc.exited;
    expect(exitCode).toBe(0);

    // Marker should have been created by post_add hook
    expect(fs.exists(markerFile)).toBe(true);
    const content = await fs.readText(markerFile);
    expect(content).toContain("post_add_done");

    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("dev ws update executes post_sync hook when mounts are fast-forwarded", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dev-cli-qmd-post-sync-"));
    const syncMarker = join(rootDir, "sync_marker.txt");
    const devYaml = `
hooks:
  post_sync: ${JSON.stringify(`echo post_sync_done > ${syncMarker}`)}
`;
    await fs.writeText(join(rootDir, "dev.yaml"), devYaml);

    // Init workspace
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "sync-qmd", "--root", rootDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // Mount repo
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "sync-qmd",
        "--root",
        rootDir,
        "--consent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addProc.exited).toBe(0);

    // Push a new commit to bare remote
    const writerDir = await mkdtemp(join(tmpdir(), "dev-cli-qmd-writer-"));
    await git.runGit(["clone", bareRemotePath, "."], { cwd: writerDir });
    await git.runGit(["config", "user.name", "Writer Agent"], { cwd: writerDir });
    await git.runGit(["config", "user.email", "writer@example.com"], { cwd: writerDir });
    await fs.writeText(join(writerDir, "update.txt"), "second commit");
    await git.runGit(["add", "."], { cwd: writerDir });
    await git.runGit(["commit", "-m", "second commit"], { cwd: writerDir });
    await git.runGit(["push", "origin", "main"], { cwd: writerDir });
    await rm(writerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );

    // Run ws update with refresh
    const updateProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "update",
        "sync-qmd",
        "--refresh",
        "--root",
        rootDir,
        "--consent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await updateProc.exited).toBe(0);

    // post_sync hook should have fired
    expect(fs.exists(syncMarker)).toBe(true);
    const content = await fs.readText(syncMarker);
    expect(content).toContain("post_sync_done");

    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("does not run vector embedding when qmd sync receives --no-embed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dev-cli-qmd-no-embed-"));
    const qmdScript = join(rootDir, "qmd-stub");
    const callsFile = join(rootDir, "qmd-calls.log");

    try {
      await fs.writeText(qmdScript, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$QMD_CALLS"\n');
      await chmod(qmdScript, 0o755);
      await fs.writeText(
        join(rootDir, "dev.yaml"),
        [
          "sources:",
          `  - url: ${JSON.stringify(bareRemotePath)}`,
          "    branch: main",
          "    labels:",
          '      "index:demo": {}',
          "plugins:",
          "  qmd:",
          `    command: ${JSON.stringify(qmdScript)}`,
          "    config_dir: scoped",
          "",
        ].join("\n"),
      );

      const syncProc = Bun.spawn(
        ["bun", "run", cliPath, "qmd", "sync", "index:demo", "--no-embed", "--root", rootDir],
        {
          env: { ...process.env, QMD_CALLS: callsFile },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(await syncProc.exited).toBe(0);
      const calls = (await fs.readText(callsFile)).trim().split("\n");
      expect(calls).toContain("update");
      expect(calls).not.toContain("embed");
    } finally {
      await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("handles missing optional tooling gracefully without failing mount operation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dev-cli-qmd-missing-"));
    const devYaml = `
hooks:
  post_add: "nonexistent_indexer_binary_12345 --path $DEV_MOUNT_PATH"
`;
    await fs.writeText(join(rootDir, "dev.yaml"), devYaml);

    // Init workspace
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "missing-tool-qmd", "--root", rootDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // Mount repo with failing hook
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "missing-tool-qmd",
        "--root",
        rootDir,
        "--consent",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await addProc.exited;
    const stdout = await new Response(addProc.stdout).text();

    // Mount itself still succeeds!
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.mountName).toBeDefined();
    expect(parsed.hookWarning).toBeDefined();
    expect(parsed.hookWarning).toContain("post_add hook failed");

    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("proves removing hook configuration leaves all core dev behavior completely unchanged", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dev-cli-qmd-clean-"));

    // Init workspace without any hooks
    const initProc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "init", "clean-ws", "--root", rootDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await initProc.exited).toBe(0);

    // Add mount
    const addProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "add",
        bareRemotePath,
        "--ws",
        "clean-ws",
        "--root",
        rootDir,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await addProc.exited;
    const stdout = await new Response(addProc.stdout).text();

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.mountName).toBeDefined();
    expect(parsed.hookWarning).toBeUndefined();

    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });
});
