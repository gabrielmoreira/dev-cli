import {
  autocomplete,
  autocompleteMultiselect,
  confirm as clackConfirm,
  isCancel,
  S_BAR,
  text as clackText,
} from "@clack/prompts";

/** Clack draws the guide bar before later message lines in confirm and
 * multiselect, but not in text and single select; those two get it here. */
function guidedHint(hint: string): string {
  return `\x1b[90m${S_BAR}\x1b[39m  \x1b[2m${hint}\x1b[22m`;
}

/** The user pressed Ctrl+C or Esc at a prompt: not a failure, so it prints nothing. */
export class CancelledError extends Error {
  readonly code = "CANCELLED";
  constructor() {
    super("Cancelled.");
    this.name = "CancelledError";
  }
}

let isQuietMode = false;
let isJsonMode = false;
let errorReported = false;

export interface NextStep {
  command: string;
  why: string;
}

export function formatNextStep({ command, why }: NextStep): string {
  return `↳ ${command}  ${why}`;
}
export interface ResultOptions<T = unknown> {
  data: T;
  json?: boolean;
  text?: string | (() => string | void);
  next?: readonly NextStep[];
}

export function fuzzyScore(query: string, text: string): number | undefined {
  query = query.trim().toLowerCase();
  if (!query) return 0;
  const lower = text.toLowerCase();
  // Keep the best subsequence at each position: reward prefixes, word starts and runs, penalize gaps.
  let scores = Array<number>(lower.length).fill(-Infinity);
  let best = -Infinity;
  for (let q = 0; q < query.length; q++) {
    const next = Array<number>(lower.length).fill(-Infinity);
    let bestGap = -Infinity;
    best = -Infinity;
    for (let index = 0; index < lower.length; index++) {
      const adjacent = scores[index - 1] ?? -Infinity;
      bestGap = Math.max(bestGap, adjacent + index);
      if (lower[index] !== query[q]) continue;
      const before = text[index - 1] ?? "";
      const current = text[index] ?? "";
      const wordStart =
        index === 0 ||
        "/-_.:@ ".includes(before) ||
        (/[a-z]/.test(before) && /[A-Z]/.test(current));
      const score =
        (q === 0 ? -index : Math.max(adjacent + 12, bestGap - index)) + 1 + (wordStart ? 6 : 0);
      next[index] = score;
      best = Math.max(best, score);
    }
    scores = next;
  }
  return best === -Infinity ? undefined : best + (lower.startsWith(query) ? 20 : 0);
}

export function rankOptions<T extends { label: string; value: string }>(
  query: string,
  options: T[],
): T[] {
  if (!query.trim()) return options;
  return options
    .map((option) => ({
      option,
      score: Math.max(
        fuzzyScore(query, option.label) ?? -Infinity,
        option.value === option.label ? -Infinity : (fuzzyScore(query, option.value) ?? -Infinity),
      ),
    }))
    .filter(({ score }) => score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .map(({ option }) => option);
}

export const ui = {
  reset(): void {
    errorReported = false;
    isJsonMode = false;
  },

  hasError(): boolean {
    return errorReported;
  },

  setQuiet(quiet: boolean): void {
    isQuietMode = quiet;
  },

  isQuiet(): boolean {
    return isQuietMode;
  },

  setJson(json: boolean): void {
    isJsonMode = json;
  },

  isJson(): boolean {
    return isJsonMode;
  },

  log(...args: unknown[]): void {
    if (!isQuietMode) {
      console.log(...args);
    }
  },

  /** Narration: what is happening. Never the answer, so never stdout. */
  info(...args: unknown[]): void {
    if (!isQuietMode) {
      console.error(...args);
    }
  },

  /** Narration: something succeeded. Never the answer, so never stdout. */
  success(...args: unknown[]): void {
    if (!isQuietMode) {
      console.error(...args);
    }
  },

  warn(...args: unknown[]): void {
    console.warn(...args);
  },

  error(...args: unknown[]): void {
    errorReported = true;
    if (isJsonMode) {
      process.stderr.write(`${args.map(String).join(" ")}\n`);
    } else {
      console.error(...args);
    }
  },

  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  },

  result<T>(options: ResultOptions<T>): void {
    if (options.json || isJsonMode) {
      console.log(JSON.stringify(options.data, null, 2));
      return;
    }

    if (typeof options.text === "function") {
      const rendered = options.text();
      if (typeof rendered === "string") {
        console.log(rendered);
      }
    } else if (typeof options.text === "string") {
      console.log(options.text);
    } else console.log(JSON.stringify(options.data, null, 2));
    for (const step of options.next ?? []) console.log(formatNextStep(step));
  },

  empty(options: { message: string; next: readonly [NextStep, ...NextStep[]] }): void {
    console.log([`○ ${options.message}`, ...options.next.map(formatNextStep)].join("\n"));
  },

  // Every prompt goes through Clack: mixing prompt libraries left two readers on
  // stdin, and on Windows ConPTY the second one failed with EPIPE.
  async text({
    message,
    hint,
    initial,
  }: {
    message: string;
    hint: string;
    initial?: string;
  }): Promise<string | undefined> {
    // stderr keeps the prompt visible when the shell wrapper captures stdout.
    const value = await clackText({
      message: `${message}\n${guidedHint(hint)}`,
      placeholder: initial,
      defaultValue: initial,
      output: process.stderr,
    });
    if (isCancel(value)) throw new CancelledError();
    return value || initial;
  },

  async select<T extends string>({
    message,
    hint,
    options,
  }: {
    message: string;
    hint: string;
    options: { label: string; value: T }[];
  }): Promise<T> {
    const selection = await autocomplete<string>({
      message: `${message}\n${guidedHint(hint)}`,
      output: process.stderr,
      placeholder: "Type to search...",
      maxItems: 10,
      options() {
        return rankOptions(this.userInput, options);
      },
      filter: (search, option) =>
        fuzzyScore(search, option.label ?? option.value) !== undefined ||
        fuzzyScore(search, option.value) !== undefined,
    });
    if (isCancel(selection)) throw new CancelledError();
    return selection as T;
  },

  async multiSelect<T extends string>({
    message,
    hint,
    options,
  }: {
    message: string;
    hint: string;
    options: { label: string; value: T }[];
  }): Promise<T[]> {
    const selection = await autocompleteMultiselect<string>({
      message: `${message}\n\x1b[2m${hint}\x1b[22m`,
      output: process.stderr,
      placeholder: "Type to search...",
      maxItems: 10,
      options() {
        return rankOptions(this.userInput, options);
      },
      filter: (search, option) =>
        fuzzyScore(search, option.label ?? option.value) !== undefined ||
        fuzzyScore(search, option.value) !== undefined,
      required: true,
    });
    if (isCancel(selection)) throw new CancelledError();
    return selection as T[];
  },

  async confirm({
    message,
    hint,
    initial = false,
  }: {
    message: string;
    hint: string;
    initial?: boolean;
  }): Promise<boolean> {
    const value = await clackConfirm({
      message: `${message}\n\x1b[2m${hint}\x1b[22m`,
      initialValue: initial,
      output: process.stderr,
    });
    if (isCancel(value)) throw new CancelledError();
    return value;
  },
};
