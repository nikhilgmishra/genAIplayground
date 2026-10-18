import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyFieldMask, leafPaths, maskTree } from "./mask.js";

const key = fc.constantFrom("startsAt", "timeZone", "status", "lines", "amountMinor", "code", "subjectId", "note", "count", "nested", "id");
const leaf = fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean(), fc.constant(null));
const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("object"), tie("array")),
  object: fc.dictionary(key, tie("value"), { maxKeys: 5 }),
  array: fc.array(tie("value"), { maxLength: 3 }),
})).value;
const record = fc.dictionary(key, json, { maxKeys: 6 });
const path = fc.array(key, { minLength: 1, maxLength: 3 }).map((p) => p.join("."));
const mask = fc.array(path, { maxLength: 6 });
const target: fc.Arbitrary<{ collectionKey: string | null; envelopeKeys: string[] }> = fc.record({
  collectionKey: fc.option(key as fc.Arbitrary<string>, { nil: null }),
  envelopeKeys: fc.uniqueArray(key as fc.Arbitrary<string>, { maxLength: 3 }),
});

/** Every leaf path of the masked record must be covered by some mask path prefix. */
function covered(leafPath: string, maskPaths: readonly string[]): boolean {
  const segs = leafPath.split(".");
  return maskPaths.some((m) => {
    const ms = m.split(".");
    // the mask path is a prefix of the leaf path, or the leaf (an empty object/array) ends inside the mask path
    const n = Math.min(ms.length, segs.length);
    for (let i = 0; i < n; i++) if (ms[i] !== segs[i]) return false;
    return true;
  });
}

describe("applyFieldMask (pure, property tested)", () => {
  it("[DATA-01][SPEC-7.field-minimization] never emits a path outside the mask or the envelope keys", () => {
    fc.assert(
      fc.property(record, mask, target, (data, m, t) => {
        const out = applyFieldMask(data, m, t);
        for (const k of Object.keys(out)) {
          if (t.collectionKey !== null && k === t.collectionKey) {
            for (const p of leafPaths(out[k])) expect(covered(p, m)).toBe(true);
          } else if (t.collectionKey === null && !t.envelopeKeys.includes(k)) {
            for (const p of leafPaths({ [k]: out[k] })) expect(covered(p, m)).toBe(true);
          } else {
            expect(t.envelopeKeys.includes(k)).toBe(true);
          }
        }
      }),
      { seed: 4242, numRuns: 400 },
    );
  });

  it("[DATA-01] is idempotent and never adds keys the input did not have", () => {
    fc.assert(
      fc.property(record, mask, target, (data, m, t) => {
        const once = applyFieldMask(data, m, t);
        expect(applyFieldMask(once, m, t)).toEqual(once);
        for (const k of Object.keys(once)) expect(Object.hasOwn(data, k)).toBe(true);
      }),
      { seed: 777, numRuns: 400 },
    );
  });

  it("[DATA-01] is monotonic: a wider mask keeps at least every leaf a narrower mask keeps", () => {
    fc.assert(
      fc.property(record, mask, mask, target, (data, m1, m2, t) => {
        const narrow = new Set(leafPaths(applyFieldMask(data, m1, t)));
        const wide = new Set(leafPaths(applyFieldMask(data, [...m1, ...m2], t)));
        // A narrow mask can leave an emptied container where the wider mask keeps its content.
        for (const p of narrow) expect(wide.has(p) || [...wide].some((w) => w.startsWith(`${p}.`))).toBe(true);
      }),
      { seed: 99, numRuns: 300 },
    );
  });

  it("[DATA-01] an empty mask leaves only envelope keys (and an emptied collection)", () => {
    fc.assert(
      fc.property(record, target, (data, t) => {
        const out = applyFieldMask(data, [], t);
        for (const k of Object.keys(out)) {
          if (k === t.collectionKey) expect(leafPaths(out[k]).every((p) => p === "")).toBe(true);
          else expect(t.envelopeKeys.includes(k)).toBe(true);
        }
      }),
      { seed: 5, numRuns: 300 },
    );
  });

  it("[DATA-01] the input is never mutated", () => {
    fc.assert(
      fc.property(record, mask, target, (data, m, t) => {
        const before = JSON.stringify(data);
        applyFieldMask(data, m, t);
        expect(JSON.stringify(data)).toBe(before);
      }),
      { seed: 11, numRuns: 200 },
    );
  });

  it("[DATA-01] keeps exactly the policy paths of the catalogue example (invoice lines traversed element-wise)", () => {
    const data = {
      invoices: [
        { invoiceId: "inv_1", subjectId: "sub_x", balanceMinor: 100, lines: [{ code: "SESSION_FEE", amountMinor: 100, serviceDate: "2026-10-01", lineId: "l1", note: "x" }] },
        "not-an-object",
      ],
      count: 1,
      debug: "dependency text",
    };
    const out = applyFieldMask(data, ["invoiceId", "balanceMinor", "lines.amountMinor", "lines.code"], { collectionKey: "invoices", envelopeKeys: ["count"] });
    expect(out).toEqual({ count: 1, invoices: [{ invoiceId: "inv_1", balanceMinor: 100, lines: [{ code: "SESSION_FEE", amountMinor: 100 }] }] });
  });

  it("[DATA-01] prototype-polluting or malformed mask segments are ignored; malformed targets strip everything", () => {
    const data = JSON.parse('{"a":{"b":1},"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(applyFieldMask(data, ["__proto__.polluted", "a.constructor", "a.b"], { collectionKey: null, envelopeKeys: [] })).toEqual({ a: { b: 1 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(maskTree(["a..b", "", "1a"]).size).toBe(0);
    expect(applyFieldMask({ a: 1 }, ["a"], { collectionKey: "bad key!" as never, envelopeKeys: [] })).toEqual({});
  });

  it("[DATA-01] a null collection stays null; a scalar where structure is expected is dropped", () => {
    expect(applyFieldMask({ items: null, n: 1 }, ["x"], { collectionKey: "items", envelopeKeys: ["n"] })).toEqual({ items: null, n: 1 });
    expect(applyFieldMask({ items: [{ a: "s" }] }, ["a.deep"], { collectionKey: "items", envelopeKeys: [] })).toEqual({ items: [{}] });
  });
});
