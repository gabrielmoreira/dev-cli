import { defineCommand } from "citty";
import SKILL from "../../skills/dev/SKILL.md" with { type: "text" };
import { ui } from "../ui.ts";

/** One frontmatter field of the skill file, so the JSON answer needs no second copy of it. */
function frontmatterValue(markdown: string, field: string): string {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  return line
    ? line
        .slice(field.length + 1)
        .trim()
        .replace(/^"|"$/g, "")
    : "";
}

export const skillCommand = defineCommand({
  meta: {
    name: "skill",
    description: "Print the instructions for an agent operating a dev root",
  },
  args: {
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    ui.result({
      data: {
        name: frontmatterValue(SKILL, "name"),
        description: frontmatterValue(SKILL, "description"),
        content: SKILL,
      },
      json: args.json,
      text: () => SKILL.trimEnd(),
    });
  },
});
