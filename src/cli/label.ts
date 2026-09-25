import { defineCommand } from "citty";
import * as cache from "../cache.ts";
import type { RuntimeConfig } from "../config.ts";
import { resolveExtraHeader } from "../credentials.ts";
import * as git from "../git.ts";
import { resolveInputSource } from "../inventory.ts";
import * as labels from "../labels.ts";
import * as mirror from "../mirror.ts";
import { createPluginBase, emit } from "../plugins/index.ts";
import { CancelledError, ui } from "../ui.ts";
import { canPrompt, getActiveConfig } from "./context.ts";
import { reportError } from "./errors.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";

type Declared = labels.SourceDeclaration;

const commonArgs = {
  root: { type: "string", description: "Explicit dev root directory" },
  json: { type: "boolean", description: "Output in structured JSON format" },
} as const;

function describeSource(source: { url: string; branch?: string; pin?: string }): string {
  return `${git.deriveDefaultMountPath(source.url)} @ ${source.branch ?? source.pin ?? "default branch"}`;
}

/** dev.yaml as it is after this command's edits, not as it was loaded. */
function currentConfig(config: RuntimeConfig): RuntimeConfig {
  const data = (config.configDoc?.toJS() ?? {}) as { sources?: RuntimeConfig["sources"] };
  return { ...config, sources: data.sources ?? [] };
}

function requireDevYaml(config: RuntimeConfig): string | undefined {
  return config.configPath && config.configDoc
    ? undefined
    : "Labels live in dev.yaml, and this dev root has none. Run 'dev init' first.";
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

/** Labels in use, then labels only defined in label_defs, then a new one. */
async function chooseLabel(config: RuntimeConfig, message: string): Promise<string> {
  const counts = new Map(
    labels.listLabels(config).map((item) => [item.label, item.sources.length]),
  );
  for (const name of Object.keys(config.labelDefs)) {
    if (!name.endsWith("*") && !counts.has(name)) counts.set(name, 0);
  }
  const NEW = "\0new";
  const choice =
    counts.size === 0
      ? NEW
      : await ui.select(message, [
          ...[...counts].map(([label, count]) => ({ label: `${label} (${count})`, value: label })),
          { label: "New label…", value: NEW },
        ]);
  if (choice !== NEW) return choice;
  const typed = (await ui.text("Label name"))?.trim();
  if (!typed) throw new CancelledError();
  return typed;
}

async function chooseExistingLabel(config: RuntimeConfig, message: string): Promise<string> {
  const known = labels.listLabels(config);
  if (known.length === 0) throw new Error("No repository carries a label yet.");
  return await ui.select(
    message,
    known.map((item) => ({ label: `${item.label} (${item.sources.length})`, value: item.label })),
  );
}

/** Repositories to pick from: the provider inventory plus what dev.yaml already declares. */
async function chooseRepositories(config: RuntimeConfig, label: string): Promise<string[]> {
  const inventory = await cache.loadAllCachedInventories(config.root);
  const options = new Map<string, { label: string; value: string }>();
  for (const source of labels.parseDeclaredSources(config.sources).sources) {
    const carries = label in source.labels ? `, already '${label}'` : "";
    options.set(git.normalizeSourceKey(source.url), {
      label: `${git.deriveDefaultMountPath(source.url)} — declared${carries}`,
      value: source.url,
    });
  }
  for (const record of inventory) {
    if (record.disabled) continue;
    const key = git.normalizeSourceKey(record.url);
    if (!options.has(key))
      options.set(key, { label: `${record.name} — ${record.url}`, value: record.url });
  }
  if (options.size === 0) {
    throw new Error("No repositories known yet. Run 'dev sync inventory', or pass a URL.");
  }
  return await ui.multiSelect(`Select repositories for '${label}'`, [...options.values()]);
}

async function resolveUrl(root: string, value: string): Promise<string> {
  const resolved = await resolveInputSource(root, value);
  if (!resolved.sourceUrl) {
    throw new Error(resolved.error ?? `Could not resolve repository '${value}'.`);
  }
  return git.stripCredentialsFromUrl(resolved.sourceUrl);
}

interface PlannedTarget {
  url: string;
  selector: labels.SourceSelector;
  declared: boolean;
  meta: Record<string, unknown>;
}

/**
 * Resolves each repository to the declaration the label lands on. Branches are
 * asked for only for the repositories the user chose to customize.
 */
async function planTargets(options: {
  config: RuntimeConfig;
  label: string;
  urls: string[];
  ref?: string;
  customize: boolean;
  fields?: Record<string, unknown>;
}): Promise<PlannedTarget[]> {
  const declared = labels.parseDeclaredSources(options.config.sources).sources;
  const branches = new Map<string, string>();
  if (options.customize && !options.ref) {
    const chosen = await ui.multiSelect("Select repositories to customize", [
      { label: "Continue with defaults", value: "defaults" },
      ...options.urls.map((url) => ({ label: git.deriveDefaultMountPath(url), value: url })),
    ]);
    for (const url of chosen.filter((value) => value !== "defaults")) {
      const extraHeader = await resolveExtraHeader(options.config, url);
      const remote = await git.listRemoteBranches({ source: url, extraHeader });
      if (remote.branches.length === 0) continue;
      branches.set(
        url,
        await ui.select(
          `Branch for ${git.deriveDefaultMountPath(url)}`,
          remote.branches.map((branch) => ({
            label: branch === remote.defaultBranch ? `${branch} (default)` : branch,
            value: branch,
          })),
        ),
      );
    }
  }

  const targets: PlannedTarget[] = [];
  for (const url of options.urls) {
    let plan = labels.planLabelTarget(declared, url, options.ref ?? branches.get(url));
    if ("ambiguous" in plan) {
      if (!canPrompt()) {
        throw new Error(
          `${git.deriveDefaultMountPath(url)} is declared on several refs. Pass --ref <branch>.`,
        );
      }
      const index = await ui.select(
        `Which ref of ${git.deriveDefaultMountPath(url)}?`,
        plan.ambiguous.map((source, i) => ({ label: describeSource(source), value: String(i) })),
      );
      plan = { selector: labels.selectorOf(plan.ambiguous[Number(index)]!), declared: true };
    }
    // Without new fields, a repository that already carries the label keeps its own.
    const existing = declared.find(
      (source) =>
        plan.declared &&
        source.url === plan.selector.url &&
        source.branch === plan.selector.branch &&
        source.pin === plan.selector.pin,
    )?.labels[options.label];
    targets.push({ url, ...plan, meta: options.fields ?? existing ?? {} });
  }
  return targets;
}

function validateMeta(config: RuntimeConfig, label: string, targets: PlannedTarget[]): void {
  const { defs } = labels.parseLabelDefs(config.labelDefs);
  const def = defs[label];
  if (!def) return;
  for (const target of targets) {
    const validation = labels.resolveLabelMeta(def, label, target.meta);
    if (validation.errors.length > 0) throw new Error(validation.errors.join("; "));
    for (const warning of validation.warnings) ui.warn(`⚠ ${warning}`);
    target.meta = validation.meta;
  }
}

function renderPlan(label: string, targets: PlannedTarget[], mirrors: boolean): string {
  return [
    `Label '${label}'${mirrors ? " (kept mirrored)" : ""}:`,
    ...targets.map(
      (target) =>
        `  + ${describeSource(target.selector)}${target.declared ? "" : "  (new in dev.yaml)"}`,
    ),
  ].join("\n");
}

/** Mirrors a label asks for that are not on disk yet. */
async function missingMirrors(config: RuntimeConfig, targets: PlannedTarget[]) {
  const onDisk = await mirror.list({ root: config.root, canonicalPrefix: config.canonicalPrefix });
  return targets.filter(
    (target) =>
      !onDisk.some(
        (item) =>
          item.sourceUrl &&
          git.normalizeSourceKey(item.sourceUrl) === git.normalizeSourceKey(target.url) &&
          (!target.selector.branch || item.branch === target.selector.branch),
      ),
  );
}

async function createMirrors(config: RuntimeConfig, json?: boolean): Promise<number> {
  if (!json) ui.info("↻ Creating mirrors…");
  const result = await labels.ensureLabelMirrors(currentConfig(config), {
    resolveExtraHeader: (source) => resolveExtraHeader(config, source),
    onCreated: (item) => {
      if (!json) ui.success(`✓ Mirrored ${describeSource(item)} at ${item.path}`);
    },
  });
  if (!json) for (const failure of result.failures) ui.warn(`⚠ ${failure.url}: ${failure.reason}`);
  return result.failures.length > 0 ? 1 : 0;
}

export const labelAddCommand = defineCommand({
  meta: {
    name: "add",
    description:
      "Put a label on repositories, and pick a branch for any of them; a repository not in dev.yaml yet is declared",
  },
  args: {
    label: { type: "positional", description: "Label name", required: false },
    sources: {
      type: "positional",
      description: "Repositories: URL, path, or inventory name (several allowed)",
      required: false,
    },
    ref: { type: "string", description: "Branch or pinned ref for every repository given" },
    fields: { type: "string", description: "Label fields as key=value pairs, comma-separated" },
    sync: {
      type: "boolean",
      description: "Create the mirrors this label asks for now, instead of on the next sync",
    },
    yes: { type: "boolean", description: "Apply the plan without confirmation" },
    ...commonArgs,
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const missingYaml = requireDevYaml(config);
    if (missingYaml) return reportError(missingYaml, args.json);
    try {
      const interactive = canPrompt();
      const label = args.label?.trim() || (interactive ? await chooseLabel(config, "Label") : "");
      const given = (args._ as string[]).slice(1);
      if (!label || (given.length === 0 && !interactive)) {
        return reportError(
          "A label and at least one repository are required: dev label add <label> <repository...>",
          args.json,
        );
      }
      const parsed = parseFields(args.fields);
      if (parsed.error) return reportError(parsed.error, args.json);

      const urls =
        given.length > 0
          ? await Promise.all(given.map((value) => resolveUrl(config.root, value)))
          : await chooseRepositories(config, label);
      const guided = interactive && given.length === 0;
      const targets = await planTargets({
        config,
        label,
        urls,
        ref: args.ref,
        customize: guided,
        fields: args.fields ? parsed.fields : undefined,
      });
      validateMeta(config, label, targets);

      const mirrors = labels.labelMirrors(labels.parseLabelDefs(config.labelDefs).defs, label);
      if (!args.json) ui.log(renderPlan(label, targets, mirrors));
      if (guided && !args.yes && !(await ui.confirm("Apply this label?", true))) {
        return 0;
      }

      const doc = config.configDoc!;
      for (const target of targets) {
        if (!target.declared) labels.upsertSourceDeclaration(doc, target.selector);
        labels.setSourceLabel(doc, target.selector, label, target.meta);
      }
      config.writeConfig?.();
      const base = createPluginBase(config.root, config);
      for (const target of targets) {
        await emit(base, "label:add:after", {
          root: config.root,
          sourceKey: git.normalizeSourceKey(target.url),
          label,
          meta: target.meta,
        });
      }

      const missing = mirrors ? await missingMirrors(config, targets) : [];
      ui.result({
        data: {
          label,
          mirror: mirrors,
          sources: targets.map((target) => ({ ...target.selector, meta: target.meta })),
          missingMirrors: missing.map((target) => target.selector),
        },
        json: args.json,
        text: () =>
          `✓ Labeled ${targets.length} repositor${targets.length === 1 ? "y" : "ies"} '${label}'.`,
      });
      if (missing.length === 0) return 0;
      const now =
        args.sync ||
        (guided &&
          (await ui.confirm(
            `Create ${missing.length} missing mirror${missing.length === 1 ? "" : "s"} now?`,
            true,
          )));
      if (now) return await createMirrors(config, args.json);
      if (!args.json) ui.info("↳ The next 'dev sync --all' or 'dev mirror sync' creates them.");
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const labelRmCommand = defineCommand({
  meta: {
    name: "rm",
    description: "Take a label off repositories; their mirrors stay on disk",
  },
  args: {
    label: { type: "positional", description: "Label name", required: false },
    sources: {
      type: "positional",
      description: "Repositories to take it off (several allowed)",
      required: false,
    },
    ref: { type: "string", description: "Declared branch or pinned ref" },
    all: { type: "boolean", description: "Take the label off every repository carrying it" },
    yes: { type: "boolean", description: "Remove without confirmation" },
    ...commonArgs,
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const missingYaml = requireDevYaml(config);
    if (missingYaml) return reportError(missingYaml, args.json);
    try {
      const interactive = canPrompt();
      const label =
        args.label?.trim() ||
        (interactive ? await chooseExistingLabel(config, "Label to remove") : "");
      const carrying =
        labels.listLabels(config).find((item) => item.label === label)?.sources ?? [];
      if (!label)
        return reportError("Usage: dev label rm <label> [repository...] [--all]", args.json);
      if (carrying.length === 0) {
        return reportError(`No repository carries label '${label}'.`, args.json);
      }

      const given = (args._ as string[]).slice(1);
      let chosen: Declared[];
      if (args.all) chosen = carrying;
      else if (given.length > 0) {
        const keys = new Set(
          (await Promise.all(given.map((value) => resolveUrl(config.root, value)))).map(
            git.normalizeSourceKey,
          ),
        );
        chosen = carrying.filter(
          (source) =>
            keys.has(git.normalizeSourceKey(source.url)) &&
            (!args.ref || source.branch === args.ref || source.pin === args.ref),
        );
        if (chosen.length === 0) {
          return reportError(`None of those repositories carries label '${label}'.`, args.json);
        }
      } else if (interactive) {
        const picked = await ui.multiSelect(
          `Take '${label}' off`,
          carrying.map((source, index) => ({
            label: describeSource(source),
            value: String(index),
          })),
        );
        chosen = picked.map((index) => carrying[Number(index)]!);
      } else {
        return reportError(
          `Name the repositories to take '${label}' off, or pass --all.`,
          args.json,
        );
      }

      if (!args.json) {
        ui.log(
          [`Remove '${label}' from:`, ...chosen.map((s) => `  - ${describeSource(s)}`)].join("\n"),
        );
      }
      const guidedRm = interactive && (given.length === 0 || !args.label);
      if (guidedRm && !args.yes && !(await ui.confirm("Remove this label?", true))) return 0;

      for (const source of chosen) {
        labels.setSourceLabel(config.configDoc!, labels.selectorOf(source), label, undefined);
      }
      config.writeConfig?.();
      const base = createPluginBase(config.root, config);
      for (const source of chosen) {
        await emit(base, "label:rm:after", {
          root: config.root,
          sourceKey: git.normalizeSourceKey(source.url),
          label,
        });
      }

      // A mirror is never deleted for a label: say which ones no label keeps anymore.
      const stillMirrored = new Set(
        labels
          .sourcesToMirror(currentConfig(config))
          .map(({ source }) => git.normalizeSourceKey(source.url)),
      );
      const { defs } = labels.parseLabelDefs(config.labelDefs);
      const unkept = labels.labelMirrors(defs, label)
        ? chosen.filter((source) => !stillMirrored.has(git.normalizeSourceKey(source.url)))
        : [];
      ui.result({
        data: {
          label,
          removed: chosen.map(labels.selectorOf),
          mirrorsNoLongerNeeded: unkept.map(labels.selectorOf),
        },
        json: args.json,
        text: () =>
          [
            `✓ Removed '${label}' from ${chosen.length} repositor${chosen.length === 1 ? "y" : "ies"}.`,
            ...unkept.map(
              (source) =>
                `  ○ ${describeSource(source)}: no label needs its mirror now; it stays on disk.`,
            ),
          ].join("\n"),
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const labelRenameCommand = defineCommand({
  meta: {
    name: "rename",
    description: "Rename a label on every repository, label definition, and workset using it",
  },
  args: {
    from: { type: "positional", description: "Current label name", required: false },
    to: { type: "positional", description: "New label name", required: false },
    ...commonArgs,
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const missingYaml = requireDevYaml(config);
    if (missingYaml) return reportError(missingYaml, args.json);
    try {
      const interactive = canPrompt();
      const from =
        args.from?.trim() ||
        (interactive ? await chooseExistingLabel(config, "Label to rename") : "");
      const to = args.to?.trim() || (interactive ? (await ui.text("New name", from))?.trim() : "");
      if (!from || !to) return reportError("Usage: dev label rename <from> <to>", args.json);
      if (from === to) {
        ui.result({
          data: { from, to, sources: 0 },
          json: args.json,
          text: () => `○ '${from}' already has that name.`,
        });
        return 0;
      }
      const renamed = labels.renameLabel(config.configDoc!, from, to);
      if (renamed.sources === 0 && !renamed.def && renamed.worksetMembers === 0) {
        return reportError(
          `No repository, label definition, or workset uses '${from}'.`,
          args.json,
        );
      }
      config.writeConfig?.();
      ui.result({
        data: { from, to, ...renamed },
        json: args.json,
        text: () =>
          `✓ Renamed '${from}' to '${to}' on ${renamed.sources} repositor${renamed.sources === 1 ? "y" : "ies"}` +
          `${renamed.def ? ", its definition" : ""}` +
          `${renamed.worksetMembers > 0 ? `, and ${renamed.worksetMembers} workset member(s)` : ""}.`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const labelListCommand = defineCommand({
  meta: { name: "list", description: "List labels and the repositories carrying each" },
  args: {
    label: { type: "positional", description: "Show only this label", required: false },
    ...commonArgs,
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const shown = labels
      .listLabels(config)
      .filter((item) => !args.label || item.label === args.label);
    ui.result({
      data: shown,
      json: args.json,
      text: () => {
        if (shown.length === 0) {
          return args.label
            ? `No repository carries label '${args.label}'.`
            : "No labels yet.  ↳ dev label add <label> <repository>";
        }
        return shown
          .flatMap((item) => [
            `${item.label} (${item.sources.length})${item.mirror ? "  mirrored" : ""}`,
            ...item.sources.map((source) => `  ${describeSource(source)}`),
          ])
          .join("\n");
      },
    });
    return 0;
  },
});

/** The interactive home: see every label, then pick what to do. Esc leaves. */
async function labelMenu(rawArgs: string[]): Promise<unknown> {
  await runNestedCommand(labelListCommand, rawArgs);
  const config = getActiveConfig();
  const hasLabels = labels.listLabels(config).length > 0;
  let action: string;
  try {
    action = await ui.select("What do you want to do? (Esc to exit)", [
      { label: "Put a label on repositories", value: "add" },
      ...(hasLabels
        ? [
            { label: "Edit a label's fields on repositories", value: "edit" },
            { label: "Take a label off repositories", value: "rm" },
            { label: "Rename a label", value: "rename" },
            { label: "Delete a label from every repository", value: "delete" },
          ]
        : []),
    ]);
  } catch (error) {
    if (error instanceof CancelledError) return 0;
    throw error;
  }
  if (action === "add") return await runNestedCommand(labelAddCommand, rawArgs);
  if (action === "rm") return await runNestedCommand(labelRmCommand, rawArgs);
  if (action === "rename") return await runNestedCommand(labelRenameCommand, rawArgs);
  const label = await chooseExistingLabel(
    config,
    action === "edit" ? "Label to edit" : "Label to delete",
  );
  if (action === "delete")
    return await runNestedCommand(labelRmCommand, [label, "--all", ...rawArgs]);

  const carrying = labels.listLabels(config).find((item) => item.label === label)!.sources;
  const picked = await ui.multiSelect(
    `Edit '${label}' on`,
    carrying.map((source, index) => ({ label: describeSource(source), value: String(index) })),
  );
  const first = carrying[Number(picked[0])]!;
  const current = Object.entries(first.labels[label] ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
  const fields = (await ui.text("Fields (key=value, comma-separated)", current)) ?? "";
  let code = 0;
  for (const index of picked) {
    const source = carrying[Number(index)]!;
    const ref = source.branch ?? source.pin;
    const result = await runNestedCommand(labelAddCommand, [
      label,
      source.url,
      ...(ref ? ["--ref", ref] : []),
      "--fields",
      fields,
      "--yes",
      ...rawArgs,
    ]);
    code ||= Number(result ?? 0);
  }
  return code;
}

export const labelCommand = defineCommand({
  meta: {
    name: "label",
    description:
      "Group repositories under labels: see, add, edit, rename, and remove them. Some labels keep their repositories mirrored",
  },
  args: labelListCommand.args,
  subCommands: {
    list: labelListCommand,
    ls: labelListCommand,
    add: labelAddCommand,
    rm: labelRmCommand,
    remove: labelRmCommand,
    rename: labelRenameCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(labelCommand, rawArgs)) return;
    if (canPrompt() && !rawArgs.some((arg) => !arg.startsWith("-")))
      return await labelMenu(rawArgs);
    return await runNestedCommand(labelListCommand, rawArgs);
  },
});
