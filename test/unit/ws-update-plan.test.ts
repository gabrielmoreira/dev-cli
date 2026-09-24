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

  function verdict(
    state: MountStatusVerdict["state"],
    observed: Partial<MountStatusVerdict["observed"]>,
  ): MountStatusVerdict {
    return {
      path: "service-a",
      source: "https://example.com/org/repo.git",
      desired: { revision: { mode: "track", branch: "main" }, readonly: false },
      observed: {
        path: "/mock/ws/service-a",
        exists: true,
        isGitWorktree: true,
        currentRevision: {},
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
        ...observed,
      },
      state,
      messages: [],
    };
  }

  it("creates a declared mount that is missing from disk, readonly or not", () => {
    const missing = verdict("missing", { exists: false, isGitWorktree: false });

    for (const mount of [baseMount, { ...baseMount, readonly: true }]) {
      const [planned] = planWorkspaceUpdate([mount], [missing]);
      expect(planned.action).toBe("create");
      expect(planned.revision).toEqual({ mode: "track", branch: "main" });
    }
  });

  it("leaves a directory that is not a worktree alone", () => {
    const occupied = verdict("missing", { exists: true, isGitWorktree: false });

    const [planned] = planWorkspaceUpdate([baseMount], [occupied]);

    expect(planned.action).toBe("skipped");
    expect(planned.reason).toBe("not_a_worktree");
  });

  it("checks out the declared revision of a clean mount on the wrong one", () => {
    const wrong = verdict("wrong_revision", {
      currentRevision: { branch: "other-branch", commitSha: "xxx" },
    });

    const [planned] = planWorkspaceUpdate([baseMount], [wrong]);
    const [readonly] = planWorkspaceUpdate([{ ...baseMount, readonly: true }], [wrong]);

    expect(planned.action).toBe("checkout");
    expect(planned.revision).toEqual({ mode: "track", branch: "main" });
    expect(readonly.reason).toBe("readonly");
  });

  it("keeps a mount on the wrong revision where it is when it holds commits nothing else has", () => {
    const detachedWithWork = verdict("wrong_revision", {
      currentRevision: { commitSha: "local-work" },
      aheadCount: 1,
    });

    const [planned] = planWorkspaceUpdate([baseMount], [detachedWithWork]);

    expect(planned.action).toBe("skipped");
    expect(planned.reason).toBe("ahead_commits");
  });

  it("offline, skips creating a mount whose mirror is not on disk", () => {
    const missing = verdict("missing", { exists: false, isGitWorktree: false });

    const [planned] = planWorkspaceUpdate([baseMount], [missing], {
      missingMirrors: new Set([baseMount.source]),
    });

    expect(planned.action).toBe("skipped");
    expect(planned.reason).toBe("no_local_mirror");
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
