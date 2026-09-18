import { describe, expect, it } from "bun:test";
import { compareWorkspace, WorkspaceError, status } from "../../src/ws.ts";
import type { MountDefinition } from "../../src/manifest.ts";
import type { ObservedWorktree } from "../../src/git.ts";

describe("Remote refresh & offline semantics (Phase 4)", () => {
  const mountDef: MountDefinition = {
    path: "service",
    source: "https://github.com/company/service.git",
    revision: { mode: "track", branch: "main" },
  };

  it("throws CONFLICTING_OPTIONS when both refresh and offline are specified", async () => {
    try {
      await status({
        root: "/any/path",
        workspaceName: "any-ws",
        refresh: true,
        offline: true,
      });
      expect.unreachable("Should have thrown CONFLICTING_OPTIONS");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe("CONFLICTING_OPTIONS");
    }
  });

  it("reports 'behind' when observed behindCount > 0 and aheadCount === 0", () => {
    const observed: ObservedWorktree = {
      path: "service",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "main", commitSha: "111111" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 3,
    };

    const verdicts = compareWorkspace([mountDef], { service: observed });
    expect(verdicts[0].state).toBe("behind");
    expect(verdicts[0].messages[0]).toContain("Behind upstream by 3 commit(s)");
  });

  it("reports 'diverged' when both aheadCount > 0 and behindCount > 0", () => {
    const observed: ObservedWorktree = {
      path: "service",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "main", commitSha: "111111" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 2,
      behindCount: 4,
    };

    const verdicts = compareWorkspace([mountDef], { service: observed });
    expect(verdicts[0].state).toBe("diverged");
    expect(verdicts[0].messages[0]).toContain("Diverged from upstream: ahead 2, behind 4");
  });
});
