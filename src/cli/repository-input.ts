import { isExplicitSource, resolveInputSource, resolveRepositorySource } from "../inventory.ts";
import { ui } from "../ui.ts";
import { canPrompt, getAmbient, type AmbientContext } from "./context.ts";
import {
  CliInputRequiredError,
  resolveTextInput,
  type RequiredCliInputDetails,
  type ResolvedCliInput,
} from "./input.ts";

const MANUAL_SOURCE = "\0manual-source";

export interface ResolveRepositoryInputOptions {
  value?: string;
  root: string;
  message: string;
  required: RequiredCliInputDetails;
  ambient?: AmbientContext;
}

export async function resolveRepositoryInputs(
  options: ResolveRepositoryInputOptions,
): Promise<ResolvedCliInput<string[]>> {
  if (options.value?.trim()) {
    const resolved = await resolveRepositoryInput(options);
    return { value: [resolved.value], source: resolved.source };
  }

  const ambient = options.ambient ?? getAmbient();
  if (!canPrompt(ambient)) {
    const resolved = await resolveRepositoryInput(options);
    return { value: [resolved.value], source: resolved.source };
  }

  const resolved = await resolveRepositorySource({ root: options.root });
  if (resolved.matches.length > 0) {
    return {
      value: await ui.multiSelect(
        options.message,
        resolved.matches.map((record) => ({
          label: `${record.name} — ${record.url}`,
          value: record.url,
        })),
      ),
      source: "prompt",
    };
  }

  const manual = await resolveTextInput({
    message: "Repository URI or local path",
    required: options.required,
    ambient,
  });
  return { value: [manual.value], source: manual.source };
}

export async function resolveRepositoryInput(
  options: ResolveRepositoryInputOptions,
): Promise<ResolvedCliInput<string>> {
  const ambient = options.ambient ?? getAmbient();
  const query = options.value?.trim();

  if (query && isExplicitSource(query)) return { value: query, source: "argument" };

  const resolved = await resolveRepositorySource({ root: options.root, query });
  if (resolved.sourceUrl) {
    return {
      value: resolved.sourceUrl,
      source: query ? "argument" : "single-candidate",
    };
  }

  if (!canPrompt(ambient)) {
    if (!query) throw new CliInputRequiredError(options.required);
    const fallback = await resolveInputSource(options.root, query);
    throw new Error(fallback.error ?? `Repository '${query}' could not be resolved.`);
  }

  if (resolved.matches.length > 0) {
    const selected = await ui.select(options.message, [
      ...resolved.matches.map((record) => ({
        label: `${record.name} — ${record.url}`,
        value: record.url,
      })),
      { label: "Enter a URL or path manually", value: MANUAL_SOURCE },
    ]);
    if (selected !== MANUAL_SOURCE) return { value: selected, source: "prompt" };
  }

  return await resolveTextInput({
    message: "Repository URI or local path",
    required: options.required,
    ambient,
  });
}
