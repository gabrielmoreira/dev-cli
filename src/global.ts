import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import * as fs from "./fs.ts";

export interface GlobalRootEntry {
  path: string;
}

export interface GlobalConfig {
  default_root?: string;
  roots: Record<string, GlobalRootEntry>;
}

const globalConfigSchema = z.object({
  default_root: z.string().optional(),
  roots: z.record(z.string(), z.object({ path: z.string() })).default({}),
});

export class GlobalRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalRootError";
  }
}

class GlobalTomlError extends Error {
  readonly code = "INVALID_GLOBAL_TOML";
  readonly details: { path: string };

  constructor(path: string, cause: unknown) {
    super(
      `Invalid TOML syntax or registry structure in global root registry at ${path}. Windows paths need forward slashes or valid TOML escaping.`,
      { cause },
    );
    this.name = "GlobalTomlError";
    this.details = { path };
  }
}

export function getGlobalConfigPath(homeDir?: string): string {
  const home = homeDir || process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, ".dev.toml");
}

export function parseGlobalToml(content: string, configPath = "~/.dev.toml"): GlobalConfig {
  try {
    return globalConfigSchema.parse(Bun.TOML.parse(content));
  } catch (cause) {
    throw new GlobalTomlError(configPath, cause);
  }
}

export function serializeGlobalToml(config: GlobalConfig): string {
  const lines: string[] = [];

  if (config.default_root) {
    lines.push(`default_root = ${JSON.stringify(config.default_root)}`);
    lines.push("");
  }

  const aliases = Object.keys(config.roots || {}).sort();
  for (const alias of aliases) {
    const entry = config.roots[alias];
    lines.push(`[roots.${JSON.stringify(alias)}]`);
    lines.push(`path = ${JSON.stringify((entry.path || "").replace(/\\/g, "/"))}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function loadGlobalConfig(configPath?: string): Promise<GlobalConfig> {
  const targetPath = resolve(configPath || getGlobalConfigPath());
  if (!fs.exists(targetPath)) {
    return { roots: {} };
  }

  const content = await fs.readText(targetPath);
  return parseGlobalToml(content, targetPath);
}

export async function saveGlobalConfig(config: GlobalConfig, configPath?: string): Promise<void> {
  const targetPath = resolve(configPath || getGlobalConfigPath());
  const content = serializeGlobalToml(config);
  await fs.writeTextAtomic(targetPath, content);
}

export function registerGlobalRoot(
  config: GlobalConfig,
  input: { alias: string; path: string; makeDefault?: boolean; force?: boolean },
): GlobalRootEntry {
  const existing = config.roots[input.alias];
  if (existing && resolve(existing.path) !== resolve(input.path) && !input.force) {
    throw new GlobalRootError(
      `Root alias '${input.alias}' already points to '${existing.path}'. Use --force to replace it.`,
    );
  }
  const entry = { path: resolve(input.path).replace(/\\/g, "/") };
  config.roots[input.alias] = entry;
  if (input.makeDefault) config.default_root = input.alias;
  return entry;
}

export function unregisterGlobalRoot(
  config: GlobalConfig,
  aliasOrPath: string,
): { alias: string; path: string; wasDefault: boolean } {
  const resolvedTarget = resolve(aliasOrPath);
  const alias = Object.hasOwn(config.roots, aliasOrPath)
    ? aliasOrPath
    : Object.entries(config.roots).find(([, entry]) => resolve(entry.path) === resolvedTarget)?.[0];
  if (!alias) throw new GlobalRootError(`Registered root '${aliasOrPath}' was not found.`);

  const path = config.roots[alias].path;
  const wasDefault = config.default_root === alias;
  delete config.roots[alias];
  if (wasDefault) config.default_root = undefined;
  return { alias, path, wasDefault };
}

export function resolveRootFromGlobal(aliasOrPath: string, config: GlobalConfig): string {
  if (config.roots && config.roots[aliasOrPath]) {
    return config.roots[aliasOrPath].path;
  }
  return aliasOrPath;
}
