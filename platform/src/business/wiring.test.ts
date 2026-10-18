/**
 * Unit tests for the wave-4 business wiring helpers: durable grant scope/expiry per workflow
 * definition (grants.ts) and the typed confirmation slots of a prepared action (confirmation.ts).
 * SYNTHETIC data; the billing lookup is the LOCAL FIXTURE billing adapter.
 */
import { describe, expect, it } from "vitest";
import { createLocalFixtureSet } from "../adapters/local/fixture-set.js";
import { APPOINTMENTS, INVOICES, PEOPLE, SLOTS, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { PreparedAction } from "../protocol/index.js";
import { FakeClock } from "../shared/clock.js";
import { confirmationSlotsFor } from "./confirmation.js";
import { grantActionsFor, grantTtlMsFor, issueWorkflowGrant } from "./grants.js";
import type { ToolDeps } from "./contract.js";
import { silentLogger } from "../observability/logger.js";

const action = (over: Partial<PreparedAction>): PreparedAction =>
  ({
    actionId: "act_synthWiringAction0001",
    kind: "appointment.reschedule",
    tenantId: TENANT_ID,
    sessionRef: "ses_bnd_synthWiringSession000000000000000000000",
    sessionGeneration: 2,
    actorId: PEOPLE.avery.actorId,
    subjectId: PEOPLE.avery.subjectId,
    target: { system: "scheduling", recordType: "appointment", recordRef: APPOINTMENTS[0].appointmentId, beforeVersion: "v1" },
    change: {},
    ...over,
  }) as PreparedAction;

describe("durable grants for business workflows", () => {
  it("[SPEC-7.durable-grant] a grant names exactly the definition's declared guarded actions", () => {
    expect(grantActionsFor("billing_dispute_review")).toEqual(["billing.review.commit", "billing.review.decision_notice", "billing.review.outcome_notice"]);
    expect(grantActionsFor("partner_onboarding")).toEqual(["partner.onboarding.activate", "partner.onboarding.decision_notice"]);
    expect(grantActionsFor("complaint_review")).toEqual(["complaint.response.disclose"]);
    expect(grantActionsFor("support_request_sync")).toEqual([]);
  });

  it("[SPEC-7.durable-grant] the grant lifetime is the sum of nonterminal deadlines, bounded to [1 h, 30 d] (engineering default)", () => {
    for (const t of ["billing_dispute_review", "partner_onboarding", "complaint_review", "callback_request", "claim_investigation", "provider_document_review"] as const) {
      const ms = grantTtlMsFor(t);
      expect(ms, t).toBeGreaterThanOrEqual(3_600_000);
      expect(ms, t).toBeLessThanOrEqual(30 * 86_400_000);
    }
  });

  it("[SPEC-7.durable-grant] without a grant store nothing is issued (grantRef null => guarded transitions fail closed); a definition without guarded actions needs no grant", async () => {
    const deps = { clock: new FakeClock(), logger: silentLogger } as Pick<ToolDeps, "grants" | "clock" | "logger">;
    const tx = { query: async () => ({ rows: [], rowCount: 0 }), exec: async () => undefined } as never;
    expect(await issueWorkflowGrant(deps, tx, { tenantId: TENANT_ID, type: "billing_dispute_review", subjectId: PEOPLE.avery.subjectId, actorId: null, sourceRef: "act_synthWiringAction0001" })).toBeNull();
    let issued = 0;
    const withStore = { ...deps, grants: { kind: "local_fixture" as const, issue: async () => ((issued += 1), { grantRef: "grt_synthWiringGrant000001" }), check: async () => ({ valid: true, reasonCode: "GRANT_VALID" }), revoke: async () => undefined } };
    expect(await issueWorkflowGrant(withStore, tx, { tenantId: TENANT_ID, type: "support_request_sync", subjectId: PEOPLE.avery.subjectId, actorId: null, sourceRef: "act_synthWiringAction0001" })).toBeNull();
    expect(issued).toBe(0);
    expect(await issueWorkflowGrant(withStore, tx, { tenantId: TENANT_ID, type: "complaint_review", subjectId: PEOPLE.avery.subjectId, actorId: null, sourceRef: "act_synthWiringAction0001" })).toBe("grt_synthWiringGrant000001");
    expect(issued).toBe(1);
  });
});

describe("typed confirmation slots (TC-07)", () => {
  const fixtures = createLocalFixtureSet({ clock: new FakeClock() });
  const deps = { adapters: { billing: fixtures.billing } } as unknown as Pick<ToolDeps, "adapters">;

  it("[ACT-01][ACT-05][ACT-F5] reschedule: from/to date, time, time zone and visit type from the authoritative prepared change", async () => {
    const change = { slotId: SLOTS[0].slotId, toStartsAt: SLOTS[0].startsAt, toTimeZone: SLOTS[0].timeZone, toModality: SLOTS[0].modality, fromStartsAt: APPOINTMENTS[0].startsAt, fromTimeZone: APPOINTMENTS[0].timeZone, fromModality: APPOINTMENTS[0].modality };
    const slots = await confirmationSlotsFor(deps, action({ change }));
    expect(slots).toMatchObject({ fromTimeZone: "America/Chicago", toTimeZone: "America/Chicago", fromModality: "video", toModality: "video" });
    expect(Object.keys(slots ?? {}).sort()).toEqual(["fromDate", "fromModality", "fromTime", "fromTimeZone", "toDate", "toModality", "toTime", "toTimeZone"]);
    // A change without the visit type is never read back partially (route to a human).
    expect(await confirmationSlotsFor(deps, action({ change: { ...change, toModality: null } }))).toBeNull();
  });

  it("[ACT-01] billing review: the invoice issue date from the system of record; another subject's invoice or a missing fact yields null (route to a human)", async () => {
    const review = { reasonCategory: "OTHER", requestedStatus: "IN_REVIEW" };
    const mine = action({ kind: "billing.review.submit", target: { system: "billing", recordType: "invoice", recordRef: INVOICES[0].invoiceId, beforeVersion: "v1" }, change: review });
    // ACT-F5: the review reason the digest binds is read back with the invoice date.
    expect(await confirmationSlotsFor(deps, mine)).toEqual({ issuedDate: INVOICES[0].issuedOn, reasonCategory: "OTHER" });
    expect(await confirmationSlotsFor(deps, { ...mine, change: { requestedStatus: "IN_REVIEW" } })).toBeNull();
    const other = action({ kind: "billing.review.submit", target: { system: "billing", recordType: "invoice", recordRef: INVOICES[1].invoiceId, beforeVersion: "v1" }, change: review });
    expect(await confirmationSlotsFor(deps, other)).toBeNull();
    expect(await confirmationSlotsFor(deps, action({ change: { toStartsAt: SLOTS[0].startsAt } }))).toBeNull();
  });
});
