import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig, type RuntimeConfig } from "../config.ts";
import * as fs from "../fs.ts";
import * as shell from "../shell.ts";
import { ui } from "../ui.ts";
import { detectWorkspaceFromCwd } from "../ws.ts";
import type {
  Integration,
  IntegrationEventName,
  IntegrationEvents,
  IntegrationFactory,
  PluginBase,
} from "./events.ts";
import { qmdFactory } from "./qmd.ts";

export type {
  Integration,
  IntegrationEventName,
  IntegrationEvents,
  IntegrationFactory,
  PluginBase,
} from "./events.ts";

/** Built-in plugins, in execution order. Adding one = a file in src/plugins/
 * plus an entry here. Configured external modules load lazily alongside these
 * factories when hooks are dispatched; built-ins win name collisions. */
export const builtinFactories: IntegrationFactory[] = [qmdFactory];

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

/** Builds integrations from built-in factories. Cheap: a factory returns an
 * object; no external process is spawned until run()/hooks execute. */
export function buildIntegrations(base: PluginBase): Integration[] {
  return builtinFactories.map((factory) => factory(base));
}

/** Loads only external factories explicitly configured for this root. */
export async function loadIntegrations(base: PluginBase): Promise<Integration[]> {
  const integrations = buildIntegrations(base);
  for (const [name, config] of Object.entries(base.config.plugins)) {
    if (typeof config.module !== "string") continue;
    if (integrations.some((integration) => integration.name === name)) {
      ui.warn(`Plugin '${name}' external module skipped: a built-in owns this name`);
      continue;
    }
    try {
      const factory: unknown = (await import(pathToFileURL(resolve(base.root, config.module)).href))
        .default;
      if (typeof factory !== "function") {
        ui.warn(`Plugin '${name}' module must default-export an integration factory`);
        continue;
      }
      const integration = (factory as IntegrationFactory)(base);
      if (integration.name !== name) {
        ui.warn(`Plugin '${name}' factory must return an integration named '${name}'`);
        continue;
      }
      integrations.push(integration);
    } catch (error) {
      ui.warn(
        `Plugin '${name}' failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return integrations;
}

/** Emits one event to every built-in or configured external integration hook.
 * Hook failure is surfaced as a warning and never blocks the caller. */
export async function emit<E extends IntegrationEventName>(
  base: PluginBase,
  event: E,
  data: IntegrationEvents[E],
): Promise<void> {
  for (const integration of await loadIntegrations(base)) {
    const hook = integration.hooks?.[event];
    if (!hook) continue;
    try {
      await hook(base, data);
    } catch (error) {
      ui.warn(
        `Plugin '${integration.name}' hook '${event}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
