import { defineCommand } from "citty";
import { addProvider, listProviders, removeProvider, type ProviderConfig } from "../provider.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";
import { getActiveConfig } from "./context.ts";
import { resolveChoiceInput, resolveConfirmation, resolveTextInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

function autoId(type: "azure_devops" | "github", qualifier: string): string {
  const prefix = type === "azure_devops" ? "ado" : "gh";
  return `${prefix}-${qualifier.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
}

export const providerAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register a remote provider in dev.yaml",
  },
  args: {
    type: {
      type: "positional",
      description: "Provider type: 'ado' (Azure DevOps) or 'github'",
      required: false,
    },
    id: {
      type: "string",
      description: "Unique provider identifier (auto-derived if omitted)",
      required: false,
    },
    org: { type: "string", description: "Azure DevOps organization name (required for ado)" },
    project: { type: "string", description: "Azure DevOps default project" },
    owner: { type: "string", description: "GitHub user or organization (required for github)" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const providerType = await resolveChoiceInput({
      value: args.type?.toLowerCase(),
      choices: async () => [
        { label: "Azure DevOps", value: "ado" },
        { label: "GitHub", value: "github" },
      ],
      message: "Where do your repositories live?",
      hint: "You can add more later with dev provider add.",
      required: {
        command: "provider add",
        field: "type",
        usage: "dev provider add <ado|github>",
        description: "Provider type",
      },
    });
    const rawType = providerType.value;

    let entry: ProviderConfig;

    if (rawType === "ado" || rawType === "azure_devops" || rawType === "azure-devops") {
      const organization = await resolveTextInput({
        value: args.org,
        message: "Azure DevOps organization",
        hint: "Read its repositories and pull requests using your az session.",
        required: {
          command: "provider add",
          field: "organization",
          usage: "dev provider add ado --org <name>",
          description: "Azure DevOps organization",
        },
      });
      const id = args.id || autoId("azure_devops", organization.value);
      entry = {
        id,
        type: "azure_devops",
        organization: organization.value,
        project: args.project,
      };
    } else if (rawType === "github" || rawType === "gh") {
      const owner = await resolveTextInput({
        value: args.owner,
        message: "GitHub owner",
        hint: "Read this user or organization using your gh session.",
        required: {
          command: "provider add",
          field: "owner",
          usage: "dev provider add github --owner <name>",
          description: "GitHub owner",
        },
      });
      const id = args.id || autoId("github", owner.value);
      entry = {
        id,
        type: "github",
        owner: owner.value,
      };
    } else {
      return reportError(
        [
          `Unsupported provider type '${args.type}'.`,
          "  Supported types:",
          "    ado  (or azure-devops, azure_devops)  — Azure DevOps",
          "    github  (or gh)                        — GitHub",
          "  Example: dev provider add ado --org my-org",
        ].join("\n"),
        args.json,
      );
    }

    await addProvider(config.root, entry);

    ui.result({
      data: entry,
      json: args.json,
      text: () => {
        let out = `○ Provider '${entry.id}' (${entry.type}) is connected:\n`;
        if (entry.type === "azure_devops") {
          out += `  Organization: ${entry.organization}\n`;
          if (entry.project) out += `  Project:      ${entry.project}\n`;
        } else {
          out += `  Owner:        ${entry.owner}\n`;
        }
        out += "\n↳ dev sync inventory  list repositories from this connection";
        return out;
      },
    });

    return 0;
  },
});

export const providerListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List configured remote providers in dev.yaml",
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const providers = await listProviders(config.root);

    ui.result({
      data: providers,
      json: args.json,
      text: () => {
        if (providers.length === 0) {
          return ui.empty({
            message: config.configPath
              ? "No provider connected, so dev cannot list your remote repositories."
              : "No dev root yet, so there are no providers to show.",
            next: config.configPath
              ? [
                  {
                    command: "dev provider add",
                    why: "connect GitHub or Azure DevOps; you can still use URLs without one",
                  },
                ]
              : [{ command: "dev init", why: "choose where to keep your work" }],
          });
        }
        const maxIdLen = Math.max(...providers.map((p) => p.id.length));
        let out = `Configured Providers (${config.root}):\n`;
        for (const p of providers) {
          const id = p.id.padEnd(maxIdLen);
          if (p.type === "azure_devops") {
            const target = p.project ? `${p.organization}/${p.project}` : p.organization;
            out += `  ${id}  [ado]     ${target}\n`;
          } else {
            out += `  ${id}  [github]  ${p.owner}\n`;
          }
        }
        return out.trimEnd();
      },
    });

    return 0;
  },
});

export const providerRemoveCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a remote provider from dev.yaml",
  },
  args: {
    id: { type: "positional", description: "Provider identifier to remove", required: false },
    force: { type: "boolean", description: "Remove without an interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const provider = await resolveChoiceInput({
      value: args.id,
      choices: async () =>
        (await listProviders(config.root)).map((item) => ({
          label: `${item.id} (${item.type})`,
          value: item.id,
        })),
      message: "Select provider to remove",
      hint: "Disconnect it from dev; repositories and workspaces stay.",
      required: {
        command: "provider remove",
        field: "id",
        usage: "dev provider remove <id>",
        description: "Provider identifier",
      },
    });
    const confirmed = await resolveConfirmation({
      confirmed: args.force,
      message: `Remove provider '${provider.value}'?`,
      hint: "Yes disconnects this provider; No keeps the connection.",
      required: {
        command: "provider remove",
        field: "confirmation",
        usage: "dev provider remove <id> --force",
        description: "Explicit confirmation (--force)",
      },
    });
    if (!confirmed) {
      ui.info("Cancelled.");
      return 0;
    }

    const success = await removeProvider(config.root, provider.value);

    if (!success) {
      return reportError(
        Object.assign(
          new Error(
            !config.configPath
              ? "No dev root yet."
              : `Provider '${provider.value}' is not connected.`,
          ),
          {
            details: {
              kind: "provider",
              value: provider.value,
              candidates: config.providers.map((item) => item.id),
              usage: !config.configPath
                ? "dev init"
                : config.providers.length > 0
                  ? "dev provider list"
                  : "dev provider add <type>",
            },
          },
        ),
        args.json,
      );
    }

    ui.result({
      data: { id: provider.value, removed: true },
      json: args.json,
      text: `✓ Removed provider '${provider.value}' from dev.yaml.`,
    });

    return 0;
  },
});

export const providerCommand = defineCommand({
  meta: {
    name: "provider",
    description: "Manage explicit remote providers in dev.yaml",
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  subCommands: {
    add: providerAddCommand,
    list: providerListCommand,
    ls: providerListCommand,
    remove: providerRemoveCommand,
    rm: providerRemoveCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(providerCommand, rawArgs)) return;
    return await runNestedCommand(providerListCommand, rawArgs);
  },
});
