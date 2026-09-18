import { defineCommand } from "citty";
import * as labels from "../labels.ts";
import { normalizeSourceKey, stripCredentialsFromUrl } from "../git.ts";
import { resolveInputSource } from "../inventory.ts";
import { ui } from "../ui.ts";
import { getActiveConfig } from "./context.ts";
import { createPluginBase, emit } from "../plugins/index.ts";

/** Resolves a CLI source reference (URL or mirror name) to its canonical URL. */
async function canonicalSourceUrl(source: string): Promise<string | undefined> {
  const direct = stripCredentialsFromUrl(source);
  if (/^[a-z]+:\/\//i.test(source) || source.startsWith("git@")) return direct;
  try {
    const config = getActiveConfig();
    const resolved = await resolveInputSource(config.root, source);
    return resolved.sourceUrl ? stripCredentialsFromUrl(resolved.sourceUrl) : undefined;
  } catch {
    return undefined;
  }
}

export const mirrorLabelAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Attach a label (with optional key=value fields) to a declared source",
  },
  args: {
    source: { type: "positional", description: "Source URL or mirror name", required: true },
    label: { type: "positional", description: "Label name", required: true },
    fields: {
      type: "positional",
      description: "Assignment fields as key=value pairs",
      required: false,
    },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    if (!config.configPath) {
      ui.error("Error: No dev.yaml found for this dev root.");
      return 1;
    }
    const url = (await canonicalSourceUrl(args.source)) ?? undefined;
    if (!url) {
      ui.error(`Error: Could not resolve source '${args.source}' to a URL.`);
      return 1;
    }

    const fields: Record<string, unknown> = {};
    for (const pair of (args.fields ?? "").split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        ui.error(`Error: Fields must be key=value pairs, got '${pair}'.`);
        return 1;
      }
      fields[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }

    const { defs } = labels.parseLabelDefs(config.labelDefs);
    const def = defs[args.label];
    const validation = def
      ? labels.resolveLabelMeta(def, args.label, fields)
      : { meta: fields, warnings: [], errors: [] };
    if (validation.errors.length > 0) {
      ui.error(`Error [LABEL_VALIDATION]: ${validation.errors.join("; ")}`);
      return 1;
    }
    for (const warning of validation.warnings) ui.warn(`Warning: ${warning}`);

    const declared = labels.parseDeclaredSources(config.sources).sources;
    const declaredSource = declared.find(
      (s) => normalizeSourceKey(s.url) === normalizeSourceKey(url),
    );
    if (!declaredSource) {
      ui.error(
        `Error: Source '${url}' is not declared in dev.yaml 'sources:'. Run 'dev mirror add ${args.source}' first.`,
      );
      return 1;
    }

    if (!config.configDoc) {
      ui.error("Error: No dev.yaml found for this dev root.");
      return 1;
    }
    labels.setSourceLabel(config.configDoc, declaredSource.url, args.label, validation.meta);
    config.writeConfig?.();
    await emit(createPluginBase(config.root, config), "mirror:label:add:after", {
      root: config.root,
      sourceKey: normalizeSourceKey(declaredSource.url),
      label: args.label,
      meta: validation.meta,
    });
    ui.result({
      data: { source: declaredSource.url, label: args.label, meta: validation.meta },
      json: false,
      text: () => `Labeled ${declaredSource.url} with '${args.label}'`,
    });
    return 0;
  },
});

export const mirrorLabelRmCommand = defineCommand({
  meta: {
    name: "rm",
    description: "Remove a label from a declared source",
  },
  args: {
    source: { type: "positional", description: "Source URL or mirror name", required: true },
    label: { type: "positional", description: "Label name", required: true },
    root: { type: "string", description: "Explicit dev root directory" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    if (!config.configPath) {
      ui.error("Error: No dev.yaml found for this dev root.");
      return 1;
    }
    const url = await canonicalSourceUrl(args.source);
    if (!url) {
      ui.error(`Error: Could not resolve source '${args.source}' to a URL.`);
      return 1;
    }
    const declared = labels.parseDeclaredSources(config.sources).sources;
    const declaredSource = declared.find(
      (s) => normalizeSourceKey(s.url) === normalizeSourceKey(url),
    );
    if (!declaredSource) {
      ui.error(`Error: Source '${url}' is not declared in dev.yaml 'sources:'.`);
      return 1;
    }

    const result = labels.setSourceLabel(
      config.configDoc!,
      declaredSource.url,
      args.label,
      undefined,
    );
    if (!result.found) {
      ui.error(`Error: Source '${url}' does not carry label '${args.label}'.`);
      return 1;
    }
    if (result.changed) config.writeConfig?.();
    if (result.changed) {
      await emit(createPluginBase(config.root, config), "mirror:label:rm:after", {
        root: config.root,
        sourceKey: normalizeSourceKey(declaredSource.url),
        label: args.label,
      });
    }
    ui.result({
      data: { source: declaredSource.url, label: args.label },
      json: false,
      text: () => `Removed label '${args.label}' from ${declaredSource.url}`,
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
