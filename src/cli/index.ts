import { defineCommand, renderUsage, runCommand, type ArgDef, type CommandDef } from "citty";
import { wsCommand, wsGoCommand, wsListCommand } from "./ws.ts";
import { mirrorCommand } from "./mirror.ts";
import { syncCommand } from "./sync.ts";
import { prCommand } from "./pr.ts";
import { wiCommand } from "./wi.ts";
import { doctorCommand, hardwareCommand } from "./doctor.ts";
import { shellInitCommand } from "./shell.ts";
import { initCommand, useCommand, currentCommand, rootCommand, rootsCommand } from "./root.ts";
import { providerCommand } from "./provider.ts";
import { type AmbientContext, setAmbient } from "./context.ts";
import { detectWorkspaceFromCwd } from "../ws.ts";
import { ui } from "../ui.ts";
import { CliInputRequiredError } from "./input.ts";
import { reportError } from "./errors.ts";
import { qmdCommand } from "./qmd.ts";
import { worksetCommand } from "./workset.ts";
import { VERSION } from "../version.ts";

export { type AmbientContext, detectWorkspaceFromCwd };

export function createDefaultAmbient(): AmbientContext {
  return {
    argv: Bun.argv.slice(2),
    cwd: process.env.DEV_CWD || process.cwd(),
    env: { ...process.env },
    isTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
  };
}

type ResolvableValue<T> = T | Promise<T> | (() => T | Promise<T>);

interface InspectableCommand {
  meta?: ResolvableValue<{ name?: string; description?: string }>;
  args?: ResolvableValue<Record<string, ArgDef>>;
  subCommands?: ResolvableValue<Record<string, ResolvableValue<InspectableCommand>>>;
}

interface ArgumentDescription {
  name: string;
  type: ArgDef["type"];
  description?: string;
  required: boolean;
  aliases?: string[];
  options?: string[];
}

interface CommandDescription {
  name: string;
  description?: string;
  aliases?: string[];
  arguments: ArgumentDescription[];
  subcommands?: CommandDescription[];
}

async function resolveDefinition<T>(value: ResolvableValue<T>): Promise<T> {
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return await value;
}

async function renderCommandUsage(command: unknown, parent?: unknown): Promise<string> {
  // Citty's generic requires parent and child to share ArgsDef; runtime rendering only reads definitions.
  return await renderUsage(command as unknown as CommandDef, parent as unknown as CommandDef);
}

async function describeCommand(
  command: InspectableCommand,
  fallbackName: string,
): Promise<CommandDescription> {
  const meta = await resolveDefinition(command.meta ?? {});
  const args = await resolveDefinition(command.args ?? {});
  const subCommands = await resolveDefinition(command.subCommands ?? {});
  const descriptions: CommandDescription[] = [];
  const byCommand = new Map<InspectableCommand, CommandDescription>();

  for (const [name, definition] of Object.entries(subCommands)) {
    const child = await resolveDefinition(definition);
    const existing = byCommand.get(child);
    if (existing) {
      existing.aliases = [...(existing.aliases ?? []), name];
      continue;
    }
    const description = await describeCommand(child, name);
    byCommand.set(child, description);
    descriptions.push(description);
  }

  return {
    name: meta.name ?? fallbackName,
    description: meta.description,
    arguments: Object.entries(args).map(([name, definition]) => ({
      name,
      type: definition.type,
      description: definition.description,
      required: definition.required === true,
      aliases:
        "alias" in definition
          ? typeof definition.alias === "string"
            ? [definition.alias]
            : definition.alias
          : undefined,
      options: "options" in definition ? definition.options : undefined,
    })),
    subcommands: descriptions.length > 0 ? descriptions : undefined,
  };
}

export async function formatHelp(isLlms = false): Promise<string> {
  if (!isLlms) return await renderCommandUsage(mainCommand);

  const command = await describeCommand(mainCommand as unknown as InspectableCommand, "dev");
  return JSON.stringify(
    {
      name: command.name,
      description: command.description,
      options: command.arguments,
      commands: command.subcommands ?? [],
    },
    null,
    2,
  );
}

async function subCommandsOf(
  command: InspectableCommand,
): Promise<Record<string, ResolvableValue<InspectableCommand>>> {
  return await resolveDefinition(command.subCommands ?? {});
}

/**
 * Help for the deepest command the words name: `["ws", "add"]` renders
 * `dev ws add`; words past the last known command are ignored.
 */
export async function formatCommandHelp(path: string[]): Promise<string> {
  let command = mainCommand as unknown as InspectableCommand;
  const names: string[] = [];
  for (const word of path) {
    const next = (await subCommandsOf(command))[word];
    if (!next) break;
    command = await resolveDefinition(next);
    names.push(word);
  }
  if (names.length === 0) return await renderCommandUsage(mainCommand);
  const parent: InspectableCommand = { meta: { name: ["dev", ...names.slice(0, -1)].join(" ") } };
  return await renderCommandUsage(command, parent);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The command the user probably meant when a word is not a command: a
 * sibling one or two edits away (`dev ws strat`), or a command elsewhere with
 * exactly that name (`dev start` -> `dev ws start`).
 */
export async function suggestCommand(words: string[]): Promise<string | undefined> {
  let command = mainCommand as unknown as InspectableCommand;
  const names: string[] = [];
  for (const word of words.filter((w) => !w.startsWith("-"))) {
    const siblings = await subCommandsOf(command);
    const next = siblings[word];
    if (next) {
      command = await resolveDefinition(next);
      names.push(word);
      continue;
    }
    // At most two edits, and fewer than half the word, so `xy` suggests nothing.
    const near = Object.keys(siblings)
      .map((name) => ({ name, distance: editDistance(name, word) }))
      .filter(({ distance }) => distance <= 2 && distance < word.length / 2)
      .sort((x, y) => x.distance - y.distance)[0];
    if (near) return ["dev", ...names, near.name].join(" ");
    return await findByName(mainCommand as unknown as InspectableCommand, word, ["dev"]);
  }
  return undefined;
}

async function findByName(
  command: InspectableCommand,
  word: string,
  path: string[],
): Promise<string | undefined> {
  for (const [name, definition] of Object.entries(await subCommandsOf(command))) {
    if (name === word) return [...path, name].join(" ");
    const found = await findByName(await resolveDefinition(definition), word, [...path, name]);
    if (found) return found;
  }
  return undefined;
}

export const mainCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Developer CLI & Workspace Engine",
    version: VERSION,
  },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
    quiet: { type: "boolean", alias: "q", description: "Silence non-essential output" },
    "non-interactive": {
      type: "boolean",
      description:
        "Never prompt; a missing value is an error naming the flag. Default under CI or a coding agent",
    },
    ws: { type: "string", description: "Target workspace name" },
  },
  subCommands: {
    init: initCommand,
    ls: wsListCommand,
    use: useCommand,
    go: wsGoCommand,
    current: currentCommand,
    roots: rootsCommand,
    root: rootCommand,
    provider: providerCommand,
    ws: wsCommand,
    mirror: mirrorCommand,
    sync: syncCommand,
    pr: prCommand,
    wi: wiCommand,
    workitem: wiCommand,
    doctor: doctorCommand,
    hardware: hardwareCommand,
    "shell-init": shellInitCommand,
    qmd: qmdCommand,
    workset: worksetCommand,
  },
});

const WORKSPACE_TARGET_SUBCOMMANDS = new Set([
  "add",
  "status",
  "update",
  "sync",
  "track",
  "lock",
  "unlock",
  "tag",
  "up",
  "remove",
  "rm",
  "path",
  "jump",
  "pick",
]);

export function normalizeCliArgs(argv: string[]): string[] {
  const args: string[] = [];
  let workspace: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) break;
    if (argument === "--ws" && argv[index + 1]) {
      workspace = argv[++index];
    } else if (argument.startsWith("--ws=")) {
      workspace = argument.slice("--ws=".length);
    } else {
      args.push(argument);
    }
  }

  let normalized = args;
  const first = normalized[0];
  if (first === "status" || first === "update") {
    normalized = ["ws", first, ...normalized.slice(1)];
  } else if (first === "workitem") {
    normalized = ["wi", ...normalized.slice(1)];
  }

  if (!workspace) return normalized;
  if (normalized.length === 0) normalized = ["ws", "status"];

  if (
    normalized[0] === "sync" ||
    (normalized[0] === "ws" && WORKSPACE_TARGET_SUBCOMMANDS.has(normalized[1] ?? "status"))
  ) {
    return [...normalized, "--ws", workspace];
  }
  return ["--ws", workspace, ...normalized];
}

export async function runCli(ambient?: AmbientContext): Promise<number> {
  const currentAmbient = ambient ?? createDefaultAmbient();
  ui.reset();
  setAmbient(currentAmbient);
  process.exitCode = 0;

  const argv = currentAmbient.argv;

  // Handle help, version, and llms early
  if (argv.length === 0) {
    ui.log(await formatHelp(false));
    return 0;
  }

  // `dev help ws add` is `dev ws add --help`.
  if (argv[0] === "help") {
    ui.log(await formatCommandHelp(normalizeCliArgs(argv.slice(1))));
    return 0;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.includes("--llms")) {
      ui.log(await formatHelp(true));
    } else {
      const words = normalizeCliArgs(
        argv.filter((argument) => argument !== "--help" && argument !== "-h"),
      ).filter((argument) => !argument.startsWith("-"));
      ui.log(await formatCommandHelp(words));
    }
    return 0;
  }

  if (argv.includes("--llms")) {
    ui.log(await formatHelp(true));
    return 0;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    ui.log(`dev v${VERSION}`);
    return 0;
  }

  // Handle shortcut commands directly at root:
  // dev status -> dev ws status
  // dev update -> dev ws update
  const normalizedArgs = normalizeCliArgs(argv);

  try {
    const result = await runCommand(mainCommand, { rawArgs: normalizedArgs });
    if (ui.hasError()) {
      return 1;
    }
    if (typeof result === "number") {
      return result;
    }
    if (
      result &&
      typeof result === "object" &&
      "result" in result &&
      typeof result.result === "number"
    ) {
      return result.result;
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof CliInputRequiredError) {
      if (currentAmbient.argv.includes("--json")) {
        return reportError(error, true);
      }
      ui.error(`✗ ${error.message}`);
      ui.error(`↳ ${error.details.usage}`);
      return 1;
    }

    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Unknown command")) {
      // eslint-disable-next-line no-control-regex
      const cleanMsg = msg.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
      const match = cleanMsg.match(/Unknown command\s+([^\s]+)/i);
      const cmdName = match ? match[1] : argv[0];
      ui.error(`✗ Unknown command: '${cmdName}'`);
      ui.error(`↳ ${(await suggestCommand(normalizedArgs)) ?? "dev --help"}`);
      return 1;
    }

    return reportError(error, currentAmbient.argv.includes("--json"));
  }
}

if (import.meta.main) {
  runCli()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((error) => {
      ui.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
