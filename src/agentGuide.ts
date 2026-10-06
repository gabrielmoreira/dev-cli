/**
 * What an agent should read or run, keyed by the task it is doing, and the
 * follow-up command of a command path. Both surfaces render from here: the
 * block at the end of `dev --help` and the `resources` list in `--llms`.
 */
export type AgentResource = {
  /** What the reader is trying to do, in the reader's words. */
  task: string;
  /** A page to read or a command to run. Never both. */
  action: string;
  kind: "page" | "command";
  /** Optional guard, for an action the reader may already have. */
  note?: string;
};

export const AGENT_RESOURCES: readonly AgentResource[] = [
  {
    task: "Set up or explain a dev root for a human",
    action: "https://github.com/gabrielmoreira/dev-cli/blob/main/docs/setup.md",
    kind: "page",
  },
  {
    task: "Debug a workspace, mount, sync or hook problem",
    action: "https://github.com/gabrielmoreira/dev-cli/blob/main/docs/integrations.md",
    kind: "page",
  },
  {
    task: "Drive dev from a script or an agent",
    action: "dev skill",
    kind: "command",
    note: "Skip if the dev skill is already in your context",
  },
  {
    task: "Ask for exact arguments, exit codes and error codes",
    action: "dev --help --llms",
    kind: "command",
  },
];

/** The follow-up command of a command path, printed as `next:` in that command's help. */
export const HELP_NEXT_STEPS: Readonly<Record<string, string>> = {
  "ws init": "dev ws add <repository-url> --ws <name>",
  "ws add": "dev go <workspace>",
  "provider add": "dev sync inventory",
  "workset manage": "dev ws init --workset <name>",
};

/** The block an agent reads at the end of `dev --help`. */
export function renderAgentResources(): string {
  const lines = ["Are you an AI? Use these resources only if your task asks for them:"];
  for (const { task, action, note } of AGENT_RESOURCES) {
    lines.push(`  ${task}:`);
    lines.push(`    ${note ? `${note}. Otherwise run: ${action}` : action}`);
  }
  return lines.join("\n");
}
