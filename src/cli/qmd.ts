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
      noEmbed: args["no-embed"],
    });
    return typeof code === "number" ? code : 0;
  },
});

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
    const config = getActiveConfig(args.root);
    const passthrough = rawArgs.slice(rawArgs.indexOf("x") + 1);
    const plugin = createQmdPlugin(createPluginBase(config.root, config));
    const code = await plugin.run({ subcommand: "x", passthrough });
    if (typeof code === "number" && code !== 0) ui.error(`qmd exited with code ${code}`);
    return typeof code === "number" ? code : 0;
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
    x: qmdXCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(qmdCommand, rawArgs)) return;
    return await runNestedCommand(qmdSyncCommand, ["", ...rawArgs]);
  },
});
