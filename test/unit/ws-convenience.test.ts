import { describe, expect, it } from "bun:test";
import type { WorkspaceManifest } from "../../src/manifest.ts";
import { planDuplication, resolveWorkspacePath, WorkspaceError } from "../../src/ws.ts";

describe("Workspace convenience pure rules (Phase 7)", () => {
  const sampleManifest: WorkspaceManifest = {
    version: 1,
    name: "alpha-feature",
    created_at: "2026-09-01T00:00:00.000Z",
    description: "Original feature branch context",
    mounts: [
      {
        path: "service-auth",
        source: "https://example.com/org/auth.git",
        revision: { mode: "track", branch: "feature/login" },
        readonly: false,
      },
    ],
  };

  it("planDuplication creates a clean target manifest with new name, fresh timestamp and copied mounts", () => {
    const planned = planDuplication(sampleManifest, "alpha-feature-copy");

    expect(planned.name).toBe("alpha-feature-copy");
    expect(planned.description).toBe("Original feature branch context");
    expect(planned.mounts).toHaveLength(1);
    expect(planned.mounts[0].path).toBe("service-auth");
    expect(planned.mounts[0].revision).toEqual({ mode: "track", branch: "feature/login" });
    expect(planned.created_at).not.toBe("2026-09-01T00:00:00.000Z");
  });

  it("resolveWorkspacePath resolves explicitly provided workspace name", () => {
    const p = resolveWorkspacePath({ root: "/dev", workspaceName: "my-ws" });
    expect(p.replace(/\\/g, "/")).toBe("/dev/ws/my-ws");
  });

  it("resolveWorkspacePath detects workspace from cwd when inside workspace", () => {
    const p = resolveWorkspacePath({
      root: "/dev",
      cwd: "/dev/ws/my-ws/service-auth/src",
    });
    expect(p.replace(/\\/g, "/")).toBe("/dev/ws/my-ws");
  });

  it("resolveWorkspacePath throws when target workspace cannot be determined", () => {
    expect(() =>
      resolveWorkspacePath({
        root: "/dev",
        cwd: "/other/unrelated/path",
      }),
    ).toThrow(WorkspaceError);
  });
});
