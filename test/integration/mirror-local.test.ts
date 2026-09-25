import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as mirror from "../../src/mirror.ts";

describe("Canonical repository local integration (Phase 8)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  let seedDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-repo-root-"));
    bareRemotePath = join(tempRoot, "remote.git");

    await git.runGit(["init", "--bare", bareRemotePath]);

    seedDir = await mkdtemp(join(tmpdir(), "dev-cli-repo-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "Canonical Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "canonical@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "canonical initial content");
    await fs.writeText(join(seedDir, "script.sh"), "#!/bin/sh\necho canonical\n");
    await chmod(join(seedDir, "script.sh"), 0o755);
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: canonical initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    // Create a feature branch
    await git.runGit(["checkout", "-b", "feature/canon"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "feature.txt"), "feature branch data");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: feature branch commit"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/canon"], { cwd: seedDir });
  });

  afterAll(async () => {
    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("does not persist transient authentication headers in mirror config", async () => {
    const authRoot = join(tempRoot, "auth-header-test");
    const result = await git.ensureMirror({
      root: authRoot,
      source: bareRemotePath,
      extraHeader: "http.extraheader=AUTHORIZATION: Bearer transient-test-token",
    });

    const configuredHeader = await git.runGit([
      "-C",
      result.mirrorPath,
      "config",
      "--get-all",
      "http.extraheader",
    ]);

    expect(configuredHeader.stdout).toBe("");
  });

  it("keeps tracked modes writable and rejects commits with workspace guidance", async () => {
    const addRes = await mirror.ensure({
      root: tempRoot,
      source: bareRemotePath,
      branch: "main",
    });

    expect(fs.exists(join(addRes.path, "file.txt"))).toBe(true);

    const scriptMode = (await stat(join(addRes.path, "script.sh"))).mode;
    expect(scriptMode & 0o200).not.toBe(0);
    expect(scriptMode & 0o100).not.toBe(0);
    expect("readOnly" in addRes).toBe(false);

    await fs.writeText(join(addRes.path, "file.txt"), "accidental mirror edit");
    await git.runGit(["add", "file.txt"], { cwd: addRes.path });
    const commit = await git.runGit(["commit", "--no-verify", "-m", "accidental mirror commit"], {
      cwd: addRes.path,
    });

    expect(commit.exitCode).not.toBe(0);
    expect(commit.stderr).toContain("commits are disabled in canonical mirrors");
    expect(commit.stderr).toContain("dev ws add");

    await git.runGit(["restore", "--staged", "file.txt"], { cwd: addRes.path });
    await git.runGit(["restore", "file.txt"], { cwd: addRes.path });
  });

  // An older version made mirrors read-only, and an earlier repair restored files
  // only: git then cannot replace a file in a directory it cannot write.
  it.skipIf(process.platform === "win32")(
    "restores write access to directories a legacy read-only mirror kept",
    async () => {
      const { path } = await mirror.ensure({
        root: tempRoot,
        source: bareRemotePath,
        branch: "main",
      });
      const nested = join(path, "legacy-dir");
      await fs.ensureDir(nested);
      await chmod(nested, 0o555);
      await chmod(path, 0o555);

      await git.installCanonicalCommitGuardForWorktree(path);

      expect((await stat(path)).mode & 0o200).not.toBe(0);
      expect((await stat(nested)).mode & 0o200).not.toBe(0);
      await rm(nested, { recursive: true });
    },
  );

  it("quarantines repeated dirty states in distinct named stashes", async () => {
    const quarantineRoot = join(tempRoot, "quarantine");
    const added = await mirror.ensure({
      root: quarantineRoot,
      source: bareRemotePath,
      branch: "main",
    });
    const plan = mirror.planCanonicalCheckout({
      root: quarantineRoot,
      source: bareRemotePath,
      branch: "main",
    });
    expect(added.path).toBe(plan.absolutePath);
    const occurrences: Array<{ stashName: string; stashSha: string }> = [];

    for (const [index, content] of ["first accidental edit", "second accidental edit"].entries()) {
      await fs.writeText(join(plan.absolutePath, "file.txt"), content);
      if (index === 0) {
        await fs.writeText(join(plan.absolutePath, "scratch.txt"), "untracked accidental work");
      }
      const result = await mirror.sync({ root: quarantineRoot, source: bareRemotePath });

      expect(result.stashed).toHaveLength(1);
      const stashed = result.stashed[0]!;
      expect(stashed.path).toBe(plan.absolutePath);
      expect(stashed.stashName).toMatch(/^dev mirror sync \d{4}-\d{2}-\d{2}T/);
      expect(stashed.changes).toContain("M file.txt");
      if (index === 0) {
        expect(stashed.changes).toContain("?? scratch.txt");
        const untracked = await git.runGit(["show", `${stashed.stashSha}^3:scratch.txt`], {
          cwd: plan.absolutePath,
        });
        expect(untracked.stdout).toBe("untracked accidental work");
      }
      expect(result.skipped.some((item) => item.reason === "UP_TO_DATE")).toBe(true);
      occurrences.push(stashed);
    }
    expect(occurrences[0]!.stashName).not.toBe(occurrences[1]!.stashName);
    expect(occurrences[0]!.stashSha).not.toBe(occurrences[1]!.stashSha);

    const stashList = await git.runGit(["stash", "list", "--format=%H"], {
      cwd: plan.absolutePath,
    });
    expect(stashList.stdout).toContain(occurrences[0]!.stashSha);
    expect(stashList.stdout).toContain(occurrences[1]!.stashSha);
  });

  it("syncs only the exact selected source when basenames collide", async () => {
    const collisionRoot = join(tempRoot, "same-name");
    const sources: string[] = [];
    for (const owner of ["owner-a", "owner-b"]) {
      const source = join(collisionRoot, owner, "shared.git");
      const seed = join(collisionRoot, `${owner}-seed`);
      await fs.ensureDir(join(collisionRoot, owner));
      await git.runGit(["init", "--bare", "-b", "main", source]);
      await git.runGit(["init", "-b", "main", seed]);
      await git.runGit(["config", "user.name", "Mirror Test"], { cwd: seed });
      await git.runGit(["config", "user.email", "mirror@example.com"], { cwd: seed });
      await fs.writeText(join(seed, "file.txt"), owner);
      await git.runGit(["add", "."], { cwd: seed });
      await git.runGit(["commit", "-m", "initial"], { cwd: seed });
      await git.runGit(["remote", "add", "origin", source], { cwd: seed });
      await git.runGit(["push", "origin", "main"], { cwd: seed });
      sources.push(source);
    }

    const first = await mirror.ensure({
      root: collisionRoot,
      source: sources[0],
      alias: "shared-a",
    });
    const second = await mirror.ensure({
      root: collisionRoot,
      source: sources[1],
      alias: "shared-b",
    });
    await fs.writeText(join(first.path, "file.txt"), "dirty first");
    await fs.writeText(join(second.path, "file.txt"), "dirty second");

    const result = await mirror.sync({ root: collisionRoot, source: sources[0] });

    expect(result.stashed.map((item) => item.path)).toEqual([first.path]);
    expect((await git.inspectWorktree(first.path)).isDirty).toBe(false);
    expect((await git.inspectWorktree(second.path)).isDirty).toBe(true);
  });

  it("repairs legacy permission damage without stashing false changes", async () => {
    const legacyRoot = join(tempRoot, "legacy-permissions");
    const added = await mirror.ensure({
      root: legacyRoot,
      source: bareRemotePath,
      branch: "main",
    });

    await chmod(join(added.path, ".git"), 0o444);
    await chmod(join(added.path, "file.txt"), 0o444);
    await chmod(join(added.path, "script.sh"), 0o444);

    const result = await mirror.sync({ root: legacyRoot, source: bareRemotePath });
    expect(result.stashed).toHaveLength(0);

    const fileMode = (await stat(join(added.path, "file.txt"))).mode;
    const scriptMode = (await stat(join(added.path, "script.sh"))).mode;
    expect(fileMode & 0o200).not.toBe(0);
    expect(scriptMode & 0o200).not.toBe(0);
    expect(scriptMode & 0o100).not.toBe(0);
  });

  it("lists canonical repositories with branch and status", async () => {
    const list = await mirror.list({ root: tempRoot });
    expect(list.length).toBeGreaterThanOrEqual(1);
    const item = list[0];
    expect(item.branch).toBe("main");
    expect(item.isClean).toBe(true);
  });

  it("tracks sibling canonical branch as a natural sibling folder", async () => {
    const trackRes = await mirror.track({
      root: tempRoot,
      source: bareRemotePath,
      branch: "feature/canon",
    });

    expect("readOnly" in trackRes).toBe(false);
    expect(trackRes.branch).toBe("feature/canon");
    expect(fs.exists(trackRes.path)).toBe(true);
    expect(fs.exists(join(trackRes.path, "feature.txt"))).toBe(true);
  });

  it("syncs a clean canonical repository via fast-forward", async () => {
    // 1. Push a new commit to main in the remote repository
    await git.runGit(["checkout", "main"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "file.txt"), "updated canonical content v2");
    await git.runGit(["commit", "-am", "feat: update main v2"], { cwd: seedDir });
    await git.runGit(["push", "origin", "main"], { cwd: seedDir });

    // 2. Sync with refresh
    const syncRes = await mirror.sync({
      root: tempRoot,
      source: bareRemotePath,
      refresh: true,
    });

    expect(syncRes.updated.length).toBeGreaterThanOrEqual(1);
    const mainUpdate = syncRes.updated.find((u) => u.branch === "main");
    expect(mainUpdate).toBeDefined();

    // 3. Prove content was updated
    const plan = mirror.planCanonicalCheckout({
      root: tempRoot,
      source: bareRemotePath,
      branch: "main",
    });
    const updatedContent = await fs.readText(join(plan.absolutePath, "file.txt"));
    expect(updatedContent).toBe("updated canonical content v2");
  });

  it("reports a fast-forward failure without hiding it", async () => {
    const plan = mirror.planCanonicalCheckout({
      root: tempRoot,
      source: bareRemotePath,
      branch: "main",
    });

    // Mock git.fastForward to force a failure during sync
    const customGit = {
      ...git,
      fastForward: async () => {
        throw new Error("Simulated fast-forward network abort or merge conflict");
      },
      inspectWorktree: async (p: string) => {
        const actual = await git.inspectWorktree(p);
        return { ...actual, behindCount: 5 }; // force sync to proceed
      },
    };

    const syncRes = await mirror.sync(
      {
        root: tempRoot,
        source: bareRemotePath,
      },
      { fs, git: customGit as typeof git },
    );

    expect(syncRes.skipped.length).toBeGreaterThanOrEqual(1);
    const failedItem = syncRes.skipped.find((s) => s.path === plan.absolutePath);
    expect(failedItem).toBeDefined();
    expect(failedItem?.reason).toContain("FAST_FORWARD_FAILED");
  });

  it("untracks sibling canonical branch cleanly", async () => {
    const untrackRes = await mirror.untrack({
      root: tempRoot,
      source: bareRemotePath,
      branch: "feature/canon",
    });

    expect(untrackRes.removed).toBe(true);
    expect(fs.exists(untrackRes.path)).toBe(false);
  });
});
