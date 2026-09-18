import { describe, expect, it } from "bun:test";
import type { MountDefinition } from "../../src/manifest.ts";
import { planReconciliation, transitionRevision, type ObservedWorktree } from "../../src/ws.ts";

describe("Workspace revision lifecycle & reconciliation pure rules (Phase 6)", () => {
  const mountTrackMain: MountDefinition = {
    path: "service-core",
    source: "https://example.com/org/repo.git",
    revision: { mode: "track", branch: "main" },
    readonly: false,
  };

  it("pure transitionRevision transitions from track to lock, and lock to track", () => {
    const locked = transitionRevision(mountTrackMain, { mode: "lock", commit: "abcdef123" });
    expect(locked.revision.mode).toBe("lock");
    if (locked.revision.mode === "lock") {
      expect(locked.revision.commit).toBe("abcdef123");
    }

    const unlocked = transitionRevision(locked, { mode: "track", branch: "feature/auth" });
    expect(unlocked.revision.mode).toBe("track");
    if (unlocked.revision.mode === "track") {
      expect(unlocked.revision.branch).toBe("feature/auth");
    }

    const tagged = transitionRevision(unlocked, { mode: "tag", tag: "v1.0.0" });
    expect(tagged.revision.mode).toBe("tag");
    if (tagged.revision.mode === "tag") {
      expect(tagged.revision.tag).toBe("v1.0.0");
    }
  });

  it("planReconciliation plans worktree creation when worktree is missing from disk", () => {
    const observedMap: Record<string, ObservedWorktree> = {
      "service-core": {
        path: "/ws/service-core",
        exists: false,
        isGitWorktree: false,
        currentRevision: {},
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
    };

    const plan = planReconciliation([mountTrackMain], observedMap);
    expect(plan).toHaveLength(1);
    expect(plan[0].path).toBe("service-core");
    expect(plan[0].action).toBe("create_worktree");
  });

  it("planReconciliation plans checkout when observed branch differs from desired track branch", () => {
    const observedMap: Record<string, ObservedWorktree> = {
      "service-core": {
        path: "/ws/service-core",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "develop", commitSha: "111111" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
    };

    const plan = planReconciliation([mountTrackMain], observedMap);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("checkout_revision");
    expect(plan[0].targetRevision).toEqual({ mode: "track", branch: "main" });
  });

  it("planReconciliation skips conflict when observed is dirty and revision differs", () => {
    const observedMap: Record<string, ObservedWorktree> = {
      "service-core": {
        path: "/ws/service-core",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "develop", commitSha: "111111" },
        isDirty: true,
        modifiedFiles: 2,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
    };

    const plan = planReconciliation([mountTrackMain], observedMap);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("conflict");
    expect(plan[0].reason).toBe("dirty_worktree");
  });

  it("planReconciliation plans no_op when observed matches desired perfectly", () => {
    const observedMap: Record<string, ObservedWorktree> = {
      "service-core": {
        path: "/ws/service-core",
        exists: true,
        isGitWorktree: true,
        currentRevision: { branch: "main", commitSha: "111111" },
        isDirty: false,
        modifiedFiles: 0,
        untrackedFiles: 0,
        aheadCount: 0,
        behindCount: 0,
      },
    };

    const plan = planReconciliation([mountTrackMain], observedMap);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("no_op");
  });
});
