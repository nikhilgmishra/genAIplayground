/**
 * The bounded, non-executable mapping DSL (follow-on prompt section 6; FO-06-05, FO-06-23).
 *
 * A mapping is DATA from the reviewed ConnectorProfile (`mappings` + `mappingTables`), compiled once:
 *   rename      source JSON pointer -> target field (RFC 6901, no wildcards or expressions)
 *   cast        the FieldMapping `type` (closed set, values.ts)
 *   enum map    semantic `enum:<tableId>` over a reviewed table
 *   date/zone   `instant` / `date` types; semantic `zone:<zoneKey>` for wall-clock vendor times
 *   unit        semantic `unit:<from>:<to>` over the closed unit table
 * Requirement classes: REQUIRED (absent or null -> drift), OPTIONAL (absent -> null), PROHIBITED (never
 * read, never emitted; another mapping that would read inside a prohibited pointer is a definition error).
 *
 * The interpreter is total: it walks a fixed rule list once per record, every pointer step spends one
 * unit of a per-call step budget, records per call and output size are capped, and a limit stops the
 * call with a typed error instead of returning a partial result. A drifted record refuses the WHOLE
 * response (ConnectorSchemaDriftError): nothing partial can be written by a caller (fault SCHEMA_DRIFT).
 * The compiled mapping has a digest (pinned in capability evidence and drift errors).
 */
import type { Classification } from "../../protocol/common.js";
import type { ConnectorMappingTables, FieldMapping } from "../../protocol/connector.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical.js";
import { ConnectorSchemaDriftError, MappingDefinitionError, MappingLimitError } from "./errors.js";
import type { DriftIssue } from "./errors.js";
import { parsePointer, pointerWithin, readPointer } from "./pointer.js";
import { applySemantic, castValue, isKnownZone, parseSemantic, semanticAccepts, unitCompatible } from "./values.js";
import type { FieldType, MappedValue, Semantic } from "./values.js";

export const DSL_LIMITS = Object.freeze({
  /** Records mapped per call (a page is bounded by the profile's maxPageSize, at most 1 000). */
  maxRecords: 1_000,
  /** Pointer steps per call across all records and rules. */
  maxSteps: 2_000_000,
  /** Mapped output characters per call. */
  maxOutputChars: 8_000_000,
  maxRules: 256,
});

export interface CompiledRule {
  readonly targetField: string;
  readonly pointer: readonly string[];
  readonly sourcePointer: string;
  readonly requirement: "REQUIRED" | "OPTIONAL";
  readonly type: FieldType;
  readonly semantic: Semantic | null;
  readonly authoritative: boolean;
  readonly classification: Classification;
}

export interface CompiledMapping {
  readonly sourceObject: string;
  readonly rules: readonly CompiledRule[];
  /** Pointers that are never read (PROHIBITED source fields). */
  readonly prohibited: readonly { targetField: string; pointer: readonly string[] }[];
  /** sha256 of the canonical mapping definition (rules, prohibited set and the tables they use). */
  readonly digest: string;
  readonly tables: CompiledTables;
}

export interface CompiledTables {
  readonly enums: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly zones: ReadonlyMap<string, string>;
}

/** Per-field provenance carried with every mapped value (authoritative-field precedence, classification). */
export interface FieldProvenance {
  readonly sourcePointer: string;
  readonly authoritative: boolean;
  readonly classification: Classification;
}

export interface MappedRecord {
  readonly values: Readonly<Record<string, MappedValue>>;
  readonly provenance: Readonly<Record<string, FieldProvenance>>;
}

export function compileTables(tables: ConnectorMappingTables | undefined): CompiledTables {
  const enums = new Map<string, ReadonlyMap<string, string>>();
  const zones = new Map<string, string>();
  for (const t of tables?.enums ?? []) {
    if (enums.has(t.tableId)) throw new MappingDefinitionError("DSL_ENUM_TABLE_DUPLICATE");
    const m = new Map<string, string>();
    for (const e of t.entries) {
      if (m.has(e.from)) throw new MappingDefinitionError("DSL_ENUM_ENTRY_DUPLICATE");
      m.set(e.from, e.to);
    }
    enums.set(t.tableId, m);
  }
  for (const z of tables?.timeZones ?? []) {
    if (zones.has(z.zoneKey)) throw new MappingDefinitionError("DSL_ZONE_DUPLICATE");
    if (!isKnownZone(z.ianaZone)) throw new MappingDefinitionError("DSL_ZONE_UNKNOWN");
    zones.set(z.zoneKey, z.ianaZone);
  }
  return { enums, zones };
}

/** Compiles the profile mappings of one source object. Throws MappingDefinitionError on any defect. */
export function compileMapping(sourceObject: string, mappings: readonly FieldMapping[], tables: ConnectorMappingTables | undefined): CompiledMapping {
  const own = mappings.filter((m) => m.sourceObject === sourceObject);
  if (own.length === 0) throw new MappingDefinitionError("DSL_NO_MAPPING_FOR_OBJECT");
  if (own.length > DSL_LIMITS.maxRules) throw new MappingDefinitionError("DSL_TOO_MANY_RULES");
  const compiledTables = compileTables(tables);
  const targets = new Set<string>();
  const rules: CompiledRule[] = [];
  const prohibited: { targetField: string; pointer: readonly string[] }[] = [];
  for (const m of own) {
    if (targets.has(m.targetField)) throw new MappingDefinitionError("DSL_DUPLICATE_TARGET");
    targets.add(m.targetField);
    const pointer = parsePointer(m.sourcePointer);
    if (pointer.length === 0) throw new MappingDefinitionError("DSL_POINTER_EMPTY_SOURCE");
    if (m.requirement === "PROHIBITED") {
      prohibited.push({ targetField: m.targetField, pointer });
      continue;
    }
    if (m.classification === "VERIFICATION_SECRET") throw new MappingDefinitionError("DSL_VERIFICATION_SECRET_MAPPED");
    const semantic = parseSemantic(m.semantic);
    if (semantic?.kind === "invalid") throw new MappingDefinitionError("DSL_SEMANTIC_INVALID");
    if (semantic && !semanticAccepts(semantic, m.type)) throw new MappingDefinitionError("DSL_SEMANTIC_TYPE_INCOMPATIBLE");
    if (semantic?.kind === "enum" && !compiledTables.enums.has(semantic.tableId)) throw new MappingDefinitionError("DSL_ENUM_TABLE_UNKNOWN");
    if (semantic?.kind === "zone" && !compiledTables.zones.has(semantic.zoneKey)) throw new MappingDefinitionError("DSL_ZONE_UNKNOWN");
    if (semantic?.kind === "unit" && !unitCompatible(semantic.from, semantic.to)) throw new MappingDefinitionError("DSL_UNIT_UNKNOWN");
    rules.push({
      targetField: m.targetField,
      pointer,
      sourcePointer: m.sourcePointer,
      requirement: m.requirement,
      type: m.type,
      semantic,
      authoritative: m.authoritative,
      classification: m.classification,
    });
  }
  // A mapping may never read a prohibited value, nor a container that holds one.
  for (const r of rules) {
    for (const p of prohibited) {
      if (pointerWithin(p.pointer, r.pointer) || pointerWithin(r.pointer, p.pointer)) throw new MappingDefinitionError("DSL_PROHIBITED_FIELD_MAPPED");
    }
  }
  const usedEnums = [...new Set(rules.flatMap((r) => (r.semantic?.kind === "enum" ? [r.semantic.tableId] : [])))].sort();
  const usedZones = [...new Set(rules.flatMap((r) => (r.semantic?.kind === "zone" ? [r.semantic.zoneKey] : [])))].sort();
  const digest = sha256Hex(
    canonicalJson({
      dsl: "vsp.connector-mapping.v1",
      sourceObject,
      rules: rules.map((r) => ({ t: r.targetField, p: r.sourcePointer, q: r.requirement, y: r.type, s: r.semantic, a: r.authoritative, c: r.classification })),
      prohibited: prohibited.map((p) => p.targetField).sort(),
      enums: usedEnums.map((id) => [id, [...(compiledTables.enums.get(id) ?? new Map()).entries()].sort()]),
      zones: usedZones.map((k) => [k, compiledTables.zones.get(k)]),
    }),
  );
  return { sourceObject, rules, prohibited, digest, tables: compiledTables };
}

class Budget {
  steps = 0;
  chars = 0;
  spend = (): void => {
    this.steps += 1;
    if (this.steps > DSL_LIMITS.maxSteps) throw new MappingLimitError("DSL_STEP_LIMIT");
  };
  emit(v: MappedValue): void {
    this.chars += typeof v === "string" ? v.length : 8;
    if (this.chars > DSL_LIMITS.maxOutputChars) throw new MappingLimitError("DSL_SIZE_LIMIT");
  }
}

function mapOne(mapping: CompiledMapping, record: unknown, budget: Budget, issues: DriftIssue[]): MappedRecord | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    issues.push({ kind: "RECORD_NOT_AN_OBJECT", targetField: "$record" });
    return null;
  }
  const values: Record<string, MappedValue> = {};
  const provenance: Record<string, FieldProvenance> = {};
  const before = issues.length;
  for (const r of mapping.rules) {
    const raw = readPointer(record, r.pointer, budget.spend);
    if (raw === undefined || raw === null) {
      if (r.requirement === "REQUIRED") issues.push({ kind: "MISSING_REQUIRED", targetField: r.targetField });
      else values[r.targetField] = null;
      provenance[r.targetField] = { sourcePointer: r.sourcePointer, authoritative: r.authoritative, classification: r.classification };
      continue;
    }
    if (typeof raw === "object") {
      // Containers are never copied: a scalar field that became an object or array is drift.
      issues.push({ kind: "TYPE_MISMATCH", targetField: r.targetField });
      continue;
    }
    const res = r.semantic ? applySemantic(raw, r.semantic, r.type, mapping.tables) : castValue(raw, r.type);
    if (!res.ok) {
      issues.push({ kind: res.kind, targetField: r.targetField });
      continue;
    }
    budget.emit(res.value);
    values[r.targetField] = res.value;
    provenance[r.targetField] = { sourcePointer: r.sourcePointer, authoritative: r.authoritative, classification: r.classification };
  }
  return issues.length === before ? { values, provenance } : null;
}

/**
 * Maps the records of one response. `recordsPointer` locates the records array (empty pointer: the body
 * is one record). Any drift in any record refuses the whole response with ConnectorSchemaDriftError.
 */
export function applyMapping(mapping: CompiledMapping, body: unknown, recordsPointer: string | null): MappedRecord[] {
  const budget = new Budget();
  const tokens = recordsPointer === null ? [] : parsePointer(recordsPointer);
  const container = tokens.length === 0 ? body : readPointer(body, tokens, budget.spend);
  const single = recordsPointer === null || recordsPointer === "";
  let records: unknown[];
  if (single) {
    records = [container];
  } else if (Array.isArray(container)) {
    records = container;
  } else {
    throw new ConnectorSchemaDriftError([{ kind: "RECORDS_NOT_AN_ARRAY", targetField: "$records" }], mapping.digest);
  }
  if (records.length > DSL_LIMITS.maxRecords) throw new MappingLimitError("DSL_SIZE_LIMIT");
  const issues: DriftIssue[] = [];
  const out: MappedRecord[] = [];
  for (const rec of records) {
    const m = mapOne(mapping, rec, budget, issues);
    if (m) out.push(m);
  }
  if (issues.length > 0) {
    const seen = new Set<string>();
    const unique = issues.filter((i) => {
      const k = `${i.kind}|${i.targetField}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    throw new ConnectorSchemaDriftError(unique, mapping.digest);
  }
  return out;
}

/** Target fields the profile marks authoritative (source-of-truth precedence for context assembly, FO-06-15). */
export function authoritativeFields(mapping: CompiledMapping): string[] {
  return mapping.rules.filter((r) => r.authoritative).map((r) => r.targetField);
}
