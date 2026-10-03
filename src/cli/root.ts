import { defineCommand } from "citty";
import { basename, resolve } from "node:path";
import * as fs from "../fs.ts";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  registerGlobalRoot,
  saveGlobalConfig,
  unregisterGlobalRoot,
  GlobalRootError,
} from "../global.ts";
import { configFilePath, rootAgentsPath } from "../paths.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";
import { providerAddCommand } from "./provider.ts";
import { syncInventoryCommand } from "./sync.ts";
import { canPrompt, getActiveConfig, getAmbient, type AmbientContext } from "./context.ts";
import { resolveChoiceInput, resolveTextInput } from "./input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

const ROOT_AGENTS_CONTENT = `# dev CLI Root

These instructions apply only inside this dev root and its descendants. They are not global machine or user instructions.

This directory is managed by dev CLI. It contains task workspaces under \`ws/\` and canonical repository mirrors under \`mirrors/\`.

## Start Here

- For manual use, run \`dev --help\` and \`dev <command> --help\`.
- For LLM use, run \`dev --help --llms\` for the structured command contract.
- Read \`ws.md\` before starting work in a workspace. Treat its Objective, Current Progress, Decisions, and Next Steps as the session brief.

## Main Workflows

- \`dev current\`: show the active dev root.
- \`dev ws list\`: list workspaces.
- \`dev ws init <workspace> --desc "<objective>"\`: create a workspace.
- \`dev ws add <repository>\`: add a repository to the current workspace.
- \`dev ws status\`: compare declared and checked-out workspace state.
- \`dev ws start [query]\`: start or focus OMP in HerdR for a workspace.
- \`dev ws update\`: create missing mounts, fix revisions, and fast-forward clean ones to match \`ws.md\`.

## Working Files

- Keep each workspace's \`ws.md\` current as work progresses. Update its Objective, Current Progress, Decisions, and Next Steps without changing the YAML frontmatter.
- Use \`ws/<workspace>/.local/\` for workspace-local artifacts, scratch files, generated plans, and other material that must never be committed. Do not put workspace work in a root-level \`.local/\`.
- Customize this \`AGENTS.md\` with root-specific guidance when needed. Running \`dev init\` again does not overwrite it.
- Do not edit \`.dev/\` or \`mirrors/\` directly. Use dev CLI commands so metadata and worktrees stay consistent.
`;

type ExistingRootChoice = "update" | "create";

function nextDefaultRoot(homeDir: string): string {
  const defaultRoot = resolve(homeDir, "dev");
  if (!fs.exists(defaultRoot)) return defaultRoot;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${defaultRoot}-${suffix}`;
    if (!fs.exists(candidate)) return candidate;
  }
}

async function resolveInitTarget(
  path: string | undefined,
  ambient: AmbientContext,
  homeDir: string,
): Promise<string> {
  if (path) return resolve(ambient.cwd, path);
  if (!canPrompt(ambient)) return resolve(homeDir, "dev");

  const current = getActiveConfig();
  let createAnother = false;
  if (current.rootSource === "file") {
    const choice = await ui.select<ExistingRootChoice>({
      message: "A dev root already exists here",
      hint: "Update keeps your workspaces; another root keeps work apart.",
      options: [
        { label: `Update ${current.root}`, value: "update" },
        { label: "Create another dev root", value: "create" },
      ],
    });
    if (choice === "update") return current.root;
    createAnother = true;
  }

  const initial = createAnother ? nextDefaultRoot(homeDir) : resolve(homeDir, "dev");
  const selected = await ui.text({
    message: "Where should dev keep your work?",
    hint: "Your dev root: workspaces, mirrors and settings live here. Enter keeps the shown path.",
    initial,
  });
  return resolve(ambient.cwd, selected?.trim() || initial);
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Create or update a dev root; with no arguments, walk you through providers",
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
    force: {
      type: "boolean",
      description: "Replace a root alias that points to another directory",
    },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    const homeDir = ambient.env.HOME || ambient.env.USERPROFILE || ambient.cwd;
    const guided =
      canPrompt(ambient) && !args.path && !args.alias && !args.adoOrg && !args.githubOwner;
    const targetDir = guided
      ? await resolveInitTarget(args.path, ambient, homeDir)
      : args.path
        ? resolve(ambient.cwd, args.path)
        : resolve(homeDir, "dev");
    const alias = args.alias || basename(targetDir);
    const devYamlPath = configFilePath({ root: targetDir });
    const globalPath = getGlobalConfigPath(ambient.env.HOME || ambient.env.USERPROFILE);
    const globalConfig = await loadGlobalConfig(globalPath);
    const previousDefaultRoot = globalConfig.default_root;
    const previousRootPath = globalConfig.roots[alias]?.path;
    try {
      registerGlobalRoot(globalConfig, {
        alias,
        path: targetDir,
        makeDefault: !previousDefaultRoot || Boolean(args.alias) || guided,
        force: args.force,
      });
    } catch (error) {
      return reportError(error, args.json);
    }
    const defaultRootChanged = previousDefaultRoot !== globalConfig.default_root;
    const registrationChanged =
      previousRootPath !== globalConfig.roots[alias]?.path || defaultRootChanged;
    await fs.ensureDir(targetDir);

    let created = false;
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

      await fs.withFileLock(devYamlPath, async () => {
        if (!fs.exists(devYamlPath)) {
          await fs.writeTextAtomic(devYamlPath, content);
          created = true;
        }
      });
    }

    const agentsPath = rootAgentsPath({ root: targetDir });
    let agentsCreated = false;
    if (!fs.exists(agentsPath)) {
      await fs.writeText(agentsPath, ROOT_AGENTS_CONTENT);
      agentsCreated = true;
    }

    if (registrationChanged) await saveGlobalConfig(globalConfig, globalPath);
    const changed = created || agentsCreated || registrationChanged;

    const result = {
      alias,
      path: targetDir,
      configPath: devYamlPath,
      globalConfigPath: globalPath,
      defaultRoot: globalConfig.default_root,
      defaultRootChanged,
      created,
      changed,
      agentsCreated,
      registrationChanged,
    };

    ui.result({
      data: result,
      json: args.json,
      text: () => {
        const defaultHint = targetDir === resolve(homeDir, "dev") ? " (default)" : "";
        const outcome = !changed
          ? `○ Your dev root at ${targetDir} is ready`
          : `${created ? "✓ Created" : "✓ Updated"} your dev root at ${targetDir}${defaultHint}`;
        return outcome;
      },
      next: [
        { command: "dev ws init <repository-url>", why: "start a workspace for a task" },
        { command: "dev provider add", why: "connect GitHub or Azure DevOps" },
      ],
    });

    if (
      !guided ||
      !(await ui.confirm({
        message: "Connect GitHub or Azure DevOps?",
        hint: "dev then lists your repositories and pull requests. Skip to use URLs.",
        initial: true,
      }))
    )
      return 0;

    do {
      const providerResult = await runNestedCommand(providerAddCommand, ["--root", targetDir]);
      if (typeof providerResult === "number" && providerResult !== 0) return providerResult;
    } while (
      await ui.confirm({
        message: "Add another provider?",
        hint: "For example a second Azure DevOps organization. No finishes setup.",
        initial: false,
      })
    );

    const syncResult = await runNestedCommand(syncInventoryCommand, ["--root", targetDir]);
    return typeof syncResult === "number" ? syncResult : 0;
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
      hint: "Use this root for its workspaces, mirrors and settings.",
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
              hint: "Use this folder for its workspaces, mirrors and settings.",
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
          ? `○ Default dev root set to '${alias}' (${resolvedPath}) in ${globalPath}.`
          : `To activate '${alias}' in this shell session, run:\n  ↳ export DEV_ROOT="${resolvedPath}"`,
    });
    return 0;
  },
});

export const currentCommand = defineCommand({
  meta: {
    name: "current",
    description: "Show which dev root is active and why",
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
        if (!config.configPath)
          return ui.empty({
            message: "No dev root yet.",
            next: [{ command: "dev init", why: "choose where to keep your work" }],
          });
        return `Your dev root: ${config.root}`;
      },
      next: config.configPath
        ? [
            { command: "dev ls", why: "see your task workspaces" },
            { command: "dev roots", why: "see the roots you can switch to" },
          ]
        : undefined,
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
          return ui.empty({
            message: "No dev root yet; you have not registered one.",
            next: [{ command: "dev init", why: "choose where to keep your work" }],
          });
        }
        let out = "Your dev roots:\n";
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
      hint: "Register a folder that already holds your dev work and settings.",
      required: {
        command: "root add",
        field: "path",
        usage: "dev root add <path> [--alias <name>]",
        description: "Dev root path",
      },
    });
    const rootPath = resolve(ambient.cwd, pathInput.value);
    if (!fs.exists(configFilePath({ root: rootPath }))) {
      return reportError(
        Object.assign(new Error(`'${rootPath}' has no dev root settings yet.`), {
          details: { usage: `dev init ${JSON.stringify(rootPath)}` },
        }),
        args.json,
      );
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
        `○ Registered dev root '${alias}' at ${entry.path}.${result.isDefault ? " It is now the default." : ""}`,
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
      hint: "Remove the saved root name; files on disk stay.",
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
    let removed: ReturnType<typeof unregisterGlobalRoot>;
    try {
      removed = unregisterGlobalRoot(globalConfig, aliasOrPath);
    } catch (error) {
      if (error instanceof GlobalRootError && error.code === "ROOT_NOT_FOUND" && error.details) {
        error.details.value = target.value;
        if (Array.isArray(error.details.candidates) && error.details.candidates.length > 0)
          error.message = `Registered root '${target.value}' was not found.`;
      }
      return reportError(error, args.json);
    }
    await saveGlobalConfig(globalConfig, globalPath);
    const result = { ...removed, filesRemoved: false };
    ui.result({
      data: result,
      json: args.json,
      text: () =>
        `✓ Unregistered dev root '${removed.alias}'. Files at ${removed.path} were not removed.`,
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
