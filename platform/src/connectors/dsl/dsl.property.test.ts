/**
 * Property tests of the bounded mapping DSL (WP-06; FO-06-23 acceptance: "property tests for termination
 * and no host escape"). fast-check generates arbitrary vendor documents and arbitrary parameter values.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConnectorOperation, FieldMapping } from "../../protocol/connector.js";
import { PlatformError } from "../../shared/errors.js";
import { applyMapping, compileMapping } from "./mapping.js";
import { renderRequest } from "./template.js";

const MAPPINGS: FieldMapping[] = [
  { sourceObject: "R", sourcePointer: "/id", targetField: "id", requirement: "REQUIRED", type: "opaque_id", semantic: null, authoritative: true, classification: "INTERNAL" },
  { sourceObject: "R", sourcePointer: "/a/b", targetField: "ab", requirement: "OPTIONAL", type: "integer", semantic: "unit:minutes:seconds", authoritative: false, classification: "INTERNAL" },
  { sourceObject: "R", sourcePointer: "/s", targetField: "s", requirement: "OPTIONAL", type: "enum_code", semantic: "enum:tt", authoritative: false, classification: "INTERNAL" },
  { sourceObject: "R", sourcePointer: "/when", targetField: "when", requirement: "OPTIONAL", type: "instant", semantic: "zone:berlin", authoritative: false, classification: "INTERNAL" },
  { sourceObject: "R", sourcePointer: "/secret", targetField: "secret", requirement: "PROHIBITED", type: "string", semantic: null, authoritative: false, classification: "PHI_RESTRICTED" },
];
const mapping = compileMapping("R", MAPPINGS, { enums: [{ tableId: "tt", entries: [{ from: "x", to: "X" }] }], timeZones: [{ zoneKey: "berlin", ianaZone: "Europe/Berlin" }] });

describe("DSL properties [FO-06-23]", () => {
  it("[FO-06-23] total: any JSON document maps or fails with a typed platform error, and never leaks a prohibited value", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), fc.option(fc.constantFrom("", "/items", "/a", "/a/b"), { nil: null }), (doc, pointer) => {
        try {
          const out = applyMapping(mapping, { items: [doc], a: doc, ...((typeof doc === "object" && doc !== null && !Array.isArray(doc)) ? doc : {}) }, pointer);
          for (const r of out) expect(Object.keys(r.values)).not.toContain("secret");
        } catch (e) {
          expect(e).toBeInstanceOf(PlatformError);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("[FO-06-23] terminates within its step bound on large and deep documents", () => {
    const big = { items: Array.from({ length: 1_000 }, (_, i) => ({ id: `r${i}`, a: { b: i }, s: "x", when: "2026-06-01T10:00:00", secret: "SYNTHETIC" })) };
    const started = Date.now();
    expect(applyMapping(mapping, big, "/items")).toHaveLength(1_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(() => applyMapping(mapping, { items: Array.from({ length: 1_001 }, () => ({ id: "x" })) }, "/items")).toThrow("DSL_SIZE_LIMIT");
  });

  it("[FO-06-23][FO-06-20][SAFE-05] no host escape: for any parameter values the request stays on the base origin under the base path", () => {
    const op: ConnectorOperation = {
      operationId: "things.get",
      kind: "READ",
      enabled: true,
      method: "GET",
      pathTemplate: "/things/{a}/sub/{b}",
      idempotency: "NATURALLY_IDEMPOTENT",
      reconcileOperationId: null,
      params: [
        { name: "a", in: "path", wireName: null, type: "token", required: true, maxLength: 64, enumValues: null, integerRange: null },
        { name: "b", in: "path", wireName: null, type: "opaque_id", required: true, maxLength: 64, enumValues: null, integerRange: null },
        { name: "q", in: "query", wireName: "q", type: "token", required: false, maxLength: 64, enumValues: null, integerRange: null },
      ],
    };
    const base = "https://api.vendor.example.test/v1";
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 }), fc.option(fc.string({ maxLength: 80 }), { nil: undefined }), (a, b, q) => {
        let url: URL;
        try {
          url = renderRequest(base, op, { params: { a, b, ...(q === undefined ? {} : { q }) } }).url;
        } catch (e) {
          expect(e).toBeInstanceOf(PlatformError);
          return;
        }
        expect(url.origin).toBe("https://api.vendor.example.test");
        expect(url.pathname.startsWith("/v1/things/")).toBe(true);
        expect(url.pathname.split("/").length).toBe(6);
        expect([...url.searchParams.keys()].every((k) => k === "q")).toBe(true);
        expect(url.hash).toBe("");
      }),
      { numRuns: 1_000 },
    );
  });
});
