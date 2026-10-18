/**
 * [SPEC-13.console][ACT-03] Staff retry of a reconciled operation through the console API,
 * end to end on the LOCAL FIXTURE composition (main/console.ts wires ConsoleApiDeps.reconciledRetry
 * to LedgerActionService.retryAfterReconcile with the LEDGER's reconciliation id):
 * a verified caller's confirmed commit times out ambiguously BEFORE reaching the provider (LOCAL
 * FIXTURE simulation) -> ledger UNKNOWN -> the caller is not told success -> a supervisor
 * reconciles (provider has no record: NOT_FOUND, action back to CONFIRMED) -> the supervisor
 * retries with the same provider idempotency key -> COMMITTED, exactly one scheduling effect.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS, STAFF } from "../../src/fixtures/synthetic-world.js";
import { DependencyError } from "../../src/shared/errors.js";
import { AVERY, createJourneyHarness } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
beforeAll(async () => {
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const APPT = APPOINTMENTS[0].appointmentId;

describe("[SPEC-13.console] reconciled retry from the console", () => {
  it("[SPEC-13.console][ACT-03][ACT-02] UNKNOWN commit -> console reconcile NOT_FOUND -> console retry commits once with the same key", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const opts = await call.tool("get_appointment_options", { appointmentId: APPT, fromDate: "2026-10-20", toDate: "2026-10-31" });
    const slot = ((opts.data?.appointments as { slotId: string | null; startsAt: string; status: string }[]) ?? []).find((a) => a.status === "OPEN");
    const prep = await call.tool("prepare_appointment_change", { appointmentId: APPT, startsAt: slot?.startsAt, modality: null, slotId: slot?.slotId });
    const change = prep.data?.change as { actionId: string; actionDigest: string };
    await call.confirmPending();

    // LOCAL FIXTURE: the provider call times out ambiguously and the request never reached the provider.
    const port = h.c.business.providers["appointment.reschedule"];
    const realCommit = port?.commit.bind(port) as NonNullable<typeof port>["commit"];
    (port as { commit: typeof realCommit }).commit = async () => {
      throw new DependencyError("TIMEOUT_AFTER_SEND", "UNKNOWN");
    };
    let unknown;
    try {
      unknown = await call.tool("commit_appointment_change", { actionId: change.actionId, digest: change.actionDigest });
    } finally {
      (port as { commit: typeof realCommit }).commit = realCommit;
    }
    expect(unknown.status).toBe("UNKNOWN_OUTCOME");
    expect(unknown.speech).toBeNull();
    const [row] = await h.q<{ state: string; provider_idempotency_key: string }>("select state, provider_idempotency_key from action_ledger where action_id = $1", [change.actionId]);
    expect(row?.state).toBe("UNKNOWN");

    // Supervisor reconciles: the provider has no record of the key.
    const rec = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/reconcile`, {}, "idem_synthConsoleReconcile0001");
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ state: "CONFIRMED", retryEligible: true, result: { result: "NOT_FOUND" } });
    const reconciliationId = (rec.body.result as { reconciliationId: string }).reconciliationId;
    expect(h.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPT))).toHaveLength(0);

    // Supervisor retries: the ledger re-checks its own latest NOT_FOUND record and commits with the SAME key.
    const retry = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/retry`, { reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" }, "idem_synthConsoleRetry00000001");
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ actionId: change.actionId, state: "COMMITTED", outcome: "COMMITTED" });
    expect(retry.body.receiptId).toMatch(/^rcp_/);
    const effects = h.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPT));
    expect(effects).toHaveLength(1);
    expect(JSON.stringify(h.c.fixtures.scheduling.deliveries)).toContain(row?.provider_idempotency_key as string);

    // A second retry is refused (the reconciliation is single use; the action is committed).
    const again = await h.consoleRequest(STAFF.supervisor, "POST", `/console/api/v1/reconciliation/${change.actionId}/retry`, { reconciliationId, reason: "RECONCILED_NOT_FOUND_RETRY" }, "idem_synthConsoleRetry00000002");
    expect(again.status).toBe(409);
    expect(h.c.fixtures.scheduling.effects.filter((e) => JSON.stringify(e).includes(APPT))).toHaveLength(1);

    // Both the console and the ledger audited the staff retry.
    const retried = await h.c.auditQuery.search({ tenantId: h.c.config.tenantId, correlationId: change.actionId, limit: 100 });
    expect(retried.length).toBeGreaterThan(0);
    await h.expectAuditChainIntact();
  }, 120_000);
});
