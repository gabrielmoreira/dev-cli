import type { RuntimeConfig } from "../config.ts";
import type * as fs from "../fs.ts";
import type * as shell from "../shell.ts";
import type { ui } from "../ui.ts";

/** Event map for plugin hooks. A stage exists only once a core emit() call
 * site produces it. After-only by design: no veto, no wildcards, no
 * priorities. Hook failure is a warning, never a blocker. */
export interface IntegrationEvents {
  "mirror:sync:after": {
    root: string;
    updated: Array<{ sourceKey: string; revision: string }>;
  };
  "label:add:after": {
    root: string;
    sourceKey: string;
    label: string;
    meta: Record<string, unknown>;
  };
  "label:rm:after": {
    root: string;
    sourceKey: string;
    label: string;
  };
}

export type IntegrationEventName = keyof IntegrationEvents;

/** Context handed to plugin factories once per invocation. Config is per-run,
 * exactly like core commands; plugins own their config slice
 * (`plugins.<name>` in dev.yaml), their metadata keys, and their tool. */
export interface PluginBase {
  root: string;
  config: RuntimeConfig;
  /** Active workspace name resolved from cwd, if any. */
  workspace: string | null;
  ui: typeof ui;
  fs: typeof fs;
  shell: typeof shell;
}

export interface Integration {
  name: string;
  run(args: Record<string, unknown>): Promise<number | void>;
  hooks?: {
    [E in IntegrationEventName]?: (
      ctx: PluginBase,
      data: IntegrationEvents[E],
    ) => void | Promise<void>;
  };
}

export type IntegrationFactory = (base: PluginBase) => Integration;
