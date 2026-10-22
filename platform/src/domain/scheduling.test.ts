/**
 * Unit (Docker-free) of the business-port writes of HttpScheduling and HttpBilling over a labelled UNIT FAKE runner
 * (unit-fake.fixture.ts) (AUTH-02, AUTH-05, ACT-02, ACT-03): the acting party comes from the confirmed action, never
 * from the target record; a body that needs current state is preceded by the lookup of its request id; a 422 is in
 * doubt. The Layer-2 suite (platform/test/integration/domain) runs the same adapters over the reference business API.
 */
import { describe, expect, it } from "vitest";
import type { MappedValue } from "../connectors/dsl/values.js";
import { ConnectorError } from "../connectors/runtime/errors.js";
import { ConflictError, DependencyError } from "../shared/errors.js";
import { HttpBilling } from "./billing.js";
import { requestIdFor } from "./changes.js";
import { HttpScheduling } from "./scheduling.js";
import { scriptedConnector } from "./unit-fake.fixture.js";
import type { Script } from "./unit-fake.fixture.js";

const KEY = `vsp-${"cd".repeat(24)}`;
const OWNER = "sub_synthUnitOwner000001";
const OTHER = "sub_synthUnitOtherParty01";

const appointment: Record<string, MappedValue> = {
  appointmentId: "apt_synthUnitAppointment01",
  subjectId: OWNER,
  providerRef: "prv_synthUnitProvider0001",
  providerDisplayName: "Clinician A",
  slotId: "slt_synthUnitSlot00000001",
  startsAt: "2026-10-24T16:00:00.000Z",
  timeZone: "America/Chicago",
  modality: "video",
  status: "SCHEDULED",
  version: "4",
};
const slot: Record<string, MappedValue> = {
  slotId: "slt_synthUnitSlot00000001",
  providerRef: "prv_synthUnitProvider0001",
  providerDisplayName: "Clinician A",
  startsAt: "2026-10-24T16:00:00.000Z",
  timeZone: "America/Chicago",
  modality: "video",
  state: "OPEN",
  version: "1",
};
const change = (o: Record<string, MappedValue>): Record<string, MappedValue> => ({
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
  resourceSubjectId: OWNER,
  requestDigest: "a".repeat(64),
  failureCode: null,
  ...o,
});

const sched = (script: Script) => {
  const { conn, runner } = scriptedConnector("scheduling", script);
  return { s: new HttpScheduling(conn), runner };
};
const trace = (runner: { calls: { kind: string; operationId: string }[] }) => runner.calls.map((c) => `${c.kind}:${c.operationId}`);

describe("business-port writes (unit, UNIT FAKE runner)", () => {
  it("[AUTH-02][AUTH-05] reschedule without the confirmed action's acting party is refused before any request: the record's own client is never assumed", async () => {
    const { s, runner } = sched(() => new Error("NO_CALL_EXPECTED"));
    await expect(s.reschedule({ appointmentId: "apt_synthUnitAppointment01", beforeVersion: "3", slotId: "slt_synthUnitSlot00000001", idempotencyKey: KEY })).rejects.toMatchObject({ reasonCode: "ACTING_PARTY_REQUIRED" });
    await expect(s.reschedule({ appointmentId: "apt_synthUnitAppointment01", beforeVersion: "3", slotId: "slt_synthUnitSlot00000001", idempotencyKey: KEY })).rejects.toBeInstanceOf(ConflictError);
    expect(runner.calls).toHaveLength(0);
  });

  it("[AUTH-02][AUTH-05] with an acting party, that party (never the appointment's subject) is sent, so the system of record re-checks the real party", async () => {
    const { s, runner } = sched((op, input) => {
      if (op === "scheduling.change.lookup") return [];
      if (op === "scheduling.slot.get") return [slot];
      if (op === "scheduling.appointment.get") return [appointment];
      if (op === "scheduling.reschedule.put") return input.body?.actingPartyId === OWNER ? [change({})] : new ConnectorError("CONNECTOR_FORBIDDEN", "FAILED", "scheduling", op, { httpStatus: 403 });
      return new Error(`UNSCRIPTED ${op}`);
    });
    await expect(s.reschedule({ appointmentId: "apt_synthUnitAppointment01", beforeVersion: "3", slotId: "slt_synthUnitSlot00000001", idempotencyKey: KEY, actingPartyId: OTHER })).rejects.toMatchObject({ reasonCode: "AUTHORITY_REFUSED" });
    const put = runner.calls.find((c) => c.kind === "execute" && c.operationId === "scheduling.reschedule.put");
    expect(put?.input.body).toMatchObject({ authority: "CLIENT_CONFIRMED", actingPartyId: OTHER });
    expect((await s.reschedule({ appointmentId: "apt_synthUnitAppointment01", beforeVersion: "3", slotId: "slt_synthUnitSlot00000001", idempotencyKey: KEY, actingPartyId: OWNER })).reference).toBe("rcp_synthUnitReceipt00001");
  });

  it("[ACT-02] create looks its request id up before deriving the slot version: a redelivery returns the earlier booking, no second write", async () => {
    let booked = false;
    const { s, runner } = sched((op) => {
      if (op === "scheduling.change.lookup") return booked ? [change({ operation: "scheduling.booking.put", resourceId: "apt_synthUnitNewAppt00001", resourceVersion: "1" })] : [];
      if (op === "scheduling.slot.get") return [{ ...slot, state: booked ? "BOOKED" : "OPEN", version: booked ? "2" : "1" }];
      if (op === "scheduling.booking.put") {
        booked = true;
        return [change({ operation: "scheduling.booking.put", resourceId: "apt_synthUnitNewAppt00001", resourceVersion: "1" })];
      }
      if (op === "scheduling.appointment.get") return [{ ...appointment, appointmentId: "apt_synthUnitNewAppt00001", version: "1" }];
      return new Error(`UNSCRIPTED ${op}`);
    });
    const input = { subjectId: OWNER, slotId: "slt_synthUnitSlot00000001", idempotencyKey: KEY };
    const first = await s.create(input);
    const again = await s.create(input);
    expect(again.reference).toBe(first.reference);
    expect(trace(runner).filter((t) => t === "execute:scheduling.booking.put")).toHaveLength(1);
    expect(runner.calls.find((c) => c.kind === "execute" && c.operationId === "scheduling.booking.put")?.input.body).toMatchObject({ subjectId: OWNER, actingPartyId: OWNER, authority: "CLIENT_CONFIRMED" });
    // An earlier change under the key for ANOTHER slot or subject is never returned as this booking.
    const foreign = sched((op) => (op === "scheduling.change.lookup" ? [change({ operation: "scheduling.booking.put", resourceSubjectId: OTHER })] : new Error(`UNEXPECTED ${op}`)));
    await expect(foreign.s.create(input)).rejects.toMatchObject({ outcome: "UNKNOWN", reasonCode: "RECONCILE_PAYLOAD_MISMATCH" });
  });

  it("[ACT-03] a 422 (request id used by another request) is UNKNOWN for the business port, never a definite refusal", async () => {
    const { s } = sched((op) => {
      if (op === "scheduling.change.lookup") return [];
      if (op === "scheduling.slot.get") return [slot];
      if (op === "scheduling.booking.put") return new ConnectorError("CONNECTOR_REQUEST_REJECTED", "FAILED", "scheduling", op, { httpStatus: 422 });
      return new Error(`UNSCRIPTED ${op}`);
    });
    const e = await s.create({ subjectId: OWNER, slotId: "slt_synthUnitSlot00000001", idempotencyKey: KEY }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(DependencyError);
    expect(e).toMatchObject({ outcome: "UNKNOWN", reasonCode: "REQUEST_ID_IN_USE" });
  });

  it("[AUTH-02][AUTH-05] billing review: refused without the acting party; otherwise the confirmed party is sent and the body is identical on redelivery", async () => {
    const { conn, runner } = scriptedConnector("billing", (op) => {
      if (op === "billing.review_request.put")
        return [change({ operation: op, resourceType: "invoice", resourceId: "inv_synthUnitInvoice00001", resourceVersion: "3", resourceStartsAt: null, resourceTimeZone: null, resourceSlotId: null })];
      if (op === "billing.invoice.get") return [{ invoiceId: "inv_synthUnitInvoice00001", subjectId: OWNER, issuedOn: "2026-10-01", dueOn: "2026-10-30", status: "IN_REVIEW", balanceMinor: 100, currency: "USD", version: "3" }];
      if (op === "billing.invoice_lines.list") return [];
      return new Error(`UNSCRIPTED ${op}`);
    });
    const b = new HttpBilling(conn);
    await expect(b.markInReview({ invoiceId: "inv_synthUnitInvoice00001", beforeVersion: "2", idempotencyKey: KEY })).rejects.toMatchObject({ reasonCode: "ACTING_PARTY_REQUIRED" });
    expect(runner.calls).toHaveLength(0);
    await b.markInReview({ invoiceId: "inv_synthUnitInvoice00001", beforeVersion: "2", idempotencyKey: KEY, actingPartyId: OTHER });
    await b.markInReview({ invoiceId: "inv_synthUnitInvoice00001", beforeVersion: "2", idempotencyKey: KEY, actingPartyId: OTHER });
    const puts = runner.calls.filter((c) => c.operationId === "billing.review_request.put");
    expect(puts).toHaveLength(2);
    expect(puts[0]?.input.body).toEqual({ invoiceId: "inv_synthUnitInvoice00001", expectedVersion: "2", reasonCode: "CHARGE_QUESTIONED", authority: "CLIENT_CONFIRMED", actingPartyId: OTHER });
    expect(puts[1]?.input.body).toEqual(puts[0]?.input.body);
  });
});
