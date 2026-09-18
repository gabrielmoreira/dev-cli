import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as fs from "./fs.ts";

export interface GlobalRootEntry {
  path: string;
}

export interface GlobalConfig {
  default_root?: string;
  roots: Record<string, GlobalRootEntry>;
}

export class GlobalRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalRootError";
  }
}

export function getGlobalConfigPath(homeDir?: string): string {
  const home = homeDir || process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, ".dev.toml");
}

export function parseGlobalToml(content: string): GlobalConfig {
  const config: GlobalConfig = {
    roots: {},
  };

  if (!content || !content.trim()) {
    return config;
  }

  const lines = content.split(/\r?\n/);
  let currentSection: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1).trim();
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (!currentSection) {
      if (key === "default_root") {
        config.default_root = val;
      }
    } else if (currentSection.startsWith("roots.")) {
      const alias = currentSection.slice("roots.".length).trim();
      if (!config.roots[alias]) {
        config.roots[alias] = { path: "" };
      }
      if (key === "path") {
        config.roots[alias].path = val;
      }
    }
  }

  return config;
}

export function serializeGlobalToml(config: GlobalConfig): string {
  const lines: string[] = [];

  if (config.default_root) {
    lines.push(`default_root = "${config.default_root}"`);
    lines.push("");
  }

  const aliases = Object.keys(config.roots || {}).sort();
  for (const alias of aliases) {
    const entry = config.roots[alias];
    lines.push(`[roots.${alias}]`);
    lines.push(`path = "${(entry.path || "").replace(/\\/g, "/")}"`);
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
  return parseGlobalToml(content);
}

export async function saveGlobalConfig(config: GlobalConfig, configPath?: string): Promise<void> {
  const targetPath = resolve(configPath || getGlobalConfigPath());
  const content = serializeGlobalToml(config);
  await fs.writeText(targetPath, content);
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
