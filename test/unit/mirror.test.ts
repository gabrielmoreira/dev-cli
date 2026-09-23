import { describe, expect, it } from "bun:test";
import {
  deriveCanonicalParts,
  planCanonicalCheckout,
  planRepoSyncAction,
  CanonicalMirrorError,
} from "../../src/mirror.ts";
import type { ObservedWorktree } from "../../src/git.ts";

describe("Canonical repository pure rules (Phase 8)", () => {
  describe("deriveCanonicalParts", () => {
    it("parses GitHub HTTPS URL into host, owner, repo and base path", () => {
      const parts = deriveCanonicalParts("https://github.com/company/auth-service.git");
      expect(parts.host).toBe("github.com");
      expect(parts.repo).toBe("auth-service");
      expect(parts.relativeBaseDir.replace(/\\/g, "/")).toBe("mirrors/github.com/company");
    });

    it("parses GitHub SSH URL into identical canonical structure", () => {
      const parts = deriveCanonicalParts("git@github.com:company/auth-service.git");
      expect(parts.host).toBe("github.com");
      expect(parts.repo).toBe("auth-service");
      expect(parts.relativeBaseDir.replace(/\\/g, "/")).toBe("mirrors/github.com/company");
    });

    it("parses Azure DevOps repository URL into canonical hierarchy", () => {
      const parts = deriveCanonicalParts(
        "https://dev.azure.com/my-org/my-proj/_git/core-service.git",
      );
      expect(parts.host).toBe("dev.azure.com");
      expect(parts.repo).toBe("core-service");
      expect(parts.relativeBaseDir.replace(/\\/g, "/")).toBe(
        "mirrors/dev.azure.com/my-org/my-proj",
      );
    });
  });

  describe("planCanonicalCheckout", () => {
    it("plans default checkout under mirrors/<host>/<owner>/<repo>", () => {
      const plan = planCanonicalCheckout({
        root: "/dev-root",
        source: "https://github.com/company/auth-service.git",
        branch: "main",
      });

      expect(plan.branch).toBe("main");
      expect(plan.isSibling).toBe(false);
      expect(plan.relativePath.replace(/\\/g, "/")).toBe("mirrors/github.com/company/auth-service");
      expect(plan.absolutePath.replace(/\\/g, "/")).toBe(
        "/dev-root/mirrors/github.com/company/auth-service",
      );
      expect(plan.adminRepoPath.replace(/\\/g, "/")).toBe(
        "/dev-root/.dev/repos/github.com__company__auth-service.git",
      );
    });

    it("plans checkouts under the configured canonical prefix", () => {
      const plan = planCanonicalCheckout({
        root: "/dev-root",
        canonicalPrefix: "repos",
        source: "https://github.com/company/auth-service.git",
        branch: "main",
      });

      expect(plan.relativePath.replace(/\\/g, "/")).toBe("repos/github.com/company/auth-service");
      expect(plan.absolutePath.replace(/\\/g, "/")).toBe(
        "/dev-root/repos/github.com/company/auth-service",
      );
    });

    it("keeps the default branch on <repo>, even when it is named explicitly", () => {
      const plan = planCanonicalCheckout({
        root: "/dev-root",
        source: "https://github.com/company/auth-service.git",
        branch: "develop",
        defaultBranch: "develop",
      });

      expect(plan.isSibling).toBe(false);
      expect(plan.relativePath.replace(/\\/g, "/")).toBe("mirrors/github.com/company/auth-service");
    });

    it("plans a non-default branch under mirrors/<host>/<owner>/<repo>@<branch>", () => {
      const plan = planCanonicalCheckout({
        root: "/dev-root",
        source: "https://github.com/company/auth-service.git",
        branch: "feature/auth-v2",
        defaultBranch: "main",
      });

      expect(plan.branch).toBe("feature/auth-v2");
      expect(plan.isSibling).toBe(true);
      expect(plan.relativePath.replace(/\\/g, "/")).toBe(
        "mirrors/github.com/company/auth-service@feature-auth-v2",
      );
    });

    it("plans sibling with custom alias name", () => {
      const plan = planCanonicalCheckout({
        root: "/dev-root",
        source: "https://github.com/company/auth-service.git",
        branch: "feature/auth-v2",
        defaultBranch: "main",
        alias: "auth-next",
      });

      expect(plan.relativePath.replace(/\\/g, "/")).toBe("mirrors/github.com/company/auth-next");
    });
  });

  describe("planRepoSyncAction", () => {
    const baseObserved: ObservedWorktree = {
      path: "/dev-root/mirrors/github.com/company/auth-service",
      exists: true,
      isGitWorktree: true,
      currentRevision: { branch: "main" },
      isDirty: false,
      modifiedFiles: 0,
      untrackedFiles: 0,
      aheadCount: 0,
      behindCount: 0,
    };

    it("plans fast_forward when worktree is clean and behind upstream", () => {
      const observed: ObservedWorktree = { ...baseObserved, behindCount: 3 };
      const action = planRepoSyncAction(observed);
      expect(action.action).toBe("fast_forward");
      expect(action.behindCount).toBe(3);
    });

    it("skips up-to-date worktrees", () => {
      const observed: ObservedWorktree = { ...baseObserved, behindCount: 0 };
      const action = planRepoSyncAction(observed);
      expect(action.action).toBe("skip");
      expect(action.reason).toBe("UP_TO_DATE");
    });

    it("skips dirty worktrees to protect worktree integrity", () => {
      const observed: ObservedWorktree = { ...baseObserved, isDirty: true, modifiedFiles: 1 };
      const action = planRepoSyncAction(observed);
      expect(action.action).toBe("skip");
      expect(action.reason).toBe("DIRTY_WORKTREE");
    });

    it("skips ahead commits to avoid overwriting local changes", () => {
      const observed: ObservedWorktree = { ...baseObserved, aheadCount: 1 };
      const action = planRepoSyncAction(observed);
      expect(action.action).toBe("skip");
      expect(action.reason).toBe("AHEAD_COMMITS");
    });

    it("skips diverged history", () => {
      const observed: ObservedWorktree = { ...baseObserved, aheadCount: 2, behindCount: 1 };
      const action = planRepoSyncAction(observed);
      expect(action.action).toBe("skip");
      expect(action.reason).toBe("DIVERGED");
    });
  });

  describe("CanonicalMirrorError", () => {
    it("creates CanonicalMirrorError with stable code and message", () => {
      const err = new CanonicalMirrorError("SAMPLE_CODE", "Sample error message");
      expect(err.code).toBe("SAMPLE_CODE");
      expect(err.message).toBe("Sample error message");
      expect(err.name).toBe("CanonicalMirrorError");
    });
  });
});
