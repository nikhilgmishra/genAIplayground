/**
 * Mapping validation against FETCHED source metadata (FO-06-05): presence is not enough, types and
 * semantics are compared too. Two documented metadata formats are understood:
 *   JSON_SCHEMA     a JSON Schema (draft 2020-12 subset) of the source object: `type`, `format`
 *                   (date-time / date), `enum`, `required`, nested `properties`; vendor annotations
 *                   `x-unit` (closed unit table) and `x-vsp-classification` / `x-vsp-prohibited`
 *                   (the tenant's field classification);
 *   FIELD_DESCRIBE  a flat field list in the style of the Salesforce sObject describe resource
 *                   (`fields[]` with `name`, `type`, `nillable`, `picklistValues[].value/active`).
 * Anything else is refused. Metadata is untrusted vendor data: it is parsed with bounds and never
 * evaluated; values never appear in an issue (target field names only).
 */
import { z } from "zod";
import { Classification } from "../../protocol/common.js";
import type { DriftIssue, DriftKind } from "./errors.js";
import { MappingDefinitionError } from "./errors.js";
import type { CompiledMapping, CompiledRule } from "./mapping.js";

export type MetadataFormat = "JSON_SCHEMA" | "FIELD_DESCRIBE";

export interface FieldMeta {
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  format: "date-time" | "date" | null;
  enumValues: readonly string[] | null;
  unit: string | null;
  classification: Classification | null;
  prohibited: boolean;
}

/** Normalized metadata of one source object: JSON pointer of each described field -> its description. */
export interface ObjectMetadata {
  readonly sourceObject: string;
  readonly fields: ReadonlyMap<string, FieldMeta>;
}

const MAX_FIELDS = 2_000;
const MAX_DEPTH = 8;

const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

const JsonSchemaNode: z.ZodType<JsonSchemaNodeT> = z.lazy(() =>
  z
    .object({
      title: z.string().max(200).optional(),
      type: z.union([z.string().max(20), z.array(z.string().max(20)).max(4)]).optional(),
      format: z.string().max(40).optional(),
      enum: z.array(z.union([z.string().max(256), z.number(), z.boolean(), z.null()])).max(1_000).optional(),
      properties: z.record(z.string().max(128), JsonSchemaNode).optional(),
      required: z.array(z.string().max(128)).max(MAX_FIELDS).optional(),
      "x-unit": z.string().max(40).optional(),
      "x-vsp-classification": z.string().max(40).optional(),
      "x-vsp-prohibited": z.boolean().optional(),
      $defs: z.record(z.string().max(128), JsonSchemaNode).optional(),
    })
    .loose(),
);
interface JsonSchemaNodeT {
  title?: string;
  type?: string | string[];
  format?: string;
  enum?: (string | number | boolean | null)[];
  properties?: Record<string, JsonSchemaNodeT>;
  required?: string[];
  "x-unit"?: string;
  "x-vsp-classification"?: string;
  "x-vsp-prohibited"?: boolean;
  $defs?: Record<string, JsonSchemaNodeT>;
}

const Describe = z
  .object({
    name: z.string().max(128),
    fields: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
            type: z.string().max(40),
            nillable: z.boolean().optional(),
            picklistValues: z.array(z.object({ value: z.string().max(256), active: z.boolean().optional() }).loose()).max(1_000).optional(),
          })
          .loose(),
      )
      .max(MAX_FIELDS),
  })
  .loose();

function schemaType(t: string | string[] | undefined): FieldMeta["type"] | null {
  const list = (Array.isArray(t) ? t : t === undefined ? [] : [t]).filter((x) => x !== "null");
  if (list.length !== 1) return null;
  const x = list[0];
  return x === "string" || x === "integer" || x === "number" || x === "boolean" || x === "object" || x === "array" ? x : null;
}

function walkJsonSchema(node: JsonSchemaNodeT, prefix: string, depth: number, out: Map<string, FieldMeta>): void {
  if (depth > MAX_DEPTH) throw new MappingDefinitionError("METADATA_TOO_DEEP");
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    if (out.size >= MAX_FIELDS) throw new MappingDefinitionError("METADATA_TOO_LARGE");
    const pointer = `${prefix}/${escapeToken(name)}`;
    const type = schemaType(child.type);
    if (type === null) continue; // undescribed or ambiguous: treated as absent
    const cls = Classification.safeParse(child["x-vsp-classification"]);
    out.set(pointer, {
      type,
      format: child.format === "date-time" || child.format === "date" ? child.format : null,
      enumValues: child.enum ? child.enum.filter((v) => v !== null).map(String) : null,
      unit: child["x-unit"] ?? null,
      classification: cls.success ? cls.data : null,
      prohibited: child["x-vsp-prohibited"] === true,
    });
    if (type === "object") walkJsonSchema(child, pointer, depth + 1, out);
  }
}

const DESCRIBE_TYPES: Record<string, Pick<FieldMeta, "type" | "format" | "unit">> = {
  string: { type: "string", format: null, unit: null },
  textarea: { type: "string", format: null, unit: null },
  email: { type: "string", format: null, unit: null },
  phone: { type: "string", format: null, unit: null },
  url: { type: "string", format: null, unit: null },
  picklist: { type: "string", format: null, unit: null },
  id: { type: "string", format: null, unit: null },
  reference: { type: "string", format: null, unit: null },
  boolean: { type: "boolean", format: null, unit: null },
  int: { type: "integer", format: null, unit: null },
  double: { type: "number", format: null, unit: null },
  percent: { type: "number", format: null, unit: null },
  currency: { type: "number", format: null, unit: "major_units" },
  date: { type: "string", format: "date", unit: null },
  datetime: { type: "string", format: "date-time", unit: null },
};

/** Parses a fetched metadata document of the declared format into per-field descriptions. */
export function parseMetadata(format: MetadataFormat, sourceObject: string, doc: unknown): ObjectMetadata {
  const fields = new Map<string, FieldMeta>();
  if (format === "JSON_SCHEMA") {
    const parsed = JsonSchemaNode.safeParse(doc);
    if (!parsed.success) throw new MappingDefinitionError("METADATA_INVALID");
    const root = parsed.data.$defs && Object.hasOwn(parsed.data.$defs, sourceObject) ? parsed.data.$defs[sourceObject] : parsed.data.title === sourceObject ? parsed.data : undefined;
    if (!root) throw new MappingDefinitionError("METADATA_OBJECT_NOT_DESCRIBED");
    walkJsonSchema(root, "", 0, fields);
  } else {
    const parsed = Describe.safeParse(doc);
    if (!parsed.success) throw new MappingDefinitionError("METADATA_INVALID");
    if (parsed.data.name !== sourceObject) throw new MappingDefinitionError("METADATA_OBJECT_NOT_DESCRIBED");
    for (const f of parsed.data.fields) {
      const t = DESCRIBE_TYPES[f.type];
      if (!t) continue;
      const picklist = f.type === "picklist" ? (f.picklistValues ?? []).filter((v) => v.active !== false).map((v) => v.value) : null;
      fields.set(`/${escapeToken(f.name)}`, { ...t, enumValues: picklist, classification: null, prohibited: false });
    }
  }
  return { sourceObject, fields };
}

const CLASS_RANK: Record<Classification, number> = { PUBLIC: 0, INTERNAL: 1, FINANCIAL: 2, PHI: 3, PHI_RESTRICTED: 4, VERIFICATION_SECRET: 5 };

function typeIssue(rule: CompiledRule, meta: FieldMeta): DriftKind | null {
  const sem = rule.semantic;
  const isTime = meta.format === "date-time";
  const isDate = meta.format === "date";
  switch (rule.type) {
    case "string":
    case "currency_code":
      return meta.type === "string" && meta.format === null ? null : isDate || isTime ? "ZONE_MISMATCH" : "TYPE_MISMATCH";
    case "integer":
    case "money_minor_units":
      if (sem?.kind === "unit") return meta.type === "integer" || meta.type === "number" || meta.type === "string" ? null : "TYPE_MISMATCH";
      return meta.type === "integer" ? null : "TYPE_MISMATCH";
    case "number":
      return meta.type === "number" || meta.type === "integer" ? null : "TYPE_MISMATCH";
    case "boolean":
      return meta.type === "boolean" ? null : "TYPE_MISMATCH";
    case "instant":
      if (meta.type !== "string") return "TYPE_MISMATCH";
      if (isDate) return "ZONE_MISMATCH";
      if (sem?.kind === "zone") return null; // wall-clock vendor time, zone supplied by the mapping table
      return isTime ? null : "ZONE_MISMATCH";
    case "date":
      if (meta.type !== "string") return "TYPE_MISMATCH";
      return isDate ? null : isTime ? "ZONE_MISMATCH" : "TYPE_MISMATCH";
    case "enum_code":
      return meta.type === "string" || meta.type === "integer" || meta.type === "boolean" ? null : "TYPE_MISMATCH";
    case "opaque_id":
      return meta.type === "string" || meta.type === "integer" ? null : "TYPE_MISMATCH";
  }
}

function semanticIssue(rule: CompiledRule, meta: FieldMeta, mapping: CompiledMapping): DriftKind | null {
  const sem = rule.semantic;
  if (sem?.kind === "enum") {
    const table = mapping.tables.enums.get(sem.tableId);
    if (!table || meta.enumValues === null) return "UNKNOWN_ENUM_VALUE"; // a closed set cannot be verified against a free field
    return meta.enumValues.every((v) => table.has(v)) ? null : "UNKNOWN_ENUM_VALUE";
  }
  if (rule.type === "enum_code" && meta.enumValues !== null && !meta.enumValues.every((v) => /^[A-Za-z0-9_.-]{1,64}$/.test(v))) return "UNKNOWN_ENUM_VALUE";
  if (sem?.kind === "unit") return meta.unit === sem.from ? null : "UNIT_MISMATCH";
  if (rule.type === "money_minor_units" && meta.unit !== null && meta.unit !== "minor_units") return "UNIT_MISMATCH";
  if (meta.unit !== null && (rule.type === "integer" || rule.type === "number") && sem === null) return "UNIT_MISMATCH";
  return null;
}

/**
 * Compares a compiled mapping with fetched metadata. Returns every issue (empty: the mapping is
 * consistent with what the vendor describes). Run at connector startup and by the test wizard.
 */
export function validateMappingAgainstMetadata(mapping: CompiledMapping, metadata: ObjectMetadata): DriftIssue[] {
  if (metadata.sourceObject !== mapping.sourceObject) throw new MappingDefinitionError("METADATA_OBJECT_MISMATCH");
  const issues: DriftIssue[] = [];
  for (const rule of mapping.rules) {
    const meta = metadata.fields.get(rule.sourcePointer);
    if (!meta) {
      if (rule.requirement === "REQUIRED") issues.push({ kind: "MISSING_REQUIRED", targetField: rule.targetField });
      continue;
    }
    if (meta.prohibited || meta.classification === "VERIFICATION_SECRET") {
      issues.push({ kind: "PROHIBITED_FIELD_MAPPED", targetField: rule.targetField });
      continue;
    }
    if (meta.classification !== null && CLASS_RANK[meta.classification] > CLASS_RANK[rule.classification]) {
      issues.push({ kind: "CLASSIFICATION_MISMATCH", targetField: rule.targetField });
    }
    const t = typeIssue(rule, meta);
    if (t) {
      issues.push({ kind: t, targetField: rule.targetField });
      continue;
    }
    const s = semanticIssue(rule, meta, mapping);
    if (s) issues.push({ kind: s, targetField: rule.targetField });
  }
  return issues;
}
