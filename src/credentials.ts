import * as shell from "./shell.ts";
import type { RuntimeConfig } from "./config.ts";

export class CredentialError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface AzureDevOpsCredential {
  kind: "pat" | "bearer";
  token: string;
  source: "config" | "azure_cli";
}

export interface GitHubCredential {
  kind: "token";
  token: string;
  source: "config" | "github_cli";
}

export interface CredentialDeps {
  shell: typeof shell;
}

export const defaultDeps: CredentialDeps = {
  shell,
};

export async function resolveAzureDevOpsCredential(
  config: RuntimeConfig,
  deps: CredentialDeps = defaultDeps,
): Promise<AzureDevOpsCredential> {
  // 1. Configured / runtime token
  const token = config.tokens.azureDevOps || config.azureDevOps.token;
  if (token && token.trim().length > 0) {
    return {
      kind: "pat",
      token: token.trim(),
      source: "config",
    };
  }

  // 2. Azure CLI session fallback
  try {
    const res = await deps.shell.runCommand("az", [
      "account",
      "get-access-token",
      "--resource",
      "499b84ac-1321-427f-aa17-267ca6975798",
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ]);
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      return {
        kind: "bearer",
        token: res.stdout.trim(),
        source: "azure_cli",
      };
    }
  } catch {}

  throw new CredentialError(
    "CREDENTIAL_NOT_AVAILABLE",
    "Azure DevOps credentials not available. Configure AZURE_DEVOPS_PAT or authenticate via 'az login'.",
  );
}

export async function resolveGitHubCredential(
  config: RuntimeConfig,
  deps: CredentialDeps = defaultDeps,
): Promise<GitHubCredential> {
  // 1. Configured / runtime token
  const token = config.tokens.github || config.github.token;
  if (token && token.trim().length > 0) {
    return {
      kind: "token",
      token: token.trim(),
      source: "config",
    };
  }

  // 2. GitHub CLI session fallback
  try {
    const res = await deps.shell.runCommand("gh", ["auth", "token"]);
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      return {
        kind: "token",
        token: res.stdout.trim(),
        source: "github_cli",
      };
    }
  } catch {}

  throw new CredentialError(
    "CREDENTIAL_NOT_AVAILABLE",
    "GitHub credentials not available. Configure GITHUB_TOKEN or authenticate via 'gh auth login'.",
  );
}

export function getAuthorizationHeader(
  credential: AzureDevOpsCredential | GitHubCredential,
): string {
  if ("kind" in credential && credential.kind === "bearer") {
    return `Bearer ${credential.token}`;
  }
  if ("kind" in credential && credential.kind === "pat") {
    const basic = Buffer.from(`:${credential.token}`).toString("base64");
    return `Basic ${basic}`;
  }
  return `Bearer ${credential.token}`;
}

export function getGitExtraHeader(credential: AzureDevOpsCredential | GitHubCredential): string {
  const auth = getAuthorizationHeader(credential);
  return `http.extraheader=AUTHORIZATION: ${auth}`;
}

function azureDevOpsOrganization(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    if (host === "dev.azure.com") {
      return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    }
    if (host.endsWith(".visualstudio.com")) {
      return host.slice(0, -".visualstudio.com".length);
    }
  } catch {}

  return /^[a-z0-9._-]+$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function sourceAzureDevOpsOrganization(source: string): string | undefined {
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    if (host === "dev.azure.com") {
      return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    }
    if (host.endsWith(".visualstudio.com")) {
      return host.slice(0, -".visualstudio.com".length);
    }
  } catch {}
  return undefined;
}

export async function resolveExtraHeader(
  config: RuntimeConfig,
  urlOrSource: string,
): Promise<string | undefined> {
  const sourceOrganization = sourceAzureDevOpsOrganization(urlOrSource);
  if (!sourceOrganization) return undefined;
  const configuredOrganizations = [
    ...config.providers
      .filter((provider) => provider.type === "azure_devops")
      .map((provider) => provider.organization),
    ...(config.azureDevOps.organization ? [config.azureDevOps.organization] : []),
  ]
    .map(azureDevOpsOrganization)
    .filter((organization): organization is string => Boolean(organization));
  if (!configuredOrganizations.includes(sourceOrganization)) return undefined;
  try {
    const cred = await resolveAzureDevOpsCredential(config);
    return getGitExtraHeader(cred);
  } catch {
    return undefined;
  }
}
