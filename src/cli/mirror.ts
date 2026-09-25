import { defineCommand } from "citty";
import * as mirror from "../mirror.ts";
import * as labels from "../labels.ts";
import { resolveExtraHeader } from "../credentials.ts";
import { ui } from "../ui.ts";
import { canPrompt, getActiveConfig, getAmbient } from "./context.ts";
import { normalizeSourceKey } from "../git.ts";
import { createPluginBase, emit } from "../plugins/index.ts";
import { mirrorLabelCommand } from "./mirror-label.ts";
import { resolveChoiceInput, resolveConfirmation, resolveTextInput } from "./input.ts";
import { resolveRepositoryInput } from "./repository-input.ts";
import { resolveMirrorSourceInput } from "./mirror-input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";
import { reportError } from "./errors.ts";

export const mirrorAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Clone and set up a canonical local mirror",
  },
  args: {
    source: {
      type: "positional",
      description: "Repository URL, path, or inventory name",
      required: false,
    },
    branch: { type: "string", description: "Default branch to track" },
    name: { type: "string", description: "Custom alias name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const url = (
      await resolveRepositoryInput({
        value: args.source,
        root: config.root,
        message: "Select repository",
        required: {
          command: "mirror add",
          field: "source",
          usage: "dev mirror add <url|path|name>",
          description: "Repository source",
        },
      })
    ).value;

    try {
      const extraHeader = await resolveExtraHeader(config, url);
      const result = await mirror.ensure({
        root: config.root,
        canonicalPrefix: config.canonicalPrefix,
        source: url,
        branch: args.branch,
        alias: args.name,
        extraHeader,
      });
      if (config.configDoc) {
        labels.upsertSourceDeclaration(config.configDoc, {
          url: result.canonicalUrl,
          branch: result.branch,
        });
        config.writeConfig?.();
      }

      ui.result({
        data: result,
        json: args.json,
        text: () =>
          result.created
            ? `✓ Mirrored ${result.canonicalUrl} @ ${result.branch} at ${result.path}`
            : `○ ${result.canonicalUrl} @ ${result.branch} is already mirrored at ${result.path}`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const mirrorListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all mirrors in /mirrors (optionally filtered by label)",
  },
  args: {
    label: { type: "string", description: "Only show checkouts of sources carrying this label" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    try {
      const items = await mirror.list({
        root: config.root,
        canonicalPrefix: config.canonicalPrefix,
      });
      let shown = items;
      const labelFilter = args.label;
      if (labelFilter) {
        const { sources: declared } = labels.parseDeclaredSources(config.sources);
        const labeledKeys = new Set(
          declared.filter((s) => labelFilter in s.labels).map((s) => normalizeSourceKey(s.url)),
        );
        shown = items.filter(
          (item) => item.sourceUrl && labeledKeys.has(normalizeSourceKey(item.sourceUrl)),
        );
      }

      ui.result({
        data: shown,
        json: args.json,
        text: () => {
          if (shown.length === 0) {
            return "No mirrors found.";
          }
          let out = `Mirrors in /mirrors:\n`;
          for (const item of shown) {
            const statusStr = item.isClean ? "clean" : "dirty";
            const syncStr = item.behind > 0 ? `behind ${item.behind}` : "up-to-date";
            out += `  ${item.name} (${item.branch}) [${statusStr}, ${syncStr}]\n`;
            out += `    path: ${item.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

/** Why a mirror was left alone, in words. */
function describeMirrorSkip(reason: string | undefined): string {
  if (reason === "DIVERGED") return "local and remote history diverged";
  if (reason === "AHEAD_COMMITS") return "local commits the remote does not have";
  if (reason === "DIRTY_WORKTREE") return "uncommitted changes";
  if (reason?.startsWith("STASH_FAILED: "))
    return `could not stash local edits: ${decisiveLine(reason.slice(14))}`;
  if (reason?.startsWith("FAST_FORWARD_FAILED: "))
    return `fast-forward failed: ${decisiveLine(reason.slice(21))}`;
  return reason ?? "unknown reason";
}

/** Git's stderr in one line: the last fatal or error line, else the first; --json keeps it all. */
function decisiveLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.findLast((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? text;
}

/**
 * A mirror sync in lines: counts first, then only what needs a look. A mirror
 * already at its remote is up to date, not skipped.
 */
export function formatMirrorSync(
  result: mirror.MirrorSyncResult,
  options: { changes?: boolean } = {},
): string[] {
  const upToDate = result.skipped.filter((item) => item.reason === "UP_TO_DATE");
  const skipped = result.skipped.filter((item) => item.reason !== "UP_TO_DATE");
  const total = result.updated.length + result.skipped.length;
  const problems = skipped.length + result.refreshFailures.length;
  const counts = [
    result.updated.length > 0 ? `${result.updated.length} updated` : "",
    upToDate.length > 0 ? `${upToDate.length} up to date` : "",
    skipped.length > 0 ? `${skipped.length} skipped` : "",
  ].filter(Boolean);
  const lines = [
    total === 0
      ? "○ no mirrors  ↳ dev mirror add <source>"
      : `${problems > 0 ? "⚠" : result.updated.length > 0 ? "✓" : "○"} ${counts.join(", ")}`,
  ];
  for (const item of result.updated) {
    lines.push(
      `  ✓ ${item.path} (${item.branch}): fast-forwarded ${item.behindCount ?? 0} commits`,
    );
  }
  for (const item of skipped) {
    lines.push(`  ⚠ ${item.path} (${item.branch}): ${describeMirrorSkip(item.reason)}`);
  }
  for (const failure of result.refreshFailures) {
    lines.push(`  ⚠ could not fetch ${failure.path}: ${failure.reason}`);
  }
  for (const stash of result.stashed) {
    lines.push(
      `  ⚠ local edits in ${stash.path} (${stash.branch}) were stashed as ${stash.stashName}`,
    );
    if (options.changes) for (const change of stash.changes) lines.push(`      ${change}`);
    lines.push(`    ↳ git -C "${stash.path}" stash apply ${stash.stashSha}`);
  }
  if (result.hookWarning) lines.push(`  ⚠ ${result.hookWarning}`);
  return lines;
}

export const mirrorSyncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Preserve local edits, then synchronize one or all mirrors",
  },
  args: {
    source: { type: "positional", description: "Specific mirror source URL", required: false },
    refresh: {
      type: "boolean",
      description: "Fetch remotes before comparing (default, unless --offline)",
    },
    offline: { type: "boolean", description: "Read strictly from local mirror without network" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const fetching = !args.offline && args.refresh !== false;
    try {
      if (fetching && !args.json) ui.info("↻ Fetching mirror remotes...");
      const result = await mirror.sync({
        root: config.root,
        canonicalPrefix: config.canonicalPrefix,
        source: args.source,
        refresh: fetching,
        offline: args.offline,
        resolveExtraHeader: (source) => resolveExtraHeader(config, source),
        globalHooks: config.hooks,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => {
          const lines = formatMirrorSync(result, { changes: true });
          if (!fetching)
            lines.push("Remotes not fetched (--offline); compared with the last fetch.");
          const stages = result.trace.stages
            .map((stage) => `${stage.name} ${(stage.ms / 1000).toFixed(1)}s`)
            .join(", ");
          lines.push("", `Done in ${(result.trace.totalMs / 1000).toFixed(1)}s (${stages}).`);
          return lines.join("\n");
        },
      });
      await emit(createPluginBase(config.root, config), "mirror:sync:after", {
        root: config.root,
        updated: result.updated
          .filter((u) => u.sourceUrl)
          .map((u) => ({ sourceKey: normalizeSourceKey(u.sourceUrl!), revision: u.branch })),
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const mirrorTrackCommand = defineCommand({
  meta: {
    name: "track",
    description: "Set up a sibling worktree tracking an additional branch",
  },
  args: {
    source: {
      type: "positional",
      description: "mirror source URL or alias",
      required: false,
    },
    branch: { type: "positional", description: "Branch to check out and track", required: false },
    branchFlag: { type: "string", description: "Branch to track" },
    name: { type: "string", description: "Custom alias name" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const source = await resolveMirrorSourceInput({
      value: args.source,
      root: config.root,
      canonicalPrefix: config.canonicalPrefix,
      command: "mirror track",
      usage: "dev mirror track <source> <branch>",
    });
    const branch = await resolveTextInput({
      value: args.branch || args.branchFlag,
      message: "Branch to track",
      required: {
        command: "mirror track",
        field: "branch",
        usage: "dev mirror track <source> <branch>",
        description: "Branch to track",
      },
    });

    try {
      const extraHeader = await resolveExtraHeader(config, source.value);
      const result = await mirror.track({
        root: config.root,
        canonicalPrefix: config.canonicalPrefix,
        source: source.value,
        branch: branch.value,
        alias: args.name,
        extraHeader,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () =>
          result.created
            ? `✓ Tracking ${result.branch} at ${result.path}`
            : `○ ${result.branch} is already tracked at ${result.path}`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const mirrorUntrackCommand = defineCommand({
  meta: {
    name: "untrack",
    description: "Remove a sibling worktree for a secondary branch",
  },
  args: {
    source: {
      type: "positional",
      description: "mirror source URL or alias",
      required: false,
    },
    branch: { type: "positional", description: "Branch worktree to remove", required: false },
    branchFlag: { type: "string", description: "Branch to untrack" },
    name: { type: "string", description: "Custom alias name" },
    force: { type: "boolean", description: "Force removal of dirty worktree" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const source = await resolveMirrorSourceInput({
      value: args.source,
      root: config.root,
      canonicalPrefix: config.canonicalPrefix,
      command: "mirror untrack",
      usage: "dev mirror untrack <source> <branch>",
    });
    const branch = await resolveTextInput({
      value: args.branch || args.branchFlag,
      message: "Branch to untrack",
      required: {
        command: "mirror untrack",
        field: "branch",
        usage: "dev mirror untrack <source> <branch>",
        description: "Branch to untrack",
      },
    });
    const confirmed = await resolveConfirmation({
      confirmed: args.force,
      message: `Untrack branch '${branch.value}'?`,
      required: {
        command: "mirror untrack",
        field: "confirmation",
        usage: "dev mirror untrack <source> <branch> --force",
        description: "Explicit confirmation (--force)",
      },
    });
    if (!confirmed) {
      ui.info("Cancelled.");
      return 0;
    }

    try {
      const result = await mirror.untrack({
        root: config.root,
        canonicalPrefix: config.canonicalPrefix,
        source: source.value,
        branch: branch.value,
        alias: args.name,
        force: args.force,
      });

      ui.result({
        data: result,
        json: args.json,
        text: () => `Untracked canonical worktree: ${result.path}`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const mirrorPickCommand = defineCommand({
  meta: {
    name: "pick",
    description: "Interactive picker for mirrors and branches",
  },
  args: {
    filter: { type: "positional", description: "Optional name filter", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      let items = await mirror.list({ root: config.root, canonicalPrefix: config.canonicalPrefix });
      const filter = args.filter?.toLowerCase();
      if (filter) {
        items = items.filter(
          (item) =>
            item.name.toLowerCase().includes(filter) || item.path.toLowerCase().includes(filter),
        );
      }

      if (canPrompt(ambient)) {
        const selected = await resolveChoiceInput({
          choices: async () =>
            items.map((item) => ({
              label: `${item.name} (${item.branch})`,
              value: item.path,
            })),
          message: "Select mirror",
          required: {
            command: "mirror pick",
            field: "mirror",
            usage: "dev mirror pick [filter]",
            description: "Mirror",
          },
        });
        ui.log(selected.value);
        return 0;
      }

      ui.result({
        data: items,
        json: args.json,
        text: () => {
          if (items.length === 0) return "No mirrors found.";
          let out = `Mirrors:\n`;
          for (const item of items) {
            out += `  - ${item.name} (${item.branch}) -> ${item.path}\n`;
          }
          return out.trimEnd();
        },
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const mirrorCommand = defineCommand({
  meta: {
    name: "mirror",
    description: "Manage canonical reference repositories",
  },
  args: mirrorListCommand.args,
  subCommands: {
    add: mirrorAddCommand,
    list: mirrorListCommand,
    ls: mirrorListCommand,
    sync: mirrorSyncCommand,
    track: mirrorTrackCommand,
    untrack: mirrorUntrackCommand,
    pick: mirrorPickCommand,
    label: mirrorLabelCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(mirrorCommand, rawArgs)) return;
    return await runNestedCommand(mirrorListCommand, rawArgs);
  },
});
