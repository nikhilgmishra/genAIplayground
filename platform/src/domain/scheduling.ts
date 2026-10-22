/**
 * Scheduling over the canonical scheduling contract (WP-23; FO-06-72, FO-11-02, FO-01-14).
 *
 * `HttpScheduling` reads and changes a tenant's scheduling system through its admitted connector profile and
 * domain binding. It serves two consumers:
 *   - the canonical, party-scoped reads (`readAppointments`, `readSlotOptions`, ...) that return an honest
 *     DomainRead (AVAILABLE / NOT_FOUND / UNAVAILABLE with the next step), scoped to the acting party (AUTH-05);
 *   - the existing SchedulingSystem port of platform/src/adapters/ports.ts (structurally: it is not imported here,
 *     the module register keeps domain independent of adapters), so the composition root can replace the LOCAL
 *     FIXTURE scheduling system with it. Its write methods implement the business layer's SchedulingCommitPort
 *     contract: one keyed write per provider idempotency key, ConflictError STATE_CHANGED / SLOT_UNAVAILABLE for a
 *     changed record, DependencyError NOT_STARTED / UNKNOWN for transport outcomes, and lookup by key for
 *     reconciliation. The acting party is NEVER taken from the target record (AUTH-02, AUTH-05): `create` acts for
 *     the confirmed action's subject (the business port passes `action.subjectId`), `reschedule` acts only for the
 *     `actingPartyId` its caller passes from the confirmed action and refuses before any request without it
 *     (ACTING_PARTY_REQUIRED), so the system of record re-checks the real party. A write whose body needs current
 *     state (the slot version) looks its request id up first: an earlier delivery is the answer, never a second
 *     body under the same id (ACT-02). Without the prepared action the port's lookup cannot prove an absence (no
 *     deadline is sent, so the system may still apply a received write): `findByIdempotencyKey` never answers
 *     "absent" for a key it cannot see, it throws UNKNOWN so the ledger keeps the action in doubt, and it cannot
 *     bind the change it finds to a payload. The domain commit port (commit.ts) is the full path.
 */
import type { MappedRecord } from "../connectors/dsl/mapping.js";
import { ConnectorError } from "../connectors/runtime/errors.js";
import { ConflictError, DependencyError, ValidationError } from "../shared/errors.js";
import type { ActingParty } from "./authority.js";
import { inScope } from "./authority.js";
import { ChangeRequests, requestIdFor } from "./changes.js";
import type { ChangeState } from "./changes.js";
import type { CanonicalAppointment, DomainRead, SlotOption, SourceRef } from "./contracts.js";
import { CanonicalAppointment as AppointmentSchema, SlotOption as SlotSchema } from "./contracts.js";
import type { DomainConnector } from "./runner.js";
import { optStr, orNull, readSafely, single, str } from "./runner.js";

/** Same shapes as platform/src/adapters/ports.ts Appointment / Slot (structural, checked by a type test). */
export interface PortAppointment {
  appointmentId: string;
  subjectId: string;
  providerDisplayName: string;
  startsAt: string;
  timeZone: string;
  modality: "video" | "in_person" | "phone";
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  version: string;
}
export interface PortSlot {
  slotId: string;
  startsAt: string;
  timeZone: string;
  modality: PortAppointment["modality"];
  providerDisplayName: string;
}

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 62;

export function appointmentOf(r: MappedRecord, source: SourceRef): CanonicalAppointment {
  const parsed = AppointmentSchema.safeParse({
    appointmentId: str(r, "appointmentId"),
    subjectId: str(r, "subjectId"),
    providerRef: str(r, "providerRef"),
    providerDisplayName: str(r, "providerDisplayName"),
    slotId: optStr(r, "slotId"),
    startsAt: str(r, "startsAt"),
    timeZone: str(r, "timeZone"),
    modality: str(r, "modality"),
    status: str(r, "status"),
    version: str(r, "version"),
    source,
  });
  if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return parsed.data;
}

export function slotOf(r: MappedRecord, source: SourceRef): SlotOption {
  const parsed = SlotSchema.safeParse({
    slotId: str(r, "slotId"),
    providerRef: str(r, "providerRef"),
    providerDisplayName: str(r, "providerDisplayName"),
    startsAt: str(r, "startsAt"),
    timeZone: str(r, "timeZone"),
    modality: str(r, "modality"),
    state: str(r, "state"),
    version: str(r, "version"),
    source,
  });
  if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
  return parsed.data;
}

export const toPortAppointment = (a: CanonicalAppointment): PortAppointment => ({
  appointmentId: a.appointmentId,
  subjectId: a.subjectId,
  providerDisplayName: a.providerDisplayName,
  startsAt: a.startsAt,
  timeZone: a.timeZone,
  modality: a.modality,
  status: a.status,
  version: a.version,
});

const toPortSlot = (s: SlotOption): PortSlot => ({ slotId: s.slotId, startsAt: s.startsAt, timeZone: s.timeZone, modality: s.modality, providerDisplayName: s.providerDisplayName });

/** Maps a refused keyed write onto the business ports' error contract (a definite refusal is not a dependency failure). */
export function refusalOf(e: unknown, kind: "slot" | "record"): never {
  // 422 on a keyed write: the request id already carries another request, which may have been applied: in doubt.
  if (e instanceof ConnectorError && e.reasonCode === "CONNECTOR_REQUEST_REJECTED" && e.httpStatus === 422) throw new DependencyError("REQUEST_ID_IN_USE", "UNKNOWN", false);
  if (e instanceof ConnectorError && e.outcome === "FAILED") {
    if (e.reasonCode === "CONNECTOR_CONFLICT") throw new ConflictError(kind === "slot" ? "SLOT_UNAVAILABLE" : "STATE_CHANGED");
    if (e.reasonCode === "CONNECTOR_FORBIDDEN") throw new ConflictError("AUTHORITY_REFUSED");
    if (e.reasonCode === "CONNECTOR_NOT_FOUND") throw new ValidationError("TARGET_NOT_FOUND");
    if (e.reasonCode === "CONNECTOR_REQUEST_REJECTED") throw new ValidationError("PROVIDER_REJECTED");
  }
  throw e;
}

/**
 * A read made before a write was sent: if it fails, nothing was written, so the commit protocol may retry with the
 * same key (NOT_STARTED), never "unknown".
 */
export async function beforeWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError) throw new DependencyError(e.reasonCode, "NOT_STARTED", true);
    throw e;
  }
}

export class HttpScheduling {
  readonly kind = "live" as const;
  readonly integrationId = "scheduling";
  readonly changes: ChangeRequests;

  constructor(readonly conn: DomainConnector) {
    if (conn.binding.binding.contract !== "scheduling.v1") throw new ValidationError("DOMAIN_BINDING_CONTRACT_MISMATCH");
    this.changes = new ChangeRequests(conn);
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return this.conn.runner.health();
  }

  // ---------------------------------------------------------------- canonical reads (unscoped: trusted callers only)

  async appointment(appointmentId: string): Promise<CanonicalAppointment | null> {
    return orNull(async () => {
      const result = await this.conn.run("getAppointment", { params: { appointmentId } });
      return appointmentOf(single(result), this.conn.source(result));
    });
  }

  async appointmentsOf(subjectId: string): Promise<CanonicalAppointment[]> {
    const { records, source } = await this.conn.all("listAppointments", { params: { subjectId } });
    return records.map((r) => appointmentOf(r, source));
  }

  async slot(slotId: string): Promise<SlotOption | null> {
    return orNull(async () => {
      const result = await this.conn.run("getSlot", { params: { slotId } });
      return slotOf(single(result), this.conn.source(result));
    });
  }

  /** Open slots a client may book in the next `days` days; with an appointment, only its provider's. */
  async slotOptions(subjectId: string, opts: { appointmentId: string | null; days: number }): Promise<SlotOption[]> {
    const params: Record<string, string | number> = { subjectId, days: opts.days };
    if (opts.appointmentId !== null) params.appointmentId = opts.appointmentId;
    const result = await this.conn.run("listSlotOptions", { params });
    const source = this.conn.source(result);
    return result.records.map((r) => slotOf(r, source));
  }

  async providerSlots(providerRef: string, days: number): Promise<SlotOption[]> {
    const result = await this.conn.run("listProviderSlots", { params: { providerId: providerRef, days } });
    const source = this.conn.source(result);
    return result.records.map((r) => slotOf(r, source));
  }

  // ---------------------------------------------------------------- party-scoped reads (AUTH-05)

  readAppointments(party: ActingParty): Promise<DomainRead<CanonicalAppointment[]>> {
    // A provider's own appointments are not part of this contract's client listing: providers read their slots.
    if (party.role !== "client") return Promise.resolve({ status: "UNAVAILABLE", reasonCode: "DOMAIN_ROLE_NOT_SUPPORTED", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    return readSafely(async () => (await this.appointmentsOf(party.partyRef)).filter((a) => inScope(party, a)));
  }

  /** One appointment, only when it belongs to the party (another party's record reads as absent). */
  readAppointment(party: ActingParty, appointmentId: string): Promise<DomainRead<CanonicalAppointment>> {
    return readSafely(async () => {
      const a = await this.appointment(appointmentId);
      return a !== null && inScope(party, a) ? a : null;
    });
  }

  readSlotOptions(party: ActingParty, opts: { appointmentId: string | null; days: number }): Promise<DomainRead<SlotOption[]>> {
    if (party.role !== "client") return this.readProviderSlots(party, opts.days);
    return readSafely(() => this.slotOptions(party.partyRef, opts));
  }

  readProviderSlots(party: ActingParty, days: number): Promise<DomainRead<SlotOption[]>> {
    if (party.role !== "provider") return Promise.resolve({ status: "UNAVAILABLE", reasonCode: "DOMAIN_ROLE_NOT_SUPPORTED", outcome: "NOT_STARTED", nextStep: "OFFER_HUMAN_OR_CALLBACK" });
    return readSafely(() => this.providerSlots(party.partyRef, days));
  }

  // ---------------------------------------------------------------- SchedulingSystem port (platform/src/adapters/ports.ts)

  async listAppointments(subjectId: string): Promise<PortAppointment[]> {
    return (await this.appointmentsOf(subjectId)).filter((a) => a.subjectId === subjectId).map(toPortAppointment);
  }

  async getAppointment(appointmentId: string): Promise<PortAppointment | null> {
    const a = await this.appointment(appointmentId);
    return a ? toPortAppointment(a) : null;
  }

  async listSlots(input: { subjectId: string; appointmentId: string | null; fromDate: string; toDate: string }): Promise<PortSlot[]> {
    const fromMs = Date.parse(`${input.fromDate}T00:00:00.000Z`);
    const toMs = Date.parse(`${input.toDate}T00:00:00.000Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || (toMs - fromMs) / DAY_MS + 1 > MAX_RANGE_DAYS) throw new ValidationError("SLOT_RANGE_INVALID");
    const nowMs = this.conn.clock.now().getTime();
    const endMs = toMs + DAY_MS;
    if (endMs <= nowMs) return [];
    const days = Math.min(MAX_RANGE_DAYS, Math.max(1, Math.ceil((endMs - nowMs) / DAY_MS)));
    let slots: SlotOption[];
    try {
      slots = await this.slotOptions(input.subjectId, { appointmentId: input.appointmentId, days });
    } catch (e) {
      if (!(e instanceof ConnectorError && e.reasonCode === "CONNECTOR_NOT_FOUND")) throw e;
      // Same answer for "absent" and "another subject's" (no existence disclosure).
      if (input.appointmentId !== null) throw new ValidationError("APPOINTMENT_NOT_FOUND");
      // Not a client of this system: a provider's own subject lists that provider's own open slots.
      try {
        slots = await this.providerSlots(input.subjectId, days);
      } catch (e2) {
        if (e2 instanceof ConnectorError && e2.reasonCode === "CONNECTOR_NOT_FOUND") throw new ValidationError("SUBJECT_NOT_FOUND");
        throw e2;
      }
    }
    return slots
      .filter((s) => {
        const day = s.startsAt.slice(0, 10);
        return s.state === "OPEN" && day >= input.fromDate && day <= input.toDate;
      })
      .map(toPortSlot);
  }

  /**
   * Business-port reschedule, CLIENT_CONFIRMED by `actingPartyId`, which the caller takes from the confirmed action
   * (its subject); refused before any request without it (the target record's own client is never assumed).
   */
  async reschedule(input: { appointmentId: string; beforeVersion: string; slotId: string; idempotencyKey: string; actingPartyId?: string }): Promise<{ appointment: PortAppointment; reference: string }> {
    if (input.actingPartyId === undefined) throw new ConflictError("ACTING_PARTY_REQUIRED");
    const actingPartyId = input.actingPartyId;
    const requestId = requestIdFor(input.idempotencyKey);
    const prior = await beforeWrite(() => this.changes.lookup("reschedule", requestId));
    if (prior !== null) return this.earlier(prior, { operation: "scheduling.reschedule.put", resourceId: input.appointmentId, slotId: input.slotId, subjectId: null }, "record");
    const slot = await beforeWrite(() => this.slot(input.slotId));
    if (!slot) throw new ConflictError("STATE_CHANGED");
    let change: ChangeState;
    try {
      change = await this.changes.submit("reschedule", requestId, {
        appointmentId: input.appointmentId,
        expectedVersion: input.beforeVersion,
        slotId: input.slotId,
        slotVersion: slot.version,
        authority: "CLIENT_CONFIRMED",
        actingPartyId,
      });
    } catch (e) {
      return refusalOf(e, "record");
    }
    return this.committed(change);
  }

  /** Business-port booking for `subjectId`, the confirmed action's subject (CLIENT_CONFIRMED by that client only). */
  async create(input: { subjectId: string; slotId: string; idempotencyKey: string }): Promise<{ appointment: PortAppointment; reference: string }> {
    const requestId = requestIdFor(input.idempotencyKey);
    // The body needs the slot's current version: an earlier delivery under this id answers first (redelivery).
    const prior = await beforeWrite(() => this.changes.lookup("book", requestId));
    if (prior !== null) return this.earlier(prior, { operation: "scheduling.booking.put", resourceId: null, slotId: input.slotId, subjectId: input.subjectId }, "slot");
    const slot = await beforeWrite(() => this.slot(input.slotId));
    if (!slot) throw new ConflictError("SLOT_UNAVAILABLE");
    // A slot that is no longer OPEN is NOT a definite refusal here: the lookup lags, so the booking that took it may
    // be this key's own earlier delivery. The keyed write decides at the system: a replay of this request, 422 for
    // this id under another body (the earlier delivery's slot version: in doubt, UNKNOWN), or 409 for a slot that is
    // not open under a fresh id (a definite refusal recorded under the id).
    let change: ChangeState;
    try {
      change = await this.changes.submit("book", requestId, { subjectId: input.subjectId, slotId: input.slotId, slotVersion: slot.version, authority: "CLIENT_CONFIRMED", actingPartyId: input.subjectId });
    } catch (e) {
      return refusalOf(e, "slot");
    }
    return this.committed(change);
  }

  /**
   * An earlier delivery found under the request id before sending: its outcome is the answer, when it is a change
   * of this request (same operation, same record / slot / subject); another request's change is UNKNOWN.
   */
  private async earlier(
    found: ChangeState,
    expected: { operation: string; resourceId: string | null; slotId: string; subjectId: string | null },
    kind: "slot" | "record",
  ): Promise<{ appointment: PortAppointment; reference: string }> {
    if (found.operation !== expected.operation) throw new DependencyError("LOOKUP_OPERATION_MISMATCH", "UNKNOWN", false);
    if (found.state === "REJECTED") {
      const code = found.failureCode;
      if (code === "VERSION_CONFLICT" || code === "STATE_CONFLICT" || code === "DEADLINE_EXCEEDED") throw new ConflictError(kind === "slot" ? "SLOT_UNAVAILABLE" : "STATE_CHANGED");
      if (code === "SLOT_UNAVAILABLE") throw new ConflictError("SLOT_UNAVAILABLE");
      if (code === "AUTHORITY_REFUSED") throw new ConflictError("AUTHORITY_REFUSED");
      throw new ValidationError("PROVIDER_REJECTED");
    }
    const same =
      (expected.resourceId === null || found.resourceId === expected.resourceId) && found.resourceSlotId === expected.slotId && (expected.subjectId === null || found.resourceSubjectId === expected.subjectId);
    if (!same) throw new DependencyError("RECONCILE_PAYLOAD_MISMATCH", "UNKNOWN", false);
    if (found.state === "INCOMPLETE") throw new DependencyError("INCOMPLETE_WRITE_FOUND", "UNKNOWN", false);
    return this.committed(found);
  }

  /**
   * Reconciliation by key for the SchedulingCommitPort: the committed appointment, null when the system rejected the
   * request (no effect), and UNKNOWN (thrown) when the key is not visible: without the prepared action the
   * visibility bound cannot be computed, so an absence is never reported as definitive here.
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<{ appointment: PortAppointment; reference: string } | null> {
    const requestId = requestIdFor(idempotencyKey);
    let found = await this.changes.lookup("book", requestId);
    if (found === null) throw new DependencyError("RECONCILE_ABSENCE_NOT_DEFINITIVE", "UNKNOWN", false);
    if (found.state === "REJECTED") return null;
    if (found.state === "INCOMPLETE") {
      if (this.conn.binding.binding.reconciliation?.incompleteWrite !== "COMPLETE_BY_REQUEST_ID") throw new DependencyError("INCOMPLETE_WRITE_ROUTED_TO_HUMAN", "UNKNOWN", false);
      found = await this.changes.complete(requestId);
    }
    return this.committed(found);
  }

  /** A COMPLETED change with its receipt, read back from the system of record. */
  private async committed(change: ChangeState): Promise<{ appointment: PortAppointment; reference: string }> {
    if (change.state !== "COMPLETED" || change.receiptId === null || change.resourceId === null) throw new DependencyError("RECEIPT_MISSING", "UNKNOWN", false);
    const appt = await this.appointment(change.resourceId);
    if (!appt) throw new DependencyError("RECEIPT_TARGET_NOT_READABLE", "UNKNOWN", false);
    return { appointment: toPortAppointment(appt), reference: change.receiptId };
  }
}
