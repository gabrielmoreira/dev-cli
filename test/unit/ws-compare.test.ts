import { describe, expect, it } from "bun:test";
import { compareWorkspace } from "../../src/ws.ts";
import type { MountDefinition } from "../../src/manifest.ts";
import type { ObservedWorktree } from "../../src/git.ts";

describe("compareWorkspace pure comparison logic (Phase 3)", () => {
  const baseDesiredMount: MountDefinition = {
    path: "core",
    source: "https://github.com/company/core.git",
    readonly: false,
    revision: { mode: "track", branch: "main" },
  };

  it("reports 'clean' when observed branch and commit match desired state and worktree is clean", () => {
    const observed: ObservedWorktree = {
      path: "core",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "main", commitSha: "abcdef123456" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };

    const verdicts = compareWorkspace([baseDesiredMount], { core: observed });
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].state).toBe("clean");
    expect(verdicts[0].messages).toEqual([]);
  });

  it("reports 'missing' when worktree directory is missing or not a git worktree", () => {
    const verdicts = compareWorkspace([baseDesiredMount], {});
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].state).toBe("missing");
    expect(verdicts[0].messages[0]).toContain("does not exist");
  });

  it("reports 'dirty' when worktree has modified or untracked files", () => {
    const observed: ObservedWorktree = {
      path: "core",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "main", commitSha: "abcdef123456" },
      isDirty: true,
      modifiedFiles: 2,
      untrackedFiles: 1,
      aheadCount: 0,
      behindCount: 0,
    };

    const verdicts = compareWorkspace([baseDesiredMount], { core: observed });
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].state).toBe("dirty");
    expect(verdicts[0].messages[0]).toContain("2 modified");
  });

  it("reports 'wrong_revision' when observed branch differs from desired branch", () => {
    const observed: ObservedWorktree = {
      path: "core",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "feature/login", commitSha: "111111" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };

    const verdicts = compareWorkspace([baseDesiredMount], { core: observed });
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].state).toBe("wrong_revision");
    expect(verdicts[0].messages[0]).toContain(
      "Expected branch 'main', but observed 'feature/login'",
    );
  });

  it("reports 'ahead' when local branch has ahead commits", () => {
    const observed: ObservedWorktree = {
      path: "core",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "main", commitSha: "abcdef123456" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 3,
      behindCount: 0,
    };

    const verdicts = compareWorkspace([baseDesiredMount], { core: observed });
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].state).toBe("ahead");
    expect(verdicts[0].messages[0]).toContain("Ahead of upstream by 3 commit(s)");
  });

  it("compares locked commit revision correctly", () => {
    const lockedDesired: MountDefinition = {
      path: "service",
      source: "https://dev.azure.com/org/proj/_git/service",
      revision: { mode: "lock", commit: "9f8a3c2e1b4d" },
    };

    const matchingObserved: ObservedWorktree = {
      path: "service",
      exists: true,
      isGitWorktree: true,
      currentRevision: { commitSha: "9f8a3c2e1b4d0000000000000000000000000000" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };

    const verdicts = compareWorkspace([lockedDesired], { service: matchingObserved });
    expect(verdicts[0].state).toBe("clean");

    const mismatchedObserved: ObservedWorktree = {
      ...matchingObserved,
      currentRevision: { commitSha: "000000000000" },
    };

    const mismatchVerdicts = compareWorkspace([lockedDesired], { service: mismatchedObserved });
    expect(mismatchVerdicts[0].state).toBe("wrong_revision");
  });
});
