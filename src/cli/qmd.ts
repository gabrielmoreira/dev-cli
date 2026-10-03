import { defineCommand } from "citty";
import { getActiveConfig } from "./context.ts";
import { CliInputRequiredError } from "./input.ts";
import { createPluginBase } from "../plugins/index.ts";
import {
  createQmdPlugin,
  DEFAULT_QMD_LABEL_PREFIX,
  parseQmdConfig,
  syncCollections,
} from "../plugins/qmd.ts";
import { ui } from "../ui.ts";
import { reportError, reportExitCode } from "./errors.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

export const qmdSyncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Reconcile qmd collections from sources carrying a label",
  },
  args: {
    label: {
      type: "positional",
      description: `Label whose sources become collections (default: all ${DEFAULT_QMD_LABEL_PREFIX}* labels)`,
      required: false,
    },
    "no-embed": { type: "boolean", description: "Skip vector indexing (lexical-only / CI)" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    try {
      const config = getActiveConfig(args.root);
      const result = await syncCollections(
        createPluginBase(config.root, config),
        parseQmdConfig(config.plugins),
        { label: args.label, noEmbed: args.embed === false },
      );
      if (!args.json) for (const warning of result.warnings) ui.warn(`⚠ ${warning}`);
      ui.result({
        data: result,
        json: args.json,
        text: () => {
          if (result.labels.length === 0)
            return ui.empty({
              message: !config.configPath
                ? "No dev root yet, so there is nothing to index."
                : `No ${DEFAULT_QMD_LABEL_PREFIX}* labels group repositories, so there is nothing to index.`,
              next: !config.configPath
                ? [{ command: "dev init", why: "choose where to keep your work" }]
                : [
                    {
                      command: `dev label add ${DEFAULT_QMD_LABEL_PREFIX}docs <repository-url>`,
                      why: "keep these repositories mirrored and searchable",
                    },
                  ],
            });
          return [
            ...result.labels.map(
              ({ label, collections }) =>
                `qmd sync '${label}': ${collections} collection(s) reconciled`,
            ),
            "qmd sync complete",
            "↳ dev qmd search <query>  search your indexed repository documents",
          ].join("\n");
        },
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

/** Runs qmd with these arguments, keeping its output and exit status as they are. */
async function runQmd(passthrough: string[], root?: string): Promise<number> {
  const config = getActiveConfig(root);
  const plugin = createQmdPlugin(createPluginBase(config.root, config));
  const code = await plugin.run({ subcommand: "x", passthrough });
  return reportExitCode(typeof code === "number" ? code : 0);
}

export const qmdXCommand = defineCommand({
  meta: {
    name: "x",
    description:
      "Run qmd with every word after x, unchanged; dev options go before x (dev --root <path> qmd x ...)",
  },
  args: {
    args: {
      type: "positional",
      description: "Arguments for qmd, passed as typed (required)",
      required: false,
    },
  },
  async run({ rawArgs }) {
    // Every word after `x` is qmd's, including --root, --json and --help.
    if (rawArgs.length === 0) {
      return reportError(
        new CliInputRequiredError({
          command: "qmd x",
          field: "args",
          usage: "dev qmd x <args>",
          description: "Arguments for qmd",
        }),
        ui.isJson(),
      );
    }
    return await runQmd(rawArgs);
  },
});

export const qmdSearchCommand = defineCommand({
  meta: {
    name: "search",
    description:
      "Search the scoped qmd index; qmd options go after -- (dev qmd search <query> -- -n 5)",
  },
  args: {
    // Required, but checked in run so the error names this command's usage.
    query: { type: "positional", description: "Search query (required)", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Ask qmd for JSON results" },
  },
  async run({ args, rawArgs }) {
    const boundary = rawArgs.indexOf("--");
    const extras = boundary === -1 ? [] : rawArgs.slice(boundary + 1);
    // citty lists the words after `--` as positionals too, at the end.
    const query = args._.slice(0, args._.length - extras.length);
    if (query.length === 0) {
      return reportError(
        new CliInputRequiredError({
          command: "qmd search",
          field: "query",
          usage: "dev qmd search <query>",
          description: "Search query",
        }),
        ui.isJson(),
      );
    }
    return await runQmd(
      ["search", ...query, ...(ui.isJson() ? ["--json"] : []), ...extras],
      args.root,
    );
  },
});

export const qmdCommand = defineCommand({
  meta: {
    name: "qmd",
    description: "Index labeled repositories with QMD and search them",
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
