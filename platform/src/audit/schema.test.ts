import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { buildAuditInput } from "./build-input.js";
import {
  AuditEventInvalidError,
  auditStreamName,
  assertStreamName,
  looksPhiShaped,
  normalizeAuditInput,
  pseudonymousSessionRef,
  validateAuditInput,
} from "./schema.js";
import { sampleAuditInput } from "./testing.js";

const clock = new FakeClock();
const base = () => sampleAuditInput(clock);

function rejects(input: unknown): AuditEventInvalidError {
  try {
    validateAuditInput(input);
  } catch (err) {
    expect(err).toBeInstanceOf(AuditEventInvalidError);
    return err as AuditEventInvalidError;
  }
  throw new Error("expected rejection");
}

describe("audit writer input schema", () => {
  it("[SPEC-13.3] accepts a complete structured event with every audit-model field", () => {
    const v = validateAuditInput(base());
    expect(v).toMatchObject({ dataClass: "SECURITY_AUDIT", action: "action.commit.succeeded", outcome: "SUCCEEDED" });
  });

  it("[DATA-01] rejects unknown keys such as transcript or free-text notes without echoing the key or value", () => {
    const err = rejects({ ...base(), transcript: "caller said their date of birth is 1990-01-01" });
    expect(err.message).toBe("AUDIT_EVENT_INVALID");
    expect(JSON.stringify(err.issues)).not.toContain("transcript");
    expect(JSON.stringify(err.issues)).not.toContain("1990");
    expect(err.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("[AUTH-06] rejects verification-secret shaped fields (otp, code) as unknown keys", () => {
    rejects({ ...base(), otpCode: "482913" });
    rejects({ ...base(), modelReasoning: "the caller seems anxious so I decided" });
  });

  it("[DATA-01] rejects lower-case or spaced free text in reasonCode and policy reason codes", () => {
    rejects({ ...base(), reasonCode: "caller was upset about bill" });
    rejects({ ...base(), reasonCode: "lowercase_code" });
    rejects({ ...base(), reasonCode: "OTP_482913" });
    rejects({
      ...base(),
      policyDecision: { decisionId: "dec_synthDecision000001", allow: true, reasonCodes: ["has diagnosis"], policyVersion: "2026-10-17.1" },
    });
    rejects({
      ...base(),
      policyDecision: { decisionId: "dec_synthDecision000001", allow: true, reasonCodes: [], policyVersion: "free text version" },
    });
  });

  it("[DATA-01] rejects free-text actions and requires a dotted code with at least two segments", () => {
    rejects({ ...base(), action: "patient called about depression" });
    rejects({ ...base(), action: "commit" });
    rejects({ ...base(), action: "Action.Commit" });
    rejects({ ...base(), action: "dob.19900101.lookup" });
    expect(validateAuditInput({ ...base(), action: "session.revoke" }).action).toBe("session.revoke");
  });

  it("[DATA-01] rejects evidence pointers outside the pointer grammar or carrying PHI-shaped values", () => {
    for (const p of [
      "https://example.invalid/recording.wav",
      "s3://bucket/key with spaces",
      "s3://x",
      "db://patients/1990-01-01",
      "sf://contacts/avery@example.com",
      "kv://callers/555-555-0101",
      "db://people/123-45-6789",
      "s3://bucket/../other-tenant/obj",
      "s3://bucket//double",
      `s3://${"a".repeat(191)}`,
    ]) {
      rejects({ ...base(), evidencePointers: [p] });
    }
    rejects({ ...base(), evidencePointers: ["ledger://actions/act_a", "ledger://actions/act_a"] });
    rejects({ ...base(), evidencePointers: Array.from({ length: 17 }, (_, i) => `db://rows/r${String.fromCharCode(97 + i)}`) });
    const ok = validateAuditInput({ ...base(), evidencePointers: ["s3://vsp-audit/restricted/obj_synthObject00001", "wf://executions/wfx_synthExec0000001"] });
    expect(ok.evidencePointers).toHaveLength(2);
  });

  it("[DATA-01] typed references are accepted only when the value is an opaque identifier", () => {
    const ok = validateAuditInput({ ...base(), evidencePointers: ["action:act_synthActionPrimary01", "workflow_event:wfe_synthWorkflowEvent01"] });
    expect(ok.evidencePointers).toHaveLength(2);
    for (const p of ["confirmation_method:dtmf", "guard:consent_recheck", "note:caller-is-upset", "action:act_short", "Action:act_synthActionPrimary01", "action:act_synthActionPrimary01 extra"]) {
      rejects({ ...base(), evidencePointers: [p] });
    }
  });

  it("[DATA-01] rejects free text in sessionRef, turnId and idempotencyKey", () => {
    rejects({ ...base(), sessionRef: "Avery Synthetic-Client session" });
    rejects({ ...base(), turnId: "the third thing the caller said" });
    rejects({ ...base(), idempotencyKey: "reschedule for avery tomorrow" });
    rejects({ ...base(), idempotencyKey: "idem-avery@example.com" });
    expect(validateAuditInput({ ...base(), idempotencyKey: "v3:ACCEPT" }).idempotencyKey).toBe("v3:ACCEPT");
  });

  it("[FO-15-45][OPS-01] occurredAt must be a time the audit store holds: year 0000 (accepted by the ISO grammar, refused by timestamptz) and times before 1970 are invalid", () => {
    for (const bad of ["0000-01-01T00:00:00Z", "1969-12-31T23:59:59.999Z", "0001-01-01T00:00:00Z"]) rejects({ ...base(), occurredAt: bad });
    for (const ok of ["1970-01-01T00:00:00Z", "2026-10-19T10:00:00Z", "9999-12-31T23:59:59.999Z"]) expect(validateAuditInput({ ...base(), occurredAt: ok }).occurredAt).toBe(ok);
  });

  it("[AUTH-03] rejects non-opaque actor and subject references", () => {
    rejects({ ...base(), actorRef: "Avery Synthetic-Client" });
    rejects({ ...base(), subjectRef: "1990-01-01" });
  });

  it("[DATA-01] property: any string containing whitespace is rejected as reasonCode and action", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ minLength: 0, maxLength: 40 }), (a, b) => {
        const text = `${a} ${b}`;
        expect(() => validateAuditInput({ ...base(), reasonCode: text })).toThrow(AuditEventInvalidError);
        expect(() => validateAuditInput({ ...base(), action: text })).toThrow(AuditEventInvalidError);
      }),
      { numRuns: 200 },
    );
  });

  it("[DATA-01] property: email and phone shaped pointers are always rejected", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.integer({ min: 200, max: 999 }),
        fc.integer({ min: 1000, max: 9999 }),
        (user, domain, mid, tail) => {
          expect(looksPhiShaped(`db://x/${user}@${domain}.com`)).toBe(true);
          expect(looksPhiShaped(`db://x/555-${mid}-${tail}`)).toBe(true);
          expect(() => validateAuditInput({ ...base(), evidencePointers: [`db://x/555-${mid}-${tail}`] })).toThrow(AuditEventInvalidError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("[AUTH-06] pseudonymizes bearer session references before they become evidence", () => {
    const input = base();
    expect(input.sessionRef).toMatch(/^ses_/);
    const n = normalizeAuditInput(input);
    expect(n.sessionRef).toMatch(/^sref_[A-Za-z0-9_-]{43}$/);
    expect(n.sessionRef).not.toContain(input.sessionRef!.slice(4));
    expect(pseudonymousSessionRef(input.sessionRef!)).toBe(n.sessionRef);
    expect(pseudonymousSessionRef(n.sessionRef!)).toBe(n.sessionRef);
    expect(validateAuditInput(n).sessionRef).toBe(n.sessionRef);
    // already one-way binding references (actions module) are kept as is
    const binding = "ses_bnd_" + "A".repeat(43);
    expect(normalizeAuditInput({ ...input, sessionRef: binding }).sessionRef).toBe(binding);
  });

  it("[SPEC-13.3] buildAuditInput fills defaults and still produces a strictly valid input", () => {
    const v = buildAuditInput(
      { tenantId: "tnt_synthTenantPrimary01", correlationId: "cor_synthCorrelation0002", sourceComponent: "gateway", action: "tool.invoke", outcome: "DENIED" },
      clock,
    );
    expect(v).toEqual({
      occurredAt: "2026-10-17T15:00:00.000Z",
      correlationId: "cor_synthCorrelation0002",
      parentId: null,
      tenantId: "tnt_synthTenantPrimary01",
      actorRef: null,
      subjectRef: null,
      role: null,
      sourceComponent: "gateway",
      callId: null,
      sessionRef: null,
      sessionGeneration: null,
      turnId: null,
      versions: null,
      action: "tool.invoke",
      policyDecision: null,
      assurance: null,
      evidencePointers: [],
      beforeHash: null,
      afterHash: null,
      idempotencyKey: null,
      outcome: "DENIED",
      reasonCode: null,
      dataClass: "SECURITY_AUDIT",
    });
    expect(() =>
      buildAuditInput({ tenantId: "tnt_synthTenantPrimary01", correlationId: "cor_synthCorrelation0002", sourceComponent: "gateway", action: "tool.invoke", outcome: "DENIED" }),
    ).toThrow(ValidationError);
  });

  it("[SPEC-13.3] stream names are per writer instance, lower-cased and grammar-checked", () => {
    expect(auditStreamName("Gateway", "ECS Task 7F3A")).toBe("gateway.ecs-task-7f3a");
    expect(auditStreamName("actions", "i-0abc/def")).toBe("actions.i-0abc-def");
    expect(() => assertStreamName("a..b")).toThrow(ValidationError);
    expect(() => assertStreamName("UPPER")).toThrow(ValidationError);
    expect(() => assertStreamName("x")).toThrow(ValidationError);
    expect(auditStreamName("worker", "x".repeat(100))).toHaveLength(64);
  });
});
