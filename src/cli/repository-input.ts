import { isExplicitSource, resolveInputSource, resolveRepositorySource } from "../inventory.ts";
import { resolveConfig } from "../config.ts";
import * as git from "../git.ts";
import { parseDeclaredSources } from "../labels.ts";
import { ui } from "../ui.ts";
import { canPrompt, getAmbient, type AmbientContext } from "./context.ts";
import {
  CliInputError,
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
    const selected = await ui.multiSelect({
      message: options.message,
      hint: options.required.command.startsWith("ws")
        ? "Each one becomes a mount: its own branch inside this workspace."
        : "Each selected repository becomes a member of this workspace recipe.",
      options: [
        ...resolved.matches.map((record) => ({
          label: `${record.name} — ${record.url}`,
          value: record.url,
        })),
        { label: "Enter a repository URI or local path manually", value: MANUAL_SOURCE },
      ],
    });
    const values = selected.filter((value) => value !== MANUAL_SOURCE);
    if (selected.includes(MANUAL_SOURCE)) {
      const manual = await resolveTextInput({
        message: "Repository URI or local path",
        hint: options.required.command.startsWith("ws")
          ? "This repository becomes a mount: your branch inside the workspace."
          : "Add a Git URL or local repository to this saved workspace recipe.",
        required: options.required,
        ambient,
      });
      values.push(manual.value);
    }
    return { value: values, source: "prompt" };
  }

  const manual = await resolveTextInput({
    message: "Repository URI or local path",
    hint: options.required.command.startsWith("ws")
      ? "This repository becomes a mount: your branch inside the workspace."
      : "Add a Git URL or local repository to this saved workspace recipe.",
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

  const config = resolveConfig({ rootFlag: options.root, cwd: ambient.cwd, env: ambient.env });
  let matches: Array<{ name: string; url: string }> = resolved.matches;
  if (query) {
    const declared = parseDeclaredSources(config.sources).sources.filter(
      (source) => git.deriveDefaultMountPath(source.url).toLowerCase() === query.toLowerCase(),
    );
    const candidates = new Map<string, { name: string; url: string }>(
      matches.map((record) => [record.url, record]),
    );
    for (const source of declared) {
      if (!candidates.has(source.url)) {
        candidates.set(source.url, { name: query, url: source.url });
      }
    }
    matches = [...candidates.values()];
    if (matches.length === 1) {
      return { value: matches[0]!.url, source: "argument" };
    }
    if (matches.length === 0 || !canPrompt(ambient)) {
      const urls = matches.map((record) => git.stripCredentialsFromUrl(record.url));
      if (urls.length > 0) {
        throw new CliInputError(
          "SOURCE_AMBIGUOUS",
          `Ambiguous repository '${query}'. Matching repositories:\n${urls.map((url) => `  - ${url}`).join("\n")}\nPlease pass a full URL.`,
          { query, matches: urls, usage: options.required.usage },
        );
      }
      const fallback = await resolveInputSource(options.root, query);
      const usage = !config.configPath
        ? "dev init"
        : config.providers.length > 0
          ? "dev sync inventory"
          : "Pass a repository URL or local path, or configure a provider: dev provider add <type>";
      const disabled = resolved.disabledMatches?.[0];
      throw new CliInputError(
        "SOURCE_NOT_FOUND",
        disabled
          ? fallback.error!
          : !config.configPath
            ? "No dev root yet."
            : `No repository matching '${query}' is known in this root.`,
        {
          query,
          usage,
          kind: "repository",
          value: query,
          candidates: parseDeclaredSources(config.sources).sources.map((source) =>
            git.deriveDefaultMountPath(source.url),
          ),
        },
      );
    }
  }

  if (!canPrompt(ambient)) throw new CliInputRequiredError(options.required);

  if (matches.length > 0) {
    const selected = await ui.select({
      message: options.message,
      hint: "Choose a Git repository; dev keeps its original location unchanged.",
      options: [
        ...matches.map((record) => ({
          label: `${record.name} — ${record.url}`,
          value: record.url,
        })),
        { label: "Enter a URL or path manually", value: MANUAL_SOURCE },
      ],
    });
    if (selected !== MANUAL_SOURCE) return { value: selected, source: "prompt" };
  }

  return await resolveTextInput({
    message: "Repository URI or local path",
    hint: options.required.command.startsWith("ws")
      ? "This repository becomes a mount: your branch inside the workspace."
      : "Add a Git URL or local repository to this saved workspace recipe.",
    required: options.required,
    ambient,
  });
}
