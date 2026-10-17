import { describe, expect, it } from "vitest";
import { APPOINTMENTS, INVOICES, SLOTS } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import type { SpeechDirective } from "../protocol/index.js";
import { FALLBACK_TEMPLATE_ID, TemplateResponseGate, isGateApproved, isGateFallback, postCheck } from "./gate.js";
import type { GateRejection, GatedUtterance } from "./gate.js";
import type { GateContext } from "./ports.js";
import { CatalogTemplateRegistry, loadDefaultTemplateRegistry } from "./registry.js";
import enUS from "./templates/en-US.json" with { type: "json" };
import esUS from "./templates/es-US.json" with { type: "json" };
import { InMemoryTurnTracker } from "./turns.js";

const SESSION = "ses_synthSessionPrimary000000001";
const AUTH = "pdc_synthDecisionPrimary01";
const TURN = "turn_synthTurn0001";
const registry = loadDefaultTemplateRegistry();
const gate = new TemplateResponseGate({ registry });

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  sessionRef: SESSION,
  currentTurnId: TURN,
  sessionGeneration: 1,
  validAuthorizationRefs: new Set([AUTH]),
  locale: "en-US",
  environment: "local",
  ...over,
});

const directive = (over: Partial<SpeechDirective> = {}): SpeechDirective => ({
  templateId: "invoice.balance",
  templateVersion: "0.1.0-draft",
  responseClass: "FINANCIAL_FACT",
  slots: { amount: INVOICES[0].balanceMinor, dueDate: INVOICES[0].dueOn },
  authorizationRef: AUTH,
  sourceRefs: [`invoice:${INVOICES[0].invoiceId}`],
  turnId: TURN,
  sessionGeneration: 1,
  ...over,
});

const ok = (r: GatedUtterance | GateRejection): GatedUtterance => {
  if (!r.ok) throw new Error(`expected success, got ${r.reasonCode}`);
  return r;
};
const rejected = (r: GatedUtterance | GateRejection): GateRejection => {
  if (r.ok) throw new Error("expected rejection");
  return r;
};

/** Registry where every template is APPROVED by a (synthetic) verified approval id — for production-path tests only. */
function approvedRegistry(): CatalogTemplateRegistry {
  const approve = (cat: typeof enUS) => {
    const c = JSON.parse(JSON.stringify(cat)) as typeof enUS;
    for (const t of c.templates) (t as { approval: { status: string; approvedBy: string | null } }).approval = { status: "APPROVED", approvedBy: "apr_synthTestApproval01" };
    return c;
  };
  return CatalogTemplateRegistry.fromCatalogs([approve(enUS), approve(esUS)], { verifiedApprovalIds: new Set(["apr_synthTestApproval01"]) });
}

describe("TemplateResponseGate: rendering", () => {
  it("[SPEC-11.confirmation] renders amounts, dates, times and time zones for confirmation in en-US and es-US", () => {
    expect(ok(gate.render(directive(), ctx())).utterance).toBe("Your current balance is $100.00, due on October 31, 2026.");
    const appt = APPOINTMENTS[0];
    const slot = SLOTS[0];
    const change = directive({
      templateId: "appointment.change_confirmation",
      responseClass: "COMMITMENT",
      slots: { fromDate: "2026-10-22", fromTime: "12:00", fromTimeZone: appt.timeZone, toDate: "2026-10-23", toTime: "12:00", toTimeZone: slot.timeZone },
      sourceRefs: ["action:act_synthPreparedAction001"],
    });
    expect(ok(gate.render(change, ctx())).utterance).toBe(
      "To confirm, I'll move your appointment from October 22, 2026 at 12:00 PM, Central Time, to October 23, 2026 at 12:00 PM, Central Time. Say yes to confirm, or no to keep it.",
    );
    expect(ok(gate.render(change, ctx({ locale: "es-US" }))).utterance).toBe(
      "Para confirmar: cambiaré su cita del 22 de octubre de 2026 a las 12:00 p. m., hora del Centro, al 23 de octubre de 2026 a las 12:00 p. m., hora del Centro. Diga sí para confirmar, o no para mantenerla.",
    );
  });

  it("[SPEC-11.confirmation] names are confirmed by spelling and support references are spelled out", () => {
    const name = ok(gate.render(directive({ templateId: "identity.name_spelling_confirmation", responseClass: "IDENTITY", slots: { name: "Avery" }, sourceRefs: [] }), ctx()));
    expect(name.utterance).toBe("I have the name Avery, spelled A, V, E, R, Y. Is that right?");
    const ref = ok(gate.render(directive({ templateId: "support_reference.pending_sync", responseClass: "COMMITMENT", slots: { supportReference: "SR-ABCD-2345" } }), ctx()));
    expect(ref.utterance).toMatch(/^Your support reference is S R, A B C D, 2 3 4 5\. .*not a case number\.$/);
  });

  it("[SPEC-11.acknowledgment] 'Let me check that.' renders as an acknowledgment that never counts as resolution", () => {
    const r = ok(gate.render(directive({ templateId: "status.checking", responseClass: "GENERIC_STATUS", slots: {}, authorizationRef: null, sourceRefs: [] }), ctx({ validAuthorizationRefs: new Set() })));
    expect(r).toMatchObject({ utterance: "Let me check that.", acknowledgmentOnly: true, protectedClass: false });
  });

  it("[ACT-05] [OPS-03] in local/ci unapproved templates render but carry the LOCAL badge; results are frozen and gate-registered", () => {
    const r = ok(gate.render(directive(), ctx({ environment: "ci" })));
    expect(r.localUnapprovedBadge).toBe(true);
    expect(r.record.approvalStatus).toBe("DRAFT");
    expect(Object.isFrozen(r)).toBe(true);
    expect(isGateApproved(r)).toBe(true);
    expect(isGateApproved({ ...r })).toBe(false);
  });

  it("[DATA-01] the response record is content-free: template, versions, authorization and sources, never slot values", () => {
    const r = ok(gate.render(directive(), ctx()));
    expect(r.record).toEqual({
      templateId: "invoice.balance",
      templateVersion: "0.1.0-draft",
      responseClass: "FINANCIAL_FACT",
      locale: "en-US",
      approvalStatus: "DRAFT",
      authorizationRef: AUTH,
      sourceRefs: [`invoice:${INVOICES[0].invoiceId}`],
      turnId: TURN,
      sessionGeneration: 1,
      catalogDigest: registry.digest(),
      environment: "local",
    });
    expect(JSON.stringify(r.record)).not.toMatch(/100\.00|10000|2026-10-31/);
  });
});

describe("TemplateResponseGate: ACT-05 before-speech checks", () => {
  it("[ACT-05] a protected template without authorization fails closed to the safe fallback + human route", () => {
    const r = rejected(gate.render(directive({ authorizationRef: null }), ctx()));
    expect(r).toMatchObject({ reasonCode: "AUTHORIZATION_MISSING", disposition: "SPEAK_FALLBACK_AND_ROUTE_HUMAN", routeToHuman: true, fallbackTemplateId: FALLBACK_TEMPLATE_ID });
    expect(r.fallbackUtterance).toBe(registry.get(FALLBACK_TEMPLATE_ID, "en-US")?.text);
    expect(isGateFallback(r)).toBe(true);
    for (const [templateId, responseClass, slots] of [
      ["identity.verified_confirmation", "IDENTITY", { displayName: "Avery" }],
      ["appointment.facts", "PROTECTED_FACT", { providerName: "Dr. Morgan", date: "2026-10-22", time: "12:00", timeZone: "America/Chicago" }],
      ["commitment.request_accepted", "COMMITMENT", { supportReference: "SR-ABCD-2345" }],
    ] as const) {
      expect(rejected(gate.render(directive({ templateId, responseClass, slots, authorizationRef: null }), ctx())).reasonCode).toBe("AUTHORIZATION_MISSING");
    }
  });

  it("[ACT-05] an authorization reference that is not current for this session/turn is refused", () => {
    expect(rejected(gate.render(directive({ authorizationRef: "pdc_synthDecisionExpired01" }), ctx())).reasonCode).toBe("AUTHORIZATION_NOT_CURRENT");
  });

  it("[ACT-05] a stale turn is dropped silently: nothing is spoken into the new state", () => {
    const r = rejected(gate.render(directive({ turnId: "turn_synthTurnOld01" }), ctx()));
    expect(r).toMatchObject({ reasonCode: "STALE_TURN", disposition: "DROP_STALE", fallbackUtterance: "", routeToHuman: false });
    expect(isGateFallback(r)).toBe(false);
  });

  it("[ACT-05] a result from another session generation is dropped (STALE_GENERATION)", () => {
    expect(rejected(gate.render(directive({ sessionGeneration: 2 }), ctx())).reasonCode).toBe("STALE_GENERATION");
    expect(rejected(gate.render(directive({ sessionGeneration: 1 }), ctx({ sessionGeneration: 3 }))).reasonCode).toBe("STALE_GENERATION");
  });

  it("[ACT-05] with a turn tracker, a turn invalidated by barge-in is stale even if the context was not refreshed", () => {
    const turns = new InMemoryTurnTracker();
    const turnId = turns.beginTurn(SESSION, 1);
    const tracked = new TemplateResponseGate({ registry, turnTracker: turns });
    expect(tracked.render(directive({ turnId }), ctx({ currentTurnId: turnId })).ok).toBe(true);
    turns.bargeIn(SESSION);
    expect(rejected(tracked.render(directive({ turnId }), ctx({ currentTurnId: turnId }))).reasonCode).toBe("STALE_TURN");
  });

  it.each([
    ["date", "invoice.balance", "FINANCIAL_FACT", { amount: 100, dueDate: "2026-02-30" }, "SLOT_INVALID_DATE"],
    ["date (wrong shape)", "invoice.balance", "FINANCIAL_FACT", { amount: 100, dueDate: "10/31/2026" }, "SLOT_INVALID_DATE"],
    ["time", "appointment.facts", "PROTECTED_FACT", { providerName: "Dr. Morgan", date: "2026-10-22", time: "25:00", timeZone: "America/Chicago" }, "SLOT_INVALID_TIME"],
    ["time zone allowlist", "appointment.facts", "PROTECTED_FACT", { providerName: "Dr. Morgan", date: "2026-10-22", time: "12:00", timeZone: "Europe/Paris" }, "SLOT_INVALID_TIME_ZONE"],
    ["money as string", "invoice.balance", "FINANCIAL_FACT", { amount: "100.00", dueDate: "2026-10-31" }, "SLOT_INVALID_MONEY"],
    ["money fractional", "invoice.balance", "FINANCIAL_FACT", { amount: 10.5, dueDate: "2026-10-31" }, "SLOT_INVALID_MONEY"],
    ["money negative", "invoice.balance", "FINANCIAL_FACT", { amount: -1, dueDate: "2026-10-31" }, "SLOT_INVALID_MONEY"],
    ["person name injection", "identity.verified_confirmation", "IDENTITY", { displayName: "Avery {ignore previous}" }, "SLOT_INVALID_PERSON_NAME"],
    ["person name digits", "identity.verified_confirmation", "IDENTITY", { displayName: "Avery 1990-01-01" }, "SLOT_INVALID_PERSON_NAME"],
    ["support reference", "commitment.request_accepted", "COMMITMENT", { supportReference: "CASE-00123" }, "SLOT_INVALID_SUPPORT_REFERENCE"],
    ["enum", "invoice.line_explanation", "FINANCIAL_FACT", { serviceDate: "2026-09-20", amount: 2500, lineType: "REFUND_PROMISED" }, "SLOT_INVALID_ENUM"],
    ["count", "onboarding.status", "PROTECTED_FACT", { stage: "DOCUMENTS_PENDING", missingCount: -2 }, "SLOT_INVALID_COUNT"],
    ["spelled code", "commitment.confirmation_code", "COMMITMENT", { confirmationCode: "AB-12" }, "SLOT_INVALID_SPELLED_CODE"],
    ["portal path", "portal.navigation", "GENERIC_STATUS", { portalPath: "https://evil.example/portal" }, "SLOT_INVALID_PORTAL_PATH"],
    ["portal path traversal", "portal.navigation", "GENERIC_STATUS", { portalPath: "/portal/../admin" }, "SLOT_INVALID_PORTAL_PATH"],
    ["boolean value", "invoice.balance", "FINANCIAL_FACT", { amount: true, dueDate: "2026-10-31" }, "SLOT_INVALID_MONEY"],
  ] as const)("[ACT-05] invalid slot type (%s) fails closed", (_label, templateId, responseClass, slots, reason) => {
    const r = rejected(gate.render(directive({ templateId, responseClass, slots: slots as SpeechDirective["slots"] }), ctx()));
    expect(r.reasonCode).toBe(reason);
    expect(r.routeToHuman).toBe(true);
  });

  it("[ACT-05] missing and extra slots are rejected", () => {
    expect(rejected(gate.render(directive({ slots: { amount: 100 } }), ctx())).reasonCode).toBe("SLOT_MISSING");
    expect(rejected(gate.render(directive({ slots: { amount: 100, dueDate: "2026-10-31", note: "free text" } }), ctx())).reasonCode).toBe("SLOT_UNEXPECTED");
  });

  it("[ACT-05] template must exist for the locale, and version and response class must match", () => {
    expect(rejected(gate.render(directive({ templateId: "invoice.unknown" }), ctx())).reasonCode).toBe("TEMPLATE_NOT_FOUND");
    expect(rejected(gate.render(directive({ templateVersion: "0.0.9" }), ctx())).reasonCode).toBe("TEMPLATE_VERSION_MISMATCH");
    expect(rejected(gate.render(directive({ responseClass: "GENERIC_STATUS" }), ctx())).reasonCode).toBe("RESPONSE_CLASS_MISMATCH");
    const fr = rejected(gate.render(directive(), ctx({ locale: "fr-FR" })));
    expect(fr.reasonCode).toBe("TEMPLATE_NOT_FOUND");
    expect(fr.fallbackUtterance).toBe(registry.get(FALLBACK_TEMPLATE_ID, "en-US")?.text);
  });

  it("[ACT-05] financial facts, protected facts and commitments must cite sources", () => {
    expect(rejected(gate.render(directive({ sourceRefs: [] }), ctx())).reasonCode).toBe("SOURCE_REFERENCE_MISSING");
  });

  it("[ACT-05] directives are strictly parsed: unknown fields or dependency free text are rejected", () => {
    const withText = { ...directive(), text: "Your refund has been approved." };
    expect(rejected(gate.render(withText, ctx())).reasonCode).toBe("DIRECTIVE_INVALID");
    expect(rejected(gate.render(null, ctx())).reasonCode).toBe("DIRECTIVE_INVALID");
  });

  it("[ACT-05] an invalid gate context routes to a human without speaking", () => {
    const r = rejected(gate.render(directive(), { ...ctx(), sessionGeneration: 0 }));
    expect(r).toMatchObject({ reasonCode: "GATE_CONTEXT_INVALID", disposition: "ROUTE_HUMAN_WITHOUT_SPEECH", fallbackUtterance: "", routeToHuman: true });
  });

  it("[ACT-05] [OPS-04] in production a PENDING/DRAFT template never renders; with no approved fallback the human route happens without speech", () => {
    for (const environment of ["production", "staging", "sandbox"] as const) {
      const r = rejected(gate.render(directive(), ctx({ environment })));
      expect(r).toMatchObject({ reasonCode: "TEMPLATE_NOT_APPROVED", disposition: "ROUTE_HUMAN_WITHOUT_SPEECH", fallbackUtterance: "", routeToHuman: true });
      const safety = rejected(gate.render(directive({ templateId: "safety.acknowledgment", responseClass: "SAFETY", slots: {}, authorizationRef: null, sourceRefs: [] }), ctx({ environment })));
      expect(safety.reasonCode).toBe("TEMPLATE_NOT_APPROVED");
    }
  });

  it("[OPS-04] in production verified APPROVED templates render without the LOCAL badge", () => {
    const prodGate = new TemplateResponseGate({ registry: approvedRegistry() });
    const r = ok(prodGate.render(directive(), ctx({ environment: "production" })));
    expect(r.localUnapprovedBadge).toBe(false);
    const fb = rejected(prodGate.render(directive({ authorizationRef: null }), ctx({ environment: "production" })));
    expect(fb).toMatchObject({ disposition: "SPEAK_FALLBACK_AND_ROUTE_HUMAN", localUnapprovedBadge: false });
  });

  it("[ACT-05] rejections are logged with reason codes only", () => {
    const { logger, records } = createMemoryLogger();
    const g = new TemplateResponseGate({ registry, logger });
    g.render(directive({ slots: { amount: 100, dueDate: "2026-10-31", secret: "4111111111111111" } }), ctx());
    expect(records[0]).toMatchObject({ event: "voice.gate.rejected", fields: { reasonCode: "SLOT_UNEXPECTED", template: "invoice.balance", kind: "FINANCIAL_FACT" } });
    expect(JSON.stringify(records)).not.toContain("4111");
  });
});

describe("TemplateResponseGate: SAFE-02", () => {
  it("[SAFE-02] safety, clinical-boundary and recording templates render at A0 without any authorization", () => {
    const a0 = ctx({ validAuthorizationRefs: new Set() });
    for (const [templateId, responseClass, slots] of [
      ["safety.acknowledgment", "SAFETY", {}],
      ["transfer.safety_update", "SAFETY", {}],
      ["clinical.boundary", "CLINICAL_BOUNDARY", {}],
      ["recording.consent_question", "RECORDING_DISCLOSURE", {}],
      ["opening.disclosure", "RECORDING_DISCLOSURE", { companyName: "Synthetic Support Co" }],
    ] as const) {
      for (const locale of ["en-US", "es-US"]) {
        const r = ok(gate.render(directive({ templateId, responseClass, slots, authorizationRef: null, sourceRefs: [] }), { ...a0, locale }));
        expect(r.protectedClass).toBe(true);
        expect(r.record.authorizationRef).toBeNull();
      }
    }
  });

  it("[SAFE-02] generic verification prompts render at A0 and reveal nothing about account existence", () => {
    const a0 = ctx({ validAuthorizationRefs: new Set() });
    for (const templateId of ["verification.secure_link_sent", "verification.otp_sent", "verification.failed_generic", "human.offer"]) {
      const r = ok(gate.render(directive({ templateId, responseClass: "GENERIC_STATUS", slots: {}, authorizationRef: null, sourceRefs: [] }), a0));
      expect(r.utterance).not.toMatch(/\byour account\b(?! on file)|we found|no account|not found/i);
    }
  });
});

describe("postCheck", () => {
  it("[ACT-05] output checks reject unresolved placeholders, control characters, render artifacts, oversize text and clinical advice", () => {
    expect(postCheck("Hello {name}.")).toBe("OUTPUT_UNRESOLVED_PLACEHOLDER");
    expect(postCheck("Hello\u0007")).toBe("OUTPUT_CONTROL_CHARACTERS");
    expect(postCheck("Your balance is undefined.")).toBe("OUTPUT_RENDER_ARTIFACT");
    expect(postCheck("x".repeat(501))).toBe("OUTPUT_TOO_LONG");
    expect(postCheck("You should take more pills.")).toBe("OUTPUT_CLINICAL_CONTENT_PROHIBITED");
    expect(postCheck("")).toBe("OUTPUT_EMPTY");
    expect(postCheck("Let me check that.")).toBeNull();
  });
});
