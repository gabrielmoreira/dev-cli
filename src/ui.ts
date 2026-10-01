import { createInterface } from "node:readline/promises";
import { consola } from "consola";
import { autocomplete, autocompleteMultiselect, isCancel } from "@clack/prompts";

/** The user pressed Ctrl+C or Esc at a prompt: not a failure, so it prints nothing. */
export class CancelledError extends Error {
  readonly code = "CANCELLED";
  constructor() {
    super("Cancelled.");
    this.name = "CancelledError";
  }
}

let isQuietMode = false;
let errorReported = false;

export interface ResultOptions<T = unknown> {
  data: T;
  json?: boolean;
  text?: string | (() => string | void);
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
    console.error(...args);
  },

  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  },

  result<T>(options: ResultOptions<T>): void {
    if (options.json) {
      console.log(JSON.stringify(options.data, null, 2));
      return;
    }

    if (typeof options.text === "function") {
      const rendered = options.text();
      if (typeof rendered === "string") {
        console.log(rendered);
      }
      return;
    }

    if (typeof options.text === "string") {
      console.log(options.text);
      return;
    }

    console.log(JSON.stringify(options.data, null, 2));
  },

  async text(message: string, initial?: string): Promise<string | undefined> {
    const prompt = initial ? `${message} (${initial}): ` : `${message}: `;
    const readline = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    const aborted = new AbortController();
    readline.on("SIGINT", () => aborted.abort());
    try {
      const value = await readline.question(prompt, { signal: aborted.signal });
      return value || initial;
    } catch (error) {
      if (aborted.signal.aborted) throw new CancelledError();
      throw error;
    } finally {
      readline.close();
    }
  },

  async select<T extends string>(
    message: string,
    options: { label: string; value: T }[],
  ): Promise<T> {
    const selection = await autocomplete<string>({
      message,
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

  async multiSelect<T extends string>(
    message: string,
    options: { label: string; value: T }[],
  ): Promise<T[]> {
    const selection = await autocompleteMultiselect<string>({
      message,
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

  async confirm(message: string, initial = false): Promise<boolean> {
    const value = await consola.prompt(message, {
      type: "confirm",
      initial,
      cancel: "undefined",
    });
    if (value === undefined) throw new CancelledError();
    return value === true;
  },
};
