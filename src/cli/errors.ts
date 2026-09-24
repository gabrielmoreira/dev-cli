import { CancelledError, ui } from "../ui.ts";

/**
 * The command that gets the user out of each failure. One line per code, defined once.
 * A code with no entry prints the message alone: a hint nobody can act on is noise.
 * A `<key>` placeholder is filled from the error's details when it has that key;
 * otherwise it stays as syntax for the user to fill in.
 */
const NEXT_STEPS: Record<string, string> = {
  BRANCH_ALREADY_MOUNTED: "dev ws status",
  CREDENTIAL_NOT_AVAILABLE: "gh auth login    # or: az login",
  DIVERGED: "dev ws update --rebase",
  MANIFEST_NOT_FOUND: "dev ls",
  MOUNT_ALREADY_EXISTS: "dev ws status",
  MOUNT_NOT_FOUND: "dev ws status",
  MOUNT_PATH_EXISTS_ON_DISK: "dev ws add <source> --path <another-name>",
  PULL_REQUEST_UNAVAILABLE: "dev pr list",
  UNSAFE_REMOVE: "git -C <path> status",
  UNTRUSTED_HOOK_BLOCKED: "rerun with --consent to allow hooks from <source>",
  WORKSET_EXISTS: "dev workset list",
  WORKSET_MEMBER_EXISTS: "dev workset list",
  WORKSET_MEMBER_NOT_FOUND: "dev workset list",
  WORKSET_NOT_FOUND: "dev workset list",
  WORKSPACE_ALREADY_EXISTS: "dev go <name>",
  WORKSPACE_NOT_FOUND: "dev ls",
  WORKTREE_NOT_FOUND: "dev ws sync",
};

export interface StructuredError {
  code?: string;
  message: string;
  nextStep?: string;
  details?: Record<string, unknown>;
}

function detailsOf(error: unknown): Record<string, unknown> | undefined {
  const raw = (error as { details?: unknown } | null)?.details;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

function fillPlaceholders(hint: string, details?: Record<string, unknown>): string {
  return hint.replace(/<(\w+)>/g, (whole, key: string) => {
    const value = details?.[key];
    return typeof value === "string" && value.length > 0 ? value : whole;
  });
}

/** Turns any thrown value into the shape both the terminal and `--json` render from. */
export function describeError(error: unknown): StructuredError {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  const details = detailsOf(error);
  const hint = code ? NEXT_STEPS[code] : undefined;

  return {
    code,
    message,
    nextStep: hint ? fillPlaceholders(hint, details) : undefined,
    details,
  };
}

/**
 * Reports a failure the same way everywhere: the hazard, then the way out.
 * Returns the exit code so a handler can `return reportError(error, args.json)`.
 */
export function reportError(error: unknown, json?: boolean): number {
  // The prompt already shows it was cancelled; 130 is the shell's code for Ctrl+C.
  if (error instanceof CancelledError) return 130;
  const described = describeError(error);

  if (json) {
    ui.error(
      JSON.stringify(
        {
          error: {
            code: described.code ?? "ERROR",
            message: described.message,
            ...(described.nextStep ? { nextStep: described.nextStep } : {}),
            ...described.details,
          },
        },
        null,
        2,
      ),
    );
    return 1;
  }

  ui.error(`✗ ${described.message}`);
  if (described.nextStep) ui.error(`↳ ${described.nextStep}`);
  return 1;
}
