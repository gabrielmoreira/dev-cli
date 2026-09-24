import { describe, expect, it } from "bun:test";
import type { MountDefinition } from "../../src/manifest.ts";
import { transitionRevision } from "../../src/ws.ts";

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
});
