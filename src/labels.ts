import type { RuntimeConfig } from "./config.ts";
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
}

export interface SourceDeclaration {
  url: string;
  branch?: string;
  pin?: string;
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

import { parseDocument, isMap, isSeq } from "yaml";

function findSourceNode(doc: ReturnType<typeof parseDocument>, url: string) {
  const seq = doc.get("sources");
  if (!isSeq(seq)) return undefined;
  for (const item of seq.items) {
    if (isMap(item) && item.get("url") === url) return item;
  }
  return undefined;
}

/** Inserts or updates a `sources:` entry for the URL. Mutates the caller's
 * parsed document in place (comments preserved); persistence belongs to
 * config.writeConfig(). Only url/branch are touched. */
export function upsertSourceDeclaration(
  doc: ReturnType<typeof parseDocument>,
  upsert: { url: string; branch?: string },
): { changed: boolean } {
  const existing = findSourceNode(doc, upsert.url);
  if (existing) {
    const before = String(existing);
    if (upsert.branch !== undefined) existing.set("branch", upsert.branch);
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
  const node = doc.createNode(
    upsert.branch !== undefined ? { url: upsert.url, branch: upsert.branch } : { url: upsert.url },
  );
  seq.add(node);
  return { changed: true };
}

/** Sets (meta given) or removes (meta undefined) one label on a declared
 * source. Mutates the caller's parsed document in place; persistence belongs
 * to config.writeConfig(). Returns found: false when the source is not
 * declared. */
export function setSourceLabel(
  doc: ReturnType<typeof parseDocument>,
  url: string,
  label: string,
  meta: Record<string, unknown> | undefined,
): { changed: boolean; found: boolean } {
  const source = findSourceNode(doc, url);
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
