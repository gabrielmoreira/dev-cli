import { isMap } from "yaml";
import {
  WorksetDefinitionSchema,
  type RuntimeConfig,
  type WorksetDefinition,
  type WorksetMember,
} from "./config.ts";
import {
  LabelError,
  parseDeclaredSources,
  resolveLabelAssignments,
  type SourceDeclaration,
} from "./labels.ts";

export type WorksetErrorCode =
  | "WORKSET_CONFIG_UNWRITABLE"
  | "WORKSET_EXISTS"
  | "WORKSET_NOT_FOUND"
  | "WORKSET_MEMBER_EXISTS"
  | "WORKSET_MEMBER_NOT_FOUND"
  | "WORKSET_LAST_MEMBER";

export class WorksetError extends Error {
  constructor(
    public readonly code: WorksetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorksetError";
  }
}

function writableDocument(config: RuntimeConfig): NonNullable<RuntimeConfig["configDoc"]> {
  if (!config.configDoc || !config.writeConfig) {
    throw new WorksetError(
      "WORKSET_CONFIG_UNWRITABLE",
      "Workset management requires a dev.yaml configuration.",
    );
  }
  return config.configDoc;
}

function persistWorksets(config: RuntimeConfig, worksets: Record<string, WorksetDefinition>): void {
  const doc = writableDocument(config);
  const existing = doc.get("worksets");
  const node = isMap(existing) ? existing : doc.createNode({});
  if (!isMap(existing)) doc.set("worksets", node);

  for (const name of node.items.map((item) => String(item.key))) {
    if (!Object.hasOwn(worksets, name)) node.delete(name);
  }
  for (const [name, workset] of Object.entries(worksets)) {
    node.set(name, doc.createNode(workset));
  }
  config.writeConfig?.();
  config.worksets = worksets;
}

/** created is false when a workset with this exact definition already exists. */
export function createWorkset(
  config: RuntimeConfig,
  name: string,
  definition: WorksetDefinition,
): { definition: WorksetDefinition; created: boolean } {
  const normalizedName = name.trim();
  const parsed = WorksetDefinitionSchema.parse(definition);
  if (Object.hasOwn(config.worksets, normalizedName)) {
    const existing = config.worksets[normalizedName]!;
    if (Bun.deepEquals(WorksetDefinitionSchema.parse(existing), parsed)) {
      return { definition: existing, created: false };
    }
    throw new WorksetError(
      "WORKSET_EXISTS",
      `Workset '${normalizedName}' already exists with a different definition.`,
    );
  }
  persistWorksets(config, { ...config.worksets, [normalizedName]: parsed });
  return { definition: parsed, created: true };
}

export function renameWorkset(
  config: RuntimeConfig,
  currentName: string,
  nextName: string,
): WorksetDefinition {
  const current = currentName.trim();
  const next = nextName.trim();
  const definition = config.worksets[current];
  if (!definition) {
    throw new WorksetError("WORKSET_NOT_FOUND", `Unknown workset '${current}'.`);
  }
  if (Object.hasOwn(config.worksets, next)) {
    throw new WorksetError("WORKSET_EXISTS", `Workset '${next}' already exists.`);
  }

  const renamed = Object.fromEntries(
    Object.entries(config.worksets).map(([name, workset]) =>
      name === current ? [next, workset] : [name, workset],
    ),
  );
  persistWorksets(config, renamed);
  return definition;
}

function memberIdentity(member: WorksetMember): string {
  return member.label !== undefined
    ? JSON.stringify(["label", member.label])
    : JSON.stringify([member.source, member.ref ?? null, member.path ?? null]);
}

function validateUniqueMembers(members: WorksetMember[]): void {
  const identities = new Set<string>();
  for (const member of members) {
    const identity = memberIdentity(member);
    if (identities.has(identity)) {
      throw new WorksetError(
        "WORKSET_MEMBER_EXISTS",
        member.label !== undefined
          ? `Label '${member.label}' is already in the workset.`
          : `Repository '${member.source}' with the same ref and path is already in the workset.`,
      );
    }
    identities.add(identity);
  }
}

/** Declared sources carrying `label`. A label no source carries is an error, not an empty set. */
export function labelSources(
  config: Pick<RuntimeConfig, "labelDefs" | "sources">,
  label: string,
): SourceDeclaration[] {
  const { matches } = resolveLabelAssignments(config, label);
  if (matches.length === 0) {
    throw new LabelError(
      "LABEL_NOT_FOUND",
      `No declared source carries label '${label}'. Add it to a repository with: dev label add ${label}`,
    );
  }
  return matches.map((match) => match.source);
}

/** Every label on a declared source, with how many sources carry it. */
export function declaredLabels(config: Pick<RuntimeConfig, "sources">): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of parseDeclaredSources(config.sources).sources) {
    for (const label of Object.keys(source.labels)) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

/** added is false when the same member (source, ref and path, or label) is already there. */
export function addWorksetMember(
  config: RuntimeConfig,
  name: string,
  member: WorksetMember,
): { definition: WorksetDefinition; added: boolean } {
  const definition = config.worksets[name];
  if (!definition) {
    throw new WorksetError("WORKSET_NOT_FOUND", `Unknown workset '${name}'.`);
  }
  if (member.label !== undefined) labelSources(config, member.label);
  const identity = memberIdentity(member);
  if (definition.members.some((existing) => memberIdentity(existing) === identity)) {
    return { definition, added: false };
  }
  const updated = WorksetDefinitionSchema.parse({
    ...definition,
    members: [...definition.members, member],
  });
  persistWorksets(config, { ...config.worksets, [name]: updated });
  return { definition: updated, added: true };
}

function findMemberIndex(definition: WorksetDefinition, target: string): number {
  const pathIndex = definition.members.findIndex(
    (member) => member.source !== undefined && member.path === target,
  );
  if (pathIndex >= 0) return pathIndex;
  const sourceMatches = definition.members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.source === target);
  if (sourceMatches.length === 1) return sourceMatches[0]!.index;
  throw new WorksetError(
    "WORKSET_MEMBER_NOT_FOUND",
    sourceMatches.length > 1
      ? `Repository '${target}' is ambiguous; select it by path.`
      : `Repository '${target}' is not in the workset.`,
  );
}

function findLabelIndex(definition: WorksetDefinition, label: string): number {
  const index = definition.members.findIndex((member) => member.label === label);
  if (index < 0) {
    throw new WorksetError("WORKSET_MEMBER_NOT_FOUND", `Label '${label}' is not in the workset.`);
  }
  return index;
}

export function editWorksetMember(
  config: RuntimeConfig,
  name: string,
  target: string,
  changes: { ref?: string; path?: string; reason?: string },
): WorksetDefinition {
  const definition = config.worksets[name];
  if (!definition) {
    throw new WorksetError("WORKSET_NOT_FOUND", `Unknown workset '${name}'.`);
  }
  const index = findMemberIndex(definition, target);
  const members = definition.members.map((member, memberIndex) =>
    memberIndex === index ? { ...member, ...changes } : member,
  );
  validateUniqueMembers(members);
  const updated = WorksetDefinitionSchema.parse({ ...definition, members });
  persistWorksets(config, { ...config.worksets, [name]: updated });
  return updated;
}

/** Removes the repository at `target` (path or source). */
export function removeWorksetMember(
  config: RuntimeConfig,
  name: string,
  target: string,
): WorksetDefinition {
  return removeMember(config, name, (definition) => findMemberIndex(definition, target));
}

export function removeWorksetLabel(
  config: RuntimeConfig,
  name: string,
  label: string,
): WorksetDefinition {
  return removeMember(config, name, (definition) => findLabelIndex(definition, label));
}

function removeMember(
  config: RuntimeConfig,
  name: string,
  find: (definition: WorksetDefinition) => number,
): WorksetDefinition {
  const definition = config.worksets[name];
  if (!definition) {
    throw new WorksetError("WORKSET_NOT_FOUND", `Unknown workset '${name}'.`);
  }
  const index = find(definition);
  if (definition.members.length === 1) {
    throw new WorksetError(
      "WORKSET_LAST_MEMBER",
      `Workset '${name}' must contain at least one repository or label.`,
    );
  }
  const updated = WorksetDefinitionSchema.parse({
    ...definition,
    members: definition.members.filter((_, memberIndex) => memberIndex !== index),
  });
  persistWorksets(config, { ...config.worksets, [name]: updated });
  return updated;
}

export function saveWorksetDraft(
  config: RuntimeConfig,
  originalName: string | undefined,
  name: string,
  definition: WorksetDefinition,
): WorksetDefinition {
  const normalizedName = name.trim();
  const parsed = WorksetDefinitionSchema.parse(definition);
  validateUniqueMembers(parsed.members);
  if (originalName && !Object.hasOwn(config.worksets, originalName)) {
    throw new WorksetError("WORKSET_NOT_FOUND", `Unknown workset '${originalName}'.`);
  }
  if (normalizedName !== originalName && Object.hasOwn(config.worksets, normalizedName)) {
    throw new WorksetError("WORKSET_EXISTS", `Workset '${normalizedName}' already exists.`);
  }

  const updated = originalName
    ? Object.fromEntries(
        Object.entries(config.worksets).map(([existingName, workset]) =>
          existingName === originalName ? [normalizedName, parsed] : [existingName, workset],
        ),
      )
    : { ...config.worksets, [normalizedName]: parsed };
  persistWorksets(config, updated);
  return parsed;
}
