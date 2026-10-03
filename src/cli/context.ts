import { parseArgs } from "citty";
import type { RuntimeConfig } from "../config.ts";
import { resolveConfig } from "../config.ts";
import { ui } from "../ui.ts";

export interface AmbientContext {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
}

let currentAmbient: AmbientContext = {
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: { ...process.env },
  isTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stderrIsTTY: Boolean(process.stderr.isTTY),
};

export function getAmbient(): AmbientContext {
  return currentAmbient;
}

export function setAmbient(ambient: AmbientContext): void {
  currentAmbient = ambient;
  const flags = readGlobalFlags(ambient.argv);
  ui.setQuiet(Boolean(flags.quiet || flags.json));
  ui.setJson(Boolean(flags.json));
}

/** One parser definition keeps narration, output, and prompt policy in lockstep. */
function readGlobalFlags(argv: string[]) {
  return parseArgs(argv, {
    json: { type: "boolean" },
    quiet: { type: "boolean", alias: "q" },
    "non-interactive": { type: "boolean" },
  });
}

/**
 * Variables coding agents set in the shells they run: the AI_AGENT and AGENT
 * conventions plus the tool-specific ones @vercel/detect-agent checks.
 */
const AGENT_ENV = [
  "AI_AGENT",
  "AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
];

export function canPrompt(ambient: AmbientContext = currentAmbient): boolean {
  const flags = readGlobalFlags(ambient.argv);
  return (
    (ambient.stdinIsTTY ?? ambient.isTTY) &&
    (ambient.isTTY || ambient.stderrIsTTY === true) &&
    !flags.json &&
    !flags["non-interactive"] &&
    !ambient.env.CI &&
    !AGENT_ENV.some((name) => ambient.env[name])
  );
}

export function findRootFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--root=")) {
      return argv[i].slice("--root=".length);
    }
  }
  return undefined;
}

export function findWorkspaceFlag(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--ws" && index + 1 < argv.length) return argv[index + 1];
    if (argv[index].startsWith("--ws=")) return argv[index].slice("--ws=".length);
  }
  return undefined;
}

export function getActiveConfig(rootFlag?: string): RuntimeConfig {
  const ambient = getAmbient();
  return resolveConfig({
    rootFlag: rootFlag ?? findRootFlag(ambient.argv),
    cwd: ambient.cwd,
    env: ambient.env,
  });
}
