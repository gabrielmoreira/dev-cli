import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import * as git from "../../src/git.ts";

describe("dev mirror CLI E2E (Phase 8)", () => {
  let tempRoot: string;
  let bareRemotePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-e2e-repo-root-"));
    bareRemotePath = join(tempRoot, "remote.git");
    await fs.writeText(
      join(tempRoot, "dev.yaml"),
      ["version: 1", "defaults:", "  canonical_prefix: references/", ""].join("\n"),
    );

    await git.runGit(["init", "--bare", bareRemotePath]);

    const seedDir = await mkdtemp(join(tmpdir(), "dev-cli-e2e-repo-seed-"));
    await git.runGit(["init", seedDir]);
    await git.runGit(["config", "user.name", "CLI Repo Author"], { cwd: seedDir });
    await git.runGit(["config", "user.email", "clirepo@example.com"], { cwd: seedDir });

    await fs.writeText(join(seedDir, "file.txt"), "hello cli repo");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: initial commit"], { cwd: seedDir });
    await git.runGit(["remote", "add", "origin", bareRemotePath], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seedDir });

    // Secondary branch
    await git.runGit(["checkout", "-b", "feature/e2e-branch"], { cwd: seedDir });
    await fs.writeText(join(seedDir, "feature.txt"), "feature e2e data");
    await git.runGit(["add", "."], { cwd: seedDir });
    await git.runGit(["commit", "-m", "feat: feature commit"], { cwd: seedDir });
    await git.runGit(["push", "-u", "origin", "feature/e2e-branch"], { cwd: seedDir });

    await rm(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it("adds, lists, tracks, syncs and untracks canonical repositories via CLI", async () => {
    // 1. dev mirror add
    const addProc = Bun.spawn(
      ["bun", "run", cliPath, "mirror", "add", bareRemotePath, "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await addProc.exited).toBe(0);
    const addJson = JSON.parse(await new Response(addProc.stdout).text());
    expect("readOnly" in addJson).toBe(false);
    expect(addJson.branch).toBe("main");
    expect(addJson.path).toContain(join(tempRoot, "references", "local"));

    // 2. dev mirror list
    const listProc = Bun.spawn(
      ["bun", "run", cliPath, "mirror", "list", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await listProc.exited).toBe(0);
    const listJson = JSON.parse(await new Response(listProc.stdout).text());
    expect(listJson).toBeArray();
    expect(listJson.length).toBe(1);
    expect(listJson[0].branch).toBe("main");
    expect("readOnly" in listJson[0]).toBe(false);

    // 3. dev mirror track
    const trackProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "mirror",
        "track",
        bareRemotePath,
        "feature/e2e-branch",
        "--root",
        tempRoot,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await trackProc.exited).toBe(0);
    const trackJson = JSON.parse(await new Response(trackProc.stdout).text());
    expect(trackJson.branch).toBe("feature/e2e-branch");
    expect("readOnly" in trackJson).toBe(false);

    await fs.writeText(join(addJson.path, "file.txt"), "accidental mirror edit");

    // 4. dev mirror sync
    const syncProc = Bun.spawn(
      ["bun", "run", cliPath, "mirror", "sync", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await syncProc.exited).toBe(0);
    const syncJson = JSON.parse(await new Response(syncProc.stdout).text());
    expect(syncJson.stashed).toHaveLength(1);
    expect(syncJson.stashed[0].changes).toEqual(["M file.txt"]);
    expect(syncJson.skipped.length).toBe(2); // Both are up to date

    // 5. dev mirror untrack
    const untrackProc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "mirror",
        "untrack",
        bareRemotePath,
        "feature/e2e-branch",
        "--root",
        tempRoot,
        "--force",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await untrackProc.exited).toBe(0);
    const untrackJson = JSON.parse(await new Response(untrackProc.stdout).text());
    expect(untrackJson.removed).toBe(true);

    // Verify list now has 1 repo
    const listAfterProc = Bun.spawn(
      ["bun", "run", cliPath, "mirror", "list", "--root", tempRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await listAfterProc.exited).toBe(0);
    const listAfterJson = JSON.parse(await new Response(listAfterProc.stdout).text());
    expect(listAfterJson.length).toBe(1);
  });
});
