/**
 * Reviewed operation templates (FO-06-23, FO-06-20): how a request is built from typed inputs.
 *
 * The method, path template, parameter set, query parameters and body fields are fixed by the reviewed
 * profile; a caller supplies VALUES only, and each value is validated against its declared type before
 * any URL exists. No declared type admits `/`, `?`, `#`, `%`, whitespace or a `..` segment, the path is
 * appended to the profile's base path and the result must stay on the base URL's origin, so neither a
 * caller nor a vendor response can construct another host, path prefix or query string. A model can
 * never invent an operation: only `operationId`s present in the profile exist.
 */
import type { ConnectorOperation, OperationParam, OperationRequestField } from "../../protocol/connector.js";
import { MappingDefinitionError } from "./errors.js";
import { parsePointer, writePointer } from "./pointer.js";
import { castValue } from "./values.js";

export type ParamValue = string | number;

export interface RenderedRequest {
  method: ConnectorOperation["method"];
  /** Absolute URL on the base origin. */
  url: URL;
  headers: Record<string, string>;
  /** JSON body for writes with a request template; never present on GET. */
  body: Record<string, unknown> | null;
}

/** Thrown when a supplied value does not satisfy the reviewed template (refused before any I/O). */
export class TemplateInputError extends MappingDefinitionError {}

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9_]{0,40})\}/g;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Checks the template against its parameter set at profile admission (every placeholder declared, and vice versa). */
export function checkOperationTemplate(op: ConnectorOperation): void {
  const params = op.params ?? [];
  const names = new Set<string>();
  for (const p of params) {
    if (names.has(p.name)) throw new MappingDefinitionError("TEMPLATE_PARAM_DUPLICATE");
    names.add(p.name);
    if (p.in === "query" && p.wireName === null) throw new MappingDefinitionError("TEMPLATE_QUERY_PARAM_WITHOUT_WIRE_NAME");
    if (p.in === "path" && p.wireName !== null) throw new MappingDefinitionError("TEMPLATE_PATH_PARAM_WITH_WIRE_NAME");
    if (p.in === "path" && !p.required) throw new MappingDefinitionError("TEMPLATE_PATH_PARAM_OPTIONAL");
    if (p.type === "enum_code" && p.enumValues === null) throw new MappingDefinitionError("TEMPLATE_ENUM_WITHOUT_VALUES");
    if (p.type === "integer" && p.integerRange === null) throw new MappingDefinitionError("TEMPLATE_INTEGER_WITHOUT_RANGE");
  }
  const placeholders = [...op.pathTemplate.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
  if (op.pathTemplate.replace(PLACEHOLDER, "").match(/[{}]/)) throw new MappingDefinitionError("TEMPLATE_PLACEHOLDER_INVALID");
  if (/(^|\/)\.\.?(\/|$)/.test(op.pathTemplate) || op.pathTemplate.includes("//")) throw new MappingDefinitionError("TEMPLATE_PATH_INVALID");
  if (new Set(placeholders).size !== placeholders.length) throw new MappingDefinitionError("TEMPLATE_PLACEHOLDER_DUPLICATE");
  const pathParams = params.filter((p) => p.in === "path").map((p) => p.name);
  for (const ph of placeholders) if (!pathParams.includes(ph)) throw new MappingDefinitionError("TEMPLATE_PLACEHOLDER_UNDECLARED");
  for (const pp of pathParams) if (!placeholders.includes(pp)) throw new MappingDefinitionError("TEMPLATE_PATH_PARAM_UNUSED");
  if (op.method === "GET" && op.requestBody) throw new MappingDefinitionError("TEMPLATE_BODY_ON_GET");
  const targets = new Set<string>();
  for (const f of op.requestBody?.fields ?? []) {
    parsePointer(f.targetPointer);
    if (f.classification === "VERIFICATION_SECRET") throw new MappingDefinitionError("TEMPLATE_VERIFICATION_SECRET_FIELD");
    if (targets.has(f.inputField)) throw new MappingDefinitionError("TEMPLATE_BODY_FIELD_DUPLICATE");
    targets.add(f.inputField);
  }
  if (op.externalIdParam !== undefined && op.externalIdParam !== null && !pathParams.includes(op.externalIdParam)) {
    throw new MappingDefinitionError("TEMPLATE_EXTERNAL_ID_PARAM_UNDECLARED");
  }
}

/** Validates one parameter value against its declared type; returns the wire string. */
export function paramWireValue(p: OperationParam, value: unknown): string {
  const refuse = (): never => {
    throw new TemplateInputError("TEMPLATE_PARAM_INVALID");
  };
  switch (p.type) {
    case "opaque_id":
      if (typeof value !== "string" || value.length > p.maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) refuse();
      return value as string;
    case "token":
      if (typeof value !== "string" || value.length > p.maxLength || !/^[A-Za-z0-9_:-][A-Za-z0-9_.:-]*$/.test(value) || value.includes("..")) refuse();
      return value as string;
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || p.integerRange === null) return refuse();
      if (value < p.integerRange.min || value > p.integerRange.max) refuse();
      return String(value);
    }
    case "enum_code":
      if (typeof value !== "string" || !(p.enumValues ?? []).includes(value)) refuse();
      return value as string;
    case "date": {
      const r = castValue(value, "date");
      if (!r.ok) refuse();
      return value as string;
    }
    case "instant": {
      const r = castValue(value, "instant");
      if (!r.ok || typeof r.value !== "string") return refuse();
      return r.value;
    }
  }
}

function bodyValue(f: OperationRequestField, value: unknown): unknown {
  const r = castValue(value, f.type);
  if (!r.ok) throw new TemplateInputError("TEMPLATE_BODY_VALUE_INVALID");
  if (typeof r.value === "string" && r.value.length > f.maxLength) throw new TemplateInputError("TEMPLATE_BODY_VALUE_INVALID");
  return r.value;
}

export interface RenderInput {
  params?: Readonly<Record<string, ParamValue>>;
  body?: Readonly<Record<string, unknown>>;
  /** Server-derived idempotency key (IDEMPOTENCY_KEY_HEADER / EXTERNAL_ID_UPSERT); never caller text. */
  idempotencyKey?: string;
  /** Extra query parameters set by the runtime itself (pagination); names must be declared by the profile. */
  runtimeQuery?: readonly [string, string][];
}

/**
 * Renders a request for a reviewed operation. `baseUrl` is the profile's documented base URL; the
 * result is refused unless it is on the same origin under the base path.
 */
export function renderRequest(baseUrl: string, op: ConnectorOperation, input: RenderInput): RenderedRequest {
  const base = new URL(baseUrl);
  const params = op.params ?? [];
  const supplied = input.params ?? {};
  for (const k of Object.keys(supplied)) if (!params.some((p) => p.name === k)) throw new TemplateInputError("TEMPLATE_PARAM_UNDECLARED");
  const values = new Map<string, string>();
  for (const p of params) {
    const v = Object.hasOwn(supplied, p.name) ? supplied[p.name] : undefined;
    if (v === undefined) {
      if (p.required) throw new TemplateInputError("TEMPLATE_PARAM_MISSING");
      continue;
    }
    values.set(p.name, paramWireValue(p, v));
  }
  const path = op.pathTemplate.replace(PLACEHOLDER, (_m, name: string) => encodeURIComponent(values.get(name) ?? ""));
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${base.origin}${basePath}${path}`);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`) || /(^|\/)\.\.?(\/|$)/.test(url.pathname) || url.pathname.includes("//")) {
    throw new TemplateInputError("TEMPLATE_PATH_ESCAPE");
  }
  for (const p of params) {
    const v = values.get(p.name);
    if (p.in === "query" && v !== undefined && p.wireName) url.searchParams.append(p.wireName, v);
  }
  for (const [k, v] of input.runtimeQuery ?? []) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(k) || v.length > 2_048) throw new TemplateInputError("TEMPLATE_RUNTIME_QUERY_INVALID");
    url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (op.idempotency === "IDEMPOTENCY_KEY_HEADER") {
    if (!op.idempotencyKeyHeader) throw new MappingDefinitionError("TEMPLATE_IDEMPOTENCY_HEADER_UNDECLARED");
    if (input.idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new TemplateInputError("TEMPLATE_IDEMPOTENCY_KEY_REQUIRED");
    headers[op.idempotencyKeyHeader.toLowerCase()] = input.idempotencyKey;
  }
  let body: Record<string, unknown> | null = null;
  if (op.requestBody) {
    const supplied = input.body ?? {};
    const declared = new Set(op.requestBody.fields.map((f) => f.inputField));
    for (const k of Object.keys(supplied)) if (!declared.has(k)) throw new TemplateInputError("TEMPLATE_BODY_FIELD_UNDECLARED");
    body = {};
    for (const f of op.requestBody.fields) {
      const v = Object.hasOwn(supplied, f.inputField) ? supplied[f.inputField] : undefined;
      if (v === undefined || v === null) {
        if (f.requirement === "REQUIRED") throw new TemplateInputError("TEMPLATE_BODY_FIELD_MISSING");
        continue;
      }
      writePointer(body, parsePointer(f.targetPointer), bodyValue(f, v));
    }
    headers["content-type"] = "application/json";
  } else if (input.body !== undefined) {
    throw new TemplateInputError("TEMPLATE_BODY_NOT_DECLARED");
  }
  return { method: op.method, url, headers, body };
}
