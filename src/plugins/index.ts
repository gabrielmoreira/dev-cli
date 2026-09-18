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

export type {
  Integration,
  IntegrationEventName,
  IntegrationEvents,
  IntegrationFactory,
  PluginBase,
} from "./events.ts";

/** Built-in plugins, in execution order. Adding one = a file in src/plugins/
 * plus an entry here. External plugins (plugins.<name>.module) load lazily at
 * dispatch and never appear in this list. */
export const builtinFactories: IntegrationFactory[] = [];

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

/** Emits one event to every built-in integration hook registered for it.
 * Hook failure is surfaced as a warning and never blocks the caller. */
export async function emit<E extends IntegrationEventName>(
  base: PluginBase,
  event: E,
  data: IntegrationEvents[E],
): Promise<void> {
  for (const integration of buildIntegrations(base)) {
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
