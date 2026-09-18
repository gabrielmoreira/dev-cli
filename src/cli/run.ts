import { runCommand, type ArgsDef, type CommandDef } from "citty";

async function resolveDefinition<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  if (typeof value === "function") return await (value as () => T | Promise<T>)();
  return await value;
}

const normalizeFlagName = (value: string): string =>
  value.replace(/^--?/, "").replace(/[-_]/g, "").toLowerCase();

export async function hasExplicitSubcommand<T extends ArgsDef>(
  command: CommandDef<T>,
  rawArgs: string[],
): Promise<boolean> {
  const args = await resolveDefinition(command.args ?? ({} as T));
  const subCommands = await resolveDefinition(command.subCommands ?? {});
  let candidate: string | undefined;

  for (let index = 0; index < rawArgs.length; index++) {
    const argument = rawArgs[index];
    if (argument === undefined) break;
    if (!argument.startsWith("-")) {
      candidate = argument;
      break;
    }
    if (argument.includes("=")) continue;

    const flag = normalizeFlagName(argument);
    const takesValue = Object.entries(args).some(([name, definition]) => {
      if (definition.type !== "string" && definition.type !== "enum") return false;
      const aliases = Array.isArray(definition.alias)
        ? definition.alias
        : definition.alias
          ? [definition.alias]
          : [];
      return (
        normalizeFlagName(name) === flag ||
        aliases.some((alias) => normalizeFlagName(alias) === flag)
      );
    });
    if (takesValue) index++;
  }

  return candidate !== undefined && Object.hasOwn(subCommands, candidate);
}

export async function runNestedCommand<T extends ArgsDef>(
  command: CommandDef<T>,
  rawArgs: string[],
): Promise<unknown> {
  return (await runCommand(command, { rawArgs })).result;
}
