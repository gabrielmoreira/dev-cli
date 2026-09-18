import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import * as ws from "../../src/ws.ts";
import type { TrustedScope } from "../../src/config.ts";

describe("Trust Model and Safe Hook Execution Integration (Phase 16)", () => {
  let tempRoot: string;
  let bareRemotePath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-trust-root-"));
    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-trust-seed-"));
    bareRemotePath = await mkdtemp(join(tmpdir(), "dev-cli-trust-bare-"));

    await git.runGit(["init", "--bare", "-b", "main"], { cwd: bareRemotePath });
    await git.runGit(["init", "-b", "main"], { cwd: seedDir });
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello trust hooks");
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

  it("blocks untrusted mount hook execution without explicit consent", async () => {
    await ws.init({ root: tempRoot, name: "ws-untrusted" });

    let err: ws.WorkspaceError | undefined;
    try {
      await ws.add({
        root: tempRoot,
        workspaceName: "ws-untrusted",
        source: "https://github.com/stranger/untrusted-repo.git",
        hooks: {
          pre_checkout: "echo 'malicious'",
        },
        trustedScopes: [],
        explicitConsent: false,
      });
    } catch (e) {
      if (e instanceof ws.WorkspaceError) {
        err = e;
      }
    }

    expect(err).toBeDefined();
    expect(err?.code).toBe("UNTRUSTED_HOOK_BLOCKED");
  });

  it("permits untrusted mount hook execution when explicit consent is provided", async () => {
    await ws.init({ root: tempRoot, name: "ws-consent" });
    const markerFile = join(tempRoot, "consent-pre-marker.txt");
    const cmd = `echo ran > ${markerFile}`;

    const res = await ws.add({
      root: tempRoot,
      workspaceName: "ws-consent",
      source: bareRemotePath,
      path: "consent-mount",
      hooks: {
        pre_checkout: cmd,
      },
      trustedScopes: [],
      explicitConsent: true,
    });

    expect(res.mountName).toBe("consent-mount");
    expect(fs.exists(markerFile)).toBe(true);
  });

  it("aborts mount cleanly when pre_checkout hook fails", async () => {
    await ws.init({ root: tempRoot, name: "ws-failing-pre" });
    const isWin = process.platform === "win32";
    const failCmd = isWin ? "cmd.exe /c exit 1" : "sh -c 'exit 1'";

    let err: ws.WorkspaceError | undefined;
    try {
      await ws.add({
        root: tempRoot,
        workspaceName: "ws-failing-pre",
        source: bareRemotePath,
        path: "failed-mount",
        hooks: {
          pre_checkout: failCmd,
        },
        explicitConsent: true,
      });
    } catch (e) {
      if (e instanceof ws.WorkspaceError) {
        err = e;
      }
    }

    expect(err).toBeDefined();
    expect(err?.code).toBe("HOOK_FAILED");

    // Mount directory must NOT exist on disk
    const mountPath = join(tempRoot, "ws", "ws-failing-pre", "failed-mount");
    expect(fs.exists(mountPath)).toBe(false);

    // Manifest must NOT contain the mount
    const { manifest: m } = await manifest.readWorkspace(
      join(tempRoot, "ws", "ws-failing-pre", "ws.md"),
    );
    expect(m.mounts.find((mount) => mount.path === "failed-mount")).toBeUndefined();
  });

  it("warns without rolling back git refs when post_checkout hook fails", async () => {
    await ws.init({ root: tempRoot, name: "ws-failing-post" });
    const isWin = process.platform === "win32";
    const failCmd = isWin ? "cmd.exe /c exit 2" : "sh -c 'exit 2'";

    const res = await ws.add({
      root: tempRoot,
      workspaceName: "ws-failing-post",
      source: bareRemotePath,
      path: "post-failed-mount",
      hooks: {
        post_checkout: failCmd,
      },
      explicitConsent: true,
    });

    expect(res.mountName).toBe("post-failed-mount");
    expect(res.hookWarning).toBeDefined();
    expect(res.hookWarning).toContain("post_checkout hook failed");

    // Mount directory exists and is a valid git worktree
    const mountPath = join(tempRoot, "ws", "ws-failing-post", "post-failed-mount");
    expect(fs.exists(mountPath)).toBe(true);

    const observed = await git.inspectWorktree(mountPath);
    expect(observed.isGitWorktree).toBe(true);

    // Manifest contains the mount
    const { manifest: m } = await manifest.readWorkspace(
      join(tempRoot, "ws", "ws-failing-post", "ws.md"),
    );
    expect(m.mounts.find((mount) => mount.path === "post-failed-mount")).toBeDefined();
  });

  it("executes trusted rule hook with environment variables", async () => {
    await ws.init({ root: tempRoot, name: "ws-trusted-env" });
    const envOutputFile = join(tempRoot, "hook-env.txt");
    const isWin = process.platform === "win32";
    const hookCmd = isWin
      ? `echo %DEV_WORKSPACE%:%DEV_MOUNT_PATH% > ${envOutputFile}`
      : `echo "$DEV_WORKSPACE:$DEV_MOUNT_PATH" > "${envOutputFile}"`;

    const trustedScope: TrustedScope = {
      provider: "local",
      tenant: "local",
      owner: "local",
      repos: ["*"],
      install: true,
      allowedTools: ["mise"],
      rules: [
        {
          match: "*",
          hooks: {
            post_checkout: hookCmd,
          },
        },
      ],
    };

    const res = await ws.add({
      root: tempRoot,
      workspaceName: "ws-trusted-env",
      source: bareRemotePath,
      path: "trusted-mount",
      trustedScopes: [trustedScope],
    });

    expect(res.mountName).toBe("trusted-mount");
    expect(fs.exists(envOutputFile)).toBe(true);
    const content = await fs.readText(envOutputFile);
    expect(content).toContain("ws-trusted-env");
    expect(content).toContain("trusted-mount");
  });
});
