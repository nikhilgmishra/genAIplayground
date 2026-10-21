/**
 * Bounded mapping DSL and reviewed operation templates (WP-06; FO-06-05, FO-06-23, FO-06-20, FO-06-22).
 * In-process production code over SYNTHETIC records and metadata documents.
 */
import { describe, expect, it } from "vitest";
import type { ConnectorOperation, FieldMapping } from "../../protocol/connector.js";
import { ConnectorSchemaDriftError, MappingDefinitionError, MappingLimitError } from "./errors.js";
import { applyMapping, authoritativeFields, compileMapping } from "./mapping.js";
import { parseMetadata, validateMappingAgainstMetadata } from "./metadata.js";
import { parsePointer, readPointer, writePointer } from "./pointer.js";
import { TemplateInputError, checkOperationTemplate, renderRequest } from "./template.js";
import { castValue, convertUnit, normalizeInstant, zonedLocalToUtc } from "./values.js";

const M = (o: Partial<FieldMapping> & Pick<FieldMapping, "sourcePointer" | "targetField">): FieldMapping => ({
  sourceObject: "Invoice",
  requirement: "REQUIRED",
  type: "string",
  semantic: null,
  authoritative: false,
  classification: "INTERNAL",
  ...o,
});

const TABLES = {
  enums: [{ tableId: "invoice_status", entries: [{ from: "open", to: "OPEN" }, { from: "paid", to: "PAID" }] }],
  timeZones: [{ zoneKey: "business", ianaZone: "America/New_York" }],
};

const MAPPINGS: FieldMapping[] = [
  M({ sourcePointer: "/id", targetField: "invoiceId", type: "opaque_id", authoritative: true }),
  M({ sourcePointer: "/status", targetField: "status", type: "enum_code", semantic: "enum:invoice_status", authoritative: true, classification: "FINANCIAL" }),
  M({ sourcePointer: "/amount", targetField: "amountMinor", type: "money_minor_units", semantic: "unit:major_units:minor_units", classification: "FINANCIAL" }),
  M({ sourcePointer: "/dueLocal", targetField: "dueAt", type: "instant", semantic: "zone:business", requirement: "OPTIONAL" }),
  M({ sourcePointer: "/period/days", targetField: "periodSeconds", type: "integer", semantic: "unit:days:seconds", requirement: "OPTIONAL" }),
  M({ sourcePointer: "/notes", targetField: "notes", requirement: "PROHIBITED", classification: "PHI_RESTRICTED" }),
];

const rec = (o: Record<string, unknown> = {}) => ({ id: "inv-001", status: "open", amount: "12.34", dueLocal: "2026-03-08T02:30:00", period: { days: 30 }, notes: "SYNTHETIC restricted", ...o });

describe("JSON pointers [FO-06-23]", () => {
  it("[FO-06-23] reads own properties and array indices only, never the prototype chain", () => {
    expect(readPointer({ a: [{ b: 1 }] }, parsePointer("/a/0/b"))).toBe(1);
    expect(readPointer({ a: { "x/y": 2, "t~": 3 } }, parsePointer("/a/x~1y"))).toBe(2);
    expect(readPointer({ a: { "t~": 3 } }, parsePointer("/a/t~0"))).toBe(3);
    expect(readPointer({}, parsePointer("/toString"))).toBeUndefined();
    expect(() => parsePointer("/__proto__/polluted")).toThrow(MappingDefinitionError);
    expect(() => parsePointer("/a/constructor")).toThrow(MappingDefinitionError);
    expect(() => parsePointer("a/b")).toThrow("DSL_POINTER_INVALID");
    expect(() => parsePointer(`/${"a/".repeat(20)}a`)).toThrow("DSL_DEPTH_LIMIT");
  });

  it("[FO-06-23] writes build fresh objects and refuse prototype keys and conflicts", () => {
    const o: Record<string, unknown> = {};
    writePointer(o, ["a", "b"], 1);
    expect(o).toEqual({ a: { b: 1 } });
    expect(() => writePointer(o, ["a", "b"], 2)).toThrow("DSL_POINTER_TARGET_CONFLICT");
    expect(() => writePointer(o, ["a", "b", "c"], 2)).toThrow("DSL_POINTER_TARGET_CONFLICT");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("closed function set [FO-06-23]", () => {
  it("[FO-06-23] casts are typed and total: wrong types are drift kinds, never exceptions", () => {
    expect(castValue("12", "integer")).toEqual({ ok: true, value: 12 });
    expect(castValue("12.5", "integer")).toEqual({ ok: false, kind: "TYPE_MISMATCH" });
    expect(castValue(true, "string")).toEqual({ ok: false, kind: "TYPE_MISMATCH" });
    expect(castValue("2026-10-19", "instant")).toEqual({ ok: false, kind: "ZONE_MISMATCH" });
    expect(castValue("2026-10-19T10:00:00+02:00", "instant")).toEqual({ ok: true, value: "2026-10-19T08:00:00.000Z" });
    expect(castValue("2026-10-19T10:00:00Z", "date")).toEqual({ ok: false, kind: "ZONE_MISMATCH" });
    expect(castValue("2026-02-30", "date")).toEqual({ ok: false, kind: "TYPE_MISMATCH" });
    expect(castValue("usd", "currency_code").ok).toBe(false);
    expect(castValue("x".repeat(4_001), "string")).toEqual({ ok: false, kind: "VALUE_TOO_LARGE" });
    expect(normalizeInstant("2026-13-01T00:00:00Z")).toBeNull();
  });

  it("[FO-06-23] wall-clock times in a business zone convert to UTC, a non-existent local time is refused (DST gap)", () => {
    expect(zonedLocalToUtc("2026-01-15T09:00:00", "America/New_York")).toBe("2026-01-15T14:00:00.000Z");
    expect(zonedLocalToUtc("2026-07-15T09:00", "America/New_York")).toBe("2026-07-15T13:00:00.000Z");
    expect(zonedLocalToUtc("2026-03-08T02:30:00", "America/New_York")).toBeNull();
    expect(zonedLocalToUtc("2026-01-15T09:00:00", "Not/AZone")).toBeNull();
  });

  it("[FO-06-23] unit conversion is exact: decimal money without float error, precision loss is drift", () => {
    expect(convertUnit("12.34", "major_units", "minor_units")).toEqual({ ok: true, value: 1234 });
    expect(convertUnit(0.1, "major_units", "minor_units")).toEqual({ ok: true, value: 10 });
    expect(convertUnit("12.345", "major_units", "minor_units")).toEqual({ ok: false, kind: "TYPE_MISMATCH" });
    expect(convertUnit(90, "minutes", "seconds")).toEqual({ ok: true, value: 5_400 });
    expect(convertUnit(90, "seconds", "minutes")).toEqual({ ok: false, kind: "UNIT_MISMATCH" });
    expect(convertUnit(120, "seconds", "minutes")).toEqual({ ok: true, value: 2 });
    expect(convertUnit(5, "minutes", "minor_units")).toEqual({ ok: false, kind: "UNIT_MISMATCH" });
  });
});

describe("mapping interpreter [FO-06-05][FO-06-23]", () => {
  const mapping = compileMapping("Invoice", MAPPINGS, TABLES);

  it("[FO-06-23] maps rename, cast, enum, zone and unit transforms; PROHIBITED fields are never read or emitted", () => {
    const [r] = applyMapping(mapping, { items: [rec({ dueLocal: "2026-01-15T09:00:00" })] }, "/items");
    expect(r?.values).toEqual({ invoiceId: "inv-001", status: "OPEN", amountMinor: 1234, dueAt: "2026-01-15T14:00:00.000Z", periodSeconds: 2_592_000 });
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC restricted");
    expect(r?.provenance.status).toEqual({ sourcePointer: "/status", authoritative: true, classification: "FINANCIAL" });
    expect(authoritativeFields(mapping)).toEqual(["invoiceId", "status"]);
  });

  it("[FO-06-05][FAULT:SCHEMA_DRIFT seam] a renamed, retyped or re-enumerated field refuses the WHOLE response with a typed drift error (no partial result)", () => {
    const good = rec({ dueLocal: "2026-01-15T09:00:00" });
    const drift = (r: unknown) => {
      try {
        applyMapping(mapping, { items: [good, r] }, "/items");
      } catch (e) {
        expect(e).toBeInstanceOf(ConnectorSchemaDriftError);
        return (e as ConnectorSchemaDriftError).issues;
      }
      throw new Error("no drift reported");
    };
    const { status: _s, ...renamed } = good;
    expect(drift({ ...renamed, state: "open" })).toEqual([{ kind: "MISSING_REQUIRED", targetField: "status" }]);
    expect(drift({ ...good, amount: { value: 12 } })).toEqual([{ kind: "TYPE_MISMATCH", targetField: "amountMinor" }]);
    expect(drift({ ...good, status: "written_off" })).toEqual([{ kind: "UNKNOWN_ENUM_VALUE", targetField: "status" }]);
    expect(drift({ ...good, dueLocal: "2026-03-08T02:30:00" })).toEqual([{ kind: "ZONE_MISMATCH", targetField: "dueAt" }]);
    expect(drift("not-an-object")).toEqual([{ kind: "RECORD_NOT_AN_OBJECT", targetField: "$record" }]);
    expect(() => applyMapping(mapping, { items: { not: "array" } }, "/items")).toThrow(ConnectorSchemaDriftError);
    const err = (() => {
      try {
        applyMapping(mapping, { items: [{ ...good, status: "written_off" }] }, "/items");
      } catch (e) {
        return e as ConnectorSchemaDriftError;
      }
      return null;
    })();
    // Reason code and target names only: no vendor value in the message (DATA-01).
    expect(err?.message).toBe("CONNECTOR_SCHEMA_DRIFT:UNKNOWN_ENUM_VALUE");
    expect(err?.mappingDigest).toBe(mapping.digest);
  });

  it("[FO-06-05] OPTIONAL fields map to null when absent; REQUIRED null is drift", () => {
    const [r] = applyMapping(mapping, rec({ dueLocal: null, period: undefined }), "");
    expect(r?.values.dueAt).toBeNull();
    expect(r?.values.periodSeconds).toBeNull();
    expect(() => applyMapping(mapping, rec({ id: null }), "")).toThrow("CONNECTOR_SCHEMA_DRIFT:MISSING_REQUIRED");
  });

  it("[FO-06-23] definitions are refused before use: prohibited overlap, unknown table, incompatible semantic, verification secrets", () => {
    expect(() => compileMapping("Invoice", [...MAPPINGS, M({ sourcePointer: "/notes/text", targetField: "x" })], TABLES)).toThrow("DSL_PROHIBITED_FIELD_MAPPED");
    expect(() => compileMapping("Invoice", [M({ sourcePointer: "/s", targetField: "s", type: "enum_code", semantic: "enum:nope" })], TABLES)).toThrow("DSL_ENUM_TABLE_UNKNOWN");
    expect(() => compileMapping("Invoice", [M({ sourcePointer: "/s", targetField: "s", type: "string", semantic: "unit:minutes:seconds" })], TABLES)).toThrow("DSL_SEMANTIC_TYPE_INCOMPATIBLE");
    expect(() => compileMapping("Invoice", [M({ sourcePointer: "/s", targetField: "s", type: "integer", semantic: "unit:minutes:minor_units" })], TABLES)).toThrow("DSL_UNIT_UNKNOWN");
    expect(() => compileMapping("Invoice", [M({ sourcePointer: "/s", targetField: "s", classification: "VERIFICATION_SECRET" })], TABLES)).toThrow("DSL_VERIFICATION_SECRET_MAPPED");
    expect(() => compileMapping("Invoice", [M({ sourcePointer: "/a", targetField: "s" }), M({ sourcePointer: "/b", targetField: "s" })], TABLES)).toThrow("DSL_DUPLICATE_TARGET");
    expect(() => compileMapping("Invoice", [M({ sourcePointer: "/a", targetField: "s", type: "instant", semantic: "zone:z" })], TABLES)).toThrow("DSL_SEMANTIC_INVALID");
    expect(() => compileMapping("Invoice", MAPPINGS, { enums: [], timeZones: [{ zoneKey: "business", ianaZone: "Mars/Olympus" }] })).toThrow("DSL_ZONE_UNKNOWN");
  });

  it("[FO-06-23] the mapping digest is pinned: stable for the same definition, different for any change", () => {
    expect(compileMapping("Invoice", MAPPINGS, TABLES).digest).toBe(mapping.digest);
    expect(compileMapping("Invoice", [...MAPPINGS].reverse(), TABLES).digest).not.toBe(mapping.digest);
    const changedTable = { ...TABLES, enums: [{ tableId: "invoice_status", entries: [{ from: "open", to: "OPEN" }, { from: "paid", to: "SETTLED" }] }] };
    expect(compileMapping("Invoice", MAPPINGS, changedTable).digest).not.toBe(mapping.digest);
  });
});

describe("interpreter bounds reachable by admissible mappings [FO-06-23]", () => {
  /** Runs one mapping call; returns what it produced (nothing when it threw) and the error. */
  const run = (m: ReturnType<typeof compileMapping>, body: unknown): { out: unknown; error: unknown } => {
    let out: unknown;
    try {
      out = applyMapping(m, body, "/items");
    } catch (e) {
      return { out, error: e };
    }
    return { out, error: null };
  };

  it("[FO-06-23] step limit: 200 rules reading depth-16 pointers over 1 000 records exceed the step budget; the call stops with DSL_STEP_LIMIT and returns nothing", () => {
    const deep = `/${Array.from({ length: 16 }, (_, i) => `k${i}`).join("/")}`; // the deepest pointer admitted
    const m = compileMapping("Invoice", Array.from({ length: 200 }, (_, i) => M({ sourcePointer: deep, targetField: `f${i}`, requirement: "OPTIONAL" })), TABLES);
    let nested: unknown = "v";
    for (let i = 15; i >= 0; i -= 1) nested = { [`k${i}`]: nested };
    const page = (n: number) => ({ items: Array.from({ length: n }, () => nested) });
    // 600 records cost 1 920 001 pointer steps (within 2 000 000) and map in full ...
    const within = run(m, page(600));
    expect([within.error, (within.out as unknown[]).length]).toEqual([null, 600]);
    // ... 1 000 records (the record cap) would cost 3 200 001: refused whole, typed, not retryable.
    const over = run(m, page(1_000));
    expect(over.out).toBeUndefined();
    expect(over.error).toBeInstanceOf(MappingLimitError);
    const e = over.error as MappingLimitError;
    expect([e.reasonCode, e.message, e.retryable]).toEqual(["DSL_STEP_LIMIT", "DSL_STEP_LIMIT", false]);
  });

  it("[FO-06-23] output-size limit: 256 rules over a 4 000-character field over 1 000 records would emit about 1e9 characters; the call stops with DSL_SIZE_LIMIT and returns nothing", () => {
    const m = compileMapping("Invoice", Array.from({ length: 256 }, (_, i) => M({ sourcePointer: "/big", targetField: `g${i}` })), TABLES);
    const big = "x".repeat(4_000); // the longest string value the DSL accepts
    const page = (n: number) => ({ items: Array.from({ length: n }, () => ({ big })) });
    // 7 records emit 7 168 000 characters (within 8 000 000) and map in full ...
    const within = run(m, page(7));
    expect([within.error, (within.out as unknown[]).length]).toEqual([null, 7]);
    // ... the 8th record crosses the output budget: the whole response is refused.
    for (const n of [8, 1_000]) {
      const over = run(m, page(n));
      expect(over.out).toBeUndefined();
      expect(over.error).toBeInstanceOf(MappingLimitError);
      const e = over.error as MappingLimitError;
      expect([e.reasonCode, e.retryable]).toEqual(["DSL_SIZE_LIMIT", false]);
    }
  });
});

describe("mapping vs fetched metadata [FO-06-05]", () => {
  const mapping = compileMapping("Invoice", MAPPINGS, TABLES);
  const schema = (props: Record<string, unknown>) => ({ title: "Invoice", type: "object", properties: props });
  const OK = {
    id: { type: "string" },
    status: { type: "string", enum: ["open", "paid"] },
    amount: { type: "string", "x-unit": "major_units" },
    dueLocal: { type: "string" },
    period: { type: "object", properties: { days: { type: "integer", "x-unit": "days" } } },
    notes: { type: "string", "x-vsp-classification": "PHI_RESTRICTED" },
  };

  it("[FO-06-05] a mapping consistent with the vendor's metadata has no issues", () => {
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema(OK)))).toEqual([]);
  });

  it("[FO-06-05] rejects a missing required field, a type mismatch and semantic mismatches (enum, unit, time zone)", () => {
    const { status: _s, ...noStatus } = OK;
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema(noStatus)))).toEqual([{ kind: "MISSING_REQUIRED", targetField: "status" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, id: { type: "boolean" } })))).toEqual([{ kind: "TYPE_MISMATCH", targetField: "invoiceId" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, status: { type: "string", enum: ["open", "paid", "void"] } })))).toEqual([{ kind: "UNKNOWN_ENUM_VALUE", targetField: "status" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, status: { type: "string" } })))).toEqual([{ kind: "UNKNOWN_ENUM_VALUE", targetField: "status" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, amount: { type: "string", "x-unit": "minor_units" } })))).toEqual([{ kind: "UNIT_MISMATCH", targetField: "amountMinor" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, dueLocal: { type: "string", format: "date" } })))).toEqual([{ kind: "ZONE_MISMATCH", targetField: "dueAt" }]);
  });

  it("[FO-06-05] an instant mapped without a zone semantic needs a zoned date-time: a plain string field (a wall-clock value, no format) is ZONE_MISMATCH", () => {
    const zoneless = compileMapping("Invoice", [M({ sourcePointer: "/id", targetField: "invoiceId", type: "opaque_id" }), M({ sourcePointer: "/issuedAt", targetField: "issuedAt", type: "instant" })], TABLES);
    const meta = (issuedAt: Record<string, unknown>) => parseMetadata("JSON_SCHEMA", "Invoice", schema({ id: { type: "string" }, issuedAt }));
    expect(validateMappingAgainstMetadata(zoneless, meta({ type: "string", format: "date-time" }))).toEqual([]);
    expect(validateMappingAgainstMetadata(zoneless, meta({ type: "string" }))).toEqual([{ kind: "ZONE_MISMATCH", targetField: "issuedAt" }]);
    expect(validateMappingAgainstMetadata(zoneless, meta({ type: "string", format: "date" }))).toEqual([{ kind: "ZONE_MISMATCH", targetField: "issuedAt" }]);
    expect(validateMappingAgainstMetadata(zoneless, meta({ type: "integer" }))).toEqual([{ kind: "TYPE_MISMATCH", targetField: "issuedAt" }]);
    // The same plain string is accepted when the mapping supplies the zone (zone:<key> semantic).
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, dueLocal: { type: "string" } })))).toEqual([]);
  });

  it("[FO-06-05][DATA-01] rejects a prohibited field: a mapped field the tenant marks prohibited, or classified above the mapping", () => {
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, id: { type: "string", "x-vsp-prohibited": true } })))).toEqual([{ kind: "PROHIBITED_FIELD_MAPPED", targetField: "invoiceId" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, id: { type: "string", "x-vsp-classification": "VERIFICATION_SECRET" } })))).toEqual([{ kind: "PROHIBITED_FIELD_MAPPED", targetField: "invoiceId" }]);
    expect(validateMappingAgainstMetadata(mapping, parseMetadata("JSON_SCHEMA", "Invoice", schema({ ...OK, id: { type: "string", "x-vsp-classification": "PHI" } })))).toEqual([{ kind: "CLASSIFICATION_MISMATCH", targetField: "invoiceId" }]);
  });

  it("[FO-06-05] understands the sObject-describe field list (picklists, currency in major units, datetime vs date)", () => {
    const m = compileMapping(
      "Case",
      [
        M({ sourceObject: "Case", sourcePointer: "/Status", targetField: "status", type: "enum_code", semantic: "enum:case_status" }),
        M({ sourceObject: "Case", sourcePointer: "/Amount__c", targetField: "amountMinor", type: "money_minor_units", semantic: "unit:major_units:minor_units" }),
        M({ sourceObject: "Case", sourcePointer: "/ClosedDate", targetField: "closedAt", type: "instant" }),
      ],
      { enums: [{ tableId: "case_status", entries: [{ from: "New", to: "NEW" }, { from: "Closed", to: "CLOSED" }] }], timeZones: [] },
    );
    const describe = (closedType: string, picklist: string[]) => ({
      name: "Case",
      fields: [
        { name: "Status", type: "picklist", picklistValues: picklist.map((value) => ({ value, active: true })) },
        { name: "Amount__c", type: "currency" },
        { name: "ClosedDate", type: closedType },
      ],
    });
    expect(validateMappingAgainstMetadata(m, parseMetadata("FIELD_DESCRIBE", "Case", describe("datetime", ["New", "Closed"])))).toEqual([]);
    expect(validateMappingAgainstMetadata(m, parseMetadata("FIELD_DESCRIBE", "Case", describe("date", ["New", "Closed", "Escalated"])))).toEqual([
      { kind: "UNKNOWN_ENUM_VALUE", targetField: "status" },
      { kind: "ZONE_MISMATCH", targetField: "closedAt" },
    ]);
    expect(() => parseMetadata("FIELD_DESCRIBE", "Case", { name: "Contact", fields: [] })).toThrow("METADATA_OBJECT_NOT_DESCRIBED");
    expect(() => parseMetadata("JSON_SCHEMA", "Case", "not a schema")).toThrow("METADATA_INVALID");
  });
});

describe("reviewed operation templates [FO-06-23][FO-06-20]", () => {
  const op: ConnectorOperation = {
    operationId: "invoices.get",
    kind: "READ",
    enabled: true,
    method: "GET",
    pathTemplate: "/accounts/{accountId}/invoices/{invoiceId}",
    idempotency: "NATURALLY_IDEMPOTENT",
    reconcileOperationId: null,
    params: [
      { name: "accountId", in: "path", wireName: null, type: "opaque_id", required: true, maxLength: 32, enumValues: null, integerRange: null },
      { name: "invoiceId", in: "path", wireName: null, type: "token", required: true, maxLength: 32, enumValues: null, integerRange: null },
      { name: "view", in: "query", wireName: "view", type: "enum_code", required: false, maxLength: 16, enumValues: ["summary", "full"], integerRange: null },
      { name: "limit", in: "query", wireName: "limit", type: "integer", required: false, maxLength: 4, enumValues: null, integerRange: { min: 1, max: 50 } },
    ],
  };
  const base = "https://billing.example.test/api/v2";

  it("[FO-06-23] renders typed values under the base path on the base origin", () => {
    checkOperationTemplate(op);
    const r = renderRequest(base, op, { params: { accountId: "acc_123", invoiceId: "inv-9.1", view: "full", limit: 10 } });
    expect(r.url.toString()).toBe("https://billing.example.test/api/v2/accounts/acc_123/invoices/inv-9.1?view=full&limit=10");
    expect(r.body).toBeNull();
  });

  it("[FO-06-20][FO-06-23][SAFE-05] no value can add a path segment, a query string, a host or a traversal; undeclared or missing params are refused", () => {
    for (const bad of ["../../admin", "a/b", "a?x=1", "a#f", "a%2Fb", "a b", "..", "//evil.example.com"]) {
      expect(() => renderRequest(base, op, { params: { accountId: "acc_1", invoiceId: bad } }), bad).toThrow(TemplateInputError);
    }
    expect(() => renderRequest(base, op, { params: { accountId: "acc_1", invoiceId: "x", host: "evil.example.com" } })).toThrow("TEMPLATE_PARAM_UNDECLARED");
    expect(() => renderRequest(base, op, { params: { accountId: "acc_1" } })).toThrow("TEMPLATE_PARAM_MISSING");
    expect(() => renderRequest(base, op, { params: { accountId: "acc_1", invoiceId: "x", view: "raw" } })).toThrow("TEMPLATE_PARAM_INVALID");
    expect(() => renderRequest(base, op, { params: { accountId: "acc_1", invoiceId: "x", limit: 51 } })).toThrow("TEMPLATE_PARAM_INVALID");
    expect(() => renderRequest(base, op, { params: { accountId: "acc_1", invoiceId: "x" }, body: { a: 1 } })).toThrow("TEMPLATE_BODY_NOT_DECLARED");
  });

  it("[FO-06-23] template defects are found at admission: undeclared placeholders, traversal segments, body on GET", () => {
    expect(() => checkOperationTemplate({ ...op, pathTemplate: "/accounts/{accountId}/x/{other}" })).toThrow("TEMPLATE_PLACEHOLDER_UNDECLARED");
    expect(() => checkOperationTemplate({ ...op, pathTemplate: "/accounts/../{accountId}/{invoiceId}" })).toThrow("TEMPLATE_PATH_INVALID");
    expect(() => checkOperationTemplate({ ...op, pathTemplate: "/accounts/{accountId}" })).toThrow("TEMPLATE_PATH_PARAM_UNUSED");
    expect(() => checkOperationTemplate({ ...op, requestBody: { fields: [{ targetPointer: "/a", inputField: "a", type: "string", requirement: "REQUIRED", classification: "INTERNAL", maxLength: 10 }] } })).toThrow("TEMPLATE_BODY_ON_GET");
  });

  it("[FO-06-23][ACT-02] write bodies come only from declared, typed fields; the idempotency key is server-derived and required", () => {
    const write: ConnectorOperation = {
      ...op,
      operationId: "invoices.review",
      kind: "WRITE",
      method: "POST",
      pathTemplate: "/accounts/{accountId}/reviews",
      params: [op.params?.[0] as NonNullable<ConnectorOperation["params"]>[number]],
      idempotency: "IDEMPOTENCY_KEY_HEADER",
      idempotencyKeyHeader: "Idempotency-Key",
      reconcileOperationId: "invoices.get",
      requestBody: {
        fields: [
          { targetPointer: "/review/reason", inputField: "reason", type: "enum_code", requirement: "REQUIRED", classification: "INTERNAL", maxLength: 32 },
          { targetPointer: "/review/amount", inputField: "amountMinor", type: "money_minor_units", requirement: "OPTIONAL", classification: "FINANCIAL", maxLength: 16 },
        ],
      },
    };
    checkOperationTemplate(write);
    const r = renderRequest(base, write, { params: { accountId: "acc_1" }, body: { reason: "DUPLICATE_CHARGE", amountMinor: 1200 }, idempotencyKey: "act_synthKey000001" });
    expect(r.body).toEqual({ review: { reason: "DUPLICATE_CHARGE", amount: 1200 } });
    expect(r.headers["idempotency-key"]).toBe("act_synthKey000001");
    expect(() => renderRequest(base, write, { params: { accountId: "acc_1" }, body: { reason: "X" } })).toThrow("TEMPLATE_IDEMPOTENCY_KEY_REQUIRED");
    expect(() => renderRequest(base, write, { params: { accountId: "acc_1" }, body: { reason: "X", sql: "drop table" }, idempotencyKey: "act_synthKey000001" })).toThrow("TEMPLATE_BODY_FIELD_UNDECLARED");
    expect(() => renderRequest(base, write, { params: { accountId: "acc_1" }, body: { reason: "has space" }, idempotencyKey: "act_synthKey000001" })).toThrow("TEMPLATE_BODY_VALUE_INVALID");
  });
});
