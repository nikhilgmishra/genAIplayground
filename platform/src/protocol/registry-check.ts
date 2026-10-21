/**
 * Contract-registry checks (FO-04-02, FO-04-03, FO-04-42, FO-04-48), run by registry.test.ts over
 * every follow-on contract and usable by tooling. Each check works on the generated JSON Schema
 * (draft 2020-12, "input" view), so it checks exactly what is published in schemas/protocol.
 *
 * - strictness: every object node that declares properties has additionalProperties:false;
 * - boundedness: every string has a length bound, pattern, enum, const or format; every array a
 *   maxItems; every number a minimum and maximum; every map (record) a maxProperties;
 * - versioning: every branch carries the contract version field pinned to the registered version;
 * - common fields (FO-04-42): the descriptor maps exactly the fields the contract's traits make
 *   relevant (common-fields.ts, independent of the descriptor); every mapped property exists, is
 *   required unless marked optional until adoption, and has the field's shape; a property named
 *   like a common field is always relevant.
 */
import { z } from "zod";
import { COMMON_FIELD_ALIASES, COMMON_FIELD_SPEC_PHRASES, relevantCommonFields, type CommonField } from "./common-fields.js";
import type { ContractDescriptor } from "./followon.js";

/** Prompt phrase of each common field, for messages. */
const COMMON_FIELD_SPEC_NAME = Object.fromEntries(
  Object.entries(COMMON_FIELD_SPEC_PHRASES).flatMap(([phrase, fields]) => fields.map((f) => [f, phrase])),
) as Record<CommonField, string>;

export type JsonNode = Record<string, unknown>;

export const toJsonSchema = (schema: z.ZodType): JsonNode => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonNode;

/** Visits every schema node with its JSON path. */
export function walkSchema(node: unknown, visit: (n: JsonNode, path: string) => void, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkSchema(n, visit, `${path}[${i}]`));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const n = node as JsonNode;
  visit(n, path);
  for (const [k, v] of Object.entries(n)) {
    if (k === "const" || k === "enum" || k === "default" || k === "examples") continue;
    walkSchema(v, visit, `${path}.${k}`);
  }
}

const typesOf = (n: JsonNode): string[] => (Array.isArray(n.type) ? (n.type as string[]) : typeof n.type === "string" ? [n.type] : []);

export function strictnessViolations(json: JsonNode): string[] {
  const out: string[] = [];
  walkSchema(json, (n, path) => {
    if (n.properties !== undefined && n.additionalProperties !== false) out.push(`${path}: object without additionalProperties:false`);
  });
  return out;
}

export function boundednessViolations(json: JsonNode): string[] {
  const out: string[] = [];
  walkSchema(json, (n, path) => {
    const types = typesOf(n);
    const bounded = n.enum !== undefined || n.const !== undefined;
    if (types.includes("string") && !bounded && n.maxLength === undefined && n.pattern === undefined && n.format === undefined) out.push(`${path}: unbounded string`);
    if (types.includes("array") && n.maxItems === undefined) out.push(`${path}: array without maxItems`);
    if ((types.includes("number") || types.includes("integer")) && !bounded && (n.minimum === undefined && n.exclusiveMinimum === undefined || n.maximum === undefined && n.exclusiveMaximum === undefined)) {
      out.push(`${path}: unbounded number`);
    }
    if (types.includes("object") && n.properties === undefined && n.maxProperties === undefined) out.push(`${path}: map without maxProperties`);
  });
  return out;
}

/** Top-level branches of a contract schema (oneOf / anyOf for unions, else the schema itself). */
export const branchesOf = (json: JsonNode): JsonNode[] => (json.oneOf as JsonNode[] | undefined) ?? (json.anyOf as JsonNode[] | undefined) ?? [json];

export function versionViolations(d: ContractDescriptor, json: JsonNode): string[] {
  const out: string[] = [];
  branchesOf(json).forEach((b, i) => {
    const props = (b.properties ?? {}) as Record<string, JsonNode>;
    const field = props[d.versionField];
    if (!field) out.push(`branch ${i}: no ${d.versionField}`);
    else if (field.const !== d.version) out.push(`branch ${i}: ${d.versionField} is not pinned to ${d.version}`);
    const required = new Set((b.required ?? []) as string[]);
    if (!required.has(d.versionField) && !d.optionalUntilAdoption.includes(d.versionField)) out.push(`branch ${i}: ${d.versionField} not required`);
  });
  if (!/^[a-z][a-z0-9-]{1,48}\.v[1-9][0-9]{0,3}$/.test(d.version)) out.push(`version ${d.version} is not <name>.v<n>`);
  return out;
}

/** A schema node with a `null` alternative removed (zod renders `.nullable()` as anyOf [X, null]). */
export function unwrapNullable(n: JsonNode): JsonNode {
  const alts = (n.anyOf ?? n.oneOf) as JsonNode[] | undefined;
  if (!alts) return n;
  const nonNull = alts.filter((a) => !(a.type === "null" || (Array.isArray(a.type) && a.type.length === 1 && a.type[0] === "null")));
  return nonNull.length === 1 && nonNull.length < alts.length ? (nonNull[0] as JsonNode) : n;
}

/**
 * Resolves a dotted property path (`scope.policyVersion`) in one branch: the node, and whether
 * every step is a required property. Null when a step is missing.
 */
export function resolvePropertyPath(branch: JsonNode, path: string): { node: JsonNode; required: boolean } | null {
  let current: JsonNode = branch;
  let required = true;
  for (const step of path.split(".")) {
    const obj = unwrapNullable(current);
    const props = (obj.properties ?? {}) as Record<string, JsonNode>;
    const next = props[step];
    if (!next) return null;
    if (!new Set((obj.required ?? []) as string[]).has(step)) required = false;
    current = next;
  }
  return { node: current, required };
}

const ID_FIELDS: readonly CommonField[] = ["tenantId", "interactionId", "caseId", "workflowId", "actorRef", "subjectRef", "turnId", "requestId", "causationId"];

const isBoundedString = (n: JsonNode): boolean => typesOf(n).includes("string") && (n.pattern !== undefined || n.maxLength !== undefined || n.enum !== undefined || n.const !== undefined || n.format !== undefined);
const isCoded = (n: JsonNode): boolean => n.enum !== undefined || n.const !== undefined || (typesOf(n).includes("string") && n.pattern !== undefined);
const isObject = (n: JsonNode): boolean => n.properties !== undefined;
const alternatives = (n: JsonNode): JsonNode[] => ((n.oneOf ?? n.anyOf) as JsonNode[] | undefined)?.map(unwrapNullable) ?? [n];

/**
 * Shape a common field's property must have in the generated JSON Schema: identifiers are bounded
 * strings, instants are date-time strings, the classification and outcome are coded (enum/const),
 * provenance is coded or structured (never free text), versions are labels, numbers or structures.
 */
export function commonFieldShapeProblem(field: CommonField, raw: JsonNode): string | null {
  const n = unwrapNullable(raw);
  const alts = alternatives(n);
  switch (field) {
    case "schemaVersion":
      return n.const !== undefined ? null : "is not a pinned const";
    case "sessionGeneration":
      return typesOf(n).includes("integer") && n.minimum !== undefined ? null : "is not a bounded integer";
    case "occurredAt":
    case "expiresAt":
      return typesOf(n).includes("string") && n.format === "date-time" ? null : "is not a UTC date-time";
    case "dataClassification":
      return n.enum !== undefined ? null : "is not an enumerated classification";
    case "outcome":
      return alts.every((a) => a.enum !== undefined || a.const !== undefined) ? null : "is not an enumerated outcome";
    case "provenance": {
      const ok = (a: JsonNode): boolean => isCoded(a) || isObject(a) || (typesOf(a).includes("array") && alternatives(unwrapNullable((a.items ?? {}) as JsonNode)).every((i) => isCoded(i) || isObject(i)));
      return alts.every(ok) ? null : "is free text, not a coded or structured provenance";
    }
    case "versions": {
      const ok = (a: JsonNode): boolean =>
        isBoundedString(a) || typesOf(a).includes("integer") || isObject(a) || (typesOf(a).includes("array") && isObject(unwrapNullable((a.items ?? {}) as JsonNode)));
      return alts.every(ok) ? null : "is not a version label, number or structure";
    }
    default:
      return ID_FIELDS.includes(field) && alts.every(isBoundedString) ? null : "is not a bounded identifier string";
  }
}

/**
 * Common-field check (FO-04-42) of one descriptor against its generated JSON Schema:
 * - relevance: the descriptor maps exactly the fields the contract's traits (common-fields.ts)
 *   make relevant, no fewer and no more;
 * - presence: every mapped property path exists in every branch and is required at every step,
 *   unless the descriptor marks it optional until adoption (with an adoption owner);
 * - shape: each mapped property has the field's shape (commonFieldShapeProblem);
 * - aliases: a top-level property named like a common field (COMMON_FIELD_ALIASES) is relevant
 *   under the traits, so a carried field can never be left out of the model.
 */
export function envelopeViolations(d: ContractDescriptor, json: JsonNode): string[] {
  const out: string[] = [];
  const relevant = new Set(relevantCommonFields(d.name));
  const mapped = new Set(Object.keys(d.commonFields) as CommonField[]);
  for (const f of relevant) if (!mapped.has(f)) out.push(`relevant common field ${f} (${COMMON_FIELD_SPEC_NAME[f]}) is not mapped`);
  for (const f of mapped) if (!relevant.has(f)) out.push(`common field ${f} is mapped but no trait of ${d.name} makes it relevant`);
  branchesOf(json).forEach((b, i) => {
    for (const [field, prop] of Object.entries(d.commonFields) as [CommonField, string | undefined][]) {
      if (prop === undefined) continue;
      const hit = resolvePropertyPath(b, prop);
      if (!hit) {
        out.push(`branch ${i}: common field ${field} (${prop}) missing`);
        continue;
      }
      if (!hit.required && !d.optionalUntilAdoption.includes(prop)) out.push(`branch ${i}: common field ${field} (${prop}) not required`);
      const shape = commonFieldShapeProblem(field, hit.node);
      if (shape) out.push(`branch ${i}: common field ${field} (${prop}) ${shape}`);
    }
    for (const key of Object.keys((b.properties ?? {}) as Record<string, unknown>)) {
      const field = COMMON_FIELD_ALIASES[key];
      if (field !== undefined && !relevant.has(field)) out.push(`branch ${i}: property ${key} carries common field ${field}, which no trait of ${d.name} makes relevant`);
    }
  });
  for (const p of d.optionalUntilAdoption) {
    if (!Object.values(d.commonFields).includes(p)) out.push(`optionalUntilAdoption lists ${p}, which is not a common field`);
  }
  if (d.optionalUntilAdoption.length > 0 && d.adoptionOwner === null) out.push("optional common fields without an adoption owner");
  return out;
}

/** Every violation of one descriptor; `knownUnbounded` lists pinned legacy paths (exact strings). */
export function contractViolations(d: ContractDescriptor, knownUnbounded: readonly string[] = []): string[] {
  const json = toJsonSchema(d.schema);
  const pinned = new Set(knownUnbounded);
  return [
    ...strictnessViolations(json),
    ...versionViolations(d, json),
    ...envelopeViolations(d, json),
    ...boundednessViolations(json).filter((v) => !pinned.has(v)),
  ];
}
