import { defineCommand } from "citty";
import * as cache from "../cache.ts";
import type { RuntimeConfig } from "../config.ts";
import * as configFile from "../config.ts";
import { resolveExtraHeader } from "../credentials.ts";
import * as git from "../git.ts";
import * as labels from "../labels.ts";
import * as mirror from "../mirror.ts";
import { createPluginBase, emit } from "../plugins/index.ts";
import { CancelledError, ui } from "../ui.ts";
import { canPrompt, getActiveConfig } from "./context.ts";
import { reportError, reportExitCode } from "./errors.ts";
import { CliInputRequiredError, resolveTextInput } from "./input.ts";
import { resolveRepositoryInput } from "./repository-input.ts";
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
  return configFile.resolveConfig({ rootFlag: config.root, cwd: config.root, env: process.env });
}

function requireDevYaml(config: RuntimeConfig): Error | undefined {
  if (config.configPath?.endsWith(".yaml")) return undefined;
  return Object.assign(
    new Error(
      config.configPath
        ? "This root needs a dev.yaml settings file to save labels."
        : "No dev root yet.",
    ),
    { details: { usage: config.configPath ? `dev init "${config.root}"` : "dev init" } },
  );
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
      : await ui.select({
          message,
          hint: "A label names a group of repositories; choose the group to change.",
          options: [
            ...[...counts].map(([label, count]) => ({
              label: `${label} (${count})`,
              value: label,
            })),
            { label: "New label…", value: NEW },
          ],
        });
  if (choice !== NEW) return choice;
  const typed = (
    await ui.text({
      message: "Label name",
      hint: "Group repositories for tasks; index: labels also keep mirrors.",
    })
  )?.trim();
  if (!typed) throw new CancelledError();
  return typed;
}

async function chooseExistingLabel(config: RuntimeConfig, message: string): Promise<string> {
  const known = labels.listLabels(config);
  if (known.length === 0)
    throw Object.assign(new Error("No repository carries a label yet."), {
      details: {
        kind: "label",
        value: "",
        candidates: [],
        usage: !config.configPath ? "dev init" : "dev label add <label> <repository-url>",
      },
    });
  return await ui.select({
    message,
    hint: "A label names a group of repositories; choose the group to change.",
    options: known.map((item) => ({
      label: `${item.label} (${item.sources.length})`,
      value: item.label,
    })),
  });
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
    throw Object.assign(new Error("No repositories are available to label yet."), {
      details: {
        kind: "repository",
        value: "",
        candidates: [],
        usage: !config.configPath
          ? "dev init"
          : config.providers.length > 0
            ? "dev sync inventory"
            : `Pass a repository URL: dev label add ${JSON.stringify(label)} <repository-url>`,
      },
    });
  }
  return await ui.multiSelect({
    message: `Select repositories for '${label}'`,
    hint: "Put this label on each selected repository.",
    options: [...options.values()],
  });
}

async function resolveUrl(config: RuntimeConfig, value: string): Promise<string> {
  const resolved = await resolveRepositoryInput({
    value,
    root: config.root,
    message: "Select repository",
    required: {
      command: "label",
      field: "sources",
      usage: "dev label add <label> <repository...>",
      description: "Repository source",
    },
  });
  return git.stripCredentialsFromUrl(resolved.value);
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
    const chosen = await ui.multiSelect({
      message: "Select repositories to customize",
      hint: "Change branch or folder; Continue with defaults keeps the plan.",
      options: [
        { label: "Continue with defaults", value: "defaults" },
        ...options.urls.map((url) => ({ label: git.deriveDefaultMountPath(url), value: url })),
      ],
    });
    for (const url of chosen.filter((value) => value !== "defaults")) {
      const extraHeader = await resolveExtraHeader(options.config, url);
      const remote = await git.listRemoteBranches({ source: url, extraHeader });
      if (remote.branches.length === 0) continue;
      branches.set(
        url,
        await ui.select({
          message: `Branch for ${git.deriveDefaultMountPath(url)}`,
          hint: "This group uses the selected branch; (default) is the remote default.",
          options: remote.branches.map((branch) => ({
            label: branch === remote.defaultBranch ? `${branch} (default)` : branch,
            value: branch,
          })),
        }),
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
      const index = await ui.select({
        message: `Which ref of ${git.deriveDefaultMountPath(url)}?`,
        hint: "Choose which branch, tag or commit belongs to this group.",
        options: plan.ambiguous.map((source, i) => ({
          label: describeSource(source),
          value: String(i),
        })),
      });
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
        `  ○ ${describeSource(target.selector)}${target.declared ? "" : "  (new in dev.yaml)"}`,
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
  return reportExitCode(result.failures.length > 0 ? 1 : 0);
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
      description: "Repositories: URL, path, or name (several allowed)",
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
      const usage = "dev label add <label> <repository...>";
      const label = (
        await resolveTextInput({
          value:
            args.label?.trim() || (interactive ? await chooseLabel(config, "Label") : undefined),
          message: "Label name",
          hint: "Group repositories for tasks; index: labels also keep mirrors.",
          required: { command: "label add", field: "label", usage, description: "Label name" },
        })
      ).value;
      const given = (args._ as string[]).slice(1);
      if (given.length === 0 && !interactive) {
        throw new CliInputRequiredError({
          command: "label add",
          field: "sources",
          usage,
          description: "At least one repository",
        });
      }
      const parsed = parseFields(args.fields);
      if (parsed.error) return reportError(parsed.error, args.json);

      const urls =
        given.length > 0
          ? await Promise.all(given.map((value) => resolveUrl(config, value)))
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
      if (
        guided &&
        !args.yes &&
        !(await ui.confirm({
          message: "Apply this label?",
          hint: "Yes saves the group; No leaves repository labels unchanged.",
          initial: true,
        }))
      ) {
        return 0;
      }

      const applied = await labels.addLabel(config, label, targets);
      const base = createPluginBase(config.root);
      for (const target of applied.added) {
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
          added: applied.added,
          unchanged: applied.unchanged,
          missingMirrors: missing.map((target) => target.selector),
        },
        json: args.json,
        text: () =>
          [
            ...(applied.added.length > 0
              ? [
                  `✓ Labeled ${applied.added.length} repositor${applied.added.length === 1 ? "y" : "ies"} '${label}'.`,
                ]
              : []),
            ...applied.unchanged.map(
              (source) => `○ ${describeSource(source)} already labeled '${label}'.`,
            ),
            `↳ dev label ls ${label}  see this group of repositories`,
          ].join("\n"),
      });
      if (missing.length === 0) return 0;
      const now =
        args.sync ||
        (guided &&
          (await ui.confirm({
            message: `Create ${missing.length} missing mirror${missing.length === 1 ? "" : "s"} now?`,
            hint: "Yes creates reference copies for reading; No waits for a sync.",
            initial: true,
          })));
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
        return reportError(
          new labels.LabelError("LABEL_NOT_FOUND", `No repository carries label '${label}'.`, {
            kind: "label",
            value: label,
            candidates: labels.listLabels(config).map((item) => item.label),
            usage:
              labels.listLabels(config).length > 0
                ? "dev label list"
                : "dev label add <label> <repository-url>",
          }),
          args.json,
        );
      }

      const given = (args._ as string[]).slice(1);
      let chosen: Declared[];
      if (args.all) chosen = carrying;
      else if (given.length > 0) {
        const keys = new Set(
          (await Promise.all(given.map((value) => resolveUrl(config, value)))).map(
            git.normalizeSourceKey,
          ),
        );
        chosen = carrying.filter(
          (source) =>
            keys.has(git.normalizeSourceKey(source.url)) &&
            (!args.ref || source.branch === args.ref || source.pin === args.ref),
        );
        if (chosen.length === 0) {
          return reportError(
            Object.assign(new Error(`None of those repositories carries label '${label}'.`), {
              details: {
                kind: "repository",
                value: given.map((value) => git.stripCredentialsFromUrl(value)).join(", "),
                candidates: carrying.map((source) => git.stripCredentialsFromUrl(source.url)),
                usage: "dev label list",
              },
            }),
            args.json,
          );
        }
      } else if (interactive) {
        const picked = await ui.multiSelect({
          message: `Take '${label}' off`,
          hint: "Remove the label only from your selection; copies on disk stay.",
          options: carrying.map((source, index) => ({
            label: describeSource(source),
            value: String(index),
          })),
        });
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
      if (
        guidedRm &&
        !args.yes &&
        !(await ui.confirm({
          message: "Remove this label?",
          hint: "Yes removes it from the selected repositories; mirrors stay.",
          initial: true,
        }))
      )
        return 0;

      await labels.removeLabel(config, label, chosen);
      const base = createPluginBase(config.root);
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
            "↳ dev label ls  see the remaining repository groups",
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
      const to =
        args.to?.trim() ||
        (interactive
          ? (
              await ui.text({
                message: "New name",
                hint: "Rename this label everywhere. Enter keeps its current name.",
                initial: from,
              })
            )?.trim()
          : "");
      if (!from || !to) return reportError("Usage: dev label rename <from> <to>", args.json);
      if (from === to) {
        ui.result({
          data: { from, to, sources: 0 },
          json: args.json,
          text: () => `○ '${from}' already has that name.`,
        });
        return 0;
      }
      const renamed = await labels.renameLabel(config, from, to);
      if (renamed.sources === 0 && !renamed.def && renamed.worksetMembers === 0) {
        return reportError(
          new labels.LabelError(
            "LABEL_NOT_FOUND",
            `No repository, label definition, or workset uses '${from}'.`,
            {
              kind: "label",
              value: from,
              candidates: labels.listLabels(config).map((item) => item.label),
              usage:
                labels.listLabels(config).length > 0
                  ? "dev label list"
                  : "dev label add <label> <repository-url>",
            },
          ),
          args.json,
        );
      }
      ui.result({
        data: { from, to, ...renamed },
        json: args.json,
        text: () =>
          `✓ Renamed '${from}' to '${to}' on ${renamed.sources} repositor${renamed.sources === 1 ? "y" : "ies"}` +
          `${renamed.def ? ", its definition" : ""}` +
          `${renamed.worksetMembers > 0 ? `, and ${renamed.worksetMembers} workset member(s)` : ""}.\n↳ dev label ls ${to}  see the renamed repository group`,
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
          return ui.empty({
            message: !config.configPath
              ? "No dev root yet, so there are no labels to show."
              : args.label
                ? `No repository carries label '${args.label}'.`
                : "No labels added to repositories yet.",
            next: !config.configPath
              ? [{ command: "dev init", why: "choose where to keep your work" }]
              : [
                  {
                    command: `dev label add ${args.label || "<label>"} <repository-url>`,
                    why: "name a group of repositories",
                  },
                ],
          });
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
    action = await ui.select({
      message: "What do you want to do? (Esc to exit)",
      hint: "A label groups repositories; choose how to change that group.",
      options: [
        { label: "Put a label on repositories", value: "add" },
        ...(hasLabels
          ? [
              { label: "Edit a label's fields on repositories", value: "edit" },
              { label: "Take a label off repositories", value: "rm" },
              { label: "Rename a label", value: "rename" },
              { label: "Delete a label from every repository", value: "delete" },
            ]
          : []),
      ],
    });
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
  const picked = await ui.multiSelect({
    message: `Edit '${label}' on`,
    hint: "Change label fields only on these repositories.",
    options: carrying.map((source, index) => ({
      label: describeSource(source),
      value: String(index),
    })),
  });
  const first = carrying[Number(picked[0])]!;
  const current = Object.entries(first.labels[label] ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
  const fields =
    (await ui.text({
      message: "Fields (key=value, comma-separated)",
      hint: "For example team=payments. Enter keeps the shown fields.",
      initial: current,
    })) ?? "";
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
  return reportExitCode(code);
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
    // `--root <path>` takes a value; that value is not a label to list.
    const positionals = rawArgs.filter(
      (arg, index) => !arg.startsWith("-") && rawArgs[index - 1] !== "--root",
    );
    if (canPrompt() && positionals.length === 0) return await labelMenu(rawArgs);
    return await runNestedCommand(labelListCommand, rawArgs);
  },
});
