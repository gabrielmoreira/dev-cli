import { defineCommand } from "citty";
import { basename, resolve } from "node:path";
import * as fs from "../fs.ts";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  registerGlobalRoot,
  saveGlobalConfig,
  unregisterGlobalRoot,
} from "../global.ts";
import { ui } from "../ui.ts";
import { getActiveConfig, getAmbient } from "./context.ts";
import { resolveChoiceInput, resolveTextInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

const ROOT_AGENTS_CONTENT = `# dev CLI Root

This directory is managed by dev CLI. It contains task workspaces under \`ws/\` and canonical repository mirrors under \`mirrors/\`.

## Start Here

- For manual use, run \`dev --help\` and \`dev <command> --help\`.
- For LLM use, run \`dev --help --llms\` for the structured command contract.
- Read \`ws.md\` before starting work in a workspace. Treat its Objective, Current Progress, Decisions, and Next Steps as the session brief.

## Main Workflows

- \`dev current\`: show the active dev root.
- \`dev ws list\`: list workspaces.
- \`dev ws init <name> --description "<objective>"\`: create a workspace.
- \`dev ws add <url-or-name>\`: add a repository to the current workspace.
- \`dev ws status\`: compare declared and checked-out workspace state.
- \`dev ws start [name]\`: start or focus OMP in HerdR for a workspace.
- \`dev ws up\`: materialize and reconcile mounts declared in \`ws.md\`.

## Working Files

- Keep each workspace's \`ws.md\` current as work progresses. Update its Objective, Current Progress, Decisions, and Next Steps without changing the YAML frontmatter.
- Use \`ws/<workspace>/.local/\` for workspace-local artifacts, scratch files, generated plans, and other material that must never be committed. Do not put workspace work in a root-level \`.local/\`.
- Customize this \`AGENTS.md\` with root-specific guidance when needed. Running \`dev init\` again does not overwrite it.
- Do not edit \`.dev/\` or \`mirrors/\` directly. Use dev CLI commands so metadata and worktrees stay consistent.
`;

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "Initialize a dev root with dev.yaml and AGENTS.md, then register it in ~/.dev.toml",
  },
  args: {
    path: {
      type: "positional",
      description: "Path to dev root directory (default: ~/dev)",
      required: false,
    },
    alias: {
      type: "string",
      description: "Named root alias for ~/.dev.toml (default: directory name)",
    },
    adoOrg: { type: "string", description: "Default Azure DevOps organization" },
    githubOwner: { type: "string", description: "Default GitHub owner/organization" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    const homeDir = ambient.env.HOME || ambient.env.USERPROFILE || ambient.cwd;
    const targetDir = args.path ? resolve(ambient.cwd, args.path) : resolve(homeDir, "dev");
    await fs.ensureDir(targetDir);

    const alias = args.alias || basename(targetDir);
    const devYamlPath = resolve(targetDir, "dev.yaml");

    if (!fs.exists(devYamlPath)) {
      let content = `# dev CLI Root Configuration\n`;
      content += `# Documentation: https://github.com/gabrielmoreira/dev-cli\n\n`;
      content += `# Default synchronization strategy for workspace mounts ('ff-only' recommended)\n`;
      content += `sync_strategy: ff-only\n\n`;
      content += `# Workspace and canonical repository prefixes\n`;
      content += `defaults:\n`;
      content += `  workspace_prefix: ws/\n`;
      content += `  canonical_prefix: mirrors/\n\n`;

      if (args.adoOrg) {
        content += `# Azure DevOps Configuration\n`;
        content += `azure_devops:\n`;
        content += `  organization: ${args.adoOrg}\n\n`;
      }

      if (args.githubOwner) {
        content += `# GitHub Configuration\n`;
        content += `github:\n`;
        content += `  owner: ${args.githubOwner}\n`;
        content += `  enabled: true\n\n`;
      }

      await fs.writeText(devYamlPath, content);
    }

    const agentsPath = resolve(targetDir, "AGENTS.md");
    if (!fs.exists(agentsPath)) {
      await fs.writeText(agentsPath, ROOT_AGENTS_CONTENT);
    }

    // Register in ~/.dev.toml
    const globalPath = getGlobalConfigPath(ambient.env.HOME || ambient.env.USERPROFILE);
    const globalConfig = await loadGlobalConfig(globalPath);
    globalConfig.roots[alias] = { path: targetDir.replace(/\\/g, "/") };
    if (!globalConfig.default_root || args.alias) {
      globalConfig.default_root = alias;
    }
    await saveGlobalConfig(globalConfig, globalPath);

    const result = {
      alias,
      path: targetDir,
      configPath: devYamlPath,
      globalConfigPath: globalPath,
    };

    ui.result({
      data: result,
      json: args.json,
      text: () => {
        let out = `Initialized dev root '${alias}' at:\n`;
        out += `  Directory:     ${targetDir}\n`;
        out += `  Configuration: ${devYamlPath}\n`;
        out += `  Global Config: ${globalPath} (alias: ${alias})`;
        return out;
      },
    });

    return 0;
  },
});

export const useCommand = defineCommand({
  meta: {
    name: "use",
    description: "Switch active dev root environment or update global default",
  },
  args: {
    target: { type: "positional", description: "Root alias or directory path", required: false },
    global: {
      type: "boolean",
      alias: "g",
      description: "Set as the global default root in ~/.dev.toml",
    },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    const globalPath = getGlobalConfigPath(ambient.env.HOME || ambient.env.USERPROFILE);
    const globalConfig = await loadGlobalConfig(globalPath);
    const manualRoot = "\0manual-root";
    const targetChoice = await resolveChoiceInput({
      value: args.target,
      choices: async () => [
        ...Object.entries(globalConfig.roots).map(([alias, entry]) => ({
          label: `${alias} — ${entry.path}`,
          value: alias,
        })),
        { label: "Enter a root path manually", value: manualRoot },
      ],
      message: "Select dev root",
      required: {
        command: "use",
        field: "root",
        usage: "dev use [alias|path]",
        description: "Dev root",
      },
    });
    const target =
      targetChoice.value === manualRoot
        ? (
            await resolveTextInput({
              message: "Dev root path",
              required: {
                command: "use",
                field: "root",
                usage: "dev use [alias|path]",
                description: "Dev root",
              },
            })
          ).value
        : targetChoice.value;

    let resolvedPath: string;
    let alias: string;
    if (globalConfig.roots[target]) {
      alias = target;
      resolvedPath = globalConfig.roots[target].path;
    } else {
      resolvedPath = resolve(ambient.cwd, target);
      alias = basename(resolvedPath);
      globalConfig.roots[alias] = { path: resolvedPath.replace(/\\/g, "/") };
    }

    if (args.global) {
      globalConfig.default_root = alias;
      await saveGlobalConfig(globalConfig, globalPath);
    }

    const result = {
      activeRoot: alias,
      path: resolvedPath,
      isGlobal: Boolean(args.global),
    };
    ui.result({
      data: result,
      json: args.json,
      text: () =>
        args.global
          ? `Default dev root set to '${alias}' (${resolvedPath}) in ${globalPath}.`
          : `To activate '${alias}' in this shell session, run:\n  export DEV_ROOT="${resolvedPath}"`,
    });
    return 0;
  },
});

export const currentCommand = defineCommand({
  meta: {
    name: "current",
    description: "Display currently resolved dev root path and discovery source",
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);

    const result = {
      root: config.root,
      source: config.rootSource,
      configPath: config.configPath,
    };

    ui.result({
      data: result,
      json: args.json,
      text: () => {
        let out = `Dev Root: ${config.root}\n`;
        out += `  Source: ${config.rootSource}\n`;
        if (config.configPath) {
          out += `  Config: ${config.configPath}`;
        }
        return out.trimEnd();
      },
    });

    return 0;
  },
});

export const rootsCommand = defineCommand({
  meta: {
    name: "roots",
    description: "List registered dev root environments from ~/.dev.toml",
  },
  args: {
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    const globalPath = getGlobalConfigPath(ambient.env.HOME || ambient.env.USERPROFILE);
    const globalConfig = await loadGlobalConfig(globalPath);
    const current = getActiveConfig();

    const currentNormalized = resolve(current.root).replace(/\\/g, "/").toLowerCase();
    const list = Object.entries(globalConfig.roots).map(([alias, entry]) => {
      const entryNormalized = resolve(entry.path).replace(/\\/g, "/").toLowerCase();
      const isDefault = alias === globalConfig.default_root;
      const isActive = entryNormalized === currentNormalized;
      return {
        alias,
        path: entry.path,
        isDefault,
        isActive,
      };
    });

    ui.result({
      data: list,
      json: args.json,
      text: () => {
        if (list.length === 0) {
          return `No dev roots registered in ${globalPath}. Run 'dev init [path]' to create one.`;
        }
        let out = `Registered Dev Roots (${globalPath}):\n`;
        for (const item of list) {
          const marker = item.isActive ? "* " : "  ";
          const defaultBadge = item.isDefault ? " (default)" : "";
          out += `${marker}${item.alias.padEnd(16)} -> ${item.path}${defaultBadge}\n`;
        }
        return out.trimEnd();
      },
    });

    return 0;
  },
});

export const rootAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register an existing dev root without modifying its files",
  },
  args: {
    path: { type: "positional", description: "Existing dev root directory", required: false },
    alias: { type: "string", description: "Root alias (default: directory name)" },
    default: { type: "boolean", description: "Make this the global default root" },
    force: { type: "boolean", description: "Replace an alias that points elsewhere" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    const pathInput = await resolveTextInput({
      value: args.path,
      message: "Existing dev root path",
      required: {
        command: "root add",
        field: "path",
        usage: "dev root add <path> [--alias <name>]",
        description: "Dev root path",
      },
    });
    const rootPath = resolve(ambient.cwd, pathInput.value);
    if (!fs.exists(resolve(rootPath, "dev.yaml"))) {
      ui.error(`Error: '${rootPath}' is not a dev root because dev.yaml is missing.`);
      return 1;
    }

    const globalPath = getGlobalConfigPath(ambient.env.HOME || ambient.env.USERPROFILE);
    const globalConfig = await loadGlobalConfig(globalPath);
    const alias = args.alias || basename(rootPath);
    const entry = registerGlobalRoot(globalConfig, {
      alias,
      path: rootPath,
      makeDefault: args.default,
      force: args.force,
    });
    await saveGlobalConfig(globalConfig, globalPath);
    const result = { alias, path: entry.path, isDefault: globalConfig.default_root === alias };
    ui.result({
      data: result,
      json: args.json,
      text: () =>
        `Registered dev root '${alias}' at ${entry.path}.${result.isDefault ? " It is now the default." : ""}`,
    });
    return 0;
  },
});

export const rootRemoveCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Unregister a dev root without deleting any files",
  },
  args: {
    target: { type: "positional", description: "Registered root alias or path", required: false },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    const globalPath = getGlobalConfigPath(ambient.env.HOME || ambient.env.USERPROFILE);
    const globalConfig = await loadGlobalConfig(globalPath);
    const target = await resolveChoiceInput({
      value: args.target,
      choices: async () =>
        Object.entries(globalConfig.roots).map(([alias, entry]) => ({
          label: `${alias} — ${entry.path}`,
          value: alias,
        })),
      message: "Select root to unregister",
      required: {
        command: "root remove",
        field: "root",
        usage: "dev root remove <alias|path>",
        description: "Registered root",
      },
    });
    const aliasOrPath = Object.hasOwn(globalConfig.roots, target.value)
      ? target.value
      : resolve(ambient.cwd, target.value);
    const removed = unregisterGlobalRoot(globalConfig, aliasOrPath);
    await saveGlobalConfig(globalConfig, globalPath);
    const result = { ...removed, filesRemoved: false };
    ui.result({
      data: result,
      json: args.json,
      text: () =>
        `Unregistered dev root '${removed.alias}'. Files at ${removed.path} were not removed.`,
    });
    return 0;
  },
});

export const rootCommand = defineCommand({
  meta: {
    name: "root",
    description: "Register, select, and unregister dev roots",
  },
  args: rootsCommand.args,
  subCommands: {
    add: rootAddCommand,
    link: rootAddCommand,
    remove: rootRemoveCommand,
    rm: rootRemoveCommand,
    unlink: rootRemoveCommand,
    list: rootsCommand,
    ls: rootsCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(rootCommand, rawArgs)) return;
    return await runNestedCommand(rootsCommand, rawArgs);
  },
});
