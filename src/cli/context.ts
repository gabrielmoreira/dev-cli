import type { RuntimeConfig } from "../config.ts";
import { resolveConfig } from "../config.ts";
import { ui } from "../ui.ts";

export interface AmbientContext {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  stdinIsTTY?: boolean;
}

let currentAmbient: AmbientContext = {
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: { ...process.env },
  isTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
};

export function getAmbient(): AmbientContext {
  return currentAmbient;
}

export function setAmbient(ambient: AmbientContext): void {
  currentAmbient = ambient;
  const isQuiet =
    ambient.argv.includes("--quiet") ||
    ambient.argv.includes("-q") ||
    ambient.argv.includes("--json");
  ui.setQuiet(isQuiet);
}

export function canPrompt(ambient: AmbientContext = currentAmbient): boolean {
  return (
    (ambient.stdinIsTTY ?? ambient.isTTY) &&
    ambient.isTTY &&
    !ambient.argv.includes("--json") &&
    !ambient.argv.includes("--non-interactive") &&
    !ambient.env.CI
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
