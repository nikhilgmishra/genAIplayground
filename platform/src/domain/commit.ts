/**
 * The domain commit port (WP-23; FO-03-09, FO-06-75, FO-11-02, FO-01-25, FO-01-26; ACT-01, ACT-02, ACT-03,
 * AUTH-02, AUTH-05).
 *
 * Implements the action executor's ProviderCommitPort contract (platform/src/actions/ports.ts; structurally, the
 * module register keeps domain from importing actions) over the canonical scheduling and billing contracts, plus
 * the authoritative read-back that prepares an action and the independent effect verification that follows it:
 *
 *   prepare        reads the target(s) from the system of record for the acting party (AUTH-05: another party's
 *                  record reads as unavailable, nothing disclosed), checks the authority family of the kind
 *                  (a provider's approval is never a client's consent), and returns the ledger's PrepareInput:
 *                  target with the before-version token (appointment AND slot versions for a reschedule) and the
 *                  exact change the party confirms, authority and acting party included (digest-bound);
 *   currentVersion re-reads those versions at commit (a changed slot or appointment refuses the commit:
 *                  STATE_CHANGED, CHANGED_SLOT_DURING_CONFIRMATION);
 *   commit         one keyed change request per provider idempotency key: the same key always sends the same
 *                  request id AND the same body (built from the confirmed action only, with the dispatch deadline
 *                  `notAfter` = preparation expiry + write timeout), so retries, redelivery and a second process
 *                  after a crash never apply it twice (ACT-02). An action prepared without the slot version (the
 *                  business layer's preparations) needs one read of the slot to complete its body: the request id
 *                  is looked up FIRST, and an earlier delivery found there is the answer (never a second body for
 *                  the same key). The system re-checks the versions, the acting party's authority and the deadline
 *                  itself. Only a definite refusal is FAILED (VERSION_CONFLICT is STATE_CHANGED, AUTHORITY_REFUSED,
 *                  TARGET_NOT_FOUND, a REJECTED change with its code); a transport failure before send is
 *                  NOT_STARTED; anything else (after send, an INCOMPLETE change, a COMPLETED one without receipt,
 *                  the request id already used by another request: 422) is UNKNOWN (thrown) and is reconciled
 *                  before any retry (ACT-03);
 *   lookup         reconciliation by key: a change found under the request id is claimed only when it is this
 *                  action's request (request digest of the body the action sends, resource slot / subject / start
 *                  / record: PAYLOAD_MISMATCH otherwise); COMMITTED with the receipt; an INCOMPLETE write completed
 *                  by its request id (step 2 only) when the binding declares COMPLETE_BY_REQUEST_ID; NOT_FOUND only
 *                  for a rejected request, or for one the system FENCED: a 404 is never proof of absence (a COMMIT
 *                  can land after the deadline), so once the deadline (+ skew) has passed the binding's fence asks the
 *                  system, which answers the stored change or records the id so nothing can ever apply under it;
 *                  otherwise UNKNOWN;
 *   verifyEffect   an EffectVerification from an authoritative read-back of the target and of the system's own
 *                  receipt for the commit, independent of any model or response text.
 * Evidence recorded in the receipt keeps the business layer's receipt-bound shape ({appointmentId, startsAt,
 * timeZone, status} / {invoiceId, status}) with the system's resource version as the after-version.
 */
import { ConnectorError, ConnectorRefusal } from "../connectors/runtime/errors.js";
import type { EffectVerification } from "../protocol/effects.js";
import { EffectVerification as EffectVerificationSchema } from "../protocol/effects.js";
import type { ActionKind, ActionTarget, PreparedAction } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { AccessDeniedError, ConflictError, DependencyError, PlatformError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { ActingParty } from "./authority.js";
import { authorityFor, commitAuthorityOf, inScope, ledgerKindOf } from "./authority.js";
import type { AdmittedBinding } from "./binding.js";
import type { HttpBilling } from "./billing.js";
import type { ChangeRequests, ChangeState, LookupDecision, PayloadExpectation } from "./changes.js";
import { decideLookup, fenceDue, isFenced, payloadMatches, requestDigestOf, requestIdFor } from "./changes.js";
import type { DomainActionKind, DomainAuthority } from "./contracts.js";
import { AUTHORITY_OF_KIND } from "./contracts.js";
import { orNull } from "./runner.js";
import type { HttpScheduling } from "./scheduling.js";
import { beforeWrite } from "./scheduling.js";

/** Same shapes as platform/src/actions/ports.ts ProviderCommitResult / ProviderLookupResult (structural). */
export type DomainCommitResult =
  | { outcome: "COMMITTED"; providerReference: string; afterVersion: string | null; evidence: Record<string, unknown> }
  | { outcome: "FAILED"; reasonCode: string; permanent: boolean };
export type DomainLookupResult = { outcome: "COMMITTED"; providerReference: string; afterVersion: string | null; evidence: Record<string, unknown> } | { outcome: "NOT_FOUND" } | { outcome: "UNKNOWN" };

/** What the port needs of an action: a PreparedAction satisfies it; so does a domain command of a provider kind. */
export interface CommitSubject {
  kind: ActionKind | DomainActionKind;
  subjectId: string;
  target: ActionTarget;
  change: PreparedAction["change"];
  /** Preparation expiry: no dispatch happens after it (the bound of the visibility rule). */
  expiresAt: string;
}

/** The ledger's PrepareInput (structural, platform/src/actions/ports.ts). */
export interface DomainPrepareInput {
  kind: ActionKind | DomainActionKind;
  target: ActionTarget;
  change: PreparedAction["change"];
  impact: { summaryTemplateId: string; fees: null; reversible: boolean };
  confirmationTemplateId: string;
  ttlSeconds: number;
  requiresStepUp: boolean;
}

export interface DomainPreparation {
  readonly domainKind: DomainActionKind;
  /** The ledger kind it is prepared under; null for a provider kind the ledger does not know yet (WP-25). */
  readonly ledgerKind: ActionKind | null;
  readonly input: DomainPrepareInput;
  /**
   * When it was prepared and when it expires (preparedAt + the prepare TTL), digest-bound: the domain command path
   * dispatches only before `expiresAt` and derives the write's dispatch deadline from it (never from its caller).
   */
  readonly preparedAt: string;
  readonly expiresAt: string;
  /**
   * Digest of the preparation (kind, ledger kind, input). The ledger binds its own confirmation digest; the domain
   * command path (`commitCommand`) refuses a preparation modified after `prepare` (tamper-evident inside the
   * process; the system of record still re-checks versions and authority itself).
   */
  readonly digest: string;
}

/** The digest of a preparation's content (everything but the digest itself), its times included. */
export function preparationDigest(p: Pick<DomainPreparation, "domainKind" | "ledgerKind" | "input" | "preparedAt" | "expiresAt">): string {
  return sha256Hex(canonicalJson({ v: "vsp.domain.preparation.v2", domainKind: p.domainKind, ledgerKind: p.ledgerKind, input: p.input, preparedAt: p.preparedAt, expiresAt: p.expiresAt }));
}

export type DomainChangeRequest =
  | { kind: "appointment.create"; slotId: string }
  | { kind: "appointment.reschedule" | "provider.appointment.reschedule"; appointmentId: string; slotId: string }
  | { kind: "appointment.cancel" | "provider.appointment.cancel"; appointmentId: string; reasonCode: "CLIENT_REQUEST" | "PROVIDER_UNAVAILABLE" | "SCHEDULING_CONFLICT" }
  | { kind: "billing.review.submit"; invoiceId: string; reasonCode: "CHARGE_QUESTIONED" | "DUPLICATE_CHARGE_SUSPECTED" | "AMOUNT_QUESTIONED" }
  | { kind: "provider.availability.block"; slotId: string; reasonCode: "PROVIDER_UNAVAILABLE" | "ADMINISTRATIVE" };

/** Refusal of a preparation (reason code only; a target outside the party's scope is "not available", no disclosure). */
export class DomainPrepareRefused extends PlatformError {}

const PREPARE_TTL_SECONDS = 300;
/** A preparation stamped further ahead of the platform clock than this is refused (no self-extended window). */
const PREPARED_AT_SKEW_MS = 60_000;
const SLOT_TOKEN = /^s([1-9][0-9]{0,8})$/;
const RESCHEDULE_TOKEN = /^a([1-9][0-9]{0,8})\.s([1-9][0-9]{0,8})$/;
const APPOINTMENT_TOKEN = /^a([1-9][0-9]{0,8})$/;
const INVOICE_TOKEN = /^i([1-9][0-9]{0,8})$/;
const PLAIN_VERSION = /^[1-9][0-9]{0,8}$/;
/** Version tokens of the business layer's own preparations (business/providers.ts). */
const BUSINESS_SLOT_OPEN = "slot.open";
const SLOT_UNAVAILABLE = "slot.unavailable";

interface WriteShape {
  canonical: "book" | "reschedule" | "cancel" | "requestReview" | "blockAvailability";
  operation: string;
  resourceType: "appointment" | "invoice" | "slot";
  conn: "scheduling" | "billing";
}

const WRITES: Readonly<Record<DomainActionKind, WriteShape>> = {
  "appointment.create": { canonical: "book", operation: "scheduling.booking.put", resourceType: "appointment", conn: "scheduling" },
  "appointment.reschedule": { canonical: "reschedule", operation: "scheduling.reschedule.put", resourceType: "appointment", conn: "scheduling" },
  "provider.appointment.reschedule": { canonical: "reschedule", operation: "scheduling.reschedule.put", resourceType: "appointment", conn: "scheduling" },
  "appointment.cancel": { canonical: "cancel", operation: "scheduling.cancellation.put", resourceType: "appointment", conn: "scheduling" },
  "provider.appointment.cancel": { canonical: "cancel", operation: "scheduling.cancellation.put", resourceType: "appointment", conn: "scheduling" },
  "billing.review.submit": { canonical: "requestReview", operation: "billing.review_request.put", resourceType: "invoice", conn: "billing" },
  "provider.availability.block": { canonical: "blockAvailability", operation: "scheduling.availability_block.put", resourceType: "slot", conn: "scheduling" },
};

/** The domain kind of an action: a ledger kind plus the digest-bound authority. */
export function domainKindOf(subject: Pick<CommitSubject, "kind" | "change">): DomainActionKind {
  const provider = subject.change.authority === "PROVIDER_APPROVED";
  switch (subject.kind) {
    case "appointment.reschedule":
      return provider ? "provider.appointment.reschedule" : "appointment.reschedule";
    case "appointment.cancel":
      return provider ? "provider.appointment.cancel" : "appointment.cancel";
    case "appointment.create":
    case "billing.review.submit":
    case "provider.appointment.reschedule":
    case "provider.appointment.cancel":
    case "provider.availability.block":
      return subject.kind;
    default:
      throw new ValidationError("ACTION_KIND_UNSUPPORTED");
  }
}

const statusAfter = (kind: DomainActionKind): string =>
  kind === "appointment.cancel" || kind === "provider.appointment.cancel" ? "CANCELLED" : kind === "billing.review.submit" ? "IN_REVIEW" : kind === "provider.availability.block" ? "BLOCKED" : "SCHEDULED";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export interface DomainCommitPortDeps {
  scheduling: HttpScheduling | null;
  billing: HttpBilling | null;
  clock: Clock;
}

export class DomainCommitPort {
  constructor(private readonly deps: DomainCommitPortDeps) {}

  private changesFor(shape: WriteShape): ChangeRequests {
    const a = shape.conn === "scheduling" ? this.deps.scheduling : this.deps.billing;
    if (!a) throw new ValidationError("DOMAIN_SYSTEM_NOT_COMPOSED");
    return a.changes;
  }

  private scheduling(): HttpScheduling {
    if (!this.deps.scheduling) throw new ValidationError("DOMAIN_SYSTEM_NOT_COMPOSED");
    return this.deps.scheduling;
  }

  private billing(): HttpBilling {
    if (!this.deps.billing) throw new ValidationError("DOMAIN_SYSTEM_NOT_COMPOSED");
    return this.deps.billing;
  }

  // ---------------------------------------------------------------- prepare (authoritative read-back)

  async prepare(party: ActingParty, req: DomainChangeRequest): Promise<DomainPreparation> {
    const authority = authorityFor(req.kind, party);
    const ledgerKind = ledgerKindOf(req.kind);
    const base = { authority, actingPartyRef: party.partyRef };
    const notAvailable = () => new DomainPrepareRefused("TARGET_NOT_AVAILABLE");
    const preparedAtMs = this.deps.clock.now().getTime();
    const make = (target: ActionTarget, change: PreparedAction["change"], template: string, reversible: boolean): DomainPreparation => {
      const content = {
        domainKind: req.kind,
        ledgerKind,
        input: { kind: ledgerKind ?? req.kind, target, change: { ...change, ...base }, impact: { summaryTemplateId: template, fees: null, reversible }, confirmationTemplateId: template, ttlSeconds: PREPARE_TTL_SECONDS, requiresStepUp: false },
        preparedAt: new Date(preparedAtMs).toISOString(),
        expiresAt: new Date(preparedAtMs + PREPARE_TTL_SECONDS * 1000).toISOString(),
      };
      return { ...content, digest: preparationDigest(content) };
    };
    switch (req.kind) {
      case "appointment.create": {
        const slot = await this.scheduling().slot(req.slotId);
        if (!slot || slot.state !== "OPEN") throw new ConflictError("SLOT_UNAVAILABLE");
        return make(
          { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: `s${slot.version}` },
          { slotId: slot.slotId, slotVersion: slot.version, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
          "appointment.create_confirmation",
          true,
        );
      }
      case "appointment.reschedule":
      case "provider.appointment.reschedule": {
        const appt = await this.scheduling().appointment(req.appointmentId);
        if (!appt || !inScope(party, appt)) throw notAvailable();
        if (appt.status !== "SCHEDULED") throw new DomainPrepareRefused("APPOINTMENT_NOT_RESCHEDULABLE");
        const slot = await this.scheduling().slot(req.slotId);
        if (!slot || slot.state !== "OPEN" || slot.providerRef !== appt.providerRef) throw new ConflictError("SLOT_UNAVAILABLE");
        return make(
          { system: "scheduling", recordType: "appointment", recordRef: appt.appointmentId, beforeVersion: `a${appt.version}.s${slot.version}` },
          {
            slotId: slot.slotId,
            slotVersion: slot.version,
            toStartsAt: slot.startsAt,
            toTimeZone: slot.timeZone,
            toModality: slot.modality,
            fromStartsAt: appt.startsAt,
            fromTimeZone: appt.timeZone,
            fromModality: appt.modality,
          },
          // A provider's approval is confirmed with its own template, never the client's consent wording.
          req.kind === "provider.appointment.reschedule" ? "provider.appointment.change_confirmation" : "appointment.change_confirmation",
          true,
        );
      }
      case "appointment.cancel":
      case "provider.appointment.cancel": {
        const appt = await this.scheduling().appointment(req.appointmentId);
        if (!appt || !inScope(party, appt)) throw notAvailable();
        if (appt.status !== "SCHEDULED") throw new DomainPrepareRefused("APPOINTMENT_NOT_CANCELLABLE");
        return make(
          { system: "scheduling", recordType: "appointment", recordRef: appt.appointmentId, beforeVersion: `a${appt.version}` },
          { reasonCode: req.reasonCode, fromStartsAt: appt.startsAt, fromTimeZone: appt.timeZone, fromModality: appt.modality },
          req.kind === "provider.appointment.cancel" ? "provider.appointment.cancel_confirmation" : "appointment.cancel_confirmation",
          false,
        );
      }
      case "billing.review.submit": {
        const inv = await this.billing().invoice(req.invoiceId);
        if (!inv || inv.subjectId !== party.partyRef) throw notAvailable();
        if (inv.status !== "OPEN") throw new DomainPrepareRefused("INVOICE_NOT_REVIEWABLE");
        return make({ system: "billing", recordType: "invoice", recordRef: inv.invoiceId, beforeVersion: `i${inv.version}` }, { reasonCode: req.reasonCode }, "billing.review_confirmation", true);
      }
      case "provider.availability.block": {
        const slot = await this.scheduling().slot(req.slotId);
        // Another provider's slot: not available (the provider's approval covers only their own schedule).
        if (!slot || slot.providerRef !== party.partyRef) throw notAvailable();
        if (slot.state !== "OPEN") throw new ConflictError("SLOT_UNAVAILABLE");
        return make(
          { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: `s${slot.version}` },
          { slotId: slot.slotId, slotVersion: slot.version, reasonCode: req.reasonCode, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone },
          "provider.availability_block_confirmation",
          true,
        );
      }
    }
  }

  // ---------------------------------------------------------------- currentVersion (commit-time re-read)

  async currentVersion(action: CommitSubject): Promise<string> {
    const kind = domainKindOf(action);
    const before = action.target.beforeVersion;
    switch (kind) {
      case "appointment.create":
      case "provider.availability.block": {
        const slot = await this.scheduling().slot(action.target.recordRef);
        if (!slot || slot.state !== "OPEN") return SLOT_UNAVAILABLE;
        return before === BUSINESS_SLOT_OPEN ? BUSINESS_SLOT_OPEN : `s${slot.version}`;
      }
      case "appointment.reschedule":
      case "provider.appointment.reschedule": {
        const appt = await this.scheduling().appointment(action.target.recordRef);
        if (!appt) return "absent";
        if (!RESCHEDULE_TOKEN.test(before)) return appt.version;
        const slotId = str(action.change.slotId);
        const slot = slotId === null ? null : await this.scheduling().slot(slotId);
        return `a${appt.version}.${slot && slot.state === "OPEN" && slot.providerRef === appt.providerRef ? `s${slot.version}` : "s-unavailable"}`;
      }
      case "appointment.cancel":
      case "provider.appointment.cancel": {
        const appt = await this.scheduling().appointment(action.target.recordRef);
        if (!appt) return "absent";
        return APPOINTMENT_TOKEN.test(before) ? `a${appt.version}` : appt.version;
      }
      case "billing.review.submit": {
        const inv = await this.billing().invoice(action.target.recordRef);
        if (!inv) return "absent";
        return INVOICE_TOKEN.test(before) ? `i${inv.version}` : inv.version;
      }
    }
  }

  // ---------------------------------------------------------------- commit

  async commit(action: CommitSubject, providerIdempotencyKey: string): Promise<DomainCommitResult> {
    let kind: DomainActionKind;
    let authority: { authority: DomainAuthority; actingPartyRef: string };
    let requestId: string;
    let plan: WritePlan;
    try {
      kind = domainKindOf(action);
      authority = commitAuthorityOf(action);
      // The kind's authority family must be the one the party confirmed under (never provider for a client kind).
      if ((kind.startsWith("provider.") ? "PROVIDER_APPROVED" : "CLIENT_CONFIRMED") !== authority.authority) throw new AccessDeniedError("DOMAIN_AUTHORITY_MISMATCH");
      requestId = requestIdFor(providerIdempotencyKey);
      plan = this.planOf(kind, action, authority);
    } catch (e) {
      // A refusal before any I/O (authority, an action that cannot be expressed as a request) is a definite failure.
      if (e instanceof PlatformError && !(e instanceof DependencyError)) return { outcome: "FAILED", reasonCode: e.reasonCode, permanent: true };
      throw e;
    }
    const shape = WRITES[kind];
    const changes = this.changesFor(shape);
    let body = plan.body;
    if (body === null) {
      // The action lacks the slot version (a business-layer preparation): its body needs a read of current state.
      // Never send a second, different body under a request id that may already carry the first delivery: look the
      // id up first and answer from what is there (ACT-02).
      const prior = await beforeWrite(() => changes.lookup(shape.canonical, requestId));
      if (prior !== null) return this.settle(kind, action, prior, this.expectationOf(kind, action, null), "PRIOR");
      try {
        body = await this.completeBody(plan);
      } catch (e) {
        if (e instanceof DependencyError) throw e;
        if (e instanceof PlatformError) return refusalResult(e) ?? { outcome: "FAILED", reasonCode: e.reasonCode, permanent: true };
        throw e;
      }
    }
    let change: ChangeState;
    try {
      change = await changes.submit(shape.canonical, requestId, body);
    } catch (e) {
      // 422 on a keyed write: the request id already carries ANOTHER request (operation or body). That request may
      // have been applied: in doubt, reconciled by key with the payload check (never "not applied").
      if (e instanceof ConnectorError && e.reasonCode === "CONNECTOR_REQUEST_REJECTED" && e.httpStatus === 422) throw new DependencyError("REQUEST_ID_IN_USE", "UNKNOWN", false);
      const refused = refusalResult(e);
      if (refused) return refused;
      throw e; // NOT_STARTED / UNKNOWN keep the ledger's classification (reconcile before any retry)
    }
    return this.settle(kind, action, change, this.expectationOf(kind, action, body), "WRITE");
  }

  /**
   * The outcome of a change the system reported for the action's request id (the write's answer, or an earlier
   * delivery found before sending). Only a REJECTED change of this request is FAILED; a COMPLETED one with its
   * receipt is COMMITTED; everything else is UNKNOWN (thrown): an INCOMPLETE change (step 1 applied, no receipt)
   * or a COMPLETED one without receipt is reconciled by key, never reported as failed (ACT-03).
   */
  private settle(kind: DomainActionKind, action: CommitSubject, change: ChangeState, expected: PayloadExpectation, from: "WRITE" | "PRIOR"): DomainCommitResult {
    const shape = WRITES[kind];
    const scheme = this.reconciliationOf(shape).requestDigest;
    if (change.operation !== shape.operation) throw new DependencyError("LOOKUP_OPERATION_MISMATCH", "UNKNOWN", false);
    if (!payloadMatches(change, expected, scheme)) throw new DependencyError("RECONCILE_PAYLOAD_MISMATCH", "UNKNOWN", false);
    if (change.state === "REJECTED") return { outcome: "FAILED", reasonCode: failureReasonOf(change.failureCode), permanent: true };
    if (change.state === "INCOMPLETE") throw new DependencyError(from === "WRITE" ? "INCOMPLETE_WRITE" : "INCOMPLETE_WRITE_FOUND", "UNKNOWN", false);
    return this.committedResult(kind, action, change);
  }

  /** The binding's reconciliation declaration of a write's system (admission guarantees it for writes). */
  private reconciliationOf(shape: WriteShape): NonNullable<AdmittedBinding["binding"]["reconciliation"]> {
    const rec = this.changesFor(shape).conn.binding.binding.reconciliation;
    if (rec === null) throw new ValidationError("DOMAIN_RECONCILIATION_NOT_DECLARED");
    return rec;
  }

  /**
   * The dispatch deadline of an action's write: the preparation's expiry plus the write's timeout (no dispatch
   * happens after the expiry; a send in flight gives up after the timeout). Deterministic, so every delivery of
   * the same key carries the same deadline; null when the system does not enforce one.
   */
  private deadlineOf(shape: WriteShape, action: CommitSubject): string | null {
    const changes = this.changesFor(shape);
    if (this.reconciliationOf(shape).dispatchDeadline !== "REQUEST_NOT_AFTER") return null;
    const expiresMs = Date.parse(action.expiresAt);
    if (!Number.isFinite(expiresMs)) throw new ValidationError("PREPARED_ACTION_EXPIRY_INVALID");
    const write = changes.conn.binding.op(shape.canonical);
    return new Date(expiresMs + (write.timeoutMs ?? changes.conn.runner.profile.limits.timeoutMs)).toISOString();
  }

  /**
   * The request body of an action, from the confirmed action only (no I/O). `body` is null when the action lacks
   * the slot version its write needs (business-layer preparations): `completeBody` reads it, after the request id
   * was looked up.
   */
  private planOf(kind: DomainActionKind, action: CommitSubject, a: { authority: DomainAuthority; actingPartyRef: string }): WritePlan {
    const c = action.change;
    const before = action.target.beforeVersion;
    const shape = WRITES[kind];
    const deadline = this.deadlineOf(shape, action);
    const withDeadline = (b: Record<string, unknown>): Record<string, unknown> => (deadline === null ? b : { ...b, notAfter: deadline });
    const apptVersion = (): string => {
      const m = RESCHEDULE_TOKEN.exec(before) ?? APPOINTMENT_TOKEN.exec(before);
      if (m?.[1]) return m[1];
      if (PLAIN_VERSION.test(before)) return before;
      throw new ValidationError("PREPARED_CHANGE_INVALID");
    };
    const slotId = str(c.slotId);
    const slotVersion = str(c.slotVersion);
    const withSlot = (b: Record<string, unknown>): WritePlan => {
      if (slotId === null) throw new ValidationError("PREPARED_CHANGE_INVALID");
      return slotVersion !== null ? { body: withDeadline({ ...b, slotVersion }), base: null, slotId } : { body: null, base: withDeadline(b), slotId };
    };
    switch (kind) {
      case "appointment.create":
        return withSlot({ subjectId: action.subjectId, slotId, authority: a.authority, actingPartyId: a.actingPartyRef });
      case "appointment.reschedule":
      case "provider.appointment.reschedule":
        return withSlot({ appointmentId: action.target.recordRef, expectedVersion: apptVersion(), slotId, authority: a.authority, actingPartyId: a.actingPartyRef });
      case "appointment.cancel":
      case "provider.appointment.cancel":
        return {
          body: withDeadline({
            appointmentId: action.target.recordRef,
            expectedVersion: apptVersion(),
            reasonCode: str(c.reasonCode) ?? (a.authority === "PROVIDER_APPROVED" ? "PROVIDER_UNAVAILABLE" : "CLIENT_REQUEST"),
            authority: a.authority,
            actingPartyId: a.actingPartyRef,
          }),
          base: null,
          slotId: null,
        };
      case "billing.review.submit": {
        const m = INVOICE_TOKEN.exec(before);
        const v = m?.[1] ?? (PLAIN_VERSION.test(before) ? before : null);
        if (v === null) throw new ValidationError("PREPARED_CHANGE_INVALID");
        return {
          body: withDeadline({ invoiceId: action.target.recordRef, expectedVersion: v, reasonCode: str(c.reasonCode) ?? "CHARGE_QUESTIONED", authority: a.authority, actingPartyId: a.actingPartyRef }),
          base: null,
          slotId: null,
        };
      }
      case "provider.availability.block": {
        const m = SLOT_TOKEN.exec(before);
        if (!m?.[1]) throw new ValidationError("PREPARED_CHANGE_INVALID");
        return {
          body: withDeadline({ providerId: action.subjectId, slotId: action.target.recordRef, slotVersion: m[1], reasonCode: str(c.reasonCode) ?? "PROVIDER_UNAVAILABLE", authority: a.authority, actingPartyId: a.actingPartyRef }),
          base: null,
          slotId: null,
        };
      }
    }
  }

  /** Completes a body that needs the slot's version, read right before the write (a failed read is NOT_STARTED). */
  private async completeBody(plan: WritePlan): Promise<Record<string, unknown>> {
    if (plan.base === null || plan.slotId === null) throw new ValidationError("PREPARED_CHANGE_INVALID");
    const slotId = plan.slotId;
    const slot = await beforeWrite(() => this.scheduling().slot(slotId));
    if (!slot) throw new ConflictError("SLOT_UNAVAILABLE");
    return { ...plan.base, slotVersion: slot.version };
  }

  /**
   * What a change found under the action's request id must show to be this action's change: the system's digest
   * of the body the action sends (when the body follows from the action alone), and the confirmed resource.
   */
  private expectationOf(kind: DomainActionKind, action: CommitSubject, body: Record<string, unknown> | null): PayloadExpectation {
    const shape = WRITES[kind];
    const scheme = this.reconciliationOf(shape).requestDigest;
    const requestDigest = scheme !== null && body !== null ? requestDigestOf(scheme, shape.operation, body) : null;
    const c = action.change;
    const slotId = str(c.slotId) ?? undefined;
    const startsAt = str(c.toStartsAt) ?? undefined;
    switch (kind) {
      case "appointment.create":
        return { requestDigest, resourceSlotId: slotId, resourceSubjectId: action.subjectId, resourceStartsAt: startsAt };
      case "appointment.reschedule":
      case "provider.appointment.reschedule":
        return { requestDigest, resourceId: action.target.recordRef, resourceSlotId: slotId, resourceStartsAt: startsAt };
      case "billing.review.submit":
        return { requestDigest, resourceId: action.target.recordRef, resourceSubjectId: action.subjectId };
      case "appointment.cancel":
      case "provider.appointment.cancel":
      case "provider.availability.block":
        return { requestDigest, resourceId: action.target.recordRef };
    }
  }

  /** The body of an action that follows from the action alone (no I/O), or null. */
  private deterministicBody(kind: DomainActionKind, action: CommitSubject): Record<string, unknown> | null {
    try {
      return this.planOf(kind, action, commitAuthorityOf(action)).body;
    } catch {
      return null;
    }
  }

  /** The receipt in the business layer's receipt-bound evidence shape, from the system's change record. */
  private committedResult(kind: DomainActionKind, action: CommitSubject, change: ChangeState): DomainCommitResult & DomainLookupResult {
    const shape = WRITES[kind];
    if (change.operation !== shape.operation || change.receiptId === null || change.resourceId === null || change.resourceVersion === null) throw new DependencyError("RECEIPT_INCONSISTENT", "UNKNOWN", false);
    // A change on another record than the confirmed one is never claimed.
    if (kind !== "appointment.create" && change.resourceId !== action.target.recordRef) throw new DependencyError("RECEIPT_TARGET_MISMATCH", "UNKNOWN", false);
    let evidence: Record<string, unknown>;
    if (shape.resourceType === "appointment") {
      if (change.resourceStartsAt === null || change.resourceTimeZone === null) throw new DependencyError("RECEIPT_INCOMPLETE", "UNKNOWN", false);
      evidence = { appointmentId: change.resourceId, startsAt: change.resourceStartsAt, timeZone: change.resourceTimeZone, status: statusAfter(kind) };
    } else if (shape.resourceType === "invoice") {
      evidence = { invoiceId: change.resourceId, status: statusAfter(kind) };
    } else {
      evidence = { slotId: change.resourceId, state: statusAfter(kind) };
    }
    return { outcome: "COMMITTED", providerReference: change.receiptId, afterVersion: change.resourceVersion, evidence };
  }

  // ---------------------------------------------------------------- lookup (reconciliation by key)

  async lookup(action: CommitSubject, providerIdempotencyKey: string): Promise<DomainLookupResult> {
    const decision = await this.reconcileDecision(action, providerIdempotencyKey);
    if (decision.outcome === "COMMITTED") return this.committedResult(domainKindOf(action), action, decision.change);
    return { outcome: decision.outcome };
  }

  /** The full reconciliation decision with its reason (for tests, operators and the evaluation drivers). */
  async reconcileDecision(action: CommitSubject, providerIdempotencyKey: string): Promise<LookupDecision> {
    const kind = domainKindOf(action);
    const shape = WRITES[kind];
    const changes = this.changesFor(shape);
    const rec = this.reconciliationOf(shape);
    const requestId = requestIdFor(providerIdempotencyKey);
    let found = await changes.lookup(shape.canonical, requestId);
    let absent: "NOT_VISIBLE_WITHIN_WINDOW" | "ABSENCE_NOT_PROVABLE" | "FENCE_NOT_DUE" = "ABSENCE_NOT_PROVABLE";
    if (found === null) {
      // A 404 is never proof of absence, whatever time has passed (a COMMIT can land after the deadline): once the
      // deadline (+ skew) has passed, the system's fence answers the stored change, or fences the id for good.
      const deadline = this.deadlineOf(shape, action);
      if (rec.fenceOperationId !== null && deadline !== null) {
        if (!fenceDue(Date.parse(deadline), rec.clockSkewAllowanceMs, this.deps.clock.now().getTime())) absent = "NOT_VISIBLE_WITHIN_WINDOW";
        else {
          found = await changes.fence(requestId, shape.operation, deadline);
          if (found === null) absent = "FENCE_NOT_DUE";
        }
      }
    }
    // A fenced id can never carry any change (whatever body): not this action's effect, and none can follow.
    if (found !== null && isFenced(found)) return { outcome: "NOT_FOUND", reasonCode: "REQUEST_FENCED" };
    if (found !== null && found.operation !== shape.operation) return { outcome: "UNKNOWN", reasonCode: "LOOKUP_OPERATION_MISMATCH" };
    // Another request's change under this id is never claimed for this action, whatever its state.
    if (found !== null && !payloadMatches(found, this.expectationOf(kind, action, this.deterministicBody(kind, action)), rec.requestDigest)) return { outcome: "UNKNOWN", reasonCode: "PAYLOAD_MISMATCH" };
    if (found?.state === "INCOMPLETE" && rec.incompleteWrite === "COMPLETE_BY_REQUEST_ID") found = await changes.complete(requestId);
    return decideLookup(found, rec.incompleteWrite, absent);
  }

  // ---------------------------------------------------------------- independent effect verification

  /**
   * Reads the changed record back from the system of record and compares it with what the committed action must
   * have produced: the record named by the receipt, its status and its version; with the commit's
   * `providerReference`, also the system's own receipt for it (GET receipt: the same record, version and
   * operation). Never reads model output or response text (EffectVerification.independentOfModel). A record not
   * readable yet is not a failure inside the binding's visibility window (NOT_FOUND_WITHIN_WINDOW); after it,
   * NOT_FOUND_AFTER_WINDOW.
   */
  async verifyEffect(input: {
    tenantId: string;
    actionId: string;
    causationId: string;
    commitReceiptId: string | null;
    action: CommitSubject;
    receipt: { providerReference: string | null; afterVersion: string | null; evidence: Record<string, unknown>; committedAt: string };
  }): Promise<EffectVerification> {
    const kind = domainKindOf(input.action);
    const shape = WRITES[kind];
    const ev = input.receipt.evidence;
    const recordRef = shape.resourceType === "appointment" ? str(ev.appointmentId) : shape.resourceType === "invoice" ? str(ev.invoiceId) : str(ev.slotId);
    if (recordRef === null) throw new ValidationError("EFFECT_EVIDENCE_INVALID");
    const changes = this.changesFor(shape);
    const rec = this.reconciliationOf(shape);
    const withReceipt = input.receipt.providerReference !== null;
    type ReceiptView = { resourceId: string; resourceVersion: string; operation: string } | null;
    const stateDigestOf = (status: string, version: string | null, receipt: ReceiptView) => sha256Hex(canonicalJson({ recordRef, status, version, receipt }));
    const expectedReceipt: ReceiptView = withReceipt ? { resourceId: recordRef, resourceVersion: input.receipt.afterVersion ?? "", operation: shape.operation } : null;
    const expected = { stateDigest: stateDigestOf(statusAfter(kind), input.receipt.afterVersion, expectedReceipt), version: input.receipt.afterVersion };
    let observed: { status: string; version: string } | null;
    if (shape.resourceType === "invoice") {
      const inv = await this.billing().invoice(recordRef);
      observed = inv ? { status: inv.status, version: inv.version } : null;
    } else if (shape.resourceType === "slot") {
      const slot = await this.scheduling().slot(recordRef);
      observed = slot ? { status: slot.state, version: slot.version } : null;
    } else {
      const appt = await this.scheduling().appointment(recordRef);
      observed = appt ? { status: appt.status, version: appt.version } : null;
    }
    // The system's own receipt for the commit (absent: a receipt the system does not know never verifies).
    let observedReceipt: ReceiptView = null;
    if (withReceipt) {
      const r = await orNull(() => changes.receipt(input.receipt.providerReference as string));
      observedReceipt = r === null ? { resourceId: "", resourceVersion: "", operation: "RECEIPT_NOT_FOUND" } : { resourceId: r.resourceId, resourceVersion: r.resourceVersion, operation: r.operation };
    }
    const now = this.deps.clock.now();
    const windowEndsAt = new Date(Date.parse(input.receipt.committedAt) + rec.visibilityWindowMs + rec.clockSkewAllowanceMs).toISOString();
    const observedDigest = observed ? stateDigestOf(observed.status, input.receipt.afterVersion === null ? null : observed.version, observedReceipt) : null;
    const result: EffectVerification["result"] =
      observed === null ? (now.getTime() <= Date.parse(windowEndsAt) ? "NOT_FOUND_WITHIN_WINDOW" : "NOT_FOUND_AFTER_WINDOW") : observedDigest === expected.stateDigest ? "VERIFIED" : "MISMATCH";
    const record = {
      schemaVersion: "effect-verification.v1" as const,
      tenantId: input.tenantId,
      causationId: input.causationId,
      occurredAt: now.toISOString(),
      caseId: null,
      workflowId: null,
      interactionId: null,
      verificationId: newId("efv"),
      actionId: input.actionId,
      commitReceiptId: input.commitReceiptId,
      method: "AUTHORITATIVE_READ_BACK" as const,
      target: { system: input.action.target.system, recordType: shape.resourceType === "slot" ? "appointment_slot" : shape.resourceType, recordRef },
      expected,
      observed: observed === null ? null : { stateDigest: observedDigest, version: observed.version, observedAt: now.toISOString(), sourceEventRef: null },
      result,
      visibilityWindowEndsAt: windowEndsAt,
      evidenceRef: `evidence://domain/effect-verification/${input.actionId}`,
      evidenceDigest: sha256Hex(canonicalJson({ expected, observed, observedReceipt })),
      verifier: { component: "domain.commit_port", connectorProfileRef: null, independentOfModel: true as const },
    };
    const parsed = EffectVerificationSchema.safeParse(record);
    if (!parsed.success) throw new ValidationError("EFFECT_VERIFICATION_INVALID");
    return parsed.data;
  }

  // ---------------------------------------------------------------- domain commands without a ledger kind

  /**
   * Commits a prepared provider action that has NO ledger ActionKind yet (provider.availability.block; WP-25 adds
   * the kind and its policy). Same protocol as the ledger path: one stable key (the caller's command key, persisted
   * by the caller before the call), the system re-checks the version and the provider's authority, and an
   * unknown outcome is reconciled by key, never retried blindly. Refused before any I/O when:
   *   - the kind has a ledger kind (DOMAIN_KIND_REQUIRES_LEDGER): a client or provider action the ledger knows runs
   *     only through the ledger's digest-bound confirmation, policy decision and commit slot, never here;
   *   - the preparation is not the acting party's own, was modified since `prepare` (its digest covers its times),
   *     is not of the party's role family, or lacks the authority its kind requires;
   *   - its expiry is not the prepare TTL after a preparation time on or before now (+ skew)
   *     (DOMAIN_PREPARATION_EXPIRY_INVALID), or has passed (DOMAIN_PREPARATION_EXPIRED).
   * The write's dispatch deadline comes from the preparation's own expiry (never from the caller).
   */
  async commitCommand(party: ActingParty, preparation: DomainPreparation, commandKey: string): Promise<DomainCommitResult | { outcome: "UNKNOWN" | "NOT_FOUND"; reasonCode: string }> {
    if (preparation.ledgerKind !== null || ledgerKindOf(preparation.domainKind) !== null) throw new AccessDeniedError("DOMAIN_KIND_REQUIRES_LEDGER");
    assertPreparedFor(party, preparation.input);
    if (preparation.digest !== preparationDigest(preparation)) throw new AccessDeniedError("DOMAIN_PREPARATION_MODIFIED");
    // The party's role must be the kind's family (a provider never commits a client action, nor the reverse).
    authorityFor(preparation.domainKind, party);
    if (preparation.input.change.authority !== AUTHORITY_OF_KIND[preparation.domainKind]) throw new AccessDeniedError("DOMAIN_AUTHORITY_MISMATCH");
    const preparedMs = Date.parse(preparation.preparedAt);
    const expiresMs = Date.parse(preparation.expiresAt);
    const nowMs = this.deps.clock.now().getTime();
    if (!Number.isFinite(preparedMs) || !Number.isFinite(expiresMs) || expiresMs - preparedMs !== PREPARE_TTL_SECONDS * 1000 || preparedMs > nowMs + PREPARED_AT_SKEW_MS) {
      throw new AccessDeniedError("DOMAIN_PREPARATION_EXPIRY_INVALID");
    }
    if (nowMs >= expiresMs) throw new AccessDeniedError("DOMAIN_PREPARATION_EXPIRED");
    const subject: CommitSubject = { kind: preparation.domainKind, subjectId: party.partyRef, target: preparation.input.target, change: preparation.input.change, expiresAt: preparation.expiresAt };
    try {
      return await this.commit(subject, commandKey);
    } catch (e) {
      if (e instanceof DependencyError && e.outcome === "NOT_STARTED") throw e;
      const decision = await this.reconcileDecision(subject, commandKey);
      if (decision.outcome === "COMMITTED") return this.committedResult(preparation.domainKind, subject, decision.change);
      return { outcome: decision.outcome, reasonCode: decision.reasonCode };
    }
  }
}

interface WritePlan {
  /** The full request body, or null when it needs the slot's version (`base` + `slotId`). */
  body: Record<string, unknown> | null;
  base: Record<string, unknown> | null;
  slotId: string | null;
}

/** The ledger reason of a change the system REJECTED (its failure code; a moved version is STATE_CHANGED). */
function failureReasonOf(code: string | null): string {
  if (code === null || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return "PROVIDER_REJECTED";
  if (code === "VERSION_CONFLICT" || code === "STATE_CONFLICT") return "STATE_CHANGED";
  return code;
}

/** Definite refusals of a keyed write (the system re-checked versions and authority and said no). */
function refusalResult(e: unknown): DomainCommitResult | null {
  // Refused by the runtime before any request existed (not declared, not enabled, scope): the same call is refused again.
  if (e instanceof ConnectorRefusal) return { outcome: "FAILED", reasonCode: e.reasonCode, permanent: true };
  if (e instanceof ConflictError) return { outcome: "FAILED", reasonCode: e.reasonCode === "SLOT_UNAVAILABLE" ? "SLOT_UNAVAILABLE" : "STATE_CHANGED", permanent: true };
  if (!(e instanceof ConnectorError) || e.outcome !== "FAILED") return null;
  switch (e.reasonCode) {
    case "CONNECTOR_CONFLICT":
      // A version moved since the party confirmed (or the request's deadline passed before it could be applied):
      // nothing was applied; the ledger invalidates the action (re-prepare, re-confirm).
      return { outcome: "FAILED", reasonCode: "STATE_CHANGED", permanent: true };
    case "CONNECTOR_FORBIDDEN":
      return { outcome: "FAILED", reasonCode: "AUTHORITY_REFUSED", permanent: true };
    case "CONNECTOR_NOT_FOUND":
      return { outcome: "FAILED", reasonCode: "TARGET_NOT_FOUND", permanent: true };
    case "CONNECTOR_REQUEST_REJECTED":
      return { outcome: "FAILED", reasonCode: "PROVIDER_REJECTED", permanent: true };
    default:
      return null;
  }
}

/** Throws AccessDeniedError when the change was not prepared for this party (used by tests and the composition). */
export function assertPreparedFor(party: ActingParty, input: DomainPrepareInput): void {
  if (input.change.actingPartyRef !== party.partyRef) throw new AccessDeniedError("DOMAIN_ACTING_PARTY_MISMATCH");
}

export type { LookupDecision };
