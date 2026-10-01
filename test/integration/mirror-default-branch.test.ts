import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";
import * as mirror from "../../src/mirror.ts";

describe("Mirror default branch discovery", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  let seedDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-default-branch-"));
    bareRemotePath = join(tempRoot, "example-org", "sample-api.git");
    await git.runGit(["init", "--bare", "-b", "develop", bareRemotePath]);

    seedDir = join(tempRoot, "seed");
    await git.runGit(["init", "-b", "develop", seedDir]);
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "agent@example.org"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "file.txt"), "initial");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "develop"], { cwd: seedDir });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("discovers develop from the repository HEAD when no branch is supplied", async () => {
    const result = await mirror.ensure({
      root: join(tempRoot, "dev-root"),
      source: bareRemotePath,
    });

    expect(result.branch).toBe("develop");
    expect((await git.inspectWorktree(result.path)).currentRevision.branch).toBe("develop");
  });

  it("leaves the default unknown when HEAD is detached and no heads exist", async () => {
    const detachedPath = join(tempRoot, "detached.git");
    await git.runGit(["clone", "--bare", bareRemotePath, detachedPath]);
    const head = await git.runGit(["rev-parse", "HEAD"], { cwd: detachedPath });
    await git.runGit(["update-ref", "--no-deref", "HEAD", head.stdout], { cwd: detachedPath });
    await git.runGit(["update-ref", "-d", "refs/heads/develop"], { cwd: detachedPath });

    expect(await git.resolveDefaultBranch(detachedPath)).toBeUndefined();
  });
});
