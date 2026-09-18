import type { TrustedScope } from "./config.ts";

export interface SourceIdentity {
  provider: string;
  tenant: string;
  owner: string;
  repo: string;
}

export interface EvaluateTrustOptions {
  sourceUrl: string;
  trustedScopes?: TrustedScope[];
}

export interface TrustDecision {
  isTrusted: boolean;
  matchedScope?: TrustedScope;
  identity: SourceIdentity;
}

export interface ResolveHookExecutionOptions {
  sourceUrl: string;
  hookName: "pre_checkout" | "post_checkout" | "post_add" | "post_sync" | string;
  mountHook?: string;
  globalHook?: string;
  trustedScopes?: TrustedScope[];
  explicitConsent?: boolean;
}

export interface HookExecutionResolution {
  allowed: boolean;
  command?: string;
  reason: string;
}

export function parseSourceIdentity(url: string): SourceIdentity {
  let cleaned = url.trim().replace(/\\/g, "/");

  // Strip file:// scheme
  cleaned = cleaned.replace(/^file:\/\//i, "");

  // Check for local file path: Windows drive (e.g. C:/) or absolute Unix path (e.g. /tmp/...)
  const isLocalWindows = /^[a-zA-Z]:\//.test(cleaned);
  const isLocalUnix = cleaned.startsWith("/");

  if (isLocalWindows || isLocalUnix) {
    cleaned = cleaned.replace(/\.git$/, "").replace(/\/+$/, "");
    const segments = cleaned.split("/").filter(Boolean);
    const repo = segments[segments.length - 1] || "repo";
    return {
      provider: "local",
      tenant: "local",
      owner: "local",
      repo,
    };
  }

  // Strip ssh git@
  if (cleaned.startsWith("git@")) {
    cleaned = cleaned.replace(/^git@([^:]+):/, "$1/");
  } else {
    cleaned = cleaned.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@/]+@/i, "");
    cleaned = cleaned.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i, "");
  }

  // Strip userinfo
  cleaned = cleaned.replace(/^[^@/]+@/, "");

  // Strip port
  cleaned = cleaned.replace(/^([^/:]+):\d+/, "$1");

  // Strip trailing .git and slashes
  cleaned = cleaned.replace(/\.git$/, "").replace(/\/+$/, "");

  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length === 0) {
    return {
      provider: "unknown",
      tenant: "unknown",
      owner: "unknown",
      repo: "unknown",
    };
  }

  const host = segments[0].toLowerCase();

  // Azure DevOps patterns:
  // dev.azure.com/<org>/<project>/_git/<repo>
  // dev.azure.com/<org>/_git/<repo>
  // <org>.visualstudio.com/<project>/_git/<repo>
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const isVs = host.endsWith(".visualstudio.com");
    const tenant = isVs ? host : "dev.azure.com";
    const owner = isVs ? host.replace(/\.visualstudio\.com$/, "") : segments[1] || "unknown";

    const filtered = segments.slice(isVs ? 1 : 2).filter((s) => s !== "_git");
    const repo = filtered[filtered.length - 1] || "unknown";

    return {
      provider: "azure_devops",
      tenant,
      owner,
      repo,
    };
  }

  // GitHub patterns:
  // github.com/<owner>/<repo>
  if (host === "github.com") {
    const owner = segments[1] || "unknown";
    const repo = segments[2] || "unknown";
    return {
      provider: "github",
      tenant: "github.com",
      owner,
      repo,
    };
  }

  // Generic git host: host/<owner>/.../<repo>
  const owner = segments.length > 2 ? segments[1] : segments[0] || "unknown";
  const repo = segments[segments.length - 1] || "unknown";
  return {
    provider: host,
    tenant: host,
    owner,
    repo,
  };
}

export function evaluateTrust(options: EvaluateTrustOptions): TrustDecision {
  const identity = parseSourceIdentity(options.sourceUrl);
  const scopes = options.trustedScopes || [];

  for (const scope of scopes) {
    const normScopeProv = scope.provider.toLowerCase().replace(/[-_]/g, "");
    const normIdProv = identity.provider.toLowerCase().replace(/[-_]/g, "");
    const providerMatch = normScopeProv === normIdProv;
    const tenantMatch = scope.tenant.toLowerCase() === identity.tenant.toLowerCase();
    const ownerMatch = scope.owner.toLowerCase() === identity.owner.toLowerCase();

    if (providerMatch && tenantMatch && ownerMatch) {
      const repoMatch =
        scope.repos.includes("*") ||
        scope.repos.some((r) => r.toLowerCase() === identity.repo.toLowerCase());

      if (repoMatch) {
        return {
          isTrusted: true,
          matchedScope: scope,
          identity,
        };
      }
    }
  }

  return {
    isTrusted: false,
    matchedScope: undefined,
    identity,
  };
}

export function resolveHookExecution(
  options: ResolveHookExecutionOptions,
): HookExecutionResolution {
  const trust = evaluateTrust({
    sourceUrl: options.sourceUrl,
    trustedScopes: options.trustedScopes,
  });

  if (!trust.isTrusted) {
    const candidateHook = options.mountHook || options.globalHook;
    if (!candidateHook) {
      return {
        allowed: false,
        reason: "no_hook_defined",
      };
    }

    if (options.explicitConsent) {
      return {
        allowed: true,
        command: candidateHook,
        reason: "explicit_consent",
      };
    }

    return {
      allowed: false,
      reason: "untrusted_blocked",
    };
  }

  // Trusted repository
  // 1st precedence: mount override in ws.md
  if (options.mountHook) {
    return {
      allowed: true,
      command: options.mountHook,
      reason: "trusted_mount_override",
    };
  }

  // 2nd precedence: exact repository rule in matched scope
  const rules = trust.matchedScope?.rules || [];
  const exactRule = rules.find((r) => r.match.toLowerCase() === trust.identity.repo.toLowerCase());
  const hookKey = options.hookName as "pre_checkout" | "post_checkout" | "post_add" | "post_sync";

  if (exactRule?.hooks?.[hookKey]) {
    return {
      allowed: true,
      command: exactRule.hooks[hookKey],
      reason: "trusted_exact_rule",
    };
  }

  // 3rd precedence: wildcard scope rule
  const wildcardRule = rules.find((r) => r.match === "*");
  if (wildcardRule?.hooks?.[hookKey]) {
    return {
      allowed: true,
      command: wildcardRule.hooks[hookKey],
      reason: "trusted_wildcard_rule",
    };
  }

  // 4th precedence: global hook from dev.yaml
  if (options.globalHook) {
    return {
      allowed: true,
      command: options.globalHook,
      reason: "trusted_global_hook",
    };
  }

  return {
    allowed: false,
    reason: "no_hook_defined",
  };
}

export function isToolAllowed(scope: TrustedScope, tool: string): boolean {
  if (scope.install !== true) {
    return false;
  }
  const allowed = scope.allowedTools || [];
  return allowed.some((t) => t.toLowerCase() === tool.toLowerCase());
}
