import { defineCommand } from "citty";
import {
  DEFAULT_SHELL,
  DEFAULT_SHELL_BY_PLATFORM,
  DEFAULT_SHELL_RUNNER,
  generateShellInit,
} from "../nav.ts";
import { ui } from "../ui.ts";
import { WorkspaceError } from "../ws.ts";

export const shellInitCommand = defineCommand({
  meta: {
    name: "shell-init",
    description: "Generate shell wrapper functions for bash, zsh, fish, or powershell",
  },
  args: {
    shell: {
      type: "positional",
      description: `Target shell: bash, zsh, fish, powershell, or pwsh (default: ${DEFAULT_SHELL_BY_PLATFORM.win32} on Windows, ${DEFAULT_SHELL_BY_PLATFORM.other} elsewhere)`,
      required: false,
    },
    runner: {
      type: "string",
      description: `CLI runner used by wrappers: direct or mise (default: ${DEFAULT_SHELL_RUNNER})`,
    },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  run({ args }) {
    const shellType = args.shell;
    const runner = args.runner;
    if (runner !== undefined && runner !== "direct" && runner !== "mise") {
      throw new WorkspaceError(
        "INVALID_ARGUMENT",
        `Unknown runner '${runner}'. Choose direct or mise.`,
        { runner, choices: ["direct", "mise"], usage: "dev shell-init --help" },
      );
    }
    const script = generateShellInit(shellType, runner);
    ui.result({
      data: { shell: shellType ?? DEFAULT_SHELL, script },
      json: args.json,
      text: () => script,
    });
    return 0;
  },
});
