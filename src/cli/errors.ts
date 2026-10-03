import { CancelledError, ui } from "../ui.ts";
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current: number[] = [];
  current.length = b.length + 1;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    const previousRow = previous;
    previous = current;
    current = previousRow;
  }
  return previous[b.length]!;
}

/** A nearby name must be within two edits and closer than half the query. */
export function closestName(value: string, candidates: readonly string[]): string | undefined {
  let closest: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - value.length) >= bestDistance) continue;
    const distance = editDistance(candidate, value);
    if (distance < bestDistance && distance < value.length / 2) {
      closest = candidate;
      bestDistance = distance;
    }
  }
  return closest;
}

/**
 * The command that gets the user out of each failure. One line per code, defined once.
 * A code with no entry prints the message alone: a hint nobody can act on is noise.
 * A `<key>` placeholder is filled from the error's details when it has that key;
 * otherwise it stays as syntax for the user to fill in.
 */
export const NEXT_STEPS: Record<string, string | undefined> = {
  BRANCH_ALREADY_MOUNTED: "dev ws status",
  API_ERROR: undefined,
  AUTH_FAILED: "gh auth login    # or: az login",
  CANCELLED: undefined,
  CANNOT_DETERMINE_COMMIT: "dev ws status",
  CONFLICTING_OPTIONS: "Remove conflicting options, or make explicit selectors agree.",
  DEFAULT_BRANCH: "dev mirror ls",
  DEFAULT_BRANCH_UNKNOWN: "Pass --branch <branch> explicitly.",
  DIRTY_WORKTREE: "dev ws status",
  ERROR: undefined,
  FAILED: undefined,
  FILE_LOCKED: "Wait for the active writer of <path> to finish, then retry.",
  HERDR_AMBIGUOUS_SESSION: "Pass --session <name> explicitly.",
  HERDR_COMMAND_FAILED: undefined,
  HERDR_INVALID_RESPONSE: undefined,
  HERDR_SERVER_START_TIMEOUT: "herdr server status",
  HERDR_SESSION_NOT_RUNNING: "herdr session list",
  HOOK_FAILED: undefined,
  INTERACTION_REQUIRED: "<usage>",
  CREDENTIAL_NOT_AVAILABLE: "gh auth login    # or: az login",
  INVALID_ARGUMENT: "<usage>",
  INVALID_CONFIG: "Edit <path> to fix the configuration syntax or values, then retry.",
  INVALID_GLOBAL_TOML: "Edit <path> to fix the TOML syntax or root entries, then retry.",
  INVALID_LABEL_FIELD:
    "Pass fields as key=value pairs, using names and types declared for the label in dev.yaml.",
  INVALID_MANIFEST: "Edit <filePath> to fix the workspace manifest, then retry.",
  INVALID_MOUNT_PATH: "Choose a relative mount path without '..' or an absolute path prefix.",
  INVALID_SOURCE: "Pass a repository URL or local path.",
  INVALID_UPDATE_PLAN: undefined,
  INVALID_WORKSPACE_NAME: "Pass a non-empty workspace name without path separators.",
  LABEL_NOT_FOUND: "dev label list",
  LABEL_VALIDATION: "Check the label fields and repository assignments in dev.yaml, then retry.",
  MANIFEST_NOT_FOUND: "dev ls",
  MIRROR_ADMIN_MISSING: "dev mirror ls",
  MIRROR_PATH_COLLISION: 'git -C "<path>" status',
  MOUNT_ALREADY_DECLARED: "dev ws status",
  MOUNT_ALREADY_EXISTS: "dev ws status",
  MOUNT_NOT_FOUND: "dev ws status",
  MOUNT_PATH_EXISTS_ON_DISK: "dev ws add <repository> --path <another-name>",
  PROVIDER_NOT_CONFIGURED: "dev provider add <type>",
  PROVIDER_NOT_FOUND: "dev provider list",
  NETWORK: "Check connectivity to the repository or provider, then retry.",
  NOT_FOUND: "Check the repository URL or provider resource, then retry.",
  PATH_OUTSIDE_ROOT: "Choose a path inside <root>.",
  PULL_REQUEST_UNAVAILABLE: "dev pr list",
  QMD_FAILED: "dev qmd sync --help",
  RATE_LIMITED: "Wait for the provider rate limit to reset, then retry.",
  REBASE_ABORT_FAILED: 'git -C "<worktreePath>" status',
  REMOVE_FAILED: 'git -C "<path>" status',
  ROOT_ALIAS_EXISTS: "dev roots",
  ROOT_NOT_FOUND: "dev roots",
  REF_NOT_FOUND: 'git ls-remote --heads --tags "<repository>"',
  SOURCE_AMBIGUOUS: "<usage>",
  SOURCE_NOT_FOUND: "<usage>",
  STASH_RESTORE_FAILED: "<recovery>",
  UNMANAGED_CHECKOUT: 'git -C "<path>" status',
  UNSAFE_REMOVE: "git -C <path> status",
  UNTRUSTED_HOOK_BLOCKED: "rerun with --consent to allow hooks from <repository>",
  WORKSET_EXISTS: "dev workset list",
  WORKSET_CONFIG_UNWRITABLE: "Use a dev root with dev.yaml: dev init <path>.",
  WORKSET_LAST_MEMBER: "dev workset show <workset>",
  WORKSET_MEMBER_EXISTS: "dev workset list",
  WORKSET_MEMBER_NOT_FOUND: "dev workset list",
  WORKSET_NOT_FOUND: "dev workset list",
  UNKNOWN_COMMAND: "<usage>",
  // The corrected command when an option is near a known one, else the command's help.
  UNKNOWN_OPTION: "<usage>",
  WORKSPACE_ALREADY_EXISTS: "dev go <name>",
  WORKSPACE_NOT_FOUND: "dev ls",
  WORKTREE_NOT_FOUND: "dev ws update",
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
export const EXIT_CODES: Record<string, number> = {
  // Deliberate generic failures retain their existing exit status.
  CANNOT_DETERMINE_COMMIT: 1,
  ERROR: 1,
  FAILED: 1,
  INVALID_UPDATE_PLAN: 1,
  LABEL_NOT_FOUND: 1,
  MANIFEST_NOT_FOUND: 1,
  MIRROR_ADMIN_MISSING: 1,
  MOUNT_NOT_FOUND: 1,
  NOT_FOUND: 1,
  REBASE_ABORT_FAILED: 1,
  REMOVE_FAILED: 1,
  STASH_RESTORE_FAILED: 1,
  WORKSET_MEMBER_NOT_FOUND: 1,
  WORKSET_NOT_FOUND: 1,
  WORKSPACE_NOT_FOUND: 1,
  WORKTREE_NOT_FOUND: 1,

  CANCELLED: 130,
  CONFLICTING_OPTIONS: EXIT_USAGE,
  INTERACTION_REQUIRED: EXIT_USAGE,
  INVALID_ARGUMENT: EXIT_USAGE,
  INVALID_CONFIG: EXIT_USAGE,
  INVALID_GLOBAL_TOML: EXIT_USAGE,
  INVALID_MANIFEST: EXIT_USAGE,
  INVALID_MOUNT_PATH: EXIT_USAGE,
  INVALID_SOURCE: EXIT_USAGE,
  INVALID_WORKSPACE_NAME: EXIT_USAGE,
  DEFAULT_BRANCH_UNKNOWN: EXIT_USAGE,
  PATH_OUTSIDE_ROOT: EXIT_USAGE,
  ROOT_NOT_FOUND: EXIT_USAGE,
  WORKSET_CONFIG_UNWRITABLE: EXIT_USAGE,
  PROVIDER_NOT_CONFIGURED: EXIT_USAGE,
  PROVIDER_NOT_FOUND: EXIT_USAGE,
  REF_NOT_FOUND: EXIT_USAGE,
  SOURCE_AMBIGUOUS: EXIT_USAGE,
  SOURCE_NOT_FOUND: EXIT_USAGE,
  LABEL_VALIDATION: EXIT_USAGE,
  INVALID_LABEL_FIELD: EXIT_USAGE,
  UNKNOWN_COMMAND: EXIT_USAGE,
  UNKNOWN_OPTION: EXIT_USAGE,
  // mirror add --branch <default>: that checkout is the mirror itself.
  DEFAULT_BRANCH: EXIT_USAGE,

  BRANCH_ALREADY_MOUNTED: 3,
  DIRTY_WORKTREE: 3,
  FILE_LOCKED: 3,
  MIRROR_PATH_COLLISION: 3,
  MOUNT_ALREADY_DECLARED: 3,
  ROOT_ALIAS_EXISTS: 3,
  UNMANAGED_CHECKOUT: 3,
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
  NETWORK: 4,
  QMD_FAILED: 4,
  RATE_LIMITED: 4,
};

export interface StructuredError {
  code?: string;
  message: string;
  nextStep?: string;
  details?: Record<string, unknown>;
}

function detailsOf(error: unknown): Record<string, unknown> | undefined {
  const raw = (error as { details?: unknown } | null)?.details;
  if (!raw || typeof raw !== "object") return undefined;
  const details = raw as Record<string, unknown>;
  if (!Object.hasOwn(details, "source")) return details;
  const { source, ...rest } = details;
  return { ...rest, repository: source };
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
  const code =
    rawCode === "E_UNKNOWN_COMMAND"
      ? "UNKNOWN_COMMAND"
      : rawCode === "EARG" || rawCode === "E_NO_COMMAND"
        ? "INTERACTION_REQUIRED"
        : typeof rawCode === "string"
          ? rawCode
          : undefined;
  const details =
    rawCode === "E_UNKNOWN_COMMAND" || rawCode === "EARG" || rawCode === "E_NO_COMMAND"
      ? { usage: "dev --help", ...detailsOf(error) }
      : detailsOf(error);
  const hint = code ? NEXT_STEPS[code] : undefined;

  return {
    code,
    message,
    nextStep:
      typeof details?.usage === "string"
        ? details.usage
        : hint
          ? fillPlaceholders(hint, details)
          : undefined,
    details,
  };
}

// citty drops the value a subcommand returns, so reported codes
// are kept here for runCli to read.
let reportedExitCode: number | undefined;

/** Records a handler's failure code, since citty drops what a nested `run` returns. */
export function reportExitCode(code: number): number {
  if (code !== 0) reportedExitCode = code;
  return code;
}

/** The last reported exit code since the previous call, if any. */
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

  if (json || ui.isJson()) {
    ui.error(
      JSON.stringify(
        {
          error: {
            code: described.code ?? "ERROR",
            message: described.message,
            ...(described.nextStep ? { nextStep: described.nextStep } : {}),
            ...described.details,
            ...(Array.isArray(described.details?.candidates) ? { details: described.details } : {}),
          },
        },
        null,
        2,
      ),
    );
    return reportedExitCode;
  }

  // A relink that failed first usually explains the failure: show it before.
  const healWarnings = described.details?.healWarnings;
  if (Array.isArray(healWarnings)) for (const warning of healWarnings) ui.warn(`⚠ ${warning}`);
  ui.error(`✗ ${described.message}`);
  const candidates = described.details?.candidates;
  if (Array.isArray(candidates) && candidates.every((candidate) => typeof candidate === "string")) {
    const value = described.details?.value;
    const near = typeof value === "string" ? closestName(value, candidates) : undefined;
    if (near && near !== value) ui.error(`Did you mean '${near}'?`);
    else if (candidates.length > 0)
      ui.error(
        `Known ${described.details?.kind ?? "available"} names: ${candidates.slice(0, 5).join(", ")}`,
      );
  }
  const choices = described.details?.choices;
  if (
    !Array.isArray(candidates) &&
    Array.isArray(choices) &&
    choices.length > 0 &&
    choices.every((choice) => typeof choice === "string")
  )
    ui.error(
      `Known ${described.details?.field ?? "available"} values: ${choices.slice(0, 5).join(", ")}`,
    );
  if (described.nextStep) ui.error(`↳ ${described.nextStep}`);
  return reportedExitCode;
}

function exitCodeOf(code: string | undefined): number {
  return (code && EXIT_CODES[code]) || 1;
}
