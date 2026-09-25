import type { RuntimeConfig } from "./config.ts";
import { normalizeSourceKey } from "./git.ts";
import * as mirror from "./mirror.ts";

/** Semantic error for label resolution failures (validation, unknown label). */
export class LabelError extends Error {
  constructor(
    public readonly code: "LABEL_VALIDATION" | "LABEL_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "LabelError";
  }
}

/** Field types supported by label_defs field schemas. */
export type LabelFieldType = "string" | "int" | "float" | "bool" | "string[]";

export interface LabelFieldSchema {
  type: LabelFieldType;
  /** Allowed values for string fields. */
  domain?: string[];
  /** Inclusive numeric bounds for int/float fields. */
  min?: number;
  max?: number;
  required: boolean;
  /** Present only when the def declares a default. */
  default?: unknown;
}

export interface LabelDef {
  /** Fixed values inherited by every assignment (e.g. qmd_collection). */
  fixed: Record<string, unknown>;
  fields: Record<string, LabelFieldSchema>;
  /** Keep every repository carrying the label mirrored; unset defers to a wildcard def. */
  mirror?: boolean;
}

export interface SourceSelector {
  url: string;
  branch?: string;
  pin?: string;
  path?: string;
}
export interface SourceDeclaration {
  url: string;
  branch?: string;
  pin?: string;
  path?: string;
  /** label -> assignment map (values validated against the label def). */
  labels: Record<string, Record<string, unknown>>;
}

export interface LabelValidation {
  meta: Record<string, unknown>;
  warnings: string[];
  errors: string[];
}

const FIELD_TYPES: ReadonlySet<string> = new Set(["string", "int", "float", "bool", "string[]"]);

function parseFieldSchema(
  name: string,
  raw: unknown,
  warnings: string[],
): LabelFieldSchema | undefined {
  if (typeof raw !== "object" || raw === null) {
    warnings.push(`label field '${name}': definition must be a map, ignoring`);
    return undefined;
  }
  const rawMap = raw as Record<string, unknown>;
  const type = String(rawMap.type ?? "string");
  if (!FIELD_TYPES.has(type)) {
    warnings.push(
      `label field '${name}': unknown type '${type}' (expected string|int|float|bool|string[]), ignoring`,
    );
    return undefined;
  }
  const schema: LabelFieldSchema = { type: type as LabelFieldType, required: false };
  if (Array.isArray(rawMap.domain)) {
    schema.domain = rawMap.domain.map(String);
  }
  if (rawMap.min !== undefined) schema.min = Number(rawMap.min);
  if (rawMap.max !== undefined) schema.max = Number(rawMap.max);
  if (rawMap.required === true) schema.required = true;
  if (rawMap.default !== undefined) {
    schema.default = coerceValue(schema, rawMap.default, `default of '${name}'`, warnings);
    schema.required = false;
  }
  return schema;
}

function coerceValue(
  schema: LabelFieldSchema,
  value: unknown,
  what: string,
  warnings: string[],
): unknown {
  switch (schema.type) {
    case "string":
      return String(value);
    case "string[]":
      return Array.isArray(value) ? value.map(String) : [String(value)];
    case "bool":
      return Boolean(value);
    case "int":
    case "float": {
      const num = schema.type === "int" ? Number.parseInt(String(value), 10) : Number(value);
      if (Number.isNaN(num)) {
        warnings.push(`${what}: '${String(value)}' is not a valid ${schema.type}`);
        return undefined;
      }
      return num;
    }
  }
}

/** Parses raw label_defs from dev.yaml into typed defs. Invalid field
 * definitions become warnings and are dropped — the rest keeps working. */
export function parseLabelDefs(raw: Record<string, Record<string, unknown>> | undefined): {
  defs: Record<string, LabelDef>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const defs: Record<string, LabelDef> = {};
  for (const [name, body] of Object.entries(raw ?? {})) {
    const def: LabelDef = { fixed: {}, fields: {} };
    for (const [key, value] of Object.entries(body)) {
      if (key === "fields" && typeof value === "object" && value !== null) {
        for (const [fieldName, fieldRaw] of Object.entries(value as Record<string, unknown>)) {
          const schema = parseFieldSchema(fieldName, fieldRaw, warnings);
          if (schema) def.fields[fieldName] = schema;
        }
      } else if (key === "mirror") {
        if (typeof value === "boolean") def.mirror = value;
        else warnings.push(`label_defs.${name}.mirror must be true or false`);
      } else {
        def.fixed[key] = value;
      }
    }
    defs[name] = def;
  }
  return { defs, warnings };
}

/** Validates one label assignment against its def. Fixed values always win
 * over assignment keys. Required-but-missing and domain/range violations are
 * errors; unknown assignment keys are warnings (typo catch, still run). */
export function resolveLabelMeta(
  def: LabelDef,
  label: string,
  assignment: unknown,
): LabelValidation {
  const warnings: string[] = [];
  const errors: string[] = [];
  const meta: Record<string, unknown> = { ...def.fixed };
  const given =
    typeof assignment === "object" && assignment !== null
      ? (assignment as Record<string, unknown>)
      : {};

  for (const [key, value] of Object.entries(given)) {
    const schema = def.fields[key];
    if (!schema) {
      warnings.push(`label '${label}': unknown field '${key}' (not declared in label_defs)`);
      continue;
    }
    if (schema.domain && !schema.domain.includes(String(value))) {
      errors.push(
        `label '${label}': field '${key}' value '${String(value)}' not in domain [${schema.domain.join(", ")}]`,
      );
      continue;
    }
    const coerced = coerceValue(schema, value, `label '${label}' field '${key}'`, warnings);
    if (coerced === undefined) continue;
    if (schema.min !== undefined && Number(coerced) < schema.min) {
      errors.push(`label '${label}': field '${key}' value ${String(coerced)} < min ${schema.min}`);
      continue;
    }
    if (schema.max !== undefined && Number(coerced) > schema.max) {
      errors.push(`label '${label}': field '${key}' value ${String(coerced)} > max ${schema.max}`);
      continue;
    }
    meta[key] = coerced;
  }

  for (const [key, schema] of Object.entries(def.fields)) {
    if (meta[key] !== undefined) continue;
    if (schema.required) {
      errors.push(`label '${label}': required field '${key}' is missing`);
    } else if (schema.default !== undefined) {
      meta[key] = schema.default;
    }
  }

  return { meta, warnings, errors };
}

/** Parses the raw `sources:` block from dev.yaml. Entries without a URL are
 * skipped with a warning; labels normalize to always-a-map form. */
export function parseDeclaredSources(raw: Array<Record<string, unknown>> | undefined): {
  sources: SourceDeclaration[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const sources: SourceDeclaration[] = [];
  for (const entry of raw ?? []) {
    const url = entry.url;
    if (typeof url !== "string" || url.trim().length === 0) {
      warnings.push(`source entry without 'url' skipped: ${JSON.stringify(entry)}`);
      continue;
    }
    const labels: Record<string, Record<string, unknown>> = {};
    const rawLabels = entry.labels;
    if (typeof rawLabels === "object" && rawLabels !== null) {
      for (const [label, assignment] of Object.entries(rawLabels as Record<string, unknown>)) {
        labels[label] =
          typeof assignment === "object" && assignment !== null
            ? (assignment as Record<string, unknown>)
            : {};
      }
    }
    sources.push({
      url: url.trim(),
      branch: typeof entry.branch === "string" ? entry.branch : undefined,
      pin: typeof entry.pin === "string" ? entry.pin : undefined,
      path: typeof entry.path === "string" ? entry.path : undefined,
      labels,
    });
  }
  return { sources, warnings };
}

/** Resolves the full desired state for one label: defs, declared sources
 * carrying it, and each assignment's validated metadata. Pure — no I/O. */
export function resolveLabelAssignments(
  config: Pick<RuntimeConfig, "labelDefs" | "sources">,
  label: string,
): {
  def: LabelDef | undefined;
  matches: Array<{ source: SourceDeclaration; meta: Record<string, unknown> }>;
  warnings: string[];
  errors: string[];
} {
  const { defs, warnings: defWarnings } = parseLabelDefs(config.labelDefs);
  const { sources, warnings: sourceWarnings } = parseDeclaredSources(config.sources);
  const warnings = [...defWarnings, ...sourceWarnings];
  const errors: string[] = [];

  const def = defs[label];
  if (!def) {
    warnings.push(
      `label '${label}' has no entry in label_defs; assignments run without validation`,
    );
  }

  const matches: Array<{ source: SourceDeclaration; meta: Record<string, unknown> }> = [];
  for (const source of sources) {
    if (!(label in source.labels)) continue;
    const validation = def
      ? resolveLabelMeta(def, label, source.labels[label])
      : { meta: { ...source.labels[label] }, warnings: [], errors: [] };
    warnings.push(...validation.warnings);
    errors.push(...validation.errors);
    matches.push({ source, meta: validation.meta });
  }
  return { def, matches, warnings, errors };
}

/** A labeled source after materialization: the checkout exists on disk at the
 * declared revision and its validated metadata is resolved. */
export interface LabeledSource {
  sourceKey: string;
  url: string;
  label: string;
  revision: { mode: "track"; branch: string } | { mode: "pin"; value: string };
  checkoutPath: string;
  commitSha?: string;
  meta: Record<string, unknown>;
}

export interface ResolveLabeledSourcesResult {
  sources: LabeledSource[];
  warnings: string[];
}

/** Resolves every source carrying `label` into a materialized checkout.
 * Validates assignments against the label def (errors abort before any I/O),
 * then ensures mirror + canonical checkout per source. Idempotent: existing
 * checkouts come back as-is; freshness stays with mirror sync. */
export async function resolveLabeledSources(
  config: RuntimeConfig,
  label: string,
  options?: { extraHeader?: string },
): Promise<ResolveLabeledSourcesResult> {
  const { matches, warnings, errors } = resolveLabelAssignments(config, label);
  if (matches.length === 0) {
    const { sources } = parseDeclaredSources(config.sources);
    if (sources.length === 0) {
      throw new LabelError(
        "LABEL_NOT_FOUND",
        `No sources declared in dev.yaml; add sources before resolving label '${label}'`,
      );
    }
    throw new LabelError("LABEL_NOT_FOUND", `No source carries label '${label}'`);
  }
  if (errors.length > 0) {
    throw new LabelError("LABEL_VALIDATION", errors.join("; "));
  }

  const sources: LabeledSource[] = [];
  for (const match of matches) {
    const ensured = await mirror.ensure({
      root: config.root,
      canonicalPrefix: config.canonicalPrefix,
      source: match.source.url,
      branch: match.source.branch,
      pin: match.source.pin,
      alias: match.source.path,
      extraHeader: options?.extraHeader,
    });
    sources.push({
      sourceKey: ensured.sourceKey,
      url: ensured.canonicalUrl,
      label,
      revision: match.source.pin
        ? { mode: "pin", value: match.source.pin }
        : { mode: "track", branch: ensured.branch },
      checkoutPath: ensured.path,
      commitSha: ensured.commitSha,
      meta: match.meta,
    });
  }
  return { sources, warnings };
}

// --- dev.yaml source declaration editing (AST-preserving) ---

import { parseDocument, isMap, isScalar, isSeq, type YAMLMap } from "yaml";

function findSourceNode(
  doc: ReturnType<typeof parseDocument>,
  selector: SourceSelector,
): YAMLMap | undefined {
  const seq = doc.get("sources");
  if (!isSeq(seq)) return undefined;
  const matches: YAMLMap[] = [];
  for (const item of seq.items) {
    if (!isMap(item) || item.get("url") !== selector.url) continue;
    if (selector.branch !== undefined && item.get("branch") !== selector.branch) continue;
    if (selector.pin !== undefined && item.get("pin") !== selector.pin) continue;
    if (selector.path !== undefined && item.get("path") !== selector.path) continue;
    matches.push(item);
  }
  const qualified =
    selector.branch !== undefined || selector.pin !== undefined || selector.path !== undefined;
  return qualified || matches.length === 1 ? matches[0] : undefined;
}

/** Inserts or updates a `sources:` entry for the URL. Mutates the caller's
 * parsed document in place (comments preserved); persistence belongs to
 * config.writeConfig(). Only url/branch are touched. */
export function upsertSourceDeclaration(
  doc: ReturnType<typeof parseDocument>,
  upsert: SourceSelector,
): { changed: boolean } {
  const existing = findSourceNode(doc, upsert);
  if (existing) {
    const before = String(existing);
    if (upsert.branch !== undefined) existing.set("branch", upsert.branch);
    if (upsert.pin !== undefined) existing.set("pin", upsert.pin);
    if (upsert.path !== undefined) existing.set("path", upsert.path);
    return { changed: String(existing) !== before };
  }
  const existingSeq = doc.get("sources");
  const seq = isSeq(existingSeq)
    ? existingSeq
    : (() => {
        const created = doc.createNode([]);
        doc.set("sources", created);
        return created;
      })();
  seq.add(doc.createNode(upsert));
  return { changed: true };
}

/** Sets (meta given) or removes (meta undefined) one label on a declared
 * source. Mutates the caller's parsed document in place; persistence belongs
 * to config.writeConfig(). Returns found: false when the source is not
 * declared. */
export function setSourceLabel(
  doc: ReturnType<typeof parseDocument>,
  selector: SourceSelector,
  label: string,
  meta: Record<string, unknown> | undefined,
): { changed: boolean; found: boolean } {
  const source = findSourceNode(doc, selector);
  if (!source) return { changed: false, found: false };

  const rawLabels = source.get("labels");
  const currentLabels: Record<string, unknown> =
    typeof rawLabels === "object" && rawLabels !== null
      ? ((rawLabels as { toJS(d: unknown): unknown }).toJS(doc) as Record<string, unknown>)
      : {};

  if (meta === undefined) {
    if (!(label in currentLabels)) return { changed: false, found: true };
    delete currentLabels[label];
  } else {
    currentLabels[label] = meta;
  }

  if (Object.keys(currentLabels).length === 0) {
    source.delete("labels");
  } else {
    source.set("labels", doc.createNode(currentLabels));
  }
  return { changed: true, found: true };
}

/** A label def key matches exactly, or as a prefix when it ends in `*` (`index:*`). */
function defMatches(key: string, label: string): boolean {
  return key.endsWith("*") ? label.startsWith(key.slice(0, -1)) : key === label;
}

/**
 * Whether a label keeps its repositories mirrored. The label's own def decides,
 * then the longest matching wildcard def; `index:*` mirrors by default, since
 * QMD can only index what is on disk.
 */
export function labelMirrors(defs: Record<string, LabelDef>, label: string): boolean {
  const own = defs[label]?.mirror;
  if (own !== undefined) return own;
  const wildcard = Object.entries(defs)
    .filter(([key, def]) => key.endsWith("*") && def.mirror !== undefined && defMatches(key, label))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (wildcard) return wildcard[1].mirror!;
  return label.startsWith("index:");
}

/** Every declared source with at least one label that asks for a mirror. Pure. */
export function sourcesToMirror(
  config: Pick<RuntimeConfig, "labelDefs" | "sources">,
): Array<{ source: SourceDeclaration; labels: string[] }> {
  const { defs } = parseLabelDefs(config.labelDefs);
  return parseDeclaredSources(config.sources).sources.flatMap((source) => {
    const mirroring = Object.keys(source.labels).filter((label) => labelMirrors(defs, label));
    return mirroring.length > 0 ? [{ source, labels: mirroring }] : [];
  });
}

export interface LabelMirrorsResult {
  created: Array<{ url: string; branch: string; path: string; labels: string[] }>;
  failures: Array<{ url: string; reason: string }>;
}

/**
 * Creates the mirrors labels ask for and that do not exist yet. An existing
 * checkout is left as it is: bringing it up to date is mirror sync's job.
 */
export async function ensureLabelMirrors(
  config: RuntimeConfig,
  options: {
    resolveExtraHeader?: (source: string) => Promise<string | undefined>;
    /** Called as each missing mirror is created; a clone can take a while. */
    onCreated?: (item: LabelMirrorsResult["created"][number]) => void;
  } = {},
): Promise<LabelMirrorsResult> {
  const result: LabelMirrorsResult = { created: [], failures: [] };
  for (const { source, labels } of sourcesToMirror(config)) {
    try {
      const ensured = await mirror.ensure({
        root: config.root,
        canonicalPrefix: config.canonicalPrefix,
        source: source.url,
        branch: source.branch,
        pin: source.pin,
        alias: source.path,
        extraHeader: await options.resolveExtraHeader?.(source.url),
      });
      if (ensured.created) {
        const item = { url: source.url, branch: ensured.branch, path: ensured.path, labels };
        result.created.push(item);
        options.onCreated?.(item);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ url: source.url, reason: message.split("\n")[0]! });
    }
  }
  return result;
}

/** Every label in use, with the sources that carry it, sorted by name. Pure. */
export function listLabels(
  config: Pick<RuntimeConfig, "labelDefs" | "sources">,
): Array<{ label: string; mirror: boolean; sources: SourceDeclaration[] }> {
  const { defs } = parseLabelDefs(config.labelDefs);
  const byLabel = new Map<string, SourceDeclaration[]>();
  for (const source of parseDeclaredSources(config.sources).sources) {
    for (const label of Object.keys(source.labels)) {
      byLabel.set(label, [...(byLabel.get(label) ?? []), source]);
    }
  }
  return [...byLabel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, sources]) => ({ label, mirror: labelMirrors(defs, label), sources }));
}

/**
 * Renames a label everywhere dev.yaml names it: on sources, as a label def key,
 * and as a workset member. Mutates the caller's document; persistence belongs to
 * config.writeConfig(). Refuses a target name already in use.
 */
export function renameLabel(
  doc: ReturnType<typeof parseDocument>,
  from: string,
  to: string,
): { sources: number; def: boolean; worksetMembers: number } {
  const renamed = { sources: 0, def: false, worksetMembers: 0 };
  const sources = doc.get("sources");
  if (isSeq(sources)) {
    for (const item of sources.items) {
      const itemLabels = isMap(item) ? item.get("labels") : undefined;
      if (!isMap(itemLabels) || !itemLabels.has(from)) continue;
      if (itemLabels.has(to)) {
        throw new LabelError("LABEL_VALIDATION", `A source already carries label '${to}'.`);
      }
      renameMapKey(itemLabels, from, to);
      renamed.sources += 1;
    }
  }
  const defs = doc.get("label_defs");
  if (isMap(defs) && defs.has(from)) {
    if (defs.has(to)) throw new LabelError("LABEL_VALIDATION", `label_defs already has '${to}'.`);
    renameMapKey(defs, from, to);
    renamed.def = true;
  }
  const worksets = doc.get("worksets");
  if (isMap(worksets)) {
    for (const pair of worksets.items) {
      const members = isMap(pair.value) ? pair.value.get("members") : undefined;
      if (!isSeq(members)) continue;
      for (const member of members.items) {
        if (isMap(member) && member.get("label") === from) {
          member.set("label", to);
          renamed.worksetMembers += 1;
        }
      }
    }
  }
  return renamed;
}

/** Renames a key in place, keeping its position, value, and comments. */
function renameMapKey(map: YAMLMap, from: string, to: string): void {
  const pair = map.items.find((candidate) => String(candidate.key) === from)!;
  pair.key = isScalar(pair.key) ? Object.assign(pair.key, { value: to }) : to;
}

/**
 * Where a label lands for a repository and an optional branch: the declaration
 * that already exists, or a new one. With no branch and several declared refs,
 * the caller must choose. Pure.
 */
export function planLabelTarget(
  sources: SourceDeclaration[],
  url: string,
  branch?: string,
): { selector: SourceSelector; declared: boolean } | { ambiguous: SourceDeclaration[] } {
  const key = normalizeSourceKey(url);
  const declared = sources.filter((source) => normalizeSourceKey(source.url) === key);
  if (branch) {
    const match = declared.find((source) => source.branch === branch || source.pin === branch);
    return match
      ? { selector: selectorOf(match), declared: true }
      : { selector: { url: declared[0]?.url ?? url, branch }, declared: false };
  }
  if (declared.length === 0) return { selector: { url }, declared: false };
  if (declared.length === 1) return { selector: selectorOf(declared[0]!), declared: true };
  return { ambiguous: declared };
}

export function selectorOf(source: SourceDeclaration): SourceSelector {
  return { url: source.url, branch: source.branch, pin: source.pin, path: source.path };
}
