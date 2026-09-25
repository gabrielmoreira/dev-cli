import { defineCommand, renderUsage, runCommand, type ArgDef, type CommandDef } from "citty";
import { wsCommand, wsGoCommand, wsListCommand, wsStartCommand } from "./ws.ts";
import { mirrorCommand } from "./mirror.ts";
import { syncCommand } from "./sync.ts";
import { prCommand } from "./pr.ts";
import { wiCommand } from "./wi.ts";
import { doctorCommand, hardwareCommand } from "./doctor.ts";
import { shellInitCommand } from "./shell.ts";
import { initCommand, useCommand, currentCommand, rootCommand, rootsCommand } from "./root.ts";
import { providerCommand } from "./provider.ts";
import { type AmbientContext, setAmbient } from "./context.ts";
import { detectWorkspaceFromCwd, WorkspaceError } from "../ws.ts";
import { ui } from "../ui.ts";
import { CliInputRequiredError } from "./input.ts";
import { EXIT_CODE_MEANINGS, EXIT_USAGE, reportError, takeReportedExitCode } from "./errors.ts";
import { qmdCommand, qmdSearchCommand, qmdXCommand } from "./qmd.ts";
import { worksetCommand } from "./workset.ts";
import { VERSION } from "../version.ts";
import { parsePullRequestUrl } from "../pr-workspace.ts";

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
      exitCodes: EXIT_CODE_MEANINGS,
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
 * exactly that name (`dev lock` -> `dev ws lock`).
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

/** Hands everything after its name to another program, so any option is fine. */
const PASSTHROUGH_COMMANDS = new Set<unknown>([qmdXCommand, qmdSearchCommand]);

/** `dry-run` and `dryRun` spell the same option, as citty reads it; `dryrun` does not. */
function optionKey(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The first option no command on the path declares. citty ignores those
 * silently, so a typo like `--dryrun` would run the real thing. A command
 * called without a subcommand may hand off to one (`dev ws` lists), so
 * the options of its subcommands count too.
 */
export async function findUnknownOption(
  argv: string[],
): Promise<{ option: string; command: string; suggestion?: string } | undefined> {
  const known = new Map<string, { name: string; takesValue: boolean }>();
  const learn = async (command: InspectableCommand) => {
    for (const [name, definition] of Object.entries(await resolveDefinition(command.args ?? {}))) {
      if (definition.type === "positional") continue;
      const option = {
        name,
        takesValue: definition.type === "string" || definition.type === "enum",
      };
      known.set(optionKey(name), option);
      const aliases = "alias" in definition ? definition.alias : undefined;
      for (const alias of typeof aliases === "string" ? [aliases] : (aliases ?? [])) {
        known.set(optionKey(alias), option);
      }
    }
  };

  // Walk the path the way citty does: the first word that is not an option or its value.
  let command = mainCommand as unknown as InspectableCommand;
  const names = ["dev"];
  await learn(command);
  let rest = argv;
  for (;;) {
    const subCommands = await subCommandsOf(command);
    if (Object.keys(subCommands).length === 0) break;
    const index = rest.findIndex(
      (word, i) =>
        !word.startsWith("-") &&
        !(
          i > 0 &&
          !rest[i - 1]!.includes("=") &&
          known.get(optionKey(rest[i - 1]!.replace(/^-+/, "")))?.takesValue
        ),
    );
    if (index < 0) {
      for (const child of Object.values(subCommands)) await learn(await resolveDefinition(child));
      break;
    }
    const next = subCommands[rest[index]!];
    // Not a command: citty reports that, with its own suggestion.
    if (!next) return undefined;
    command = await resolveDefinition(next);
    names.push(rest[index]!);
    if (PASSTHROUGH_COMMANDS.has(command)) return undefined;
    await learn(command);
    rest = rest.slice(index + 1);
  }

  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === "--") break;
    if (!word.startsWith("-") || word === "-") continue;
    const name = word.replace(/^-+/, "").split("=")[0]!;
    const option = known.get(optionKey(name)) ?? known.get(optionKey(name.replace(/^no-/, "")));
    if (option) {
      if (option.takesValue && !word.includes("=")) index++;
      continue;
    }
    const suggestion = [...new Set([...known.values()].map((candidate) => candidate.name))]
      .map((candidate) => ({
        candidate,
        distance: editDistance(optionKey(candidate), optionKey(name)),
      }))
      .filter(({ distance }) => distance <= Math.min(2, Math.max(1, Math.floor(name.length / 2))))
      .sort((x, y) => x.distance - y.distance)[0]?.candidate;
    return {
      option: word.split("=")[0]!,
      command: names.join(" "),
      suggestion: suggestion ? `--${suggestion}` : undefined,
    };
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
    start: wsStartCommand,
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
  } else if (first && parsePullRequestUrl(first)) {
    // A pull request URL names its own intent: `dev <url>` is `dev ws init <url>`.
    normalized = ["ws", "init", ...normalized];
  } else if (first === "ws" && normalized[1] && parsePullRequestUrl(normalized[1])) {
    normalized = ["ws", "init", ...normalized.slice(1)];
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
  takeReportedExitCode();
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
  if (normalizedArgs[1] === "init" && !argv.includes("init")) {
    ui.info(`↳ dev ws init ${normalizedArgs[2]}`);
  }

  const unknownOption = await findUnknownOption(normalizedArgs);
  if (unknownOption) {
    const { option, command, suggestion } = unknownOption;
    return reportError(
      new WorkspaceError(
        "UNKNOWN_OPTION",
        `'${command}' has no option ${option}${suggestion ? `; did you mean ${suggestion}?` : "."}`,
        { option, usage: suggestion ? `${command} ${suggestion}` : `${command} --help` },
      ),
      currentAmbient.argv.includes("--json"),
    );
  }

  try {
    const result = await runCommand(mainCommand, { rawArgs: normalizedArgs });
    const code =
      typeof result === "number"
        ? result
        : result &&
            typeof result === "object" &&
            "result" in result &&
            typeof result.result === "number"
          ? result.result
          : 0;
    if (code !== 0) return code;
    // A nested command's return value never reaches here; a handler that
    // printed an error without reporting a code still failed.
    return takeReportedExitCode() ?? (ui.hasError() ? 1 : 0);
  } catch (error: unknown) {
    if (error instanceof CliInputRequiredError) {
      if (currentAmbient.argv.includes("--json")) {
        return reportError(error, true);
      }
      ui.error(`✗ ${error.message}`);
      ui.error(`↳ ${error.details.usage}`);
      return EXIT_USAGE;
    }

    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Unknown command")) {
      // eslint-disable-next-line no-control-regex
      const cleanMsg = msg.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
      const match = cleanMsg.match(/Unknown command\s+([^\s]+)/i);
      const cmdName = match ? match[1] : argv[0];
      ui.error(`✗ Unknown command: '${cmdName}'`);
      ui.error(`↳ ${(await suggestCommand(normalizedArgs)) ?? "dev --help"}`);
      return EXIT_USAGE;
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
