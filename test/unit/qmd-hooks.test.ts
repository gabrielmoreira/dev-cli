import { describe, expect, test } from "bun:test";
import { resolveHookExecution } from "../../src/trust.ts";
import type { TrustedScope } from "../../src/config.ts";

describe("QMD and Lifecycle Hooks Pure Resolution (Phase 19)", () => {
  const sampleScopes: TrustedScope[] = [
    {
      provider: "azuredevops",
      tenant: "dev.azure.com",
      owner: "my-org",
      repos: ["payments", "auth"],
      rules: [
        {
          match: "payments",
          hooks: {
            post_add: "mise x -- qmd update --path $DEV_MOUNT_PATH",
            post_sync: "mise x -- qmd index --incremental",
          },
        },
        {
          match: "*",
          hooks: {
            post_add: "echo 'generic post_add'",
            post_sync: "echo 'generic post_sync'",
          },
        },
      ],
    },
  ];

  test("resolves mount-specific post_add hook with top precedence", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "post_add",
      mountHook: "custom-indexer --path $DEV_MOUNT_PATH",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("custom-indexer --path $DEV_MOUNT_PATH");
    expect(result.reason).toBe("trusted_mount_override");
  });

  test("resolves exact scope rule for post_add and post_sync", () => {
    const postAdd = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "post_add",
      trustedScopes: sampleScopes,
    });
    expect(postAdd.allowed).toBe(true);
    expect(postAdd.command).toBe("mise x -- qmd update --path $DEV_MOUNT_PATH");
    expect(postAdd.reason).toBe("trusted_exact_rule");

    const postSync = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "post_sync",
      trustedScopes: sampleScopes,
    });
    expect(postSync.allowed).toBe(true);
    expect(postSync.command).toBe("mise x -- qmd index --incremental");
    expect(postSync.reason).toBe("trusted_exact_rule");
  });

  test("falls back to wildcard rule for repositories without exact match", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/auth",
      hookName: "post_add",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("echo 'generic post_add'");
    expect(result.reason).toBe("trusted_wildcard_rule");
  });

  test("falls back to global hook from dev.yaml when no scope rules match", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/unknown-repo",
      hookName: "post_sync",
      globalHook: "mise x -- qmd index --incremental",
      trustedScopes: [
        {
          provider: "azuredevops",
          tenant: "dev.azure.com",
          owner: "my-org",
          repos: ["unknown-repo"],
        },
      ],
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("mise x -- qmd index --incremental");
    expect(result.reason).toBe("trusted_global_hook");
  });

  test("blocks post_add / post_sync on untrusted repository without consent", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://github.com/untrusted-author/random-repo.git",
      hookName: "post_add",
      mountHook: "mise x -- qmd update --path $DEV_MOUNT_PATH",
      trustedScopes: sampleScopes,
      explicitConsent: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("untrusted_blocked");
  });

  test("allows post_add / post_sync on untrusted repository with explicit consent", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://github.com/untrusted-author/random-repo.git",
      hookName: "post_add",
      mountHook: "mise x -- qmd update --path $DEV_MOUNT_PATH",
      trustedScopes: sampleScopes,
      explicitConsent: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("mise x -- qmd update --path $DEV_MOUNT_PATH");
    expect(result.reason).toBe("explicit_consent");
  });

  test("returns no_hook_defined when no hook is configured", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-org/project/_git/payments",
      hookName: "non_existent_hook",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_hook_defined");
  });
});
