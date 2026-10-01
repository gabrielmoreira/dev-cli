import { defineCommand } from "citty";
import { generateShellInit } from "../nav.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";

export const shellInitCommand = defineCommand({
  meta: {
    name: "shell-init",
    description: "Generate shell wrapper functions for bash, zsh, fish, or powershell",
  },
  args: {
    shell: {
      type: "positional",
      description: "Target shell: bash, zsh, fish, powershell, or pwsh",
      required: false,
    },
    runner: {
      type: "string",
      description: "CLI runner used by wrappers: direct or mise",
    },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  run({ args }) {
    const shellType = args.shell || (process.platform === "win32" ? "powershell" : "bash");
    const runner = args.runner ?? "direct";
    if (runner !== "direct" && runner !== "mise") {
      return reportError("--runner must be 'direct' or 'mise'.");
    }
    const script = generateShellInit(shellType, runner);
    ui.result({
      data: { shell: shellType, script },
      json: args.json,
      text: () => script,
    });
    return 0;
  },
});
