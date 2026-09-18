import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import yaml from "yaml";
import { z } from "zod";

export const CONFIG_FILE_NAME = "dev.yaml";
import { parseGlobalToml } from "./global.ts";

export type RootSource = "flag" | "env" | "file" | "global" | "default";

export interface ResolveConfigOptions {
  rootFlag?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export const ConfigDefaultsSchema = z.object({
  workspacePrefix: z.string().default("ws/"),
  canonicalPrefix: z.string().default("mirrors/"),
  autoFetchInterval: z.string().optional(),
});

export const AzureDevOpsConfigSchema = z.object({
  organization: z.string().optional(),
  project: z.string().optional(),
  token: z.string().optional(),
});

export const GitHubConfigSchema = z.object({
  owner: z.string().optional(),
  token: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const TrustedScopeRuleSchema = z.object({
  match: z.string().default("*"),
  hooks: z
    .object({
      pre_checkout: z.string().optional(),
      post_checkout: z.string().optional(),
      post_add: z.string().optional(),
      post_sync: z.string().optional(),
    })
    .optional(),
});

export const TrustedScopeSchema = z.object({
  provider: z.string(),
  tenant: z.string(),
  owner: z.string(),
  repos: z.array(z.string()).default([]),
  install: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  rules: z.array(TrustedScopeRuleSchema).optional(),
});

export const GlobalHooksSchema = z.object({
  post_add: z.string().optional(),
  post_sync: z.string().optional(),
  pre_checkout: z.string().optional(),
  post_checkout: z.string().optional(),
});

export const AzureDevOpsProviderSchema = z.object({
  id: z.string(),
  type: z.literal("azure_devops"),
  organization: z.string(),
  project: z.string().optional(),
});

export const GitHubProviderSchema = z.object({
  id: z.string(),
  type: z.literal("github"),
  owner: z.string(),
});

export const ProviderConfigSchema = z.discriminatedUnion("type", [
  AzureDevOpsProviderSchema,
  GitHubProviderSchema,
]);

export type ConfigDefaults = z.infer<typeof ConfigDefaultsSchema>;
export type AzureDevOpsConfig = z.infer<typeof AzureDevOpsConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type TrustedScopeRule = z.infer<typeof TrustedScopeRuleSchema>;
export type TrustedScope = z.infer<typeof TrustedScopeSchema>;
export type GlobalHooksConfig = z.infer<typeof GlobalHooksSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface RuntimeConfig {
  root: string;
  rootSource: RootSource;
  configPath?: string;
  /** Parsed dev.yaml document (AST-preserving); undefined for dev.toml roots. */
  configDoc?: ReturnType<typeof yaml.parseDocument>;
  /** Persists the current configDoc back to configPath. No-op without dev.yaml. */
  writeConfig?: () => void;
  workspacePrefix: string;
  canonicalPrefix: string;
  defaults: ConfigDefaults;
  azureDevOps: AzureDevOpsConfig;
  github: GitHubConfig;
  trustedScopes: TrustedScope[];
  hooks: GlobalHooksConfig;
  providers: ProviderConfig[];
  labelDefs: Record<string, Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  plugins: Record<string, Record<string, unknown>>;
  tokens: {
    azureDevOps?: string;
    github?: string;
  };
}

const RawDefaultsSchema = z
  .object({
    workspace_prefix: z.string().optional(),
    workspacePrefix: z.string().optional(),
    canonical_prefix: z.string().optional(),
    canonicalPrefix: z.string().optional(),
    auto_fetch_interval: z.string().optional(),
    autoFetchInterval: z.string().optional(),
  })
  .transform((val) => ({
    workspacePrefix: val.workspace_prefix || val.workspacePrefix || "ws/",
    canonicalPrefix: val.canonical_prefix || val.canonicalPrefix || "mirrors/",
    autoFetchInterval: val.auto_fetch_interval || val.autoFetchInterval,
  }));

const RawAdoSchema = z
  .object({
    organization: z.string().optional(),
    project: z.string().optional(),
    token: z.string().optional(),
    pat: z.string().optional(),
  })
  .transform((val) => ({
    organization: val.organization,
    project: val.project,
    token: val.token || val.pat,
  }));

const RawGithubSchema = z
  .object({
    owner: z.string().optional(),
    token: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .transform((val) => ({
    owner: val.owner,
    token: val.token,
    enabled: val.enabled !== false,
  }));

const RawRuleSchema = z.object({
  match: z.string().default("*"),
  hooks: z
    .object({
      pre_checkout: z.string().optional(),
      post_checkout: z.string().optional(),
      post_add: z.string().optional(),
      post_sync: z.string().optional(),
    })
    .optional(),
});

const RawTrustedScopeSchema = z
  .object({
    provider: z.string().default(""),
    tenant: z.string().default(""),
    owner: z.string().default(""),
    repos: z
      .array(z.any())
      .optional()
      .transform((r) => (r ? r.map(String) : [])),
    install: z.boolean().optional(),
    allowed_tools: z
      .array(z.any())
      .optional()
      .transform((t) => (t ? t.map(String) : undefined)),
    allowedTools: z
      .array(z.any())
      .optional()
      .transform((t) => (t ? t.map(String) : undefined)),
    rules: z.array(RawRuleSchema).optional(),
  })
  .transform((val) => ({
    provider: val.provider,
    tenant: val.tenant,
    owner: val.owner,
    repos: val.repos,
    install: val.install,
    allowedTools: val.allowed_tools || val.allowedTools,
    rules: val.rules,
  }));

const RawHooksSchema = z.object({
  post_add: z.string().optional(),
  post_sync: z.string().optional(),
  pre_checkout: z.string().optional(),
  post_checkout: z.string().optional(),
});

export const RawConfigFileSchema = z.object({
  version: z.number().optional(),
  defaults: RawDefaultsSchema.optional(),
  azure_devops: RawAdoSchema.optional(),
  azureDevOps: RawAdoSchema.optional(),
  github: RawGithubSchema.optional(),
  trusted_scopes: z.array(RawTrustedScopeSchema).optional(),
  trustedScopes: z.array(RawTrustedScopeSchema).optional(),
  hooks: RawHooksSchema.optional(),
  providers: z.array(ProviderConfigSchema).optional(),
  label_defs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  labelDefs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  sources: z.array(z.record(z.string(), z.unknown())).optional(),
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

function resolveConfiguredPath(path: string, base?: string): string {
  if (isAbsolute(path) || win32.isAbsolute(path)) return path;
  return base ? resolve(base, path) : resolve(path);
}

export function findUpConfig(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const yamlPath = join(current, CONFIG_FILE_NAME);
    if (existsSync(yamlPath)) return current;
    const tomlPath = join(current, "dev.toml");
    if (existsSync(tomlPath)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export const findUpwardDevRoot = findUpConfig;

export function resolveConfig(options: ResolveConfigOptions): RuntimeConfig {
  let root: string;
  let rootSource: RootSource;

  if (options.rootFlag && options.rootFlag.trim().length > 0) {
    root = resolveConfiguredPath(options.rootFlag.trim(), options.cwd);
    rootSource = "flag";
  } else {
    const found = findUpConfig(options.cwd);
    if (found) {
      root = found;
      rootSource = "file";
    } else if (options.env.DEV_ROOT && options.env.DEV_ROOT.trim().length > 0) {
      root = resolveConfiguredPath(options.env.DEV_ROOT.trim());
      rootSource = "env";
    } else {
      const home = options.env.HOME || options.env.USERPROFILE || homedir();
      const globalTomlPath = join(home, ".dev.toml");
      let globalRoot: string | undefined;
      if (existsSync(globalTomlPath)) {
        try {
          const content = readFileSync(globalTomlPath, "utf8");
          const globalConfig = parseGlobalToml(content);
          if (globalConfig.default_root && globalConfig.roots[globalConfig.default_root]) {
            globalRoot = globalConfig.roots[globalConfig.default_root].path;
          }
        } catch {
          // ignore error parsing ~/.dev.toml
        }
      }

      if (globalRoot) {
        root = resolveConfiguredPath(globalRoot);
        rootSource = "global";
      } else {
        root = resolve(home, "dev");
        rootSource = "default";
      }
    }
  }

  let configPath: string | undefined;
  const yamlPath = join(root, CONFIG_FILE_NAME);
  const tomlPath = join(root, "dev.toml");
  if (existsSync(yamlPath)) {
    configPath = yamlPath;
  } else if (existsSync(tomlPath)) {
    configPath = tomlPath;
  }

  let rawConfig: Record<string, unknown> = {};
  let configDoc: ReturnType<typeof yaml.parseDocument> | undefined;
  if (configPath) {
    try {
      const content = readFileSync(configPath, "utf8");
      if (configPath.endsWith(".toml")) {
        rawConfig = (Bun.TOML.parse(content) as Record<string, unknown>) || {};
      } else {
        configDoc = yaml.parseDocument(content);
        if (configDoc.errors.length > 0) {
          throw new Error(configDoc.errors.map((e) => e.message).join("; "));
        }
        rawConfig = (configDoc.toJS() as Record<string, unknown>) || {};
      }
    } catch (e: any) {
      throw new Error(`Failed to parse configuration file at ${configPath}: ${e.message}`);
    }
  }

  const parsed = RawConfigFileSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid configuration in ${configPath}: ${details}`);
  }

  const configData = parsed.data;
  const defaults: ConfigDefaults = configData.defaults ?? {
    workspacePrefix: "ws/",
    canonicalPrefix: "mirrors/",
    autoFetchInterval: undefined,
  };

  const azureDevOps: AzureDevOpsConfig = configData.azure_devops ?? configData.azureDevOps ?? {};
  const github: GitHubConfig = configData.github ?? { enabled: true };
  const trustedScopes: TrustedScope[] = configData.trusted_scopes ?? configData.trustedScopes ?? [];
  const hooks: GlobalHooksConfig = configData.hooks ?? {};

  const providers: ProviderConfig[] = [...(configData.providers ?? [])];

  if (providers.length === 0) {
    if (azureDevOps.organization) {
      providers.push({
        id: "default-ado",
        type: "azure_devops",
        organization: azureDevOps.organization,
        project: azureDevOps.project,
      });
    }
    if (github.owner) {
      providers.push({
        id: "default-github",
        type: "github",
        owner: github.owner,
      });
    }
  }

  const adoToken = options.env.AZURE_DEVOPS_PAT?.trim() || azureDevOps.token?.trim() || undefined;
  const ghToken =
    options.env.GITHUB_TOKEN?.trim() ||
    options.env.GH_TOKEN?.trim() ||
    github.token?.trim() ||
    undefined;

  return {
    root,
    rootSource,
    configPath,
    configDoc,
    writeConfig: configDoc
      ? () => {
          if (!configPath) return;
          writeFileSync(configPath, String(configDoc));
        }
      : undefined,
    workspacePrefix: defaults.workspacePrefix.replace(/\/+$/, ""),
    canonicalPrefix: defaults.canonicalPrefix.replace(/\/+$/, ""),
    defaults,
    azureDevOps,
    github,
    trustedScopes,
    hooks,
    providers,
    labelDefs: configData.label_defs ?? configData.labelDefs ?? {},
    sources: configData.sources ?? [],
    plugins: configData.plugins ?? {},
    tokens: {
      azureDevOps: adoToken,
      github: ghToken,
    },
  };
}
