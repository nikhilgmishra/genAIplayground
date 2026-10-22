/**
 * Unit (Docker-free) of the domain commit port over a labelled UNIT FAKE runner (unit-fake.fixture.ts): refusal
 * mapping, request bodies built from the confirmed action only (dispatch deadline included), receipt-bound evidence,
 * payload binding of found changes, reconciliation decisions and effect verification (FO-03-09, FO-06-75,
 * FO-11-02; ACT-01, ACT-02, ACT-03, AUTH-02). The UNIT FAKE answers writes the way the reference API does: the
 * change it returns carries the request digest of the body it received. The same port runs over the real connector
 * runtime and the reference business API in platform/test/integration/domain.
 */
import { describe, expect, it } from "vitest";
import type { MappedValue } from "../connectors/dsl/values.js";
import type { ExecuteInput } from "../connectors/runtime/connector.js";
import { ConnectorError, ConnectorRefusal } from "../connectors/runtime/errors.js";
import { AccessDeniedError, DependencyError } from "../shared/errors.js";
import { HttpBilling } from "./billing.js";
import { requestDigestOf, requestIdFor } from "./changes.js";
import type { CommitSubject } from "./commit.js";
import { DomainCommitPort, domainKindOf, preparationDigest } from "./commit.js";
import { HttpScheduling } from "./scheduling.js";
import { scriptedConnector } from "./unit-fake.fixture.js";
import type { Script } from "./unit-fake.fixture.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const KEY = `vsp-${"ab".repeat(24)}`;
const EXPIRES = new Date(NOW.getTime() + 300_000).toISOString();
/** expiresAt + the reference profile's default write timeout (5 s). */
const NOT_AFTER = new Date(NOW.getTime() + 300_000 + 5_000).toISOString();
const client = { role: "client" as const, partyRef: "sub_synthUnitClient00001" };
const provider = { role: "provider" as const, partyRef: "prv_synthUnitProvider0001" };

const appointment = (o: Record<string, MappedValue> = {}): Record<string, MappedValue> => ({
  appointmentId: "apt_synthUnitAppointment01",
  subjectId: client.partyRef,
  providerRef: provider.partyRef,
  providerDisplayName: "Clinician A",
  slotId: null,
  startsAt: "2026-10-22T15:00:00.000Z",
  timeZone: "America/Chicago",
  modality: "video",
  status: "SCHEDULED",
  version: "3",
  ...o,
});
const slot = (o: Record<string, MappedValue> = {}): Record<string, MappedValue> => ({
  slotId: "slt_synthUnitSlot00000001",
  providerRef: provider.partyRef,
  providerDisplayName: "Clinician A",
  startsAt: "2026-10-24T16:00:00.000Z",
  timeZone: "America/Chicago",
  modality: "video",
  state: "OPEN",
  version: "1",
  ...o,
});
const completed = (o: Record<string, MappedValue> = {}): Record<string, MappedValue> => ({
  requestId: requestIdFor(KEY),
  operation: "scheduling.reschedule.put",
  state: "COMPLETED",
  receiptId: "rcp_synthUnitReceipt00001",
  resourceType: "appointment",
  resourceId: "apt_synthUnitAppointment01",
  resourceVersion: "4",
  resourceStartsAt: "2026-10-24T16:00:00.000Z",
  resourceTimeZone: "America/Chicago",
  resourceSlotId: "slt_synthUnitSlot00000001",
  resourceSubjectId: client.partyRef,
  requestDigest: null,
  failureCode: null,
  ...o,
});
/** The digest the system stores for a write it received (reference API: REFBIZ_REQUEST_V1). */
const digestOf = (operation: string, input: ExecuteInput): string => requestDigestOf("REFBIZ_REQUEST_V1", operation, (input.body ?? {}) as Record<string, unknown>);
/** A write answer the way the system gives it: the change of the request it received. */
const answering =
  (o: Record<string, MappedValue> = {}) =>
  (input: ExecuteInput, operation = "scheduling.reschedule.put"): Record<string, MappedValue>[] => [completed({ operation, requestDigest: digestOf(operation, input), ...o })];

const notFound = () => new ConnectorError("CONNECTOR_NOT_FOUND", "FAILED", "scheduling", "x", { httpStatus: 404 });

function rig(script: Script, o: { windowMs?: number; incompleteWrite?: "COMPLETE_BY_REQUEST_ID" | "ROUTE_TO_HUMAN"; dispatchDeadline?: "REQUEST_NOT_AFTER" | "NONE"; fence?: boolean } = {}, now: Date = NOW) {
  const { conn, runner } = scriptedConnector("scheduling", script, o, { now: () => now });
  const scheduling = new HttpScheduling(conn);
  const port = new DomainCommitPort({ scheduling, billing: null, clock: { now: () => now } });
  return { port, runner, scheduling };
}

const baseScript =
  (write: (input: ExecuteInput) => Record<string, MappedValue>[] | Error, lookup: () => Record<string, MappedValue>[] = () => []): Script =>
  (op, input) => {
    if (op === "scheduling.appointment.get") return [appointment()];
    if (op === "scheduling.slot.get") return [slot()];
    if (op === "scheduling.reschedule.put") return write(input);
    if (op === "scheduling.change.lookup") return lookup();
    if (op === "scheduling.change.complete") return [completed({ requestDigest: lookup()[0]?.requestDigest ?? null })];
    return new Error(`UNSCRIPTED ${op}`);
  };

async function prepared(port: DomainCommitPort): Promise<CommitSubject> {
  const p = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: "apt_synthUnitAppointment01", slotId: "slt_synthUnitSlot00000001" });
  return { kind: "appointment.reschedule", subjectId: client.partyRef, target: p.input.target, change: p.input.change, expiresAt: EXPIRES };
}

/** The exact body the port sends for the prepared reschedule (from the confirmed action only). */
const RESCHEDULE_BODY = { appointmentId: "apt_synthUnitAppointment01", expectedVersion: "3", slotId: "slt_synthUnitSlot00000001", slotVersion: "1", authority: "CLIENT_CONFIRMED", actingPartyId: client.partyRef, notAfter: NOT_AFTER };
const RESCHEDULE_DIGEST = requestDigestOf("REFBIZ_REQUEST_V1", "scheduling.reschedule.put", RESCHEDULE_BODY);

describe("domain commit port (unit, UNIT FAKE runner)", () => {
  it("[FO-03-09][ACT-01] prepare reads back the target and binds both versions and the authority; a provider cannot prepare a client action (no I/O)", async () => {
    const { port, runner } = rig(baseScript(answering()));
    const p = await port.prepare(client, { kind: "appointment.reschedule", appointmentId: "apt_synthUnitAppointment01", slotId: "slt_synthUnitSlot00000001" });
    expect(p.ledgerKind).toBe("appointment.reschedule");
    expect(p.input.target).toEqual({ system: "scheduling", recordType: "appointment", recordRef: "apt_synthUnitAppointment01", beforeVersion: "a3.s1" });
    expect(p.input.change).toMatchObject({ slotId: "slt_synthUnitSlot00000001", slotVersion: "1", authority: "CLIENT_CONFIRMED", actingPartyRef: client.partyRef, fromStartsAt: "2026-10-22T15:00:00.000Z", toStartsAt: "2026-10-24T16:00:00.000Z" });
    expect(p.input.confirmationTemplateId).toBe("appointment.change_confirmation");
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    const before = runner.calls.length;
    await expect(port.prepare(provider, { kind: "appointment.reschedule", appointmentId: "apt_synthUnitAppointment01", slotId: "slt_synthUnitSlot00000001" })).rejects.toBeInstanceOf(AccessDeniedError);
    expect(runner.calls.length).toBe(before);
    // A provider's approval is confirmed with its own template, never the client's consent wording.
    const pp = await port.prepare(provider, { kind: "provider.appointment.reschedule", appointmentId: "apt_synthUnitAppointment01", slotId: "slt_synthUnitSlot00000001" });
    expect(pp.input.confirmationTemplateId).toBe("provider.appointment.change_confirmation");
    expect(pp.input.change).toMatchObject({ authority: "PROVIDER_APPROVED", actingPartyRef: provider.partyRef });
  });

  it("[ACT-02][ACT-03] the keyed write carries the request id of the stable key, a body built from the confirmed action only and the dispatch deadline; receipt-bound evidence", async () => {
    const { port, runner } = rig(baseScript(answering()));
    const action = await prepared(port);
    const r = await port.commit(action, KEY);
    expect(r).toEqual({
      outcome: "COMMITTED",
      providerReference: "rcp_synthUnitReceipt00001",
      afterVersion: "4",
      evidence: { appointmentId: "apt_synthUnitAppointment01", startsAt: "2026-10-24T16:00:00.000Z", timeZone: "America/Chicago", status: "SCHEDULED" },
    });
    const put = runner.calls.find((c) => c.operationId === "scheduling.reschedule.put");
    expect(put?.input.params).toEqual({ requestId: requestIdFor(KEY) });
    expect(put?.input.body).toEqual(RESCHEDULE_BODY);
    // No read of current state was needed for the body: the slot version is the confirmed one.
    expect(runner.calls.filter((c) => c.operationId === "scheduling.slot.get")).toHaveLength(1);
    // A redelivery sends exactly the same body (same digest): the system replays instead of refusing it.
    await port.commit(action, KEY);
    const puts = runner.calls.filter((c) => c.operationId === "scheduling.reschedule.put");
    expect(puts).toHaveLength(2);
    expect(puts[1]?.input.body).toEqual(puts[0]?.input.body);
  });

  it.each([
    ["CONNECTOR_CONFLICT", "STATE_CHANGED"],
    ["CONNECTOR_FORBIDDEN", "AUTHORITY_REFUSED"],
    ["CONNECTOR_NOT_FOUND", "TARGET_NOT_FOUND"],
    ["CONNECTOR_REQUEST_REJECTED", "PROVIDER_REJECTED"],
  ])("[ACT-03] a definite refusal %s is FAILED %s (never UNKNOWN, never retried)", async (code, reason) => {
    const { port } = rig(baseScript(() => new ConnectorError(code, "FAILED", "scheduling", "scheduling.reschedule.put", { httpStatus: code === "CONNECTOR_REQUEST_REJECTED" ? 400 : 409 })));
    expect(await port.commit(await prepared(port), KEY)).toEqual({ outcome: "FAILED", reasonCode: reason, permanent: true });
  });

  it("[ACT-02][ACT-03] 422 (the request id already carries another request) is in doubt: UNKNOWN, reconciled by key, never 'not applied'", async () => {
    const { port } = rig(baseScript(() => new ConnectorError("CONNECTOR_REQUEST_REJECTED", "FAILED", "scheduling", "scheduling.reschedule.put", { httpStatus: 422 })));
    await expect(port.commit(await prepared(port), KEY)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "REQUEST_ID_IN_USE" });
  });

  it("[ACT-03] a refusal before any request is FAILED; NOT_STARTED and UNKNOWN keep the executor's classification", async () => {
    const refused = rig(baseScript(() => new ConnectorRefusal("OPERATION_NOT_ENABLED", "scheduling", "scheduling.reschedule.put")));
    expect(await refused.port.commit(await prepared(refused.port), KEY)).toEqual({ outcome: "FAILED", reasonCode: "OPERATION_NOT_ENABLED", permanent: true });
    const notStarted = rig(baseScript(() => new ConnectorError("CONNECTION_REFUSED", "NOT_STARTED", "scheduling", "scheduling.reschedule.put")));
    await expect(notStarted.port.commit(await prepared(notStarted.port), KEY)).rejects.toMatchObject({ outcome: "NOT_STARTED" });
    const unknown = rig(baseScript(() => new ConnectorError("TIMEOUT_AFTER_SEND", "UNKNOWN", "scheduling", "scheduling.reschedule.put")));
    await expect(unknown.port.commit(await prepared(unknown.port), KEY)).rejects.toMatchObject({ outcome: "UNKNOWN" });
  });

  it("[ACT-03][FAULT:PARTIAL_WRITE] a write answer that is not COMPLETED with a receipt is UNKNOWN, never FAILED: INCOMPLETE (step 1 applied) and COMPLETED without receipt", async () => {
    const incomplete = rig(baseScript(answering({ state: "INCOMPLETE", receiptId: null })));
    const e1 = await incomplete.port.commit(await prepared(incomplete.port), KEY).then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(e1).toBeInstanceOf(DependencyError);
    expect(e1).toMatchObject({ outcome: "UNKNOWN", reasonCode: "INCOMPLETE_WRITE" });
    const noReceipt = rig(baseScript(answering({ receiptId: null })));
    await expect(noReceipt.port.commit(await prepared(noReceipt.port), KEY)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "RECEIPT_INCONSISTENT" });
    // Only a REJECTED change is a definite failure, with the system's code (a moved version is STATE_CHANGED).
    const rejected = rig(baseScript(answering({ state: "REJECTED", receiptId: null, failureCode: "VERSION_CONFLICT" })));
    expect(await rejected.port.commit(await prepared(rejected.port), KEY)).toEqual({ outcome: "FAILED", reasonCode: "STATE_CHANGED", permanent: true });
    const refused = rig(baseScript(answering({ state: "REJECTED", receiptId: null, failureCode: "AUTHORITY_REFUSED" })));
    expect(await refused.port.commit(await prepared(refused.port), KEY)).toEqual({ outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true });
  });

  it("[ACT-02] a receipt for another record, or a change whose request digest is not the body sent, is never claimed (UNKNOWN)", async () => {
    const other = rig(baseScript(answering({ resourceId: "apt_synthSomeOtherAppt0001" })));
    await expect(other.port.commit(await prepared(other.port), KEY)).rejects.toBeInstanceOf(DependencyError);
    const wrongDigest = rig(baseScript(() => [completed({ requestDigest: "f".repeat(64) })]));
    await expect(wrongDigest.port.commit(await prepared(wrongDigest.port), KEY)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "RECONCILE_PAYLOAD_MISMATCH" });
    // A system that promised digests (binding REFBIZ_REQUEST_V1) and sends none is not trusted.
    const noDigest = rig(baseScript(() => [completed({ requestDigest: null })]));
    await expect(noDigest.port.commit(await prepared(noDigest.port), KEY)).rejects.toMatchObject({ reasonCode: "RECONCILE_PAYLOAD_MISMATCH" });
  });

  it("[ACT-01][AUTH-02] an action whose authority does not match its kind's family is FAILED before any request", async () => {
    const { port, runner } = rig(baseScript(answering()));
    const action = await prepared(port);
    const before = runner.calls.length;
    const forged: CommitSubject = { ...action, kind: "provider.availability.block", change: { ...action.change, authority: "CLIENT_CONFIRMED" } };
    expect(await port.commit(forged, KEY)).toEqual({ outcome: "FAILED", reasonCode: "DOMAIN_AUTHORITY_MISMATCH", permanent: true });
    const otherParty: CommitSubject = { ...action, change: { ...action.change, actingPartyRef: "sub_synthUnitOtherClient1" } };
    expect(await port.commit(otherParty, KEY)).toEqual({ outcome: "FAILED", reasonCode: "DOMAIN_ACTING_PARTY_MISMATCH", permanent: true });
    expect(runner.calls.length).toBe(before);
    expect(domainKindOf({ kind: "appointment.reschedule", change: { authority: "PROVIDER_APPROVED" } })).toBe("provider.appointment.reschedule");
    expect(domainKindOf({ kind: "appointment.cancel", change: {} })).toBe("appointment.cancel");
  });

  it("[ACT-01] the commit-time version re-read detects a changed slot or appointment", async () => {
    let slotVersion = "1";
    const { port } = rig((op) => (op === "scheduling.slot.get" ? [slot({ version: slotVersion })] : op === "scheduling.appointment.get" ? [appointment()] : []));
    const action = await prepared(port);
    expect(await port.currentVersion(action)).toBe(action.target.beforeVersion);
    slotVersion = "2";
    expect(await port.currentVersion(action)).toBe("a3.s2");
    // Business-layer tokens (plain appointment version) keep their own format.
    expect(await port.currentVersion({ ...action, target: { ...action.target, beforeVersion: "3" } })).toBe("3");
  });

  it("[ACT-02][ACT-03] a business-prepared action (no slot version): the request id is looked up BEFORE any body is derived; an earlier delivery is the answer, never a second body", async () => {
    // The first delivery is visible under the key: no slot read, no write, the earlier change is the answer.
    const earlier = rig((op) => {
      if (op === "scheduling.change.lookup") return [completed({ requestDigest: "e".repeat(64) })];
      return new Error(`UNEXPECTED ${op}`);
    });
    const business: CommitSubject = {
      kind: "appointment.reschedule",
      subjectId: client.partyRef,
      target: { system: "scheduling", recordType: "appointment", recordRef: "apt_synthUnitAppointment01", beforeVersion: "3" },
      change: { slotId: "slt_synthUnitSlot00000001", toStartsAt: "2026-10-24T16:00:00.000Z", toTimeZone: "America/Chicago" },
      expiresAt: EXPIRES,
    };
    expect(await earlier.port.commit(business, KEY)).toMatchObject({ outcome: "COMMITTED", providerReference: "rcp_synthUnitReceipt00001" });
    const trace = (r: { runner: { calls: { kind: string; operationId: string }[] } }) => r.runner.calls.map((c) => `${c.kind}:${c.operationId}`);
    // (the UNIT FAKE records a lookup as `reconcile:` with the write it reconciles)
    expect(trace(earlier)).toEqual(["reconcile:scheduling.reschedule.put"]);
    // An earlier change under the key on ANOTHER slot is not this action's: UNKNOWN, nothing sent.
    const otherSlot = rig((op) => (op === "scheduling.change.lookup" ? [completed({ resourceSlotId: "slt_synthUnitOtherSlot0001" })] : new Error(`UNEXPECTED ${op}`)));
    await expect(otherSlot.port.commit(business, KEY)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "RECONCILE_PAYLOAD_MISMATCH" });
    expect(trace(otherSlot)).toEqual(["reconcile:scheduling.reschedule.put"]);
    // Nothing under the key yet: the slot is read right before the write, the body completed with its version.
    const fresh = rig(baseScript(answering()));
    expect((await fresh.port.commit(business, KEY)).outcome).toBe("COMMITTED");
    expect(trace(fresh)).toEqual(["reconcile:scheduling.reschedule.put", "execute:scheduling.slot.get", "execute:scheduling.reschedule.put"]);
    expect(fresh.runner.calls.at(-1)?.input.body).toMatchObject({ slotVersion: "1", expectedVersion: "3", notAfter: NOT_AFTER });
    // The pre-send lookup failing is NOT_STARTED (nothing was sent).
    const down = rig((op) => (op === "scheduling.change.lookup" ? new ConnectorError("CONNECTION_REFUSED", "NOT_STARTED", "scheduling", op) : new Error(`UNEXPECTED ${op}`)));
    await expect(down.port.commit(business, KEY)).rejects.toMatchObject({ outcome: "NOT_STARTED" });
  });

  it("[ACT-03] lookup completes an INCOMPLETE write of THIS request by its request id when the binding declares it; otherwise UNKNOWN", async () => {
    const incomplete = () => [completed({ state: "INCOMPLETE", receiptId: null, requestDigest: RESCHEDULE_DIGEST })];
    const a = rig(baseScript(answering(), incomplete));
    const action = await prepared(a.port);
    expect((await a.port.lookup(action, KEY)).outcome).toBe("COMMITTED");
    expect(a.runner.calls.filter((c) => c.operationId === "scheduling.change.complete")).toHaveLength(1);
    // Reconciliation reads (lookup) and completes; it never sends the write again.
    expect(a.runner.calls.filter((c) => c.kind === "execute" && c.operationId === "scheduling.reschedule.put")).toHaveLength(0);
    const b = rig(baseScript(answering(), incomplete), { incompleteWrite: "ROUTE_TO_HUMAN" });
    expect(await b.port.reconcileDecision(await prepared(b.port), KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "INCOMPLETE_WRITE_ROUTED_TO_HUMAN" });
    expect(b.runner.calls.filter((c) => c.operationId === "scheduling.change.complete")).toHaveLength(0);
    const c = rig(baseScript(answering(), () => [completed({ operation: "scheduling.booking.put" })]));
    expect(await c.port.reconcileDecision(await prepared(c.port), KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "LOOKUP_OPERATION_MISMATCH" });
  });

  it("[ACT-02][ACT-03] reconciliation never claims another request's change under the key: digest or resource mismatch is UNKNOWN (PAYLOAD_MISMATCH), never COMMITTED", async () => {
    const otherDigest = rig(baseScript(answering(), () => [completed({ requestDigest: "0".repeat(64) })]));
    const action = await prepared(otherDigest.port);
    expect(await otherDigest.port.reconcileDecision(action, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "PAYLOAD_MISMATCH" });
    expect(await otherDigest.port.lookup(action, KEY)).toEqual({ outcome: "UNKNOWN" });
    const same = rig(baseScript(answering(), () => [completed({ requestDigest: RESCHEDULE_DIGEST })]));
    expect((await same.port.reconcileDecision(action, KEY)).outcome).toBe("COMMITTED");
    // A business-prepared create (no digest can be recomputed): the found booking must be this slot, subject and start.
    const create: CommitSubject = {
      kind: "appointment.create",
      subjectId: client.partyRef,
      target: { system: "scheduling", recordType: "appointment_slot", recordRef: "slt_synthUnitSlot00000001", beforeVersion: "slot.open" },
      change: { slotId: "slt_synthUnitSlot00000001", toStartsAt: "2026-10-24T16:00:00.000Z" },
      expiresAt: EXPIRES,
    };
    const booked = (o: Record<string, MappedValue>) => () => [completed({ operation: "scheduling.booking.put", resourceId: "apt_synthUnitNewAppt00001", resourceVersion: "1", requestDigest: "1".repeat(64), ...o })];
    const lookupOnly = (fn: () => Record<string, MappedValue>[]): Script => (op) => (op === "scheduling.change.lookup" ? fn() : new Error(`UNEXPECTED ${op}`));
    expect((await rig(lookupOnly(booked({}))).port.reconcileDecision(create, KEY)).outcome).toBe("COMMITTED");
    expect(await rig(lookupOnly(booked({ resourceSlotId: "slt_synthUnitOtherSlot0001" }))).port.reconcileDecision(create, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "PAYLOAD_MISMATCH" });
    expect(await rig(lookupOnly(booked({ resourceSubjectId: "sub_synthUnitOtherClient1" }))).port.reconcileDecision(create, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "PAYLOAD_MISMATCH" });
    expect(await rig(lookupOnly(booked({ resourceStartsAt: "2026-10-25T16:00:00.000Z" }))).port.reconcileDecision(create, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "PAYLOAD_MISMATCH" });
  });

  it("[ACT-03] absence: a 404 is never NOT_FOUND by itself; once the deadline (expiry + write timeout) + skew has passed the system's fence decides: FENCED is NOT_FOUND, a change it holds (a late COMMIT) is that change", async () => {
    const writeTimeout = 5_000;
    const skew = 200;
    const at = (ms: number) => new Date(Date.parse(EXPIRES) + writeTimeout + ms);
    const action = await prepared(rig(baseScript(answering())).port);
    const fences: ExecuteInput[] = [];
    const withFence =
      (answer: () => Record<string, MappedValue>[] | Error): Script =>
      (op, input) => {
        if (op === "scheduling.change.fence") {
          fences.push(input);
          return answer();
        }
        return baseScript(answering())(op, input);
      };
    const fenced = () => [completed({ state: "REJECTED", receiptId: null, failureCode: "FENCED", resourceId: null, resourceVersion: null, resourceStartsAt: null, resourceTimeZone: null, resourceSlotId: null, resourceSubjectId: null, requestDigest: "f".repeat(64) })];
    // Before the deadline + skew: UNKNOWN, and the fence is not even asked.
    expect(await rig(withFence(fenced)).port.lookup(action, KEY)).toEqual({ outcome: "UNKNOWN" });
    expect(await rig(withFence(fenced), {}, at(skew)).port.reconcileDecision(action, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "NOT_VISIBLE_WITHIN_WINDOW" });
    expect(fences).toHaveLength(0);
    // After it: the fence of THIS request id, with the request's operation and its deadline (never a clock rule).
    expect(await rig(withFence(fenced), {}, at(skew + 1)).port.reconcileDecision(action, KEY)).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_FENCED" });
    expect(fences).toHaveLength(1);
    expect(fences[0]?.params).toEqual({ requestId: requestIdFor(KEY) });
    expect(fences[0]?.body).toEqual({ operation: "scheduling.reschedule.put", notAfter: NOT_AFTER });
    // A write whose COMMIT landed after its deadline: the fence answers the change, never NOT_FOUND, even a day later.
    const late = rig(withFence(() => [completed({ requestDigest: RESCHEDULE_DIGEST })]), {}, at(86_400_000));
    expect((await late.port.reconcileDecision(action, KEY)).outcome).toBe("COMMITTED");
    expect((await late.port.lookup(action, KEY)).outcome).toBe("COMMITTED");
    // The system refusing an early fence (its clock): UNKNOWN; a fence that cannot answer: never NOT_FOUND.
    const early = rig(withFence(() => new ConnectorError("CONNECTOR_CONFLICT", "FAILED", "scheduling", "scheduling.change.fence", { httpStatus: 409 })), {}, at(skew + 1));
    expect(await early.port.reconcileDecision(action, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "FENCE_NOT_DUE" });
    const down = rig(withFence(() => new ConnectorError("TIMEOUT_AFTER_SEND", "UNKNOWN", "scheduling", "scheduling.change.fence")), {}, at(skew + 1));
    await expect(down.port.reconcileDecision(action, KEY)).rejects.toBeInstanceOf(ConnectorError);
    // A binding without a fence: an absence is never definitive, however late, and nothing is fenced.
    const noFence = rig(withFence(fenced), { fence: false }, at(86_400_000));
    const asked = fences.length;
    expect(await noFence.port.reconcileDecision(action, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "ABSENCE_NOT_PROVABLE" });
    expect(fences).toHaveLength(asked);
    // A system without a dispatch deadline (and so without a fence): never definitive, and its writes carry no deadline.
    const none = rig(baseScript(answering()), { windowMs: 1_000, dispatchDeadline: "NONE" }, at(86_400_000));
    expect(await none.port.reconcileDecision(action, KEY)).toEqual({ outcome: "UNKNOWN", reasonCode: "ABSENCE_NOT_PROVABLE" });
    expect((await none.port.commit(action, KEY)).outcome).toBe("COMMITTED");
    const sent = none.runner.calls.find((c) => c.kind === "execute" && c.operationId === "scheduling.reschedule.put")?.input.body;
    expect(sent).toMatchObject({ appointmentId: "apt_synthUnitAppointment01" });
    expect(sent).not.toHaveProperty("notAfter");
    // A REJECTED request (e.g. DEADLINE_EXCEEDED) is a definite no-effect at once.
    const rejected = rig(baseScript(answering(), () => [completed({ state: "REJECTED", receiptId: null, failureCode: "DEADLINE_EXCEEDED", requestDigest: RESCHEDULE_DIGEST })]));
    expect(await rejected.port.reconcileDecision(action, KEY)).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_REJECTED" });
    // A FENCED id found by the plain lookup is NOT_FOUND whatever digest it carries (nothing can apply under it).
    const seen = rig(baseScript(answering(), fenced));
    expect(await seen.port.reconcileDecision(action, KEY)).toEqual({ outcome: "NOT_FOUND", reasonCode: "REQUEST_FENCED" });
  });

  it("[ACT-02][FO-03-09] cancel: the exact body from the confirmed action (expected version, reason, authority, acting party, deadline), client and provider", async () => {
    const script: Script = (op, input) => {
      if (op === "scheduling.appointment.get") return [appointment()];
      if (op === "scheduling.cancellation.put")
        return [completed({ requestId: String(input.params?.requestId), operation: op, resourceVersion: "4", resourceStartsAt: "2026-10-22T15:00:00.000Z", resourceSlotId: null, requestDigest: digestOf(op, input) })];
      return new Error(`UNSCRIPTED ${op}`);
    };
    const { port, runner } = rig(script);
    const cp = await port.prepare(client, { kind: "appointment.cancel", appointmentId: "apt_synthUnitAppointment01", reasonCode: "SCHEDULING_CONFLICT" });
    expect(cp.ledgerKind).toBe("appointment.cancel");
    expect(cp.input.target.beforeVersion).toBe("a3");
    const action: CommitSubject = { kind: "appointment.cancel", subjectId: client.partyRef, target: cp.input.target, change: cp.input.change, expiresAt: EXPIRES };
    expect(await port.commit(action, KEY)).toEqual({
      outcome: "COMMITTED",
      providerReference: "rcp_synthUnitReceipt00001",
      afterVersion: "4",
      evidence: { appointmentId: "apt_synthUnitAppointment01", startsAt: "2026-10-22T15:00:00.000Z", timeZone: "America/Chicago", status: "CANCELLED" },
    });
    const sent = runner.calls.filter((c) => c.operationId === "scheduling.cancellation.put");
    expect(sent[0]?.input.params).toEqual({ requestId: requestIdFor(KEY) });
    expect(sent[0]?.input.body).toEqual({ appointmentId: "apt_synthUnitAppointment01", expectedVersion: "3", reasonCode: "SCHEDULING_CONFLICT", authority: "CLIENT_CONFIRMED", actingPartyId: client.partyRef, notAfter: NOT_AFTER });
    // Provider-approved cancellation on the provider's own schedule: its own authority and acting party.
    const pp = await port.prepare(provider, { kind: "provider.appointment.cancel", appointmentId: "apt_synthUnitAppointment01", reasonCode: "PROVIDER_UNAVAILABLE" });
    const key2 = `vsp-${"cd".repeat(24)}`;
    expect((await port.commit({ kind: "appointment.cancel", subjectId: provider.partyRef, target: pp.input.target, change: pp.input.change, expiresAt: EXPIRES }, key2)).outcome).toBe("COMMITTED");
    expect(runner.calls.filter((c) => c.operationId === "scheduling.cancellation.put")[1]?.input.body).toEqual({
      appointmentId: "apt_synthUnitAppointment01",
      expectedVersion: "3",
      reasonCode: "PROVIDER_UNAVAILABLE",
      authority: "PROVIDER_APPROVED",
      actingPartyId: provider.partyRef,
      notAfter: NOT_AFTER,
    });
    // The commit-time version re-read of a cancel is the appointment's.
    expect(await port.currentVersion(action)).toBe("a3");
  });

  it("[FO-11-02] effect verification reads the record and the system's receipt back: VERIFIED, MISMATCH on another version or a foreign / unknown receipt, NOT_FOUND_WITHIN_WINDOW", async () => {
    let answer: Record<string, MappedValue>[] | Error = [appointment({ version: "4", startsAt: "2026-10-24T16:00:00.000Z" })];
    let receipt: Record<string, MappedValue>[] | Error = [
      {
        receiptId: "rcp_synthUnitReceipt00001",
        requestId: requestIdFor(KEY),
        operation: "scheduling.reschedule.put",
        resourceType: "appointment",
        resourceId: "apt_synthUnitAppointment01",
        resourceVersion: "4",
        stateDigest: "a".repeat(64),
        requestDigest: RESCHEDULE_DIGEST,
        committedAt: NOW.toISOString(),
      },
    ];
    const { port, runner } = rig((op) => (op === "scheduling.appointment.get" ? answer : op === "scheduling.slot.get" ? [slot()] : op === "scheduling.receipt.get" ? receipt : []));
    const action = await prepared(port);
    const input = {
      tenantId: "tnt_synthUnitTenant000001",
      actionId: "act_synthUnitAction000001",
      causationId: "act_synthUnitAction000001",
      commitReceiptId: null,
      action,
      receipt: { providerReference: "rcp_synthUnitReceipt00001", afterVersion: "4", evidence: { appointmentId: "apt_synthUnitAppointment01" }, committedAt: NOW.toISOString() },
    };
    expect((await port.verifyEffect(input)).result).toBe("VERIFIED");
    expect(runner.calls.find((c) => c.operationId === "scheduling.receipt.get")?.input.params).toEqual({ receiptId: "rcp_synthUnitReceipt00001" });
    answer = [appointment({ version: "5" })];
    expect((await port.verifyEffect(input)).result).toBe("MISMATCH");
    answer = [appointment({ version: "4", startsAt: "2026-10-24T16:00:00.000Z" })];
    // The system's receipt names another version of the record: the commit's receipt is not the effect.
    receipt = [{ ...(receipt as Record<string, MappedValue>[])[0], resourceVersion: "9" } as Record<string, MappedValue>];
    expect((await port.verifyEffect(input)).result).toBe("MISMATCH");
    // A receipt the system does not know never verifies.
    receipt = notFound();
    expect((await port.verifyEffect(input)).result).toBe("MISMATCH");
    // Without a receipt reference, the record read-back alone.
    expect((await port.verifyEffect({ ...input, receipt: { ...input.receipt, providerReference: null } })).result).toBe("VERIFIED");
    answer = notFound();
    const v = await port.verifyEffect(input);
    expect(v.result).toBe("NOT_FOUND_WITHIN_WINDOW");
    expect(v.verifier.independentOfModel).toBe(true);
  });

  it("[FO-03-09] billing: a review is prepared on the open invoice's version and sent with the invoice version, the deadline and the acting party only", async () => {
    const { conn, runner } = scriptedConnector(
      "billing",
      (op, input) => {
        if (op === "billing.invoice.get") return [{ invoiceId: "inv_synthUnitInvoice00001", subjectId: client.partyRef, issuedOn: "2026-10-01", dueOn: "2026-10-30", status: "OPEN", balanceMinor: 12_500, currency: "USD", version: "2" }];
        if (op === "billing.invoice_lines.list") return [];
        if (op === "billing.review_request.put")
          return [
            completed({
              operation: "billing.review_request.put",
              resourceType: "invoice",
              resourceId: "inv_synthUnitInvoice00001",
              resourceVersion: "3",
              resourceStartsAt: null,
              resourceTimeZone: null,
              resourceSlotId: null,
              resourceSubjectId: client.partyRef,
              requestDigest: digestOf("billing.review_request.put", input),
            }),
          ];
        return new Error(`UNSCRIPTED ${op}`);
      },
      {},
      { now: () => NOW },
    );
    const port = new DomainCommitPort({ scheduling: null, billing: new HttpBilling(conn), clock: { now: () => NOW } });
    const p = await port.prepare(client, { kind: "billing.review.submit", invoiceId: "inv_synthUnitInvoice00001", reasonCode: "CHARGE_QUESTIONED" });
    expect(p.input.target.beforeVersion).toBe("i2");
    const r = await port.commit({ kind: "billing.review.submit", subjectId: client.partyRef, target: p.input.target, change: p.input.change, expiresAt: EXPIRES }, KEY);
    expect(r).toEqual({ outcome: "COMMITTED", providerReference: "rcp_synthUnitReceipt00001", afterVersion: "3", evidence: { invoiceId: "inv_synthUnitInvoice00001", status: "IN_REVIEW" } });
    expect(runner.calls.find((c) => c.operationId === "billing.review_request.put")?.input.body).toEqual({
      invoiceId: "inv_synthUnitInvoice00001",
      expectedVersion: "2",
      reasonCode: "CHARGE_QUESTIONED",
      authority: "CLIENT_CONFIRMED",
      actingPartyId: client.partyRef,
      notAfter: NOT_AFTER,
    });
    // Another client's invoice is not available to prepare.
    await expect(port.prepare({ role: "client", partyRef: "sub_synthUnitOtherClient1" }, { kind: "billing.review.submit", invoiceId: "inv_synthUnitInvoice00001", reasonCode: "CHARGE_QUESTIONED" })).rejects.toMatchObject({ reasonCode: "TARGET_NOT_AVAILABLE" });
  });

  it("[AUTH-02][FO-01-26] the domain command path refuses before any I/O a preparation of another party, a modified one, the wrong role family or authority", async () => {
    const { port, runner } = rig((op, input) => {
      if (op === "scheduling.slot.get") return [slot()];
      if (op === "scheduling.availability_block.put")
        return [completed({ operation: op, resourceType: "slot", resourceId: "slt_synthUnitSlot00000001", resourceVersion: "2", resourceStartsAt: null, resourceTimeZone: null, resourceSubjectId: null, requestDigest: digestOf(op, input) })];
      return new Error(`UNSCRIPTED ${op}`);
    });
    const prep = await port.prepare(provider, { kind: "provider.availability.block", slotId: "slt_synthUnitSlot00000001", reasonCode: "PROVIDER_UNAVAILABLE" });
    expect(prep.preparedAt).toBe(NOW.toISOString());
    expect(prep.expiresAt).toBe(EXPIRES);
    const before = runner.calls.length;
    await expect(port.commitCommand({ role: "provider", partyRef: "prv_synthUnitOtherProvide1" }, prep, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_ACTING_PARTY_MISMATCH" });
    const modified = { ...prep, input: { ...prep.input, target: { ...prep.input.target, recordRef: "slt_synthUnitOtherSlot0001" } } };
    await expect(port.commitCommand(provider, modified, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_PREPARATION_MODIFIED" });
    // The times are digest-bound: a later expiry without a new digest is a modified preparation.
    await expect(port.commitCommand(provider, { ...prep, expiresAt: new Date(NOW.getTime() + 82_800_000).toISOString() }, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_PREPARATION_MODIFIED" });
    // A client session carrying the provider's preparation (same party reference, other role) is refused by family.
    await expect(port.commitCommand({ role: "client", partyRef: provider.partyRef }, prep, KEY)).rejects.toMatchObject({ reasonCode: "CLIENT_CANNOT_APPROVE_PROVIDER_ACTION" });
    expect(runner.calls.length).toBe(before);
    expect((await port.commitCommand(provider, prep, KEY)).outcome).toBe("COMMITTED");
    // The write's deadline comes from the preparation's own expiry (+ the write timeout), never from a caller.
    expect(runner.calls.find((c) => c.operationId === "scheduling.availability_block.put")?.input.body).toMatchObject({ notAfter: NOT_AFTER, authority: "PROVIDER_APPROVED", actingPartyId: provider.partyRef });
  });

  it("[ACT-01][AUTH-02][FO-01-26] the domain command path never commits a kind the ledger knows, nor an expired or self-extended preparation (no I/O)", async () => {
    const script: Script = (op, input) => {
      if (op === "scheduling.appointment.get") return [appointment()];
      if (op === "scheduling.slot.get") return [slot()];
      if (op === "scheduling.cancellation.put" || op === "scheduling.availability_block.put") return [completed({ operation: op, requestDigest: digestOf(op, input) })];
      return new Error(`UNSCRIPTED ${op}`);
    };
    const { port, runner } = rig(script);
    // A client kind with a ledger kind (and a provider kind the ledger knows): only through the ledger's confirmation.
    const cancel = await port.prepare(client, { kind: "appointment.cancel", appointmentId: "apt_synthUnitAppointment01", reasonCode: "CLIENT_REQUEST" });
    const reschedule = await port.prepare(provider, { kind: "provider.appointment.reschedule", appointmentId: "apt_synthUnitAppointment01", slotId: "slt_synthUnitSlot00000001" });
    const before = runner.calls.length;
    await expect(port.commitCommand(client, cancel, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_KIND_REQUIRES_LEDGER" });
    await expect(port.commitCommand(provider, reschedule, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_KIND_REQUIRES_LEDGER" });
    // Even a preparation that claims no ledger kind (digest recomputed by a forger) of a ledger-known domain kind.
    const unledgered = { ...cancel, ledgerKind: null };
    await expect(port.commitCommand(client, { ...unledgered, digest: preparationDigest(unledgered) }, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_KIND_REQUIRES_LEDGER" });
    expect(runner.calls.length).toBe(before);
    // An expired preparation: refused (no I/O).
    const block = await port.prepare(provider, { kind: "provider.availability.block", slotId: "slt_synthUnitSlot00000001", reasonCode: "PROVIDER_UNAVAILABLE" });
    const later = rig(script, {}, new Date(Date.parse(block.expiresAt) + 1));
    await expect(later.port.commitCommand(provider, block, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_PREPARATION_EXPIRED" });
    expect(later.runner.calls).toHaveLength(0);
    // A forged far-future window, digest recomputed: the expiry must be the prepare TTL after a non-future preparedAt.
    const far = { ...block, expiresAt: new Date(NOW.getTime() + 82_800_000).toISOString() };
    await expect(port.commitCommand(provider, { ...far, digest: preparationDigest(far) }, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_PREPARATION_EXPIRY_INVALID" });
    const shifted = { ...block, preparedAt: new Date(NOW.getTime() + 82_800_000).toISOString(), expiresAt: new Date(NOW.getTime() + 82_800_000 + 300_000).toISOString() };
    await expect(port.commitCommand(provider, { ...shifted, digest: preparationDigest(shifted) }, KEY)).rejects.toMatchObject({ reasonCode: "DOMAIN_PREPARATION_EXPIRY_INVALID" });
    expect(runner.calls.length).toBe(before + 1);
  });
});
