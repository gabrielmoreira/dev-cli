import { defineCommand } from "citty";
import { getActiveConfig } from "./context.ts";
import { createPluginBase } from "../plugins/index.ts";
import { createQmdPlugin } from "../plugins/qmd.ts";
import { ui } from "../ui.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

export const qmdSyncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Reconcile qmd collections from sources carrying a label",
  },
  args: {
    label: {
      type: "positional",
      description: "Label whose sources become collections",
      required: false,
    },
    "no-embed": { type: "boolean", description: "Skip vector indexing (lexical-only / CI)" },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const plugin = createQmdPlugin(createPluginBase(config.root, config));
    const code = await plugin.run({
      subcommand: "sync",
      label: String(args.label ?? ""),
      noEmbed: args.embed === false,
    });
    return typeof code === "number" ? code : 0;
  },
});

/** Collects everything the user typed after `marker`, minus the CLI's own
 * `--root`, so it reaches qmd verbatim. */
function passthroughAfter(rawArgs: string[], marker: string): string[] {
  const passthrough: string[] = [];
  const start = rawArgs.indexOf(marker);
  for (let index = start + 1; index < rawArgs.length; index++) {
    const argument = rawArgs[index]!;
    if (argument === "--root") {
      index++;
      continue;
    }
    if (argument.startsWith("--root=")) continue;
    passthrough.push(argument);
  }
  return passthrough;
}

async function runPassthrough(root: string | undefined, passthrough: string[]): Promise<number> {
  const config = getActiveConfig(root);
  const plugin = createQmdPlugin(createPluginBase(config.root, config));
  const code = await plugin.run({ subcommand: "x", passthrough });
  if (typeof code === "number" && code !== 0) ui.error(`qmd exited with code ${code}`);
  return typeof code === "number" ? code : 0;
}

export const qmdXCommand = defineCommand({
  meta: {
    name: "x",
    description: "Raw qmd passthrough with the scoped registry env",
  },
  args: {
    args: { type: "positional", description: "Arguments passed to qmd verbatim", required: true },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args, rawArgs }) {
    return await runPassthrough(args.root, passthroughAfter(rawArgs, "x"));
  },
});

export const qmdSearchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search the scoped qmd index (shortcut for 'qmd x search')",
  },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args, rawArgs }) {
    return await runPassthrough(args.root, ["search", ...passthroughAfter(rawArgs, "search")]);
  },
});

export const qmdCommand = defineCommand({
  meta: {
    name: "qmd",
    description: "QMD plugin: collections from labeled sources (scoped registry)",
  },
  args: qmdSyncCommand.args,
  subCommands: {
    sync: qmdSyncCommand,
    search: qmdSearchCommand,
    x: qmdXCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(qmdCommand, rawArgs)) return;
    return await runNestedCommand(qmdSyncCommand, ["", ...rawArgs]);
  },
});
