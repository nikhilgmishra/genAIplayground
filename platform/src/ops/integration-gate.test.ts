/**
 * OPS-KS-02: the INTEGRATION (and WRITES) kill switch stops background writes to the
 * integration. Unit tests for the gate, then the LOCAL FIXTURE composition with the real
 * console API, worker loops (outbox.dispatch / outbox.consume / support.sync_retry) and
 * Salesforce fixture. SYNTHETIC data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterHealth, CaseFields, SupportRecordSystem } from "../adapters/ports.js";
import { AVERY, STAFF_SUPERVISOR, createJourneyHarness } from "../../test/journeys/harness.js";
import type { JourneyHarness } from "../../test/journeys/harness.js";
import { emptySnapshot } from "./kill-switches.js";
import { IntegrationHeldError, KillSwitchGatedSupportRecords, integrationHold, isIntegrationHeld } from "./integration-gate.js";
import type { KillSwitchSnapshot } from "./ports.js";

class RecordingSupportRecordsFixture implements SupportRecordSystem {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "salesforce";
  readonly calls: string[] = [];
  health(): Promise<AdapterHealth> {
    return Promise.resolve({ healthy: true, reasonCode: null });
  }
  upsertInteraction(): Promise<{ recordId: string; created: boolean }> {
    this.calls.push("upsertInteraction");
    return Promise.resolve({ recordId: "rec_1", created: true });
  }
  upsertCase(_e: string, _i: string, _f: CaseFields): Promise<{ caseId: string; created: boolean }> {
    this.calls.push("upsertCase");
    return Promise.resolve({ caseId: "case_1", created: true });
  }
  getCaseByExternalId(): Promise<{ caseId: string; status: string; ownerQueue: string } | null> {
    this.calls.push("getCase");
    return Promise.resolve(null);
  }
}

describe("integration kill-switch gate (unit)", () => {
  it("[SPEC-13.kill][OPS-KS-02] INTEGRATION holds reads and writes; WRITES holds writes only; unreadable state holds everything", () => {
    const s = emptySnapshot();
    expect(integrationHold({ ...s, integrations: ["salesforce"] }, { integration: "salesforce", write: true })).toBe("KILL_SWITCH_INTEGRATION");
    expect(integrationHold({ ...s, integrations: ["salesforce"] }, { integration: "salesforce", write: false })).toBe("KILL_SWITCH_INTEGRATION");
    expect(integrationHold({ ...s, writes: true }, { integration: "salesforce", write: true })).toBe("KILL_SWITCH_WRITES");
    expect(integrationHold({ ...s, writes: true }, { integration: "salesforce", write: false })).toBeNull();
    expect(integrationHold({ ...s, integrations: ["scheduling"] }, { integration: "salesforce", write: true })).toBeNull();
    expect(integrationHold(null, { integration: "salesforce", write: false })).toBe("KILL_SWITCH_STATE_UNAVAILABLE");
  });

  it("[SPEC-13.kill][OPS-KS-02] the gated adapter never calls the vendor while held and passes through otherwise", async () => {
    const run = async (snap: () => Promise<KillSwitchSnapshot>) => {
      const inner = new RecordingSupportRecordsFixture();
      const gated = new KillSwitchGatedSupportRecords({ inner, snapshot: snap });
      const results = await Promise.allSettled([
        gated.upsertInteraction("x", { callId: "c", language: "en", consentStatus: "GRANTED", startedAt: "2026-10-18T00:00:00.000Z" }),
        gated.upsertCase("x", "y", {} as CaseFields),
        gated.getCaseByExternalId("x"),
      ]);
      return { inner, gated, results };
    };
    const held = await run(() => Promise.resolve({ ...emptySnapshot(), integrations: ["salesforce"] }));
    expect(held.inner.calls).toEqual([]);
    for (const r of held.results) {
      expect(r.status).toBe("rejected");
      const err = (r as PromiseRejectedResult).reason as unknown;
      expect(err).toBeInstanceOf(IntegrationHeldError);
      expect(isIntegrationHeld(err)).toBe(true);
      expect((err as IntegrationHeldError).outcome).toBe("NOT_STARTED");
    }
    const failing = await run(() => Promise.reject(new Error("db down")));
    expect(failing.inner.calls).toEqual([]);
    const clear = await run(() => Promise.resolve(emptySnapshot()));
    expect(clear.inner.calls).toEqual(["upsertInteraction", "upsertCase", "getCase"]);
    expect(clear.gated.integrationId).toBe("salesforce");
    expect(clear.gated.kind).toBe("local_fixture");
  });
});

describe("INTEGRATION / WRITES switches stop the worker's Salesforce sync (LOCAL FIXTURE composition)", () => {
  let h: JourneyHarness;
  let seq = 0;
  beforeAll(async () => {
    h = await createJourneyHarness();
  }, 180_000);
  afterAll(async () => {
    await h?.close();
  });

  const setSwitch = async (scope: "INTEGRATION" | "WRITES", target: string, engaged: boolean) => {
    const res = await h.consoleRequest(
      STAFF_SUPERVISOR,
      "POST",
      "/console/api/v1/kill-switches",
      { scope, target, engaged, reason: engaged ? "PHI_EXPOSURE_SUSPECTED" : "INCIDENT_CLOSED", confirmationPhrase: `${engaged ? "ENGAGE" : "RELEASE"} ${scope} ${target}` },
      `idem_opsKs02Switch${String(++seq).padStart(12, "0")}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const createRequest = async (): Promise<string> => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const created = await call.tool("create_support_request", { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: "en" });
    expect(created.status).toBe("SUCCESS");
    return (created.data?.request as { supportReference: string }).supportReference;
  };
  const row = async (ref: string) =>
    (await h.q<{ sync_state: string; sync_attempts: number; last_sync_reason: string | null }>("select sync_state, sync_attempts, last_sync_reason from support_requests where reference_number = $1", [ref]))[0];
  const cases = () => h.c.fixtures.supportRecords.records().cases.length;
  const sync = () => h.runWorker(["outbox.dispatch", "outbox.consume"]);
  /** Several full retry cycles: sweep, dispatch, consume, with the clock past every backoff. */
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      h.clock.advanceSeconds(20 * 60);
      await h.runWorker(["support.sync_retry", "outbox.dispatch", "outbox.consume"]);
    }
  };

  it("[SPEC-13.kill][OPS-KS-02] INTEGRATION salesforce engaged: nothing reaches Salesforce, the request is held (never dead-lettered, no attempt spent) and syncs after release", async () => {
    const ref = await createRequest();
    const before = cases();
    await setSwitch("INTEGRATION", "salesforce", true);
    await sync();
    expect(cases()).toBe(before);
    // Held before any claim: no state transition, no attempt spent, durable hold marker recorded.
    expect(await row(ref)).toMatchObject({ sync_state: "PENDING", sync_attempts: 0, last_sync_reason: "KILL_SWITCH_INTEGRATION" });
    // Longer than the whole retry budget (maxAttempts 6): still held, still nothing sent.
    await cycles(8);
    expect(cases()).toBe(before);
    expect(await row(ref)).toMatchObject({ sync_state: "PENDING", sync_attempts: 0 });
    // Even a sweep that ignores the switch (direct service call) only re-enqueues; the consumer holds again.
    h.clock.advanceSeconds(20 * 60);
    expect(await h.c.business.supportRequests.retryDue?.(h.c.config.tenantId)).toBe(1);
    await sync();
    expect(cases()).toBe(before);
    expect(await row(ref)).toMatchObject({ sync_state: "PENDING", sync_attempts: 0, last_sync_reason: "KILL_SWITCH_INTEGRATION" });
    await setSwitch("INTEGRATION", "salesforce", false);
    await cycles(1);
    expect(cases()).toBe(before + 1);
    expect(await row(ref)).toMatchObject({ sync_state: "SYNCED", sync_attempts: 1, last_sync_reason: null });
  }, 180_000);

  it("[SPEC-13.kill][OPS-KS-02] WRITES engaged holds the background upsert too; held syncs are audited as support_request.sync_held", async () => {
    const ref = await createRequest();
    const before = cases();
    await setSwitch("WRITES", "*", true);
    await sync();
    expect(cases()).toBe(before);
    expect(await row(ref)).toMatchObject({ sync_state: "PENDING", sync_attempts: 0, last_sync_reason: "KILL_SWITCH_WRITES" });
    const held = await h.q<{ n: string }>("select count(*)::text as n from audit_outbox where event->>'action' = 'support_request.sync_held'");
    expect(Number(held[0]?.n ?? 0)).toBeGreaterThan(0);
    await setSwitch("WRITES", "*", false);
    await cycles(1);
    expect(await row(ref)).toMatchObject({ sync_state: "SYNCED" });
    expect(cases()).toBe(before + 1);
  }, 180_000);
});
