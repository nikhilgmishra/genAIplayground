import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { APPOINTMENTS, PEOPLE, SLOTS, TENANT_ID } from "../fixtures/synthetic-world.js";
import { PreparedAction } from "../protocol/index.js";
import type { PreparedAction as PreparedActionT } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { newSessionRef } from "../shared/ids.js";
import {
  DIGEST_FIELDS,
  bindingRefFromHash,
  computeActionDigest,
  evidenceHashOf,
  isSessionBindingRef,
  providerIdempotencyKeyFor,
  sessionBindingRef,
  sessionRefHash,
  verifyActionDigest,
} from "./digest.js";

/** SYNTHETIC prepared action. */
function base(): PreparedActionT {
  const fields = {
    actionId: "act_synthDigestAction001",
    kind: "appointment.reschedule" as const,
    tenantId: TENANT_ID,
    sessionRef: sessionBindingRef(newSessionRef()),
    sessionGeneration: 1,
    actorId: PEOPLE.avery.actorId,
    subjectId: PEOPLE.avery.subjectId,
    target: { system: "scheduling" as const, recordType: "appointment", recordRef: APPOINTMENTS[0].appointmentId, beforeVersion: "v1" },
    change: { slotId: SLOTS[0].slotId },
    impact: { summaryTemplateId: "appointment.reschedule.summary", fees: { currency: "USD" as const, minorUnits: 2500 }, reversible: true },
    policyDecisionId: "pdc_synthDecision000001",
    policyVersion: "policy-2026-10-17.1",
    preparedAt: "2026-10-17T15:00:00.000Z",
    expiresAt: "2026-10-17T15:05:00.000Z",
    confirmationTemplateId: "appointment.reschedule.confirm",
    requiresStepUp: false,
  };
  return PreparedAction.parse({ ...fields, digest: computeActionDigest(fields), state: "PREPARED" });
}

describe("computeActionDigest", () => {
  it("[ACT-01] is sha256 over canonical JSON of every PreparedAction field except digest and state", () => {
    const a = base();
    const { digest: _d, state: _s, ...rest } = a;
    expect(computeActionDigest(a)).toBe(sha256Hex(canonicalJson(rest)));
    expect([...DIGEST_FIELDS].sort()).toEqual(Object.keys(rest).sort());
    expect(DIGEST_FIELDS).not.toContain("digest");
    expect(DIGEST_FIELDS).not.toContain("state");
  });

  it("[ACT-01] ignores state and the stored digest, so confirmation survives state transitions", () => {
    const a = base();
    expect(computeActionDigest({ ...a, state: "CONFIRMED" })).toBe(a.digest);
    expect(computeActionDigest({ ...a, digest: "0".repeat(64) })).toBe(a.digest);
    expect(verifyActionDigest({ ...a, state: "COMMITTED" })).toBe(true);
    expect(verifyActionDigest({ ...a, digest: "0".repeat(64) })).toBe(false);
  });

  it("[ACT-01] property: changing any digest-covered field changes the digest (fees, target, change, session, generation, expiry)", () => {
    const a = base();
    const mutations: ((x: PreparedActionT, n: number) => PreparedActionT)[] = [
      (x, n) => ({ ...x, impact: { ...x.impact, fees: { currency: "USD", minorUnits: 2500 + n + 1 } } }),
      (x) => ({ ...x, impact: { ...x.impact, fees: null } }),
      (x) => ({ ...x, impact: { ...x.impact, reversible: !x.impact.reversible } }),
      (x, n) => ({ ...x, target: { ...x.target, beforeVersion: `v${n + 2}` } }),
      (x) => ({ ...x, target: { ...x.target, recordRef: APPOINTMENTS[1].appointmentId } }),
      (x) => ({ ...x, change: { slotId: SLOTS[1].slotId } }),
      (x, n) => ({ ...x, change: { ...x.change, extra: n } }),
      (x, n) => ({ ...x, sessionGeneration: x.sessionGeneration + n + 1 }),
      (x) => ({ ...x, sessionRef: sessionBindingRef(newSessionRef()) }),
      (x) => ({ ...x, subjectId: PEOPLE.blake.subjectId }),
      (x) => ({ ...x, kind: "appointment.cancel" }),
      (x) => ({ ...x, expiresAt: "2026-10-17T15:06:00.000Z" }),
      (x) => ({ ...x, requiresStepUp: !x.requiresStepUp }),
      (x) => ({ ...x, policyDecisionId: "pdc_synthDecision000002" }),
      (x) => ({ ...x, confirmationTemplateId: "appointment.cancel.confirm" }),
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: mutations.length - 1 }), fc.integer({ min: 0, max: 1000 }), (i, n) => {
        const mutated = mutations[i]?.(a, n);
        if (!mutated) return;
        expect(computeActionDigest(mutated)).not.toBe(a.digest);
      }),
      { seed: 17, numRuns: 300 },
    );
  });

  it("[ACT-01] property: key order of nested objects does not affect the digest", () => {
    const a = base();
    fc.assert(
      fc.property(fc.shuffledSubarray(Object.keys(a.target), { minLength: 4, maxLength: 4 }), (keys) => {
        const reordered: Record<string, unknown> = {};
        for (const k of keys) reordered[k] = (a.target as Record<string, unknown>)[k];
        expect(computeActionDigest({ ...a, target: reordered as PreparedActionT["target"] })).toBe(a.digest);
      }),
      { seed: 18, numRuns: 50 },
    );
  });

  it("[SPEC-8.3] rejects unvalidated extra fields instead of digesting them", () => {
    const a = base();
    expect(() => computeActionDigest({ ...a, target: { ...a.target, note: "free text" } } as unknown as PreparedActionT)).toThrow("ACTION_DIGEST_INPUT_INVALID");
  });
});

describe("session binding and provider keys", () => {
  it("[AUTH-06] the binding ref is derived from sha256 of the bearer and is never the bearer itself", () => {
    const bearer = newSessionRef();
    const binding = sessionBindingRef(bearer);
    expect(binding).not.toContain(bearer.slice(4));
    expect(isSessionBindingRef(binding)).toBe(true);
    expect(isSessionBindingRef(bearer)).toBe(false);
    expect(bindingRefFromHash(sessionRefHash(bearer))).toBe(binding);
    expect(sessionRefHash(bearer)).toBe(sha256Hex(bearer));
    expect(() => sessionRefHash(binding)).toThrow("SESSION_REF_INVALID");
  });

  it("[ACT-02] provider idempotency key is stable per action and distinct across actions", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{16,40}$/), fc.stringMatching(/^[A-Za-z0-9_-]{16,40}$/), (x, y) => {
        const a = `act_${x}`;
        const b = `act_${y}`;
        expect(providerIdempotencyKeyFor(a)).toBe(providerIdempotencyKeyFor(a));
        expect(providerIdempotencyKeyFor(a).length).toBeGreaterThanOrEqual(16);
        expect(providerIdempotencyKeyFor(a)).not.toContain(x);
        if (a !== b) expect(providerIdempotencyKeyFor(a)).not.toBe(providerIdempotencyKeyFor(b));
      }),
      { seed: 19, numRuns: 200 },
    );
  });

  it("[SPEC-8.3] evidence hash is canonical and marks non-canonical evidence instead of throwing", () => {
    const e1 = evidenceHashOf({ providerSystem: "scheduling", providerReference: "ref1", afterVersion: "v2", evidence: { b: 1, a: 2 } });
    const e2 = evidenceHashOf({ providerSystem: "scheduling", providerReference: "ref1", afterVersion: "v2", evidence: { a: 2, b: 1 } });
    expect(e1).toEqual(e2);
    expect(e1.canonical).toBe(true);
    const bad = evidenceHashOf({ providerSystem: "scheduling", providerReference: "ref1", afterVersion: "v2", evidence: { n: Number.NaN } });
    expect(bad.canonical).toBe(false);
    expect(bad.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
