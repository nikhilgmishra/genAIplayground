/**
 * Unit (Docker-free) of the NON-idempotent legacy create over a labelled UNIT FAKE runner (unit-fake.fixture.ts)
 * (FO-06-75; ACT-02, ACT-03): the create runs only under the delivery's own reservation of the reference (a
 * redelivery never sends a second create, even while the lookup lags); an appointment under the reference that is
 * not this booking is never claimed; the POST carries the enforced dispatch deadline and the dispatch id; absence
 * is NOT_FOUND only from the product's reference fence (FENCED), never from an empty lookup plus time.
 */
import { describe, expect, it } from "vitest";
import type { MappedValue } from "../connectors/dsl/values.js";
import { ConnectorError } from "../connectors/runtime/errors.js";
import { externalRefFor, HttpLegacyScheduling } from "./legacy.js";
import type { LegacySubject } from "./legacy.js";
import { scriptedConnector } from "./unit-fake.fixture.js";
import type { Script } from "./unit-fake.fixture.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const KEY = `vsp-${"ef".repeat(24)}`;
const CLIENT = "sub_synthUnitClient00001";
const PROVIDER = "prv_synthUnitProvider0001";
const EXPIRES = new Date(NOW.getTime() + 300_000).toISOString();

const subject: LegacySubject = {
  kind: "appointment.create",
  subjectId: CLIENT,
  target: { system: "scheduling", recordType: "provider_schedule", recordRef: PROVIDER, beforeVersion: "legacy.open" },
  change: { providerRef: PROVIDER, toStartsAt: "2026-10-26T15:00:00.000Z", toTimeZone: "America/Chicago", toModality: "video", authority: "CLIENT_CONFIRMED", actingPartyRef: CLIENT },
  expiresAt: EXPIRES,
};
const legacyAppt = (o: Record<string, MappedValue> = {}): Record<string, MappedValue> => ({
  appointmentId: "apt_synthUnitLegacyAppt01",
  subjectId: CLIENT,
  providerRef: PROVIDER,
  startsAt: "2026-10-26T15:00:00.000Z",
  modality: "video",
  status: "SCHEDULED",
  version: "1",
  externalRef: externalRefFor(KEY),
  ...o,
});

const DISPATCH = "dsp_synthUnitDispatch000001";
const rig = (script: Script, now: Date = NOW) => {
  const { conn, runner } = scriptedConnector("legacy", script, {}, { now: () => now });
  return { legacy: new HttpLegacyScheduling(conn, () => DISPATCH), runner };
};
const calls = <C extends { kind: string; operationId: string }>(runner: { calls: C[] }, operationId: string): C[] => runner.calls.filter((c) => c.kind === "execute" && c.operationId === operationId);
const posts = <C extends { kind: string; operationId: string }>(runner: { calls: C[] }): C[] => calls(runner, "legacy.appointment.post");
const ref = (state: string, mine: boolean): Record<string, MappedValue>[] => [{ externalRef: externalRefFor(KEY), referenceState: state, reservedForDispatch: mine }];
/** A product script: the reservation answer, the lookup, the create and the fence. */
const product =
  (o: { reserve?: () => Record<string, MappedValue>[] | Error; lookup?: () => Record<string, MappedValue>[]; post?: () => Record<string, MappedValue>[] | Error; fence?: () => Record<string, MappedValue>[] | Error } = {}): Script =>
  (op) => {
    if (op === "legacy.reference.reserve") return o.reserve ? o.reserve() : ref("RESERVED", true);
    if (op === "legacy.reference.release") return ref("RELEASED", false);
    if (op === "legacy.appointments.by_reference") return o.lookup ? o.lookup() : [];
    if (op === "legacy.appointment.post") return o.post ? o.post() : [legacyAppt()];
    if (op === "legacy.reference.fence") return o.fence ? o.fence() : ref("FENCED", false);
    return new Error(`UNEXPECTED ${op}`);
  };

describe("legacy non-idempotent create (unit, UNIT FAKE runner)", () => {
  it("[ACT-03][FO-06-75] the create runs only under this dispatch's own reservation: reserve with a fresh dispatch id and the deadline, then one POST with the reference, the deadline and the dispatch id", async () => {
    const { legacy, runner } = rig(product());
    expect((await legacy.commit(subject, KEY)).outcome).toBe("COMMITTED");
    const deadline = new Date(Date.parse(EXPIRES) + 5_000).toISOString();
    expect(calls(runner, "legacy.reference.reserve")[0]?.input).toMatchObject({ params: { externalRef: externalRefFor(KEY) }, body: { dispatchId: DISPATCH, notAfter: deadline } });
    expect(posts(runner)).toHaveLength(1);
    expect(posts(runner)[0]?.input).toMatchObject({ params: { externalRef: externalRefFor(KEY) }, body: { clientRef: CLIENT, providerRef: PROVIDER, notAfter: deadline, dispatchId: DISPATCH } });
    // The reservation precedes the create (the order is the protocol).
    expect(runner.calls.map((c) => c.operationId)).toEqual(["legacy.reference.reserve", "legacy.appointment.post"]);
    const late = rig(product({ post: () => new ConnectorError("CONNECTOR_CONFLICT", "FAILED", "scheduling-legacy", "legacy.appointment.post", { httpStatus: 409 }) }));
    expect(await late.legacy.commit(subject, KEY)).toEqual({ outcome: "FAILED", reasonCode: "DISPATCH_DEADLINE_PASSED", permanent: true });
  });

  it("[ACT-02][FO-06-75] a redelivery (the reference reserved by another dispatch) NEVER sends a create, even while the lookup lags: the earlier appointment when visible, UNKNOWN otherwise", async () => {
    for (const state of ["RESERVED", "POSTED"]) {
      // Within the lag: nothing visible yet. In doubt, never a second POST.
      const lagging = rig(product({ reserve: () => ref(state, false) }));
      await expect(lagging.legacy.commit(subject, KEY)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "EARLIER_DISPATCH_IN_DOUBT" });
      expect(posts(lagging.runner)).toHaveLength(0);
      // Once visible: the earlier appointment is the answer.
      const visible = rig(product({ reserve: () => ref(state, false), lookup: () => [legacyAppt()] }));
      expect(await visible.legacy.commit(subject, KEY)).toMatchObject({ outcome: "COMMITTED", providerReference: "apt_synthUnitLegacyAppt01" });
      expect(posts(visible.runner)).toHaveLength(0);
    }
    // A fenced reference: nothing can ever be created under it.
    const fenced = rig(product({ reserve: () => ref("FENCED", false) }));
    expect(await fenced.legacy.commit(subject, KEY)).toEqual({ outcome: "FAILED", reasonCode: "REQUEST_FENCED", permanent: true });
    expect(posts(fenced.runner)).toHaveLength(0);
  });

  it("[ACT-02] an appointment under the reference that is not this booking (other client, provider or start) is never claimed: UNKNOWN, no POST", async () => {
    const variants: Record<string, MappedValue>[] = [{ subjectId: "sub_synthUnitOtherClient1" }, { providerRef: "prv_synthUnitOtherProvide1" }, { startsAt: "2026-10-27T15:00:00.000Z" }];
    for (const o of variants) {
      const { legacy, runner } = rig(product({ reserve: () => ref("POSTED", false), lookup: () => [legacyAppt(o)] }));
      await expect(legacy.commit(subject, KEY)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "RECONCILE_PAYLOAD_MISMATCH" });
      expect(posts(runner)).toHaveLength(0);
      expect(await legacy.lookup(subject, KEY)).toEqual({ outcome: "UNKNOWN" });
    }
  });

  it("[ACT-03] a create that provably never left (NOT_STARTED) gives its reservation back; one sent and unanswered keeps it (UNKNOWN)", async () => {
    const notStarted = rig(product({ post: () => new ConnectorError("CONNECTION_REFUSED", "NOT_STARTED", "scheduling-legacy", "legacy.appointment.post") }));
    await expect(notStarted.legacy.commit(subject, KEY)).rejects.toMatchObject({ outcome: "NOT_STARTED" });
    expect(calls(notStarted.runner, "legacy.reference.release")[0]?.input).toMatchObject({ params: { externalRef: externalRefFor(KEY) }, body: { dispatchId: DISPATCH } });
    const sent = rig(product({ post: () => new ConnectorError("TIMEOUT_AFTER_SEND", "UNKNOWN", "scheduling-legacy", "legacy.appointment.post") }));
    await expect(sent.legacy.commit(subject, KEY)).rejects.toMatchObject({ outcome: "UNKNOWN" });
    expect(calls(sent.runner, "legacy.reference.release")).toHaveLength(0);
    // The reservation itself failing before send: NOT_STARTED, no create.
    const down = rig(product({ reserve: () => new ConnectorError("CONNECTION_REFUSED", "NOT_STARTED", "scheduling-legacy", "legacy.reference.reserve") }));
    await expect(down.legacy.commit(subject, KEY)).rejects.toMatchObject({ outcome: "NOT_STARTED" });
    expect(posts(down.runner)).toHaveLength(0);
  });

  it("[ACT-03] absence: none visible is never NOT_FOUND by itself; after the deadline + skew the reference fence decides (FENCED only), never without a fence", async () => {
    const deadlineMs = Date.parse(EXPIRES) + 5_000;
    // Before the deadline + skew: UNKNOWN, nothing fenced.
    const early = rig(product(), new Date(deadlineMs + 200));
    expect(await early.legacy.lookup(subject, KEY)).toEqual({ outcome: "UNKNOWN" });
    expect(calls(early.runner, "legacy.reference.fence")).toHaveLength(0);
    // After it: FENCED is NOT_FOUND; POSTED (a create committed late, not visible yet) stays UNKNOWN, even a day later.
    const fenced = rig(product(), new Date(deadlineMs + 201));
    expect(await fenced.legacy.lookup(subject, KEY)).toEqual({ outcome: "NOT_FOUND" });
    expect(calls(fenced.runner, "legacy.reference.fence")[0]?.input).toMatchObject({ params: { externalRef: externalRefFor(KEY) }, body: { notAfter: new Date(deadlineMs).toISOString() } });
    expect(await rig(product({ fence: () => ref("POSTED", false) }), new Date(deadlineMs + 86_400_000)).legacy.lookup(subject, KEY)).toEqual({ outcome: "UNKNOWN" });
    // The product refusing an early fence (its clock): UNKNOWN.
    expect(await rig(product({ fence: () => new ConnectorError("CONNECTOR_CONFLICT", "FAILED", "scheduling-legacy", "legacy.reference.fence", { httpStatus: 409 }) }), new Date(deadlineMs + 201)).legacy.lookup(subject, KEY)).toEqual({ outcome: "UNKNOWN" });
    // Two appointments under one reference (a duplicate the product made) are never resolved by picking one.
    expect(await rig(product({ lookup: () => [legacyAppt(), legacyAppt({ appointmentId: "apt_synthUnitLegacyAppt02" })] })).legacy.lookup(subject, KEY)).toEqual({ outcome: "UNKNOWN" });
  });

  it("[ACT-03][FO-06-75] a non-idempotent binding without a dispatch reservation or a fence is not admitted (never a second create, never an unsettleable unknown)", () => {
    expect(() => scriptedConnector("legacy", product(), { dispatchDeadline: "NONE" })).toThrow(/BINDING_NON_IDEMPOTENT_WITHOUT_FENCE/);
    expect(() => scriptedConnector("legacy", product(), { fence: false })).toThrow(/BINDING_NON_IDEMPOTENT_WITHOUT_FENCE/);
  });
});
