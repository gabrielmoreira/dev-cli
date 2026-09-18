import { describe, expect, it } from "bun:test";
import type { MountDefinition } from "../../src/manifest.ts";
import {
  planWorkspaceUpdate,
  validateUpdatePlan,
  type MountStatusVerdict,
  type PlannedMountUpdate,
} from "../../src/ws.ts";

describe("Workspace update planning pure rules (Phase 5)", () => {
  const baseMount: MountDefinition = {
    path: "service-a",
    source: "https://example.com/org/repo.git",
    revision: { mode: "track", branch: "main" },
    readonly: false,
  };

  it("plans fast-forward for clean and behind mount", () => {
    const status: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "abc111" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 2,
      },
      state: "behind",
      messages: [],
    };

    const plan = planWorkspaceUpdate([baseMount], [status]);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("fast_forward");
    expect(plan[0].targetRef).toBe("refs/remotes/origin/main");
  });

  it("marks clean mount with 0 behind commits as up_to_date", () => {
    const status: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "abc111" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
      state: "clean",
      messages: [],
    };

    const plan = planWorkspaceUpdate([baseMount], [status]);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("up_to_date");
  });

  it("skips dirty worktrees to protect uncommitted changes", () => {
    const status: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "abc111" },
        isDirty: true,
        modifiedFiles: 1,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 1,
      },
      state: "dirty",
      messages: [],
    };

    const plan = planWorkspaceUpdate([baseMount], [status]);
    expect(plan[0].action).toBe("skipped");
    expect(plan[0].reason).toBe("dirty_worktree");
  });

  it("skips mounts with local ahead commits to prevent overwriting local history", () => {
    const status: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "ahead222" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 1,
        behindCount: 0,
      },
      state: "ahead",
      messages: [],
    };

    const plan = planWorkspaceUpdate([baseMount], [status]);
    expect(plan[0].action).toBe("skipped");
    expect(plan[0].reason).toBe("ahead_commits");
  });

  it("skips diverged history", () => {
    const status: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "div333" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 1,
        behindCount: 2,
      },
      state: "diverged",
      messages: [],
    };

    const plan = planWorkspaceUpdate([baseMount], [status]);
    expect(plan[0].action).toBe("skipped");
    expect(plan[0].reason).toBe("diverged_history");
  });

  it("skips missing worktrees and wrong revisions", () => {
    const missingStatus: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: false,
        isGitWorktree: false,
        currentRevision: {},
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
      state: "missing",
      messages: [],
    };
    const planMissing = planWorkspaceUpdate([baseMount], [missingStatus]);
    expect(planMissing[0].action).toBe("skipped");
    expect(planMissing[0].reason).toBe("missing_worktree");

    const wrongRevStatus: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: false,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "other-branch", commitSha: "xxx" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
      state: "wrong_revision",
      messages: [],
    };
    const planWrong = planWorkspaceUpdate([baseMount], [wrongRevStatus]);
    expect(planWrong[0].action).toBe("skipped");
    expect(planWrong[0].reason).toBe("wrong_revision");
  });

  it("skips readonly mounts", () => {
    const readonlyMount: MountDefinition = {
      ...baseMount,
      readonly: true,
    };
    const status: MountStatusVerdict = {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: {
        revision: { mode: "track", branch: "main" },
        readonly: true,
      },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "abc" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 2,
      },
      state: "behind",
      messages: [],
    };

    const plan = planWorkspaceUpdate([readonlyMount], [status]);
    expect(plan[0].action).toBe("skipped");
    expect(plan[0].reason).toBe("readonly");
  });

  it("validateUpdatePlan passes valid plan and rejects invalid entries", () => {
    const validPlan: PlannedMountUpdate[] = [
      {
        path: "service-a",
        source: "https://example.com/org/repo.git",
        action: "fast_forward",
        targetRef: "refs/remotes/origin/main",
      },
      {
        path: "service-b",
        source: "https://example.com/org/repo2.git",
        action: "skipped",
        reason: "dirty_worktree",
      },
    ];

    expect(() => validateUpdatePlan(validPlan)).not.toThrow();

    const invalidPlan: PlannedMountUpdate[] = [
      {
        path: "service-a",
        source: "https://example.com/org/repo.git",
        action: "fast_forward",
        targetRef: "", // Empty target ref is invalid
      },
    ];
    expect(() => validateUpdatePlan(invalidPlan)).toThrow();
  });
});
