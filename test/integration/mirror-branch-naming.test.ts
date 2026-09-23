import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as mirror from "../../src/mirror.ts";

/** A branch checkout used to land on the default branch's folder, so
 * `mirror add --branch X` and `mirror track X` produced two checkouts of the
 * same branch under different names. The default branch owns `<repo>`; every
 * other revision is a sibling. */
describe("Canonical checkout naming against the default branch", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  let seedDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-branch-naming-"));
    bareRemotePath = join(tempRoot, "remote.git");
    await git.runGit(["init", "--bare", "-b", "main", bareRemotePath]);

    seedDir = await mkdtemp(join(tmpdir(), "dev-cli-branch-seed-"));
    await git.runGit(["init", "-b", "main", seedDir]);
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "file.txt"), "initial");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    await git.runGit(["checkout", "-b", "feature/payments"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "feature.txt"), "feature");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: feature"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/payments"], { cwd: seedDir });
  });

  afterAll(async () => {
    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("names an explicit default branch as the plain checkout, not a sibling", async () => {
    const root = join(tempRoot, "explicit-default");
    const result = await mirror.add({ root, source: bareRemotePath, branch: "main" });

    expect(result.path.replace(/\\/g, "/")).toMatch(/\/remote$/);
    expect(result.branch).toBe("main");
  });

  it("gives a non-default branch its own sibling folder", async () => {
    const root = join(tempRoot, "feature-branch");
    const added = await mirror.add({ root, source: bareRemotePath, branch: "feature/payments" });

    expect(added.path.replace(/\\/g, "/")).toMatch(/\/remote@feature-payments$/);
    expect(added.branch).toBe("feature/payments");
  });

  it("puts add --branch and track on the same path instead of duplicating the branch", async () => {
    const root = join(tempRoot, "add-then-track");
    await mirror.add({ root, source: bareRemotePath });
    const added = await mirror.add({ root, source: bareRemotePath, branch: "feature/payments" });

    let trackError: mirror.CanonicalMirrorError | undefined;
    try {
      await mirror.track({ root, source: bareRemotePath, branch: "feature/payments" });
    } catch (error) {
      trackError = error as mirror.CanonicalMirrorError;
    }

    expect(trackError?.code).toBe("BRANCH_ALREADY_TRACKED");
    expect(trackError?.message).toContain(added.path);
  });

  it("refuses to track the default branch as a sibling of itself", async () => {
    const root = join(tempRoot, "track-default");
    await mirror.add({ root, source: bareRemotePath });

    let code: string | undefined;
    try {
      await mirror.track({ root, source: bareRemotePath, branch: "main" });
    } catch (error) {
      code = (error as mirror.CanonicalMirrorError).code;
    }

    expect(code).toBe("DEFAULT_BRANCH");
    expect(fs.exists(join(root, "mirrors", "local", "remote@main"))).toBe(false);
  });
});
