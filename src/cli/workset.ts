import { defineCommand } from "citty";
import { ui } from "../ui.ts";
import { getActiveConfig } from "./context.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

export const worksetListCommand = defineCommand({
  meta: { name: "list", description: "List configured worksets" },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const worksets = Object.entries(config.worksets)
      .map(([name, workset]) => ({
        name,
        description: workset.description,
        memberCount: workset.members.length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    ui.result({
      data: worksets,
      json: args.json,
      text: () =>
        worksets.length === 0
          ? "No worksets configured."
          : worksets
              .map(
                (workset) =>
                  `${workset.name} (${workset.memberCount})${workset.description ? ` — ${workset.description}` : ""}`,
              )
              .join("\n"),
    });
    return 0;
  },
});

export const worksetShowCommand = defineCommand({
  meta: { name: "show", description: "Show one configured workset" },
  args: {
    name: { type: "positional", description: "Workset name", required: true },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workset = config.worksets[args.name];
    if (!workset) {
      ui.error(`Error: Unknown workset '${args.name}'.`);
      return 1;
    }
    const data = { name: args.name, ...workset };
    ui.result({
      data,
      json: args.json,
      text: () => {
        const lines = [
          `${args.name}${workset.description ? ` — ${workset.description}` : ""}`,
          ...workset.members.map((member) => {
            const ref = member.ref ? ` @ ${member.ref}` : "";
            const path = member.path ? ` → ${member.path}` : "";
            const reason = member.reason ? ` — ${member.reason}` : "";
            return `  ${member.source}${ref}${path}${reason}`;
          }),
        ];
        return lines.join("\n");
      },
    });
    return 0;
  },
});

export const worksetCommand = defineCommand({
  meta: { name: "workset", description: "Inspect reusable repository worksets" },
  subCommands: {
    list: worksetListCommand,
    show: worksetShowCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(worksetCommand, rawArgs)) return;
    return await runNestedCommand(worksetListCommand, ["", ...rawArgs]);
  },
});
