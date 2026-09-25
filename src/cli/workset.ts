import { defineCommand } from "citty";
import * as git from "../git.ts";
import * as workset from "../workset.ts";
import type { RuntimeConfig, WorksetDefinition, WorksetMember } from "../config.ts";
import { ui } from "../ui.ts";
import { canPrompt, getActiveConfig, getAmbient } from "./context.ts";
import { resolveChoiceInput, resolveConfirmation, resolveTextInput } from "./input.ts";
import { resolveRepositoryInput } from "./repository-input.ts";
import { hasExplicitSubcommand, runNestedCommand } from "./run.ts";
import { reportError } from "./errors.ts";

export const worksetCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a reusable repository workset" },
  args: {
    name: { type: "positional", description: "Workset name", required: false },
    source: {
      type: "positional",
      description: "Initial repository URL, path, or inventory name",
      required: false,
    },
    description: { type: "string", description: "Workset description" },
    ref: { type: "string", description: "Branch, tag, or revision" },
    path: { type: "string", description: "Workspace mount path" },
    reason: { type: "string", description: "Reason this repository belongs in the workset" },
    yes: { type: "boolean", description: "Create without interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const name = await resolveTextInput({
        value: args.name,
        message: "Workset name",
        required: {
          command: "workset create",
          field: "name",
          usage: "dev workset create [name] [repository]",
          description: "Workset name",
        },
        ambient,
      });
      const description =
        args.description !== undefined
          ? args.description
          : canPrompt(ambient)
            ? optionalText(await ui.text("Workset description"))
            : undefined;
      const source = await resolveRepositoryInput({
        value: args.source,
        root: config.root,
        message: "Select initial repository",
        required: {
          command: "workset create",
          field: "repository",
          usage: "dev workset create [name] [repository]",
          description: "Initial repository",
        },
        ambient,
      });
      const member = {
        source: source.value,
        ref:
          args.ref !== undefined
            ? args.ref
            : canPrompt(ambient)
              ? optionalText(await ui.text("Ref (optional)"))
              : undefined,
        path:
          args.path !== undefined
            ? args.path
            : canPrompt(ambient)
              ? optionalText(
                  await ui.text("Workspace path", git.deriveDefaultMountPath(source.value)),
                )
              : undefined,
        reason:
          args.reason !== undefined
            ? args.reason
            : canPrompt(ambient)
              ? optionalText(await ui.text("Reason (optional)"))
              : undefined,
      };
      const draft = { description: optionalText(description), members: [member] };
      if (canPrompt(ambient) && !args.yes) {
        ui.log(renderWorkset(config, name.value, draft));
        if (!(await ui.confirm("Create this workset?", true))) return 0;
      }
      const { definition, created } = workset.createWorkset(config, name.value, draft);
      ui.result({
        data: { name: name.value, created, ...definition },
        json: args.json,
        text: created
          ? `✓ Created workset '${name.value}' with ${member.source}`
          : `○ Workset '${name.value}' already exists with this definition`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetRenameCommand = defineCommand({
  meta: { name: "rename", description: "Rename a configured workset" },
  args: {
    name: { type: "positional", description: "Current workset name", required: false },
    newName: { type: "positional", description: "New workset name", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const current = await resolveChoiceInput({
        value: args.name,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset to rename",
        required: {
          command: "workset rename",
          field: "name",
          usage: "dev workset rename [name] [new-name]",
          description: "Current workset name",
        },
        ambient,
      });
      const next = await resolveTextInput({
        value: args.newName,
        message: "New workset name",
        required: {
          command: "workset rename",
          field: "new-name",
          usage: "dev workset rename [name] [new-name]",
          description: "New workset name",
        },
        ambient,
      });
      const definition = workset.renameWorkset(config, current.value, next.value);
      ui.result({
        data: { name: next.value, ...definition },
        json: args.json,
        text: `Renamed workset '${current.value}' to '${next.value}'.`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function renderMember(config: RuntimeConfig, member: WorksetMember): string {
  const reason = member.reason ? ` — ${member.reason}` : "";
  if (member.label !== undefined) {
    const count = workset.declaredLabels(config).get(member.label) ?? 0;
    return `label ${member.label} (${count} ${count === 1 ? "repository" : "repositories"})${reason}`;
  }
  const ref = member.ref ? ` @ ${member.ref}` : "";
  const path = member.path ? ` → ${member.path}` : "";
  return `${member.source}${ref}${path}${reason}`;
}

function renderWorkset(config: RuntimeConfig, name: string, definition: WorksetDefinition): string {
  const lines = [
    `${name}${definition.description ? ` — ${definition.description}` : ""}`,
    ...definition.members.map((member) => `  ${renderMember(config, member)}`),
  ];
  return lines.join("\n");
}

function repositoryChoice(member: WorksetMember & { source: string }): string {
  return `${member.path ?? git.deriveDefaultMountPath(member.source)} — ${member.source}`;
}

export const worksetManageCommand = defineCommand({
  meta: { name: "manage", description: "Interactively manage a workset" },
  args: {
    name: { type: "positional", description: "Workset name", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const ambient = getAmbient();
    if (!canPrompt(ambient)) {
      return reportError("'dev workset manage' requires an interactive terminal.", args.json);
    }
    const config = getActiveConfig(args.root);
    let name = args.name?.trim();
    let originalName: string | undefined;

    if (!name && Object.keys(config.worksets).length > 0) {
      const selected = await ui.select("Select workset to manage", [
        ...Object.keys(config.worksets).map((worksetName) => ({
          label: worksetName,
          value: worksetName,
        })),
        { label: "Create new workset", value: "\0create" },
      ]);
      if (selected !== "\0create") {
        name = selected;
        originalName = selected;
      }
    }

    if (name && config.worksets[name]) originalName = name;
    if (!name) {
      name = (
        await resolveTextInput({
          message: "Workset name",
          required: {
            command: "workset manage",
            field: "name",
            usage: "dev workset manage [name]",
            description: "Workset name",
          },
          ambient,
        })
      ).value;
    }

    const existing = originalName ? config.worksets[originalName] : undefined;
    const draft: WorksetDefinition = existing
      ? structuredClone(existing)
      : {
          description: optionalText(await ui.text("Workset description")),
          members: [],
        };

    while (true) {
      const labelCounts = workset.declaredLabels(config);
      const hasRepository = draft.members.some((member) => member.source !== undefined);
      const hasLabel = draft.members.some((member) => member.label !== undefined);
      const action = await ui.select("Manage workset", [
        { label: "Rename workset", value: "rename" },
        { label: "Edit description", value: "description" },
        { label: "Add repository", value: "add" },
        ...(labelCounts.size > 0 ? [{ label: "Add label", value: "add-label" }] : []),
        ...(hasRepository ? [{ label: "Edit repository", value: "edit" }] : []),
        ...(draft.members.length > 0
          ? [
              {
                label: `Remove ${hasLabel ? "repository or label" : "repository"}`,
                value: "remove",
              },
              { label: "Review changes", value: "review" },
              { label: "Save and exit", value: "save" },
            ]
          : []),
        { label: "Discard changes", value: "discard" },
      ]);

      if (action === "discard") {
        ui.info("Discarded workset changes.");
        return 0;
      }
      if (action === "rename") {
        name = (
          await resolveTextInput({
            message: "New workset name",
            initial: name,
            required: {
              command: "workset manage",
              field: "name",
              usage: "dev workset manage [name]",
              description: "Workset name",
            },
            ambient,
          })
        ).value;
        continue;
      }
      if (action === "description") {
        draft.description = optionalText(await ui.text("Workset description", draft.description));
        continue;
      }
      if (action === "add") {
        const source = await resolveRepositoryInput({
          root: config.root,
          message: "Select repository to add",
          required: {
            command: "workset manage",
            field: "repository",
            usage: "dev workset manage [name]",
            description: "Repository",
          },
          ambient,
        });
        draft.members.push({
          source: source.value,
          ref: optionalText(await ui.text("Ref (optional)")),
          path: optionalText(
            await ui.text("Workspace path", git.deriveDefaultMountPath(source.value)),
          ),
          reason: optionalText(await ui.text("Reason (optional)")),
        });
        continue;
      }
      if (action === "add-label") {
        const label = await ui.select(
          "Select label to add",
          [...labelCounts].map(([label, count]) => ({
            label: `${label} (${count} ${count === 1 ? "repository" : "repositories"})`,
            value: label,
          })),
        );
        draft.members.push({ label, reason: optionalText(await ui.text("Reason (optional)")) });
        continue;
      }
      if (action === "review") {
        ui.log(renderWorkset(config, name, draft));
        continue;
      }

      if (action === "remove") {
        const selected = await ui.select(
          "Select member to remove",
          draft.members.map((member, index) => ({
            label:
              member.source !== undefined ? repositoryChoice(member) : renderMember(config, member),
            value: String(index),
          })),
        );
        draft.members.splice(Number(selected), 1);
        continue;
      }

      if (action === "edit") {
        const selected = await ui.select(
          "Select repository to edit",
          draft.members.flatMap((member, index) =>
            member.source !== undefined
              ? [{ label: repositoryChoice(member), value: String(index) }]
              : [],
          ),
        );
        const index = Number(selected);
        const member = draft.members[index];
        if (member?.source === undefined) continue;
        draft.members[index] = {
          ...member,
          ref: optionalText(await ui.text("Ref (optional)", member.ref)),
          path: optionalText(
            await ui.text(
              "Workspace path",
              member.path ?? git.deriveDefaultMountPath(member.source),
            ),
          ),
          reason: optionalText(await ui.text("Reason (optional)", member.reason)),
        };
        continue;
      }

      ui.log(renderWorkset(config, name, draft));
      if (!(await ui.confirm("Save this workset?", true))) continue;
      try {
        const definition = workset.saveWorksetDraft(config, originalName, name, draft);
        ui.result({
          data: { name, ...definition },
          json: args.json,
          text: `Saved workset '${name}'.`,
        });
        return 0;
      } catch (error) {
        return reportError(error, args.json);
      }
    }
  },
});

export const worksetRepoAddCommand = defineCommand({
  meta: { name: "add", description: "Add a repository to a workset" },
  args: {
    workset: { type: "positional", description: "Workset name", required: false },
    source: {
      type: "positional",
      description: "Repository URL, path, or inventory name",
      required: false,
    },
    ref: { type: "string", description: "Branch, tag, or revision" },
    path: { type: "string", description: "Workspace mount path" },
    reason: { type: "string", description: "Reason this repository belongs in the workset" },
    yes: { type: "boolean", description: "Add without interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const selectedWorkset = await resolveChoiceInput({
        value: args.workset,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset",
        required: {
          command: "workset repo add",
          field: "workset",
          usage: "dev workset repo add [workset] [repository]",
          description: "Workset name",
        },
        ambient,
      });
      const source = await resolveRepositoryInput({
        value: args.source,
        root: config.root,
        message: "Select repository to add",
        required: {
          command: "workset repo add",
          field: "repository",
          usage: "dev workset repo add [workset] [repository]",
          description: "Repository",
        },
        ambient,
      });
      const member = {
        source: source.value,
        ref:
          args.ref !== undefined
            ? args.ref
            : canPrompt(ambient)
              ? optionalText(await ui.text("Ref (optional)"))
              : undefined,
        path:
          args.path !== undefined
            ? args.path
            : canPrompt(ambient)
              ? optionalText(
                  await ui.text("Workspace path", git.deriveDefaultMountPath(source.value)),
                )
              : undefined,
        reason:
          args.reason !== undefined
            ? args.reason
            : canPrompt(ambient)
              ? optionalText(await ui.text("Reason (optional)"))
              : undefined,
      };
      if (canPrompt(ambient) && !args.yes) {
        ui.log(renderWorkset(config, selectedWorkset.value, { members: [member] }));
        if (!(await ui.confirm("Add this repository?", true))) return 0;
      }
      const { definition, added } = workset.addWorksetMember(config, selectedWorkset.value, member);
      ui.result({
        data: { name: selectedWorkset.value, added, ...definition },
        json: args.json,
        text: added
          ? `✓ Added ${member.source} to workset '${selectedWorkset.value}'`
          : `○ ${member.source} is already in workset '${selectedWorkset.value}'`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetRepoEditCommand = defineCommand({
  meta: { name: "edit", description: "Edit repository metadata in a workset" },
  args: {
    workset: { type: "positional", description: "Workset name", required: false },
    member: { type: "positional", description: "Repository path or source", required: false },
    ref: { type: "string", description: "Branch, tag, or revision" },
    path: { type: "string", description: "Workspace mount path" },
    reason: { type: "string", description: "Reason this repository belongs in the workset" },
    yes: { type: "boolean", description: "Update without interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const selectedWorkset = await resolveChoiceInput({
        value: args.workset,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset",
        required: {
          command: "workset repo edit",
          field: "workset",
          usage: "dev workset repo edit [workset] [repository]",
          description: "Workset name",
        },
        ambient,
      });
      const currentWorkset = config.worksets[selectedWorkset.value];
      if (!currentWorkset) {
        throw new workset.WorksetError(
          "WORKSET_NOT_FOUND",
          `Unknown workset '${selectedWorkset.value}'.`,
        );
      }
      const repositories = currentWorkset.members.filter((member) => member.source !== undefined);
      const selectedMember = await resolveChoiceInput({
        value: args.member,
        choices: async () =>
          repositories.map((member) => ({
            label: repositoryChoice(member),
            value: member.path ?? member.source,
          })),
        message: "Select repository to edit",
        required: {
          command: "workset repo edit",
          field: "repository",
          usage: "dev workset repo edit [workset] [repository]",
          description: "Repository",
        },
        ambient,
      });
      const currentMember =
        repositories.find((member) => member.path === selectedMember.value) ??
        repositories.find((member) => member.source === selectedMember.value);
      const ref =
        args.ref !== undefined
          ? args.ref
          : canPrompt(ambient)
            ? optionalText(await ui.text("Ref (optional)", currentMember?.ref))
            : undefined;
      const path =
        args.path !== undefined
          ? args.path
          : canPrompt(ambient)
            ? optionalText(await ui.text("Workspace path", currentMember?.path))
            : undefined;
      const reason =
        args.reason !== undefined
          ? args.reason
          : canPrompt(ambient)
            ? optionalText(await ui.text("Reason (optional)", currentMember?.reason))
            : undefined;
      const changes = {
        ...(ref !== undefined ? { ref } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
      if (canPrompt(ambient) && !args.yes) {
        if (!(await ui.confirm("Update this repository?", true))) return 0;
      }
      const definition = workset.editWorksetMember(
        config,
        selectedWorkset.value,
        selectedMember.value,
        changes,
      );
      ui.result({
        data: { name: selectedWorkset.value, ...definition },
        json: args.json,
        text: `Updated repository in workset '${selectedWorkset.value}'.`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetRepoRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove a repository from a workset" },
  args: {
    workset: { type: "positional", description: "Workset name", required: false },
    member: { type: "positional", description: "Repository path or source", required: false },
    force: { type: "boolean", description: "Remove without interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const selectedWorkset = await resolveChoiceInput({
        value: args.workset,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset",
        required: {
          command: "workset repo remove",
          field: "workset",
          usage: "dev workset repo remove [workset] [repository] --force",
          description: "Workset name",
        },
        ambient,
      });
      const currentWorkset = config.worksets[selectedWorkset.value];
      if (!currentWorkset) {
        throw new workset.WorksetError(
          "WORKSET_NOT_FOUND",
          `Unknown workset '${selectedWorkset.value}'.`,
        );
      }
      const selectedMember = await resolveChoiceInput({
        value: args.member,
        choices: async () =>
          currentWorkset.members.flatMap((member) =>
            member.source !== undefined
              ? [{ label: repositoryChoice(member), value: member.path ?? member.source }]
              : [],
          ),
        message: "Select repository to remove",
        required: {
          command: "workset repo remove",
          field: "repository",
          usage: "dev workset repo remove [workset] [repository] --force",
          description: "Repository",
        },
        ambient,
      });
      const confirmed = await resolveConfirmation({
        confirmed: args.force,
        message: `Remove '${selectedMember.value}' from workset '${selectedWorkset.value}'?`,
        required: {
          command: "workset repo remove",
          field: "confirmation",
          usage: "dev workset repo remove [workset] [repository] --force",
          description: "Explicit confirmation (--force)",
        },
        ambient,
      });
      if (!confirmed) return 0;
      const definition = workset.removeWorksetMember(
        config,
        selectedWorkset.value,
        selectedMember.value,
      );
      ui.result({
        data: { name: selectedWorkset.value, ...definition },
        json: args.json,
        text: `Removed repository from workset '${selectedWorkset.value}'.`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetRepoCommand = defineCommand({
  meta: { name: "repo", description: "Manage repositories in a workset" },
  subCommands: {
    add: worksetRepoAddCommand,
    edit: worksetRepoEditCommand,
    remove: worksetRepoRemoveCommand,
  },
});

export const worksetLabelAddCommand = defineCommand({
  meta: { name: "add", description: "Add every repository carrying a label to a workset" },
  args: {
    workset: { type: "positional", description: "Workset name", required: false },
    label: { type: "positional", description: "Label on declared sources", required: false },
    reason: { type: "string", description: "Reason this label belongs in the workset" },
    yes: { type: "boolean", description: "Add without interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const selectedWorkset = await resolveChoiceInput({
        value: args.workset,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset",
        required: {
          command: "workset label add",
          field: "workset",
          usage: "dev workset label add [workset] [label]",
          description: "Workset name",
        },
        ambient,
      });
      const label = await resolveChoiceInput({
        value: args.label,
        choices: async () =>
          [...workset.declaredLabels(config)].map(([label, count]) => ({
            label: `${label} (${count} ${count === 1 ? "repository" : "repositories"})`,
            value: label,
          })),
        message: "Select label to add",
        required: {
          command: "workset label add",
          field: "label",
          usage: "dev workset label add [workset] [label]",
          description: "Label",
        },
        ambient,
      });
      const member = {
        label: label.value,
        reason:
          args.reason !== undefined
            ? args.reason
            : canPrompt(ambient)
              ? optionalText(await ui.text("Reason (optional)"))
              : undefined,
      };
      if (canPrompt(ambient) && !args.yes) {
        ui.log(renderWorkset(config, selectedWorkset.value, { members: [member] }));
        if (!(await ui.confirm("Add this label?", true))) return 0;
      }
      const { definition, added } = workset.addWorksetMember(config, selectedWorkset.value, member);
      ui.result({
        data: { name: selectedWorkset.value, added, ...definition },
        json: args.json,
        text: added
          ? `✓ Added label ${member.label} to workset '${selectedWorkset.value}'`
          : `○ Label ${member.label} is already in workset '${selectedWorkset.value}'`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetLabelRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove a label from a workset" },
  args: {
    workset: { type: "positional", description: "Workset name", required: false },
    label: { type: "positional", description: "Label in the workset", required: false },
    force: { type: "boolean", description: "Remove without interactive confirmation" },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const ambient = getAmbient();
    try {
      const selectedWorkset = await resolveChoiceInput({
        value: args.workset,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset",
        required: {
          command: "workset label remove",
          field: "workset",
          usage: "dev workset label remove [workset] [label] --force",
          description: "Workset name",
        },
        ambient,
      });
      const currentWorkset = config.worksets[selectedWorkset.value];
      if (!currentWorkset) {
        throw new workset.WorksetError(
          "WORKSET_NOT_FOUND",
          `Unknown workset '${selectedWorkset.value}'.`,
        );
      }
      const label = await resolveChoiceInput({
        value: args.label,
        choices: async () =>
          currentWorkset.members.flatMap((member) =>
            member.label !== undefined ? [{ label: member.label, value: member.label }] : [],
          ),
        message: "Select label to remove",
        required: {
          command: "workset label remove",
          field: "label",
          usage: "dev workset label remove [workset] [label] --force",
          description: "Label",
        },
        ambient,
      });
      const confirmed = await resolveConfirmation({
        confirmed: args.force,
        message: `Remove label '${label.value}' from workset '${selectedWorkset.value}'?`,
        required: {
          command: "workset label remove",
          field: "confirmation",
          usage: "dev workset label remove [workset] [label] --force",
          description: "Explicit confirmation (--force)",
        },
        ambient,
      });
      if (!confirmed) return 0;
      const definition = workset.removeWorksetLabel(config, selectedWorkset.value, label.value);
      ui.result({
        data: { name: selectedWorkset.value, ...definition },
        json: args.json,
        text: `Removed label ${label.value} from workset '${selectedWorkset.value}'.`,
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetLabelCommand = defineCommand({
  meta: { name: "label", description: "Manage labels in a workset" },
  subCommands: {
    add: worksetLabelAddCommand,
    remove: worksetLabelRemoveCommand,
  },
});

export const worksetListCommand = defineCommand({
  meta: { name: "list", description: "List configured worksets" },
  args: {
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const worksets = Object.entries(config.worksets)
      .map(([name, workset]) => ({
        name,
        description: workset.description,
        memberCount: workset.members.length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    ui.result({
      data: worksets,
      json: args.json,
      text: () =>
        worksets.length === 0
          ? "No worksets configured."
          : worksets
              .map(
                (workset) =>
                  `${workset.name} (${workset.memberCount})${workset.description ? ` — ${workset.description}` : ""}`,
              )
              .join("\n"),
    });
    return 0;
  },
});

export const worksetShowCommand = defineCommand({
  meta: { name: "show", description: "Show one configured workset" },
  args: {
    name: { type: "positional", description: "Workset name", required: true },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    const workset = config.worksets[args.name];
    if (!workset) {
      return reportError(`Unknown workset '${args.name}'.`, args.json);
    }
    const data = { name: args.name, ...workset };
    ui.result({
      data,
      json: args.json,
      text: () => renderWorkset(config, args.name, workset),
    });
    return 0;
  },
});

export const worksetCommand = defineCommand({
  meta: { name: "workset", description: "Manage reusable repository worksets" },
  subCommands: {
    list: worksetListCommand,
    create: worksetCreateCommand,
    rename: worksetRenameCommand,
    manage: worksetManageCommand,
    repo: worksetRepoCommand,
    label: worksetLabelCommand,
    show: worksetShowCommand,
  },
  async run({ rawArgs }) {
    if (await hasExplicitSubcommand(worksetCommand, rawArgs)) return;
    return await runNestedCommand(worksetListCommand, ["", ...rawArgs]);
  },
});
