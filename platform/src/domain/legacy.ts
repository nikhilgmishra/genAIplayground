/**
 * A NON-idempotent scheduling API behind the canonical contract (WP-23; FO-06-75, ACT-02, ACT-03).
 *
 * The reference API keeps an older scheduling product for some tenants: its create (`legacy.appointment.post`)
 * makes another appointment on every delivery. FO-06-75 requires such an API to have an explicit, supported
 * reconciliation path; this adapter adds the two facts a lagging lookup cannot give:
 *
 *   - every action has one external reference derived from the ledger's stable key (same key, same reference),
 *     carried in the request so the system stores it with the appointment;
 *   - DISPATCH MARKER: before any create, the delivery reserves the reference at the system with a fresh dispatch
 *     id (`reserveReference`; the first reservation wins) and creates ONLY when the answer says the reference is
 *     reserved for this dispatch. A redelivery of the same key (another dispatch) never sends a create, even while
 *     the lookup by reference still lags: it answers the earlier appointment when the lookup shows it, otherwise
 *     UNKNOWN (EARLIER_DISPATCH_IN_DOUBT) until the fence settles it. A create that provably never left (NOT_STARTED)
 *     gives its reservation back (`releaseReference`), so a retry may create;
 *   - the runtime never retries the POST after it was sent (NOT_IDEMPOTENT_RECONCILE_REQUIRED: a 5xx or a timeout
 *     after send is UNKNOWN);
 *   - every POST carries the dispatch deadline `notAfter` (the action's expiry plus the write timeout) when the
 *     binding declares that the product enforces it (REQUEST_NOT_AFTER), and its dispatch id;
 *   - lookup by reference is the reconciliation: exactly one appointment that is this booking is COMMITTED; more
 *     than one (a duplicate the product created) is UNKNOWN and routed to a human, never resolved by picking one;
 *     NONE is NEVER definitive by itself (a create's COMMIT can land after its deadline). Once the deadline (+ skew)
 *     has passed, the reference FENCE asks the product: POSTED (a create committed: UNKNOWN until the lookup shows
 *     it) or FENCED (no create can ever be stored under the reference): only FENCED is NOT_FOUND.
 * The legacy product has no slot locking: the commit-time version is the absence of a conflicting appointment
 * of the provider at that time, which the system itself does not enforce (documented fidelity limitation).
 *
 * The request body is built from the confirmed action only. The legacy product takes a wall-clock local start in
 * the tenant's business time zone: the zone comes from the reviewed profile's DSL zone table (`business`), the same
 * table its responses are mapped through.
 */
import { createHash, randomBytes } from "node:crypto";
import type { MappedRecord } from "../connectors/dsl/mapping.js";
import { ConnectorError, ConnectorRefusal } from "../connectors/runtime/errors.js";
import type { ActionTarget, PreparedAction } from "../protocol/index.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import type { ActingParty } from "./authority.js";
import { fenceDue } from "./changes.js";
import type { DomainCommitResult, DomainLookupResult } from "./commit.js";
import type { CanonicalAppointment, SourceRef } from "./contracts.js";
import { CanonicalAppointment as AppointmentSchema } from "./contracts.js";
import type { DomainConnector } from "./runner.js";
import { orNull, single, str } from "./runner.js";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const MODE_CODE: Readonly<Record<string, string>> = { video: "VID", in_person: "OFC", phone: "TEL" };
/** Commit-time version token of a legacy create (the product has no slot version). */
export const LEGACY_OPEN = "legacy.open";

/** External reference of a provider idempotency key (opaque, URL-safe, stable across processes). */
export function externalRefFor(providerIdempotencyKey: string): string {
  if (!KEY.test(providerIdempotencyKey)) throw new ValidationError("PROVIDER_IDEMPOTENCY_KEY_INVALID");
  return `vsp_${createHash("sha256").update(`vsp.domain.legacy-ref.v1\n${providerIdempotencyKey}`).digest("base64url").slice(0, 32)}`;
}

/** A fresh dispatch id: one per delivery attempt of the adapter (opaque, never derived from the key). */
export const newDispatchId = (): string => `dsp_${randomBytes(16).toString("base64url")}`;

/** A legacy reference's state as the product reports it (the reserving dispatch id is never disclosed). */
export interface ReferenceState {
  readonly state: "RESERVED" | "POSTED" | "FENCED" | "RELEASED";
  readonly reservedForDispatch: boolean;
}

/** Wall-clock local time (YYYY-MM-DDTHH:mm) of a UTC instant in an IANA zone. */
export function wallClockIn(instant: string, zone: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export interface LegacySubject {
  kind: PreparedAction["kind"];
  subjectId: string;
  target: ActionTarget;
  change: PreparedAction["change"];
  expiresAt: string;
}

export class HttpLegacyScheduling {
  readonly kind = "live" as const;
  readonly integrationId = "scheduling-legacy";

  private readonly window: { clockSkewAllowanceMs: number; enforcedDeadline: boolean; fence: boolean };

  constructor(
    readonly conn: DomainConnector,
    /** A fresh dispatch id per delivery (injectable for tests). */
    private readonly dispatchIds: () => string = newDispatchId,
  ) {
    if (conn.binding.binding.contract !== "scheduling.legacy.v1") throw new ValidationError("DOMAIN_BINDING_CONTRACT_MISMATCH");
    const r = conn.binding.binding.reconciliation;
    if (r === null) throw new ValidationError("DOMAIN_RECONCILIATION_NOT_DECLARED");
    // Admission refuses a non-idempotent write without a reservation; checked again here (never create without one).
    if (r.dispatchReservation === null) throw new ValidationError("DOMAIN_DISPATCH_RESERVATION_NOT_DECLARED");
    this.window = { clockSkewAllowanceMs: r.clockSkewAllowanceMs, enforcedDeadline: r.dispatchDeadline === "REQUEST_NOT_AFTER", fence: r.fenceOperationId !== null };
  }

  /** The tenant's business zone, from the reviewed profile's DSL zone table. */
  private businessZone(): string {
    const z = this.conn.runner.profile.mappingTables?.timeZones.find((t) => t.zoneKey === "business");
    if (!z) throw new ValidationError("LEGACY_PROFILE_ZONE_REQUIRED");
    return z.ianaZone;
  }

  private appointmentOf(r: MappedRecord, source: SourceRef, providerDisplayName: string): CanonicalAppointment {
    const parsed = AppointmentSchema.safeParse({
      appointmentId: str(r, "appointmentId"),
      subjectId: str(r, "subjectId"),
      providerRef: str(r, "providerRef"),
      providerDisplayName,
      slotId: null,
      startsAt: str(r, "startsAt"),
      timeZone: this.businessZone(),
      modality: str(r, "modality"),
      status: str(r, "status"),
      version: str(r, "version"),
      source,
    });
    if (!parsed.success) throw new ValidationError("DOMAIN_RECORD_INVALID");
    return parsed.data;
  }

  /** One appointment of the legacy product (the product has no provider display name: an opaque label is used). */
  async appointment(apptRef: string): Promise<CanonicalAppointment | null> {
    return orNull(async () => {
      const result = await this.conn.run("getAppointment", { params: { apptRef } });
      return this.appointmentOf(single(result), this.conn.source(result), "provider");
    });
  }

  /** Appointments carrying the reference (visible after the documented window). */
  async byReference(externalRef: string): Promise<CanonicalAppointment[]> {
    const { found, result } = await this.conn.runner.reconcile(this.conn.operationId("createAppointment"), { params: { externalRef } });
    if (!found || result === null) return [];
    const source = this.conn.source(result);
    return result.records.map((r) => this.appointmentOf(r, source, "provider"));
  }

  /** Prepare input of a legacy create, authority CLIENT_CONFIRMED by the client (a provider never books for a client). */
  prepareCreate(party: ActingParty, req: { providerRef: string; startsAt: string; modality: "video" | "in_person" | "phone" }): {
    kind: "appointment.create";
    target: ActionTarget;
    change: PreparedAction["change"];
    impact: { summaryTemplateId: string; fees: null; reversible: boolean };
    confirmationTemplateId: string;
    ttlSeconds: number;
    requiresStepUp: boolean;
  } {
    if (party.role !== "client") throw new AccessDeniedError("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
    if (Number.isNaN(Date.parse(req.startsAt))) throw new ValidationError("LEGACY_START_INVALID");
    return {
      kind: "appointment.create",
      target: { system: "scheduling", recordType: "provider_schedule", recordRef: req.providerRef, beforeVersion: LEGACY_OPEN },
      change: { providerRef: req.providerRef, toStartsAt: new Date(req.startsAt).toISOString(), toTimeZone: this.businessZone(), toModality: req.modality, authority: "CLIENT_CONFIRMED", actingPartyRef: party.partyRef },
      impact: { summaryTemplateId: "appointment.create_confirmation", fees: null, reversible: true },
      confirmationTemplateId: "appointment.create_confirmation",
      ttlSeconds: 300,
      requiresStepUp: false,
    };
  }

  /** The legacy product has no version: the token is constant (no optimistic concurrency at the source). */
  async currentVersion(_action: LegacySubject): Promise<string> {
    return LEGACY_OPEN;
  }

  /** Reserves the reference for one dispatch (the first reservation wins; later ones are told it is not theirs). */
  async reserve(externalRef: string, dispatchId: string, notAfter: string | null): Promise<ReferenceState> {
    const body: Record<string, unknown> = { dispatchId };
    if (notAfter !== null) body.notAfter = notAfter;
    return this.referenceStateOf(await this.conn.run("reserveReference", { params: { externalRef }, body, idempotencyKey: externalRef }));
  }

  /** Gives back this dispatch's reservation (only while RESERVED by it): its create provably never left. */
  async release(externalRef: string, dispatchId: string): Promise<ReferenceState> {
    return this.referenceStateOf(await this.conn.run("releaseReference", { params: { externalRef }, body: { dispatchId }, idempotencyKey: externalRef }));
  }

  /**
   * The reference fence, once the create's deadline has passed: POSTED (a create committed under it; a create still
   * inside its transaction is waited for) or FENCED (nothing can ever be created under it). Null when the product's
   * own clock has not passed the deadline yet (409: nothing changed).
   */
  async fence(externalRef: string, notAfter: string): Promise<ReferenceState | null> {
    try {
      return this.referenceStateOf(await this.conn.run("fenceReference", { params: { externalRef }, body: { notAfter }, idempotencyKey: externalRef }));
    } catch (e) {
      if (e instanceof ConnectorError && e.outcome === "FAILED" && e.reasonCode === "CONNECTOR_CONFLICT") return null;
      throw e;
    }
  }

  private referenceStateOf(result: Awaited<ReturnType<DomainConnector["run"]>>): ReferenceState {
    const r = single(result);
    const state = str(r, "referenceState");
    if (state !== "RESERVED" && state !== "POSTED" && state !== "FENCED" && state !== "RELEASED") throw new ValidationError("DOMAIN_RECORD_INVALID");
    return { state, reservedForDispatch: r.values.reservedForDispatch === true };
  }

  async commit(action: LegacySubject, providerIdempotencyKey: string): Promise<DomainCommitResult> {
    let body: Record<string, unknown>;
    let externalRef: string;
    let deadline: string | null;
    try {
      if (action.kind !== "appointment.create") throw new ValidationError("ACTION_KIND_UNSUPPORTED");
      if (action.change.authority !== undefined && action.change.authority !== "CLIENT_CONFIRMED") throw new AccessDeniedError("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
      if (action.change.actingPartyRef !== undefined && action.change.actingPartyRef !== action.subjectId) throw new AccessDeniedError("DOMAIN_ACTING_PARTY_MISMATCH");
      const startsAt = action.change.toStartsAt;
      const modality = action.change.toModality;
      if (typeof startsAt !== "string" || typeof modality !== "string" || MODE_CODE[modality] === undefined) throw new ValidationError("PREPARED_CHANGE_INVALID");
      externalRef = externalRefFor(providerIdempotencyKey);
      body = { clientRef: action.subjectId, providerRef: action.target.recordRef, startLocal: wallClockIn(startsAt, this.businessZone()), modeCode: MODE_CODE[modality] };
      deadline = this.deadlineOf(action);
      if (deadline !== null) body.notAfter = deadline;
    } catch (e) {
      if (e instanceof PlatformError) return { outcome: "FAILED", reasonCode: e.reasonCode, permanent: true };
      throw e;
    }
    // The dispatch marker: this delivery creates only under its own reservation of the reference.
    const dispatchId = this.dispatchIds();
    let reservation: ReferenceState;
    try {
      reservation = await this.reserve(externalRef, dispatchId, deadline);
    } catch (e) {
      if (e instanceof ConnectorRefusal) return { outcome: "FAILED", reasonCode: e.reasonCode, permanent: true };
      if (e instanceof ConnectorError && e.outcome === "NOT_STARTED") throw new DependencyError(e.reasonCode, "NOT_STARTED", true);
      if (e instanceof ConnectorError && e.outcome === "FAILED") {
        // 409: no reservation after the deadline (nothing stored under the reference, no create can follow).
        if (e.reasonCode === "CONNECTOR_CONFLICT") return { outcome: "FAILED", reasonCode: "DISPATCH_DEADLINE_PASSED", permanent: true };
        if (e.reasonCode === "CONNECTOR_FORBIDDEN") return { outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true };
        if (e.reasonCode === "CONNECTOR_REQUEST_REJECTED") return { outcome: "FAILED", reasonCode: "PROVIDER_REJECTED", permanent: true };
      }
      // The reservation may exist, but this delivery sent no create: in doubt, settled by the fence.
      throw e;
    }
    if (reservation.state === "FENCED") return { outcome: "FAILED", reasonCode: "REQUEST_FENCED", permanent: true };
    if (!(reservation.state === "RESERVED" && reservation.reservedForDispatch)) return this.earlierDispatch(action, externalRef);
    let result;
    try {
      result = await this.conn.run("createAppointment", { params: { externalRef }, body: { ...body, dispatchId } });
    } catch (e) {
      if (e instanceof ConnectorRefusal || (e instanceof ConnectorError && e.outcome === "NOT_STARTED")) {
        // Provably never sent: give the reservation back so a retry of the same key may create (best effort; kept,
        // a retry is only in doubt, never a second create).
        await this.release(externalRef, dispatchId).catch(() => undefined);
        if (e instanceof ConnectorRefusal) return { outcome: "FAILED", reasonCode: e.reasonCode, permanent: true };
        throw new DependencyError(e.reasonCode, "NOT_STARTED", true);
      }
      if (e instanceof ConnectorError && e.outcome === "FAILED") {
        if (e.reasonCode === "CONNECTOR_NOT_FOUND") return { outcome: "FAILED", reasonCode: "TARGET_NOT_FOUND", permanent: true };
        if (e.reasonCode === "CONNECTOR_REQUEST_REJECTED") return { outcome: "FAILED", reasonCode: "PROVIDER_REJECTED", permanent: true };
        if (e.reasonCode === "CONNECTOR_FORBIDDEN") return { outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true };
        // 409 DEADLINE_EXCEEDED / FENCED: the product refused to create it (nothing stored).
        if (e.reasonCode === "CONNECTOR_CONFLICT") return { outcome: "FAILED", reasonCode: "DISPATCH_DEADLINE_PASSED", permanent: true };
      }
      throw e;
    }
    return this.committed(this.appointmentOf(single(result), this.conn.source(result), "provider"));
  }

  /**
   * Another dispatch holds the reference (an earlier delivery of this key): only it may create. This delivery
   * never sends a create; it answers the earlier appointment once the lookup shows it, otherwise UNKNOWN.
   */
  private async earlierDispatch(action: LegacySubject, externalRef: string): Promise<DomainCommitResult> {
    let found: CanonicalAppointment[];
    try {
      found = await this.byReference(externalRef);
    } catch (e) {
      if (e instanceof ConnectorError) throw new DependencyError("EARLIER_DISPATCH_IN_DOUBT", "UNKNOWN", false);
      throw e;
    }
    if (found.length === 1 && found[0]) {
      // An appointment under this reference that is not this action's booking is never claimed for it.
      if (!this.isBookingOf(found[0], action)) throw new DependencyError("RECONCILE_PAYLOAD_MISMATCH", "UNKNOWN", false);
      return this.committed(found[0]);
    }
    if (found.length > 1) throw new DependencyError("LEGACY_DUPLICATE_APPOINTMENTS", "UNKNOWN", false);
    throw new DependencyError("EARLIER_DISPATCH_IN_DOUBT", "UNKNOWN", false);
  }

  private committed(a: CanonicalAppointment): DomainCommitResult & DomainLookupResult {
    return { outcome: "COMMITTED", providerReference: a.appointmentId, afterVersion: a.version, evidence: { appointmentId: a.appointmentId, startsAt: a.startsAt, timeZone: a.timeZone, status: a.status } };
  }

  /** The appointment is the action's booking: same client, provider and start (the product has no request digest). */
  private isBookingOf(a: CanonicalAppointment, action: LegacySubject): boolean {
    const startsAt = action.change.toStartsAt;
    // The product keeps wall-clock minutes: the start is compared at minute precision.
    const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000);
    return a.subjectId === action.subjectId && a.providerRef === action.target.recordRef && typeof startsAt === "string" && minute(a.startsAt) === minute(startsAt);
  }

  async lookup(action: LegacySubject, providerIdempotencyKey: string): Promise<DomainLookupResult> {
    const externalRef = externalRefFor(providerIdempotencyKey);
    const found = await this.byReference(externalRef);
    if (found.length === 1 && found[0]) return this.isBookingOf(found[0], action) ? this.committed(found[0]) : { outcome: "UNKNOWN" };
    // A duplicate created by the product: never resolved by picking one (a human reconciles it).
    if (found.length > 1) return { outcome: "UNKNOWN" };
    // None visible is never proof of absence (a create's COMMIT can land after its deadline): only the fence is.
    const deadline = this.deadlineOf(action);
    if (deadline === null || !this.window.fence) return { outcome: "UNKNOWN" };
    if (!fenceDue(Date.parse(deadline), this.window.clockSkewAllowanceMs, this.conn.clock.now().getTime())) return { outcome: "UNKNOWN" };
    const ref = await this.fence(externalRef, deadline);
    // FENCED: no create can ever be stored under the reference. POSTED: one committed; the lookup shows it later.
    return ref?.state === "FENCED" ? { outcome: "NOT_FOUND" } : { outcome: "UNKNOWN" };
  }

  /** The POST's dispatch deadline (expiry + write timeout; deterministic per action), or null when not enforced. */
  private deadlineOf(action: LegacySubject): string | null {
    if (!this.window.enforcedDeadline) return null;
    const expiresMs = Date.parse(action.expiresAt);
    if (!Number.isFinite(expiresMs)) throw new ValidationError("PREPARED_ACTION_EXPIRY_INVALID");
    const timeoutMs = this.conn.binding.op("createAppointment").timeoutMs ?? this.conn.runner.profile.limits.timeoutMs;
    return new Date(expiresMs + timeoutMs).toISOString();
  }
}
