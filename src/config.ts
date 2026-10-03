import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml, { parseDocument, isMap, isScalar, isSeq, type YAMLMap } from "yaml";
import { z } from "zod";
import * as fs from "./fs.ts";
import { LabelError, type SourceSelector } from "./labels.ts";
import { getGlobalConfigPath, parseGlobalToml } from "./global.ts";
import { configFilePath, legacyConfigFilePath } from "./paths.ts";

export class ConfigError extends Error {
  readonly code = "INVALID_CONFIG";
  readonly details: { path: string };

  constructor(path: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.details = { path };
  }
}

export async function updateConfig(
  configPath: string,
  mutate: (doc: ReturnType<typeof yaml.parseDocument>) => void | Promise<void>,
): Promise<void> {
  await fs.withFileLock(configPath, async () => {
    let content: string;
    try {
      content = await fs.readText(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      content = "sync_strategy: ff-only\n";
    }
    const doc = yaml.parseDocument(content);
    if (doc.errors.length > 0) {
      throw new Error(doc.errors.map((error) => error.message).join("; "));
    }
    const before = String(doc);
    await mutate(doc);
    const after = String(doc);
    if (after !== before) await fs.writeTextAtomic(configPath, after);
  });
}

function findSourceNode(
  doc: ReturnType<typeof parseDocument>,
  selector: SourceSelector,
): YAMLMap | undefined {
  const seq = doc.get("sources");
  if (!isSeq(seq)) return undefined;
  const matches: YAMLMap[] = [];
  for (const item of seq.items) {
    if (!isMap(item) || item.get("url") !== selector.url) continue;
    if (selector.branch !== undefined && item.get("branch") !== selector.branch) continue;
    if (selector.pin !== undefined && item.get("pin") !== selector.pin) continue;
    if (selector.path !== undefined && item.get("path") !== selector.path) continue;
    matches.push(item);
  }
  const qualified =
    selector.branch !== undefined || selector.pin !== undefined || selector.path !== undefined;
  return qualified || matches.length === 1 ? matches[0] : undefined;
}

/** Inserts or updates a `sources:` entry for the URL. Mutates the caller's
 * parsed document in place (comments preserved); persistence happens inside
 * config.updateConfig(). Only url/branch are touched. */
export function upsertSourceDeclaration(
  doc: ReturnType<typeof parseDocument>,
  upsert: SourceSelector,
): { changed: boolean } {
  const existing = findSourceNode(doc, upsert);
  if (existing) {
    const before = String(existing);
    if (upsert.branch !== undefined) existing.set("branch", upsert.branch);
    if (upsert.pin !== undefined) existing.set("pin", upsert.pin);
    if (upsert.path !== undefined) existing.set("path", upsert.path);
    return { changed: String(existing) !== before };
  }
  const existingSeq = doc.get("sources");
  const seq = isSeq(existingSeq)
    ? existingSeq
    : (() => {
        const created = doc.createNode([]);
        doc.set("sources", created);
        return created;
      })();
  seq.add(doc.createNode(upsert));
  return { changed: true };
}

/** Sets (meta given) or removes (meta undefined) one label on a declared
 * source. Mutates the caller's parsed document in place; persistence happens
 * inside config.updateConfig(). Returns found: false when the source is not
 * declared. */
export function setSourceLabel(
  doc: ReturnType<typeof parseDocument>,
  selector: SourceSelector,
  label: string,
  meta: Record<string, unknown> | undefined,
): { changed: boolean; found: boolean } {
  const source = findSourceNode(doc, selector);
  if (!source) return { changed: false, found: false };

  const rawLabels = source.get("labels");
  const currentLabels: Record<string, unknown> =
    typeof rawLabels === "object" && rawLabels !== null
      ? ((rawLabels as { toJS(d: unknown): unknown }).toJS(doc) as Record<string, unknown>)
      : {};

  if (meta === undefined) {
    if (!(label in currentLabels)) return { changed: false, found: true };
    delete currentLabels[label];
  } else {
    if (label in currentLabels && isDeepStrictEqual(currentLabels[label], meta)) {
      return { changed: false, found: true };
    }
    currentLabels[label] = meta;
  }

  if (Object.keys(currentLabels).length === 0) {
    source.delete("labels");
  } else {
    source.set("labels", doc.createNode(currentLabels));
  }
  return { changed: true, found: true };
}

/**
 * Renames a label everywhere dev.yaml names it: on sources, as a label def key,
 * and as a workset member. Mutates the caller's document; persistence happens
 * inside config.updateConfig(). Refuses a target name already in use.
 */
export function renameLabel(
  doc: ReturnType<typeof parseDocument>,
  from: string,
  to: string,
): { sources: number; def: boolean; worksetMembers: number } {
  const renamed = { sources: 0, def: false, worksetMembers: 0 };
  const sources = doc.get("sources");
  if (isSeq(sources)) {
    for (const item of sources.items) {
      const itemLabels = isMap(item) ? item.get("labels") : undefined;
      if (!isMap(itemLabels) || !itemLabels.has(from)) continue;
      if (itemLabels.has(to)) {
        throw new LabelError("LABEL_VALIDATION", `A source already carries label '${to}'.`);
      }
      renameMapKey(itemLabels, from, to);
      renamed.sources += 1;
    }
  }
  const defs = doc.get("label_defs");
  if (isMap(defs) && defs.has(from)) {
    if (defs.has(to)) throw new LabelError("LABEL_VALIDATION", `label_defs already has '${to}'.`);
    renameMapKey(defs, from, to);
    renamed.def = true;
  }
  const worksets = doc.get("worksets");
  if (isMap(worksets)) {
    for (const pair of worksets.items) {
      const members = isMap(pair.value) ? pair.value.get("members") : undefined;
      if (!isSeq(members)) continue;
      for (const member of members.items) {
        if (isMap(member) && member.get("label") === from) {
          member.set("label", to);
          renamed.worksetMembers += 1;
        }
      }
    }
  }
  return renamed;
}

/** Renames a key in place, keeping its position, value, and comments. */
function renameMapKey(map: YAMLMap, from: string, to: string): void {
  const pair = map.items.find((candidate) => String(candidate.key) === from)!;
  pair.key = isScalar(pair.key) ? Object.assign(pair.key, { value: to }) : to;
}

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

// A member names one repository or one label; exactly one of `source` and `label`.
// A label member is strict: ref, path and setup belong to each declared source, not to the label.
// `setup: false` on a repository member opts that mount out of the workset's setup command.
export const WorksetMemberSchema = z.union([
  z.object({
    source: z.string().min(1),
    label: z.never().optional(),
    ref: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    setup: z.union([z.string().min(1), z.literal(false)]).optional(),
    reason: z.string().min(1).optional(),
  }),
  z.strictObject({
    label: z.string().min(1),
    source: z.never().optional(),
    setup: z.never().optional(),
    reason: z.string().min(1).optional(),
  }),
]);

export const WorksetDefinitionSchema = z.object({
  description: z.string().optional(),
  /** Command run once in every mount after a workspace from this workset is created. */
  setup: z.string().min(1).optional(),
  members: z.array(WorksetMemberSchema).min(1),
});

export type WorksetMember = z.infer<typeof WorksetMemberSchema>;
export type WorksetDefinition = z.infer<typeof WorksetDefinitionSchema>;

export interface RuntimeConfig {
  root: string;
  rootSource: RootSource;
  configPath?: string;
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
  worksets: Record<string, WorksetDefinition>;
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
  worksets: z.record(z.string(), WorksetDefinitionSchema).optional(),
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

function resolveConfiguredPath(path: string, base?: string): string {
  if (isAbsolute(path) || win32.isAbsolute(path)) return path;
  return base ? resolve(base, path) : resolve(path);
}

export function findUpConfig(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const yamlPath = configFilePath({ root: current });
    if (existsSync(yamlPath)) return current;
    const tomlPath = legacyConfigFilePath({ root: current });
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
      const globalTomlPath = getGlobalConfigPath(home);
      let globalRoot: string | undefined;
      if (existsSync(globalTomlPath)) {
        const content = readFileSync(globalTomlPath, "utf8");
        const globalConfig = parseGlobalToml(content, globalTomlPath);
        if (globalConfig.default_root && globalConfig.roots[globalConfig.default_root]) {
          globalRoot = globalConfig.roots[globalConfig.default_root].path;
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
  const yamlPath = configFilePath({ root });
  const tomlPath = legacyConfigFilePath({ root });
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        configPath,
        `Failed to parse configuration file at ${configPath}: ${message}`,
      );
    }
  }

  const parsed = RawConfigFileSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new ConfigError(
      configPath ?? yamlPath,
      `Invalid configuration in ${configPath}: ${details}`,
    );
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
    worksets: configData.worksets ?? {},
    plugins: configData.plugins ?? {},
    tokens: {
      azureDevOps: adoToken,
      github: ghToken,
    },
  };
}
