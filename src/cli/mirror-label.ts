import { defineCommand } from "citty";
import type { RuntimeConfig } from "../config.ts";
import { deriveDefaultMountPath, normalizeSourceKey, stripCredentialsFromUrl } from "../git.ts";
import { resolveInputSource } from "../inventory.ts";
import * as labels from "../labels.ts";
import { createPluginBase, emit } from "../plugins/index.ts";
import { ui } from "../ui.ts";
import { reportError } from "./errors.ts";
import { canPrompt, getActiveConfig } from "./context.ts";
import { resolveTextInput } from "./input.ts";

type DeclaredSource = labels.SourceDeclaration;

function sourceSelector(source: DeclaredSource): labels.SourceSelector {
  return {
    url: source.url,
    branch: source.branch,
    pin: source.pin,
    path: source.path,
  };
}

function sourceRef(source: DeclaredSource): string {
  return source.branch ?? source.pin ?? "default";
}

function sourceLabel(source: DeclaredSource): string {
  const path = source.path ? ` → ${source.path}` : "";
  return `${deriveDefaultMountPath(source.url)} @ ${sourceRef(source)}${path}`;
}

async function canonicalSourceUrl(root: string, source: string): Promise<string | undefined> {
  try {
    const resolved = await resolveInputSource(root, source);
    return resolved.sourceUrl ? stripCredentialsFromUrl(resolved.sourceUrl) : undefined;
  } catch {
    return undefined;
  }
}

async function resolveDeclaredSources(options: {
  config: RuntimeConfig;
  source?: string;
  ref?: string;
  multiple: boolean;
}): Promise<{ sources: DeclaredSource[]; error?: string }> {
  const declared = labels.parseDeclaredSources(options.config.sources).sources;
  if (!options.source) {
    if (!canPrompt())
      return { sources: [], error: "Source is required outside an interactive terminal." };
    if (declared.length === 0)
      return { sources: [], error: "No sources are declared in dev.yaml." };
    const selected = await ui.multiSelect(
      "Select sources to label",
      declared.map((source, index) => ({ label: sourceLabel(source), value: String(index) })),
    );
    const sources = selected
      .map((value) => declared[Number(value)])
      .filter((source): source is DeclaredSource => Boolean(source));
    if (sources.length === 0) return { sources: [], error: "Select at least one source." };
    return { sources: options.multiple ? sources : [sources[0]!] };
  }

  const url = await canonicalSourceUrl(options.config.root, options.source);
  if (!url) return { sources: [], error: `Could not resolve source '${options.source}'.` };
  let matches = declared.filter(
    (source) => normalizeSourceKey(source.url) === normalizeSourceKey(url),
  );
  if (options.ref) {
    matches = matches.filter(
      (source) => source.branch === options.ref || source.pin === options.ref,
    );
  }
  if (matches.length === 0) {
    return {
      sources: [],
      error: options.ref
        ? `Source '${url}' does not declare ref '${options.ref}'.`
        : `Source '${url}' is not declared in dev.yaml. Run 'dev mirror add ${options.source}' first.`,
    };
  }
  if (matches.length > 1) {
    if (!canPrompt()) {
      return {
        sources: [],
        error: `Source '${url}' matches multiple declared refs. Pass --ref <branch>.`,
      };
    }
    const selected = await ui.select(
      "Select source ref",
      matches.map((source, index) => ({ label: sourceLabel(source), value: String(index) })),
    );
    matches = [matches[Number(selected)]!];
  }
  return { sources: options.multiple ? matches : [matches[0]!] };
}

async function resolveLabelName(
  config: RuntimeConfig,
  value: string | undefined,
): Promise<string | undefined> {
  if (value?.trim()) return value.trim();
  if (!canPrompt()) return undefined;
  const known = new Set(Object.keys(config.labelDefs));
  for (const source of labels.parseDeclaredSources(config.sources).sources) {
    for (const label of Object.keys(source.labels)) known.add(label);
  }
  if (known.size > 0) {
    return await ui.select(
      "Select label",
      [...known].sort().map((label) => ({ label, value: label })),
    );
  }
  return (
    await resolveTextInput({
      message: "Label name",
      required: {
        command: "mirror label add",
        field: "label",
        usage: "dev mirror label add [source] [label]",
        description: "Label name",
      },
    })
  ).value;
}

function parseFields(raw: string | undefined): { fields: Record<string, unknown>; error?: string } {
  const fields: Record<string, unknown> = {};
  for (const pair of (raw ?? "").split(",").filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { fields, error: `Fields must be key=value pairs, got '${pair}'.` };
    fields[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { fields };
}

function renderLabelPlan(label: string, sources: DeclaredSource[]): string {
  return [`Apply label '${label}':`, ...sources.map((source) => `  ${sourceLabel(source)}`)].join(
    "\n",
  );
}

export const mirrorLabelAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Attach a label to one or more declared sources",
  },
  args: {
    source: { type: "positional", description: "Source URI or inventory name", required: false },
    label: { type: "positional", description: "Label name", required: false },
    fields: {
      type: "positional",
      description: "Assignment fields as comma-separated key=value pairs",
      required: false,
    },
    ref: { type: "string", description: "Declared branch or pinned ref" },
    yes: { type: "boolean", description: "Apply an interactive plan without confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    if (!config.configPath || !config.configDoc) {
      return reportError("No dev.yaml found for this dev root.");
    }

    const resolved = await resolveDeclaredSources({
      config,
      source: args.source,
      ref: args.ref,
      multiple: !args.source,
    });
    if (resolved.error) {
      return reportError(resolved.error);
    }
    const label = await resolveLabelName(config, args.label);
    if (!label) {
      return reportError("Label name is required outside an interactive terminal.");
    }
    const parsedFields = parseFields(args.fields);
    if (parsedFields.error) {
      return reportError(parsedFields.error);
    }

    const { defs } = labels.parseLabelDefs(config.labelDefs);
    const def = defs[label];
    const validation = def
      ? labels.resolveLabelMeta(def, label, parsedFields.fields)
      : { meta: parsedFields.fields, warnings: [], errors: [] };
    if (validation.errors.length > 0) {
      return reportError(validation.errors.join("; "));
    }
    for (const warning of validation.warnings) ui.warn(`⚠ ${warning}`);

    const guided = !args.source || !args.label;
    if (guided) {
      ui.log(renderLabelPlan(label, resolved.sources));
      if (!args.yes && !(await ui.confirm("Apply this label plan?", true))) return 0;
    }

    const results = [];
    for (const source of resolved.sources) {
      const result = labels.setSourceLabel(
        config.configDoc,
        sourceSelector(source),
        label,
        validation.meta,
      );
      if (!result.found) {
        return reportError(`Declared source '${sourceLabel(source)}' could not be updated.`);
      }
      results.push({ source: source.url, ref: sourceRef(source), label, meta: validation.meta });
    }
    config.writeConfig?.();
    for (const result of results) {
      await emit(createPluginBase(config.root, config), "mirror:label:add:after", {
        root: config.root,
        sourceKey: normalizeSourceKey(result.source),
        label,
        meta: validation.meta,
      });
    }
    ui.result({
      data: results.length === 1 ? results[0] : results,
      json: false,
      text: () => `Applied label '${label}' to ${results.length} source(s)`,
    });
    return 0;
  },
});

export const mirrorLabelRmCommand = defineCommand({
  meta: { name: "rm", description: "Remove a label from a declared source" },
  args: {
    source: { type: "positional", description: "Source URI or inventory name", required: true },
    label: { type: "positional", description: "Label name", required: true },
    ref: { type: "string", description: "Declared branch or pinned ref" },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    if (!config.configPath || !config.configDoc) {
      return reportError("No dev.yaml found for this dev root.");
    }
    const resolved = await resolveDeclaredSources({
      config,
      source: args.source,
      ref: args.ref,
      multiple: false,
    });
    if (resolved.error) {
      return reportError(resolved.error);
    }
    const source = resolved.sources[0]!;
    const result = labels.setSourceLabel(
      config.configDoc,
      sourceSelector(source),
      args.label,
      undefined,
    );
    if (!result.found || !result.changed) {
      return reportError(`Source '${sourceLabel(source)}' does not carry label '${args.label}'.`);
    }
    config.writeConfig?.();
    await emit(createPluginBase(config.root, config), "mirror:label:rm:after", {
      root: config.root,
      sourceKey: normalizeSourceKey(source.url),
      label: args.label,
    });
    ui.result({
      data: { source: source.url, ref: sourceRef(source), label: args.label },
      json: false,
      text: () => `Removed label '${args.label}' from ${sourceLabel(source)}`,
    });
    return 0;
  },
});

export const mirrorLabelCommand = defineCommand({
  meta: { name: "label", description: "Manage labels on declared sources" },
  subCommands: {
    add: mirrorLabelAddCommand,
    rm: mirrorLabelRmCommand,
    remove: mirrorLabelRmCommand,
  },
});
