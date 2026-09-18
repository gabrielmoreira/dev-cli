import { describe, expect, it } from "bun:test";
import {
  defaultWorkspaceBody,
  parseWorkspace,
  serializeWorkspace,
  type WorkspaceManifest,
} from "../../src/manifest.ts";

describe("Manifest serialization & parsing (Phase 1)", () => {
  it("serializes and parses back an initial empty workspace manifest", () => {
    const original: WorkspaceManifest = {
      version: 1,
      name: "task-alpha",
      created_at: "2026-09-14T20:00:00.000Z",
      description: "Initial investigation",
      mounts: [],
    };

    const serialized = serializeWorkspace(original);
    expect(serialized).toContain("---");
    expect(serialized).toContain("version: 1");
    expect(serialized).toContain("name: task-alpha");
    expect(serialized).toContain("mounts: []");
    expect(serialized).toContain("# Workspace: task-alpha");

    const parsed = parseWorkspace(serialized);
    expect(parsed.manifest.version).toBe(original.version);
    expect(parsed.manifest.name).toBe(original.name);
    expect(parsed.manifest.description).toBe(original.description);
    expect(parsed.manifest.mounts).toEqual([]);
    expect(parsed.body).toContain("# Workspace: task-alpha");
  });

  it("creates a workspace brief that humans and LLMs can maintain", () => {
    const body = defaultWorkspaceBody("checkout-payment-fix", "Fix webhook idempotency");

    expect(body).toContain("Read this file at the start of every work session");
    expect(body).toContain("keep the YAML frontmatter intact");
    expect(body).toContain("## Objective\nFix webhook idempotency");
    expect(body).toContain("## Current Progress");
    expect(body).toContain("## Decisions");
    expect(body).toContain("## Next Steps");
    expect(body).toContain("`dev --help --llms`");
    expect(body).toContain("`dev ws start`");
    expect(body).toContain("Use this workspace's `.local/` for workspace-local artifacts");
  });

  it("handles manifests with mounts and hooks", () => {
    const original: WorkspaceManifest = {
      version: 1,
      name: "checkout-payment-fix",
      created_at: "2026-09-06T00:15:00Z",
      description: "Fix webhook idempotency",
      mounts: [
        {
          path: "core",
          source: "git@github.com:company/core.git",
          readonly: false,
          revision: {
            mode: "track",
            branch: "fix/payment-idempotency",
          },
          hooks: {
            pre_checkout: "echo preparing",
            post_checkout: "mise install",
          },
        },
        {
          path: "payment-service",
          source: "https://dev.azure.com/Company/Project/_git/payment-service",
          readonly: true,
          revision: {
            mode: "lock",
            commit: "9f8a3c2e1b4d",
          },
        },
      ],
    };

    const serialized = serializeWorkspace(original);
    const parsed = parseWorkspace(serialized);

    expect(parsed.manifest.mounts.length).toBe(2);
    expect(parsed.manifest.mounts[0].path).toBe("core");
    expect(parsed.manifest.mounts[0].revision.mode).toBe("track");
    expect(parsed.manifest.mounts[0].hooks?.post_checkout).toBe("mise install");
    expect(parsed.manifest.mounts[1].readonly).toBe(true);
    expect(parsed.manifest.mounts[1].revision.mode).toBe("lock");
  });

  it("fails cleanly when frontmatter is missing", () => {
    expect(() => parseWorkspace("# Just markdown without frontmatter")).toThrow(
      "missing YAML frontmatter",
    );
  });
});
