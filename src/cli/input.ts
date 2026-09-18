import { ui } from "../ui.ts";
import { canPrompt, type AmbientContext } from "./context.ts";

export type CliInputSource = "argument" | "cwd" | "single-candidate" | "default" | "prompt";

export interface ResolvedCliInput<T> {
  value: T;
  source: CliInputSource;
}

export interface RequiredCliInputDetails {
  command: string;
  field: string;
  usage: string;
  description: string;
  choices?: readonly string[];
}

export class CliInputRequiredError extends Error {
  readonly code = "INTERACTION_REQUIRED";

  constructor(readonly details: RequiredCliInputDetails) {
    super(`${details.description} is required.`);
    this.name = "CliInputRequiredError";
  }
}

export interface ResolveTextInputOptions {
  value?: string;
  defaultValue?: string;
  initial?: string;
  message: string;
  required: RequiredCliInputDetails;
  ambient?: AmbientContext;
}

export interface ResolveChoiceInputOptions<T extends string> {
  value?: T;
  inferred?: ResolvedCliInput<T>;
  choices: () => Promise<Array<{ label: string; value: T }>>;
  message: string;
  required: RequiredCliInputDetails;
  ambient?: AmbientContext;
}

export async function resolveChoiceInput<T extends string>(
  options: ResolveChoiceInputOptions<T>,
): Promise<ResolvedCliInput<T>> {
  if (options.value) return { value: options.value, source: "argument" };
  if (options.inferred) return options.inferred;

  const choices = await options.choices();
  const [onlyChoice] = choices;
  if (onlyChoice && choices.length === 1) {
    return { value: onlyChoice.value, source: "single-candidate" };
  }
  if (choices.length > 1 && canPrompt(options.ambient)) {
    return {
      value: await ui.select(options.message, choices),
      source: "prompt",
    };
  }

  throw new CliInputRequiredError({
    ...options.required,
    choices: choices.map((choice) => choice.value),
  });
}

export interface ResolveConfirmationOptions {
  confirmed?: boolean;
  message: string;
  required: RequiredCliInputDetails;
  ambient?: AmbientContext;
}

export async function resolveConfirmation(options: ResolveConfirmationOptions): Promise<boolean> {
  if (options.confirmed) return true;
  if (canPrompt(options.ambient)) return await ui.confirm(options.message);
  throw new CliInputRequiredError(options.required);
}
export async function resolveTextInput(
  options: ResolveTextInputOptions,
): Promise<ResolvedCliInput<string>> {
  const value = options.value?.trim();
  if (value) return { value, source: "argument" };

  const defaultValue = options.defaultValue?.trim();
  if (defaultValue) return { value: defaultValue, source: "default" };

  if (canPrompt(options.ambient)) {
    const response = await ui.text(options.message, options.initial);
    const prompted = typeof response === "string" ? response.trim() : "";
    if (prompted) return { value: prompted, source: "prompt" };
  }

  throw new CliInputRequiredError(options.required);
}
