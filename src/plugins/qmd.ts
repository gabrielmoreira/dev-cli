import { join } from "node:path";
import { deriveCanonicalParts } from "../paths.ts";
import { LabelError, resolveLabeledSources } from "../labels.ts";
import type { Integration, IntegrationFactory, PluginBase } from "./events.ts";

export interface QmdPluginConfig {
  /** Invocation: PATH shim, absolute path, or "mise exec -q -- qmd" split on
   * whitespace. Default "qmd". */
  command: string;
  /** scoped (default): <root>/.dev/plugins/qmd | global: qmd's own registry
   * | any other value: absolute config dir. */
  config_dir: string;
}

export function parseQmdConfig(raw: Record<string, unknown> | undefined): QmdPluginConfig {
  const rawqmd = (raw?.qmd ?? {}) as Record<string, unknown>;
  const command =
    typeof rawqmd.command === "string" && rawqmd.command.trim() ? rawqmd.command.trim() : "qmd";
  const configDir =
    typeof rawqmd.config_dir === "string" && rawqmd.config_dir.trim()
      ? rawqmd.config_dir.trim()
      : "scoped";
  return { command, config_dir: configDir };
}

/** The env every qmd invocation must run under: QMD_CONFIG_DIR scoped to the
 * dev root by default, keeping each root's registry isolated and rebuildable. */
export function qmdEnv(base: PluginBase, config: QmdPluginConfig): Record<string, string> {
  const dir =
    config.config_dir === "scoped"
      ? join(base.root, ".dev", "plugins", "qmd")
      : config.config_dir === "global"
        ? ""
        : config.config_dir;
  return dir ? { QMD_CONFIG_DIR: dir } : {};
}

function splitCommand(config: QmdPluginConfig): { bin: string; prefix: string[] } {
  const parts = config.command.split(/\s+/).filter(Boolean);
  return { bin: parts[parts.length - 1]!, prefix: parts.slice(0, -1) };
}

async function qmd(
  base: PluginBase,
  config: QmdPluginConfig,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { bin, prefix } = splitCommand(config);
  return base.shell.runCommand(bin, [...prefix, ...args], {
    env: qmdEnv(base, config),
  });
}

function collectionName(label: string, checkoutPath: string): string {
  const repoFolder = deriveCanonicalParts(checkoutPath).repo;
  return `${label}--${repoFolder}`;
}

export function createQmdPlugin(base: PluginBase): Integration {
  const config = parseQmdConfig(base.config.plugins);

  return {
    name: "qmd",

    async run(args) {
      const sub = String(args.subcommand ?? "");

      if (sub === "x") {
        const passthrough = (args.passthrough as string[]) ?? [];
        const res = await qmd(base, config, passthrough);
        if (res.exitCode !== 0) base.ui.error(res.stderr || res.stdout);
        else if (res.stdout) base.ui.log(res.stdout);
        return res.exitCode;
      }

      if (sub === "sync") {
        return syncCollections(base, config, {
          label: String(args.label ?? ""),
          noEmbed: Boolean(args.noEmbed),
        });
      }

      base.ui.error(`Unknown qmd subcommand '${sub}'. Use 'sync' or 'x'.`);
      return 1;
    },

    hooks: {
      // Freshness: checkouts may have been fast-forwarded by mirror sync.
      // qmd update is delta and cheap; never embed here (heavy, opt-in).
      "mirror:sync:after": async (b, data) => {
        if (data.updated.length === 0) return;
        await qmd(b, config, ["update"]);
      },
    },
  };
}

export async function syncCollections(
  base: PluginBase,
  config: QmdPluginConfig,
  opts: { label: string; noEmbed: boolean },
): Promise<number> {
  const { label } = opts;
  if (!label) {
    base.ui.error("Error: label required. Usage: dev qmd sync <label> [--no-embed]");
    return 1;
  }

  let resolved;
  try {
    resolved = await resolveLabeledSources(base.config, label);
  } catch (error) {
    if (error instanceof LabelError) {
      base.ui.error(`Error [${error.code}]: ${error.message}`);
      return 1;
    }
    throw error;
  }
  for (const warning of resolved.warnings) base.ui.warn(`Warning: ${warning}`);

  const desired = new Map<string, string>(); // collection name -> checkout path
  for (const source of resolved.sources) {
    desired.set(collectionName(label, source.checkoutPath), source.checkoutPath);
  }

  const failed = await reconcileCollections(base, config, label, desired);
  if (failed) {
    base.ui.error(`qmd ${failed.step} failed: ${failed.stderr}`);
    return 1;
  }

  base.ui.log(`qmd sync '${label}': ${desired.size} collection(s) reconciled`);
  return 0;
}

/** Reconciles owned collections (`<label>--*`) toward `desired`: removes
 * stale, adds missing (idempotent — qmd exits 1 on duplicates, tolerated),
 * then updates delta and optionally embeds. Returns the first failure. */
export async function reconcileCollections(
  base: PluginBase,
  config: QmdPluginConfig,
  label: string,
  desired: Map<string, string>,
  opts: { embed: boolean } = { embed: true },
): Promise<{ step: string; stderr: string } | null> {
  const list = await qmd(base, config, ["collection", "list"]);
  const ownedNames = new Set(
    list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${label}--`))
      .map((line) => line.split(/\s+/)[0]!),
  );

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    const removed = await qmd(base, config, ["collection", "remove", name]);
    if (removed.exitCode !== 0)
      return { step: "collection remove", stderr: removed.stderr || removed.stdout };
  }

  for (const [name, path] of desired) {
    if (ownedNames.has(name)) continue;
    // qmd exits 1 when name or path+pattern already exists: idempotent add.
    await qmd(base, config, ["collection", "add", path, "--name", name]);
  }

  const update = await qmd(base, config, ["update"]);
  if (update.exitCode !== 0) return { step: "update", stderr: update.stderr || update.stdout };

  if (opts.embed) {
    const embed = await qmd(base, config, ["embed"]);
    if (embed.exitCode !== 0) return { step: "embed", stderr: embed.stderr || embed.stdout };
  }
  return null;
}

export const qmdFactory: IntegrationFactory = createQmdPlugin;
