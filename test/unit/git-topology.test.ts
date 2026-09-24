import { describe, expect, it } from "bun:test";
import {
  deriveDefaultMountPath,
  normalizeSourceKey,
  redactCredentials,
  stripCredentialsFromUrl,
} from "../../src/git.ts";
import { planMount, WorkspaceError } from "../../src/ws.ts";

describe("Git topology pure rules (Phase 2)", () => {
  it("normalizes Azure DevOps Git URLs into stable source keys", () => {
    const url1 = "https://dev.azure.com/example-org/example-project/_git/alpha-service";
    const url2 = "https://example-org@dev.azure.com/example-org/example-project/_git/alpha-service";
    const url3 = "https://dev.azure.com/example-org/example-project/_git/alpha-service.git";

    const key1 = normalizeSourceKey(url1);
    const key2 = normalizeSourceKey(url2);
    const key3 = normalizeSourceKey(url3);

    expect(key1).toBe("dev.azure.com__example-org__example-project___git__alpha-service");
    expect(key2).toBe(key1);
    expect(key3).toBe(key1);
  });

  it("normalizes GitHub HTTPS and SSH URLs into identical source keys", () => {
    const httpsUrl = "https://github.com/example-owner/dev-cli.git";
    const sshUrl = "git@github.com:example-owner/dev-cli.git";

    const httpsKey = normalizeSourceKey(httpsUrl);
    const sshKey = normalizeSourceKey(sshUrl);

    expect(httpsKey).toBe("github.com__example-owner__dev-cli");
    expect(sshKey).toBe(httpsKey);
  });

  it("removes passwords and tokens from source keys and canonical URLs", () => {
    const urlWithPassword = "https://user:example-password@dev.azure.com/org/proj/_git/repo.git";
    const urlWithToken = "https://example-token@github.com/company/repo.git";
    const cleanUrl = "https://dev.azure.com/org/proj/_git/repo.git";
    const sshWithPassword = "ssh://user:example-password@dev.azure.com/org/proj/_git/repo.git";

    expect(normalizeSourceKey(urlWithPassword)).toBe("dev.azure.com__org__proj___git__repo");
    expect(normalizeSourceKey(urlWithPassword)).toBe(normalizeSourceKey(cleanUrl));
    expect(normalizeSourceKey(urlWithToken)).toBe("github.com__company__repo");
    expect(normalizeSourceKey(sshWithPassword)).toBe("dev.azure.com__org__proj___git__repo");

    expect(stripCredentialsFromUrl(urlWithPassword)).toBe(cleanUrl);
    expect(stripCredentialsFromUrl(sshWithPassword)).toBe(
      "ssh://dev.azure.com/org/proj/_git/repo.git",
    );

    expect(deriveDefaultMountPath(urlWithPassword)).toBe("repo");
  });

  it("derives default mount folder name from repository URLs", () => {
    expect(deriveDefaultMountPath("https://dev.azure.com/org/proj/_git/alpha-service")).toBe(
      "alpha-service",
    );
    expect(deriveDefaultMountPath("https://github.com/company/core.git")).toBe("core");
    expect(deriveDefaultMountPath("git@github.com:company/auth-service.git")).toBe("auth-service");
    expect(deriveDefaultMountPath("https://example.com/mirrors/tool/")).toBe("tool");
  });

  it("plans mounts with default and custom paths", () => {
    const planDefault = planMount({
      source: "https://dev.azure.com/org/proj/_git/alpha-service",
      existingMounts: [],
    });
    expect(planDefault.mountName).toBe("alpha-service");
    expect(planDefault.readonly).toBe(false);

    const planCustom = planMount({
      source: "https://dev.azure.com/org/proj/_git/alpha-service",
      path: "custom-folder",
      branch: "feature/login",
      readonly: true,
      existingMounts: [],
    });
    expect(planCustom.mountName).toBe("custom-folder");
    expect(planCustom.revision).toEqual({ mode: "track", branch: "feature/login" });
    expect(planCustom.readonly).toBe(true);
  });

  it("rejects mount paths that escape the workspace", () => {
    for (const path of ["../outside", "nested/../../outside", "/absolute/path"]) {
      expect(() =>
        planMount({
          source: "https://github.com/company/core.git",
          path,
          existingMounts: [],
        }),
      ).toThrow(WorkspaceError);
    }
  });

  it("rejects duplicate mount paths in mount planning", () => {
    expect(() =>
      planMount({
        source: "https://github.com/company/core.git",
        existingMounts: [
          {
            path: "core",
            source: "https://github.com/company/core.git",
            revision: { mode: "track", branch: "main" },
          },
        ],
      }),
    ).toThrow(WorkspaceError);
  });

  it("rejects the same branch twice for one repository", () => {
    expect(() =>
      planMount({
        source: "https://github.com/company/core.git",
        path: "core-copy",
        branch: "main",
        existingMounts: [
          {
            path: "core-main",
            source: "https://github.com/company/core.git",
            revision: { mode: "track", branch: "main" },
          },
        ],
      }),
    ).toThrow("Branch 'main' is already mounted for this repository");
  });

  it("removes credentials from anywhere inside a message", () => {
    const message =
      "Failed to create mirror for https://user:ghp_secret@github.com/org/repo: fatal: could not read from https://user:ghp_secret@github.com/org/repo";
    const safe = redactCredentials(message);
    expect(safe).not.toContain("ghp_secret");
    expect(safe).not.toContain("user:");
    expect(safe).toContain("https://github.com/org/repo");
  });

  it("leaves text without credentials untouched", () => {
    expect(redactCredentials("fatal: repository not found")).toBe("fatal: repository not found");
    expect(redactCredentials("https://github.com/org/repo")).toBe("https://github.com/org/repo");
  });
});
