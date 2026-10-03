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
        hint: "Name a saved recipe. Start it with dev ws init --workset <name>.",
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
            ? optionalText(
                await ui.text({
                  message: "Workset description",
                  hint: "Describe the saved workspace recipe for you and your agents.",
                }),
              )
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
              ? optionalText(
                  await ui.text({
                    message: "Ref (optional)",
                    hint: "Use a branch, tag or commit; blank uses the remote default branch.",
                  }),
                )
              : undefined,
        path:
          args.path !== undefined
            ? args.path
            : canPrompt(ambient)
              ? optionalText(
                  await ui.text({
                    message: "Workspace path",
                    hint: "Folder inside a workspace. Enter keeps the shown folder.",
                    initial: git.deriveDefaultMountPath(source.value),
                  }),
                )
              : undefined,
        reason:
          args.reason !== undefined
            ? args.reason
            : canPrompt(ambient)
              ? optionalText(
                  await ui.text({
                    message: "Reason (optional)",
                    hint: "Explain why the task needs this member; blank leaves no note.",
                  }),
                )
              : undefined,
      };
      const draft = { description: optionalText(description), members: [member] };
      if (canPrompt(ambient) && !args.yes) {
        ui.log(renderWorkset(config, name.value, draft));
        if (
          !(await ui.confirm({
            message: "Create this workset?",
            hint: "Yes saves this recipe; No leaves your worksets unchanged.",
            initial: true,
          }))
        )
          return 0;
      }
      const { definition, created } = await workset.createWorkset(config, name.value, draft);
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
        hint: "Rename a saved workspace recipe, not a task folder.",
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
        hint: "Rename this saved recipe. Enter keeps the shown name.",
        required: {
          command: "workset rename",
          field: "new-name",
          usage: "dev workset rename [name] [new-name]",
          description: "New workset name",
        },
        ambient,
      });
      const definition = await workset.renameWorkset(config, current.value, next.value);
      ui.result({
        data: { name: next.value, ...definition },
        json: args.json,
        text: `✓ Renamed workset '${current.value}' to '${next.value}'.`,
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
      const selected = await ui.select({
        message: "Select workset to manage",
        hint: "Edit a saved workspace recipe, or start a new one.",
        options: [
          ...Object.keys(config.worksets).map((worksetName) => ({
            label: worksetName,
            value: worksetName,
          })),
          { label: "Create new workset", value: "\0create" },
        ],
      });
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
          hint: "Name a saved recipe. Start it with dev ws init --workset <name>.",
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
          description: optionalText(
            await ui.text({
              message: "Workset description",
              hint: "Describe the saved workspace recipe for you and your agents.",
            }),
          ),
          members: [],
        };

    while (true) {
      const labelCounts = workset.declaredLabels(config);
      const hasRepository = draft.members.some((member) => member.source !== undefined);
      const hasLabel = draft.members.some((member) => member.label !== undefined);
      const action = await ui.select({
        message: "Manage workset",
        hint: "Edit a draft recipe. Nothing changes until you save.",
        options: [
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
        ],
      });

      if (action === "discard") {
        ui.info("Discarded workset changes.");
        return 0;
      }
      if (action === "rename") {
        name = (
          await resolveTextInput({
            message: "New workset name",
            hint: "Rename this saved recipe. Enter keeps the shown name.",
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
        draft.description = optionalText(
          await ui.text({
            message: "Workset description",
            hint: "Purpose of the saved workspace recipe. Enter keeps the shown text.",
            initial: draft.description,
          }),
        );
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
          ref: optionalText(
            await ui.text({
              message: "Ref (optional)",
              hint: "Use a branch, tag or commit; blank uses the remote default branch.",
            }),
          ),
          path: optionalText(
            await ui.text({
              message: "Workspace path",
              hint: "Folder inside a workspace. Enter keeps the shown folder.",
              initial: git.deriveDefaultMountPath(source.value),
            }),
          ),
          reason: optionalText(
            await ui.text({
              message: "Reason (optional)",
              hint: "Explain why the task needs this member; blank leaves no note.",
            }),
          ),
        });
        continue;
      }
      if (action === "add-label") {
        const label = await ui.select({
          message: "Select label to add",
          hint: "The recipe includes repositories carrying this label.",
          options: [...labelCounts].map(([label, count]) => ({
            label: `${label} (${count} ${count === 1 ? "repository" : "repositories"})`,
            value: label,
          })),
        });
        draft.members.push({
          label,
          reason: optionalText(
            await ui.text({
              message: "Reason (optional)",
              hint: "Explain why the task needs this member; blank leaves no note.",
            }),
          ),
        });
        continue;
      }
      if (action === "review") {
        ui.log(renderWorkset(config, name, draft));
        continue;
      }

      if (action === "remove") {
        const selected = await ui.select({
          message: "Select member to remove",
          hint: "Remove it from the recipe, not from existing workspaces.",
          options: draft.members.map((member, index) => ({
            label:
              member.source !== undefined ? repositoryChoice(member) : renderMember(config, member),
            value: String(index),
          })),
        });
        draft.members.splice(Number(selected), 1);
        continue;
      }

      if (action === "edit") {
        const selected = await ui.select({
          message: "Select repository to edit",
          hint: "Change the branch, folder or reason saved in this recipe.",
          options: draft.members.flatMap((member, index) =>
            member.source !== undefined
              ? [{ label: repositoryChoice(member), value: String(index) }]
              : [],
          ),
        });
        const index = Number(selected);
        const member = draft.members[index];
        if (member?.source === undefined) continue;
        draft.members[index] = {
          ...member,
          ref: optionalText(
            await ui.text({
              message: "Ref (optional)",
              hint: "Branch, tag or commit. Enter keeps the shown value, or remote default.",
              initial: member.ref,
            }),
          ),
          path: optionalText(
            await ui.text({
              message: "Workspace path",
              hint: "Folder inside a workspace. Enter keeps the shown folder.",
              initial: member.path ?? git.deriveDefaultMountPath(member.source),
            }),
          ),
          reason: optionalText(
            await ui.text({
              message: "Reason (optional)",
              hint: "Explain why the task needs it. Enter keeps the shown note.",
              initial: member.reason,
            }),
          ),
        };
        continue;
      }

      ui.log(renderWorkset(config, name, draft));
      if (
        !(await ui.confirm({
          message: "Save this workset?",
          hint: "Yes saves the draft; No leaves the saved recipe unchanged.",
          initial: true,
        }))
      )
        continue;
      try {
        const definition = await workset.saveWorksetDraft(config, originalName, name, draft);
        ui.result({
          data: { name, ...definition },
          json: args.json,
          text: `✓ Saved workset '${name}'.`,
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
        hint: "Use this saved recipe to choose repositories and branches.",
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
              ? optionalText(
                  await ui.text({
                    message: "Ref (optional)",
                    hint: "Use a branch, tag or commit; blank uses the remote default branch.",
                  }),
                )
              : undefined,
        path:
          args.path !== undefined
            ? args.path
            : canPrompt(ambient)
              ? optionalText(
                  await ui.text({
                    message: "Workspace path",
                    hint: "Folder inside a workspace. Enter keeps the shown folder.",
                    initial: git.deriveDefaultMountPath(source.value),
                  }),
                )
              : undefined,
        reason:
          args.reason !== undefined
            ? args.reason
            : canPrompt(ambient)
              ? optionalText(
                  await ui.text({
                    message: "Reason (optional)",
                    hint: "Explain why the task needs this member; blank leaves no note.",
                  }),
                )
              : undefined,
      };
      if (canPrompt(ambient) && !args.yes) {
        ui.log(renderWorkset(config, selectedWorkset.value, { members: [member] }));
        if (
          !(await ui.confirm({
            message: "Add this repository?",
            hint: "Yes adds it to the recipe; No leaves the recipe unchanged.",
            initial: true,
          }))
        )
          return 0;
      }
      const { definition, added } = await workset.addWorksetMember(
        config,
        selectedWorkset.value,
        member,
      );
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
        hint: "Use this saved recipe to choose repositories and branches.",
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
        hint: "Change the branch, folder or reason saved in this recipe.",
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
            ? optionalText(
                await ui.text({
                  message: "Ref (optional)",
                  hint: "Branch, tag or commit. Enter keeps the shown value, or remote default.",
                  initial: currentMember?.ref,
                }),
              )
            : undefined;
      const path =
        args.path !== undefined
          ? args.path
          : canPrompt(ambient)
            ? optionalText(
                await ui.text({
                  message: "Workspace path",
                  hint: "Folder inside a workspace. Enter keeps the shown folder.",
                  initial: currentMember?.path,
                }),
              )
            : undefined;
      const reason =
        args.reason !== undefined
          ? args.reason
          : canPrompt(ambient)
            ? optionalText(
                await ui.text({
                  message: "Reason (optional)",
                  hint: "Explain why the task needs it. Enter keeps the shown note.",
                  initial: currentMember?.reason,
                }),
              )
            : undefined;
      const changes = {
        ...(ref !== undefined ? { ref } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
      if (canPrompt(ambient) && !args.yes) {
        if (
          !(await ui.confirm({
            message: "Update this repository?",
            hint: "Yes saves this member; No keeps its previous branch and folder.",
            initial: true,
          }))
        )
          return 0;
      }
      const definition = await workset.editWorksetMember(
        config,
        selectedWorkset.value,
        selectedMember.value,
        changes,
      );
      ui.result({
        data: { name: selectedWorkset.value, ...definition },
        json: args.json,
        text: `✓ Updated repository in workset '${selectedWorkset.value}'.`,
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
        hint: "Use this saved recipe to choose repositories and branches.",
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
        hint: "Remove it from this recipe; existing workspace mounts stay.",
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
        hint: "Yes removes this recipe member; existing workspaces stay.",
        required: {
          command: "workset repo remove",
          field: "confirmation",
          usage: "dev workset repo remove [workset] [repository] --force",
          description: "Explicit confirmation (--force)",
        },
        ambient,
      });
      if (!confirmed) return 0;
      const definition = await workset.removeWorksetMember(
        config,
        selectedWorkset.value,
        selectedMember.value,
      );
      ui.result({
        data: { name: selectedWorkset.value, ...definition },
        json: args.json,
        text: `✓ Removed repository from workset '${selectedWorkset.value}'.`,
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
    rm: worksetRepoRemoveCommand,
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
        hint: "Use this saved recipe to choose repositories and branches.",
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
        hint: "The recipe includes repositories carrying this label.",
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
              ? optionalText(
                  await ui.text({
                    message: "Reason (optional)",
                    hint: "Explain why the task needs this member; blank leaves no note.",
                  }),
                )
              : undefined,
      };
      if (canPrompt(ambient) && !args.yes) {
        ui.log(renderWorkset(config, selectedWorkset.value, { members: [member] }));
        if (
          !(await ui.confirm({
            message: "Add this label?",
            hint: "Yes adds this group to the recipe; No leaves it unchanged.",
            initial: true,
          }))
        )
          return 0;
      }
      const { definition, added } = await workset.addWorksetMember(
        config,
        selectedWorkset.value,
        member,
      );
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
        hint: "Use this saved recipe to choose repositories and branches.",
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
        hint: "Remove this group from the recipe; repository labels stay.",
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
        hint: "Yes removes the group from this recipe; repository labels stay.",
        required: {
          command: "workset label remove",
          field: "confirmation",
          usage: "dev workset label remove [workset] [label] --force",
          description: "Explicit confirmation (--force)",
        },
        ambient,
      });
      if (!confirmed) return 0;
      const definition = await workset.removeWorksetLabel(
        config,
        selectedWorkset.value,
        label.value,
      );
      ui.result({
        data: { name: selectedWorkset.value, ...definition },
        json: args.json,
        text: `✓ Removed label ${label.value} from workset '${selectedWorkset.value}'.`,
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
    rm: worksetLabelRemoveCommand,
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
    name: { type: "positional", description: "Workset name", required: false },
    root: { type: "string", description: "Explicit dev root directory" },
    json: { type: "boolean", description: "Output in structured JSON format" },
  },
  async run({ args }) {
    const config = getActiveConfig(args.root);
    try {
      const selected = await resolveChoiceInput({
        value: args.name,
        choices: async () =>
          Object.keys(config.worksets).map((name) => ({ label: name, value: name })),
        message: "Select workset",
        hint: "Use this saved recipe to choose repositories and branches.",
        required: {
          command: "workset show",
          field: "name",
          usage: "dev workset show <name>",
          description: "Workset name",
        },
      });
      const definition = config.worksets[selected.value];
      if (!definition)
        throw new workset.WorksetError("WORKSET_NOT_FOUND", `Unknown workset '${selected.value}'.`);
      ui.result({
        data: { name: selected.value, ...definition },
        json: args.json,
        text: () => renderWorkset(config, selected.value, definition),
      });
      return 0;
    } catch (error) {
      return reportError(error, args.json);
    }
  },
});

export const worksetCommand = defineCommand({
  meta: { name: "workset", description: "Manage reusable repository worksets" },
  args: worksetListCommand.args,
  subCommands: {
    list: worksetListCommand,
    ls: worksetListCommand,
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
