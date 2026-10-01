import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig, type RuntimeConfig } from "../config.ts";
import * as fs from "../fs.ts";
import * as shell from "../shell.ts";
import { ui } from "../ui.ts";
import { detectWorkspaceFromCwd } from "../ws.ts";
import type { Plugin, PluginEventName, PluginEvents, PluginFactory, PluginBase } from "./events.ts";
import { qmdFactory } from "./qmd.ts";

export type { Plugin, PluginEventName, PluginEvents, PluginFactory, PluginBase } from "./events.ts";

/** Built-in plugins, in execution order. Adding one = a file in src/plugins/
 * plus an entry here. Configured external modules load lazily alongside these
 * factories when hooks are dispatched; built-ins win name collisions. */
export const builtinFactories: PluginFactory[] = [qmdFactory];

/** Builds the plugin base from the invocation environment. */
export function createPluginBase(root: string, config?: RuntimeConfig): PluginBase {
  return {
    root,
    config: config ?? resolveConfig({ cwd: root, env: process.env }),
    workspace: detectWorkspaceFromCwd(process.cwd(), root) ?? null,
    ui,
    fs,
    shell,
  };
}

/** Builds plugins from built-in factories. Cheap: a factory returns an
 * object; no external process is spawned until run()/hooks execute. */
export function buildPlugins(base: PluginBase): Plugin[] {
  return builtinFactories.map((factory) => factory(base));
}

/** Loads only external factories explicitly configured for this root. */
export async function loadPlugins(base: PluginBase): Promise<Plugin[]> {
  const plugins = buildPlugins(base);
  for (const [name, config] of Object.entries(base.config.plugins)) {
    if (typeof config.module !== "string") continue;
    if (plugins.some((plugin) => plugin.name === name)) {
      ui.warn(`Plugin '${name}' external module skipped: a built-in owns this name`);
      continue;
    }
    try {
      const factory: unknown = (await import(pathToFileURL(resolve(base.root, config.module)).href))
        .default;
      if (typeof factory !== "function") {
        ui.warn(`Plugin '${name}' module must default-export a plugin factory`);
        continue;
      }
      const plugin = (factory as PluginFactory)(base);
      if (plugin.name !== name) {
        ui.warn(`Plugin '${name}' factory must return a plugin named '${name}'`);
        continue;
      }
      plugins.push(plugin);
    } catch (error) {
      ui.warn(
        `Plugin '${name}' failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return plugins;
}

/** Emits one event to every built-in or configured external plugin hook.
 * Hook failure is surfaced as a warning and never blocks the caller. */
export async function emit<E extends PluginEventName>(
  base: PluginBase,
  event: E,
  data: PluginEvents[E],
): Promise<void> {
  for (const plugin of await loadPlugins(base)) {
    const hook = plugin.hooks?.[event];
    if (!hook) continue;
    try {
      await hook(base, data);
    } catch (error) {
      ui.warn(
        `Plugin '${plugin.name}' hook '${event}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
