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
  MANIFEST_NOT_FOUND: "dev ls",
  MOUNT_ALREADY_EXISTS: "dev ws status",
  MOUNT_NOT_FOUND: "dev ws status",
  MOUNT_PATH_EXISTS_ON_DISK: "dev ws add <source> --path <another-name>",
  PROVIDER_NOT_CONFIGURED: "dev provider add <type>",
  PROVIDER_NOT_FOUND: "dev provider list",
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

/** What each exit code means; published in `dev --help --llms`. */
export const EXIT_CODE_MEANINGS: Record<number, string> = {
  0: "success, including when nothing needed to change",
  1: "failed for a reason not listed below",
  2: "wrong usage, or input is required and the session cannot prompt",
  3: "refused because acting would discard or overwrite something: uncommitted work, local commits, an existing mount, workspace or workset, an untrusted hook",
  4: "something outside dev failed: credentials, a provider API, HerdR, or a hook",
  130: "cancelled by the user",
};

export const EXIT_USAGE = 2;
const EXIT_CODES: Record<string, number> = {
  CONFLICTING_OPTIONS: EXIT_USAGE,
  INTERACTION_REQUIRED: EXIT_USAGE,
  INVALID_MOUNT_PATH: EXIT_USAGE,
  INVALID_SOURCE: EXIT_USAGE,
  INVALID_WORKSPACE_NAME: EXIT_USAGE,
  PROVIDER_NOT_CONFIGURED: EXIT_USAGE,
  PROVIDER_NOT_FOUND: EXIT_USAGE,
  LABEL_VALIDATION: EXIT_USAGE,
  // mirror add --branch <default>: that checkout is the mirror itself.
  DEFAULT_BRANCH: EXIT_USAGE,

  BRANCH_ALREADY_MOUNTED: 3,
  DIRTY_WORKTREE: 3,
  MOUNT_ALREADY_EXISTS: 3,
  MOUNT_PATH_EXISTS_ON_DISK: 3,
  UNSAFE_REMOVE: 3,
  UNTRUSTED_HOOK_BLOCKED: 3,
  WORKSET_EXISTS: 3,
  WORKSET_LAST_MEMBER: 3,
  WORKSET_MEMBER_EXISTS: 3,
  WORKSPACE_ALREADY_EXISTS: 3,

  API_ERROR: 4,
  AUTH_FAILED: 4,
  CREDENTIAL_NOT_AVAILABLE: 4,
  HERDR_AMBIGUOUS_SESSION: 4,
  HERDR_COMMAND_FAILED: 4,
  HERDR_INVALID_RESPONSE: 4,
  HERDR_SERVER_START_TIMEOUT: 4,
  HERDR_SESSION_NOT_RUNNING: 4,
  HOOK_FAILED: 4,
  PULL_REQUEST_UNAVAILABLE: 4,
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

// citty drops the value a subcommand returns, so the code reportError decided
// is kept here for runCli to read.
let reportedExitCode: number | undefined;

/** The exit code of the last reported error since the previous call, if any. */
export function takeReportedExitCode(): number | undefined {
  const code = reportedExitCode;
  reportedExitCode = undefined;
  return code;
}

/**
 * Reports a failure the same way everywhere: the hazard, then the way out.
 * Returns the exit code so a handler can `return reportError(error, args.json)`.
 */
export function reportError(error: unknown, json?: boolean): number {
  // The prompt already shows it was cancelled; 130 is the shell's code for Ctrl+C.
  if (error instanceof CancelledError) return (reportedExitCode = 130);
  const described = describeError(error);
  reportedExitCode = exitCodeOf(described.code);

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
    return reportedExitCode;
  }

  ui.error(`✗ ${described.message}`);
  if (described.nextStep) ui.error(`↳ ${described.nextStep}`);
  return reportedExitCode;
}

function exitCodeOf(code: string | undefined): number {
  return (code && EXIT_CODES[code]) || 1;
}
