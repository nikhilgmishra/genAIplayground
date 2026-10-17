/**
 * LOCAL FIXTURE — mutable in-memory copy of the SYNTHETIC world
 * (platform/src/fixtures/synthetic-world.ts). NOT REAL PEOPLE, NOT PHI.
 *
 * Every LOCAL fixture adapter reads and writes one SyntheticStore so tests can
 * observe cross-adapter effects (a reschedule frees one slot and books another;
 * an expired grant changes relationship facts). The canonical world constants
 * are never mutated: the store deep-copies them on construction and on
 * `reset()`, so each test can start from the same state.
 *
 * Version counters:
 *  - versioned records (appointments, invoices) carry `version` "vN", bumped on
 *    every update (optimistic concurrency for reschedule / billing review);
 *  - `revision` counts every mutation of the store, `collectionRevision(c)` per
 *    collection, so tests can assert that a replay or a failed call changed
 *    nothing;
 *  - the version of each record immediately before its latest change is kept so
 *    the STALE_READ fault can serve it.
 *
 * Accessors return copies: callers cannot mutate the store except through
 * `update` / `insert`.
 */
import {
  APPOINTMENTS,
  CLAIMS,
  DELEGATIONS,
  DESTINATIONS,
  INVOICES,
  ONBOARDING,
  ORGANIZATIONS,
  PEOPLE,
  REMITTANCES,
  SLOTS,
  SYNTHETIC_BADGE,
  TREATING_RELATIONSHIPS,
  type SyntheticPerson,
} from "../../fixtures/synthetic-world.js";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import type { Appointment, ClaimStatus, Invoice, OnboardingStatus, Remittance, Slot } from "../ports.js";

export const LOCAL_FIXTURE_LABEL = "LOCAL FIXTURE — SYNTHETIC DATA ONLY";
export { SYNTHETIC_BADGE };

export type StoredPerson = SyntheticPerson;

export interface StoredOrganization {
  organizationId: string;
  kind: "practice" | "partner";
  displayName: string;
}

/** Authoritative delegation / enrollment / legal-authority record (as held by the registries). */
export interface StoredDelegation {
  grantId: string;
  kind: "practice_delegation" | "partner_affiliation" | "legal_representative" | "parental_authority";
  actorId: string;
  subjectId: string | null;
  organizationId: string | null;
  scopes: string[];
  source: "enrollment_system" | "delegation_registry" | "partner_contract_registry" | "legal_authority_registry";
  validFrom: string;
  validUntil: string | null;
  /** Registry constraint codes. Kept as strings so tests can model unknown codes (mapped fail-closed). */
  constraints: string[];
}

export interface StoredTreatingRelationship {
  relationshipId: string;
  providerActorId: string;
  clientSubjectId: string;
  validUntil: string | null;
}

export interface StoredAppointment extends Appointment {
  providerActorId: string;
  /** Slot this appointment currently holds (null for the seeded appointments). */
  slotId: string | null;
}

export type SlotHold =
  | { kind: "appointment"; appointmentId: string }
  /** Booked through another channel (simulated concurrent booking). */
  | { kind: "external" }
  /** First step of a partially applied write, keyed by its idempotency key. */
  | { kind: "pending"; idempotencyKey: string };

export interface StoredSlot extends Slot {
  providerActorId: string;
  heldBy: SlotHold | null;
}

export type StoredInvoice = Invoice;
export type StoredClaim = ClaimStatus;
export type StoredOnboarding = OnboardingStatus;
export type StoredRemittance = Remittance;

export interface StoredDestination {
  destinationId: string;
  purpose: string;
  vendorQueueRef: string;
  fallbackDestinationIds: string[];
  languages: string[];
}

export interface SyntheticCollections {
  people: StoredPerson;
  organizations: StoredOrganization;
  delegations: StoredDelegation;
  treatingRelationships: StoredTreatingRelationship;
  appointments: StoredAppointment;
  slots: StoredSlot;
  invoices: StoredInvoice;
  claims: StoredClaim;
  onboarding: StoredOnboarding;
  remittances: StoredRemittance;
  destinations: StoredDestination;
}
export type CollectionName = keyof SyntheticCollections;
export const COLLECTIONS: readonly CollectionName[] = [
  "people",
  "organizations",
  "delegations",
  "treatingRelationships",
  "appointments",
  "slots",
  "invoices",
  "claims",
  "onboarding",
  "remittances",
  "destinations",
];

const ID_OF: { [K in CollectionName]: (r: SyntheticCollections[K]) => string } = {
  people: (r) => r.actorId,
  organizations: (r) => r.organizationId,
  delegations: (r) => r.grantId,
  treatingRelationships: (r) => r.relationshipId,
  appointments: (r) => r.appointmentId,
  slots: (r) => r.slotId,
  invoices: (r) => r.invoiceId,
  claims: (r) => r.claimId,
  onboarding: (r) => r.providerId,
  remittances: (r) => r.remittanceId,
  destinations: (r) => r.destinationId,
};

type State = { [K in CollectionName]: Map<string, SyntheticCollections[K]> };

const clone = <T>(v: T): T => structuredClone(v);

/** Builds a fresh deep copy of the canonical SYNTHETIC world. */
function seedState(): State {
  const people: StoredPerson[] = Object.values(PEOPLE).map((p) => {
    const person: StoredPerson = {
      actorId: p.actorId,
      accountId: p.accountId,
      subjectId: p.subjectId,
      role: p.role,
      displayName: p.displayName,
      fullName: p.fullName,
      dateOfBirth: p.dateOfBirth,
      idpIssuer: p.idpIssuer,
      idpSubject: p.idpSubject,
      channels: p.channels.map((c) => ({ ...c })),
      organizationId: p.organizationId,
      accountState: p.accountState,
    };
    if ("isMinor" in p) person.isMinor = p.isMinor;
    return person;
  });
  const organizations: StoredOrganization[] = Object.values(ORGANIZATIONS).map((o) => ({ ...o }));
  const delegations: StoredDelegation[] = DELEGATIONS.map((d) => ({
    grantId: d.grantId,
    kind: d.kind,
    actorId: d.actorId,
    subjectId: d.subjectId,
    organizationId: d.organizationId,
    scopes: [...d.scopes],
    source: d.source,
    validFrom: d.validFrom,
    validUntil: d.validUntil,
    constraints: "constraints" in d ? [...d.constraints] : [],
  }));
  const treatingRelationships: StoredTreatingRelationship[] = TREATING_RELATIONSHIPS.map((t, i) => ({
    relationshipId: `trl_synthTreating${String(i + 1).padStart(5, "0")}`,
    providerActorId: t.providerActorId,
    clientSubjectId: t.clientSubjectId,
    validUntil: t.validUntil,
  }));
  const appointments: StoredAppointment[] = APPOINTMENTS.map((a) => ({ ...a, slotId: null }));
  const slots: StoredSlot[] = SLOTS.map((s) => ({ ...s, heldBy: null }));
  const invoices: StoredInvoice[] = INVOICES.map((inv) => ({ ...inv, lines: inv.lines.map((l) => ({ ...l })) }));
  const claims: StoredClaim[] = CLAIMS.map((c) => ({ ...c }));
  const onboarding: StoredOnboarding[] = ONBOARDING.map((o) => ({ ...o, missingDocumentTypes: [...o.missingDocumentTypes] }));
  const remittances: StoredRemittance[] = REMITTANCES.map((r) => ({ ...r }));
  const destinations: StoredDestination[] = DESTINATIONS.map((d) => ({
    destinationId: d.destinationId,
    purpose: d.purpose,
    vendorQueueRef: d.vendorQueueRef,
    fallbackDestinationIds: [...d.fallbackDestinationIds],
    languages: [...d.languages],
  }));
  const toMap = <K extends CollectionName>(c: K, rows: SyntheticCollections[K][]): Map<string, SyntheticCollections[K]> =>
    new Map(rows.map((r) => [ID_OF[c](r), r]));
  return {
    people: toMap("people", people),
    organizations: toMap("organizations", organizations),
    delegations: toMap("delegations", delegations),
    treatingRelationships: toMap("treatingRelationships", treatingRelationships),
    appointments: toMap("appointments", appointments),
    slots: toMap("slots", slots),
    invoices: toMap("invoices", invoices),
    claims: toMap("claims", claims),
    onboarding: toMap("onboarding", onboarding),
    remittances: toMap("remittances", remittances),
    destinations: toMap("destinations", destinations),
  };
}

/** "v3" -> "v4". Versions are opaque to callers but must strictly increase here. */
export function nextVersion(version: string): string {
  const m = /^v(\d{1,9})$/.exec(version);
  if (!m || m[1] === undefined) throw new ValidationError("FIXTURE_VERSION_FORMAT_INVALID");
  return `v${Number(m[1]) + 1}`;
}

const isVersioned = (r: unknown): r is { version: string } =>
  typeof r === "object" && r !== null && typeof (r as { version?: unknown }).version === "string";

export class SyntheticStore {
  readonly kind = "local_fixture" as const;
  readonly label = LOCAL_FIXTURE_LABEL;
  readonly badge = SYNTHETIC_BADGE;
  private state: State;
  private previous = new Map<string, unknown>();
  private rev = 0;
  private collectionRevs = new Map<CollectionName, number>();
  private seq = 0;

  constructor() {
    this.state = seedState();
  }

  /** Restores the canonical SYNTHETIC world and zeroes every counter. */
  reset(): void {
    this.state = seedState();
    this.previous.clear();
    this.rev = 0;
    this.collectionRevs.clear();
    this.seq = 0;
  }

  /** Total number of mutations since construction / reset. */
  get revision(): number {
    return this.rev;
  }

  collectionRevision(c: CollectionName): number {
    return this.collectionRevs.get(c) ?? 0;
  }

  /** Monotonic sequence shared by fixture effect logs (deterministic ordering across adapters). */
  nextSequence(): number {
    return ++this.seq;
  }

  get<K extends CollectionName>(c: K, id: string): SyntheticCollections[K] | null {
    const r = this.state[c].get(id);
    return r === undefined ? null : clone(r);
  }

  list<K extends CollectionName>(c: K): SyntheticCollections[K][] {
    return [...this.state[c].values()].map(clone);
  }

  /** The record as it was immediately before its latest change (null if never changed). */
  previousVersion<K extends CollectionName>(c: K, id: string): SyntheticCollections[K] | null {
    const r = this.previous.get(`${c}:${id}`) as SyntheticCollections[K] | undefined;
    return r === undefined ? null : clone(r);
  }

  /** Stale view of a record: its previous version when it has one, otherwise the current one. */
  staleGet<K extends CollectionName>(c: K, id: string): SyntheticCollections[K] | null {
    return this.previousVersion(c, id) ?? this.get(c, id);
  }

  staleList<K extends CollectionName>(c: K): SyntheticCollections[K][] {
    return [...this.state[c].entries()].map(([id, r]) => this.previousVersion(c, id) ?? clone(r));
  }

  /**
   * Applies `fn` to a draft copy and stores it. Versioned records get their
   * version bumped (unless `fn` changed it explicitly). Returns a copy.
   */
  update<K extends CollectionName>(c: K, id: string, fn: (draft: SyntheticCollections[K]) => void): SyntheticCollections[K] {
    const current = this.state[c].get(id);
    if (current === undefined) throw new ValidationError("FIXTURE_RECORD_NOT_FOUND");
    const draft = clone(current);
    fn(draft);
    if (ID_OF[c](draft) !== id) throw new ValidationError("FIXTURE_RECORD_ID_IMMUTABLE");
    if (isVersioned(current) && isVersioned(draft) && draft.version === current.version) draft.version = nextVersion(current.version);
    this.previous.set(`${c}:${id}`, clone(current));
    this.state[c].set(id, draft);
    this.bump(c);
    return clone(draft);
  }

  insert<K extends CollectionName>(c: K, record: SyntheticCollections[K]): SyntheticCollections[K] {
    const id = ID_OF[c](record);
    if (this.state[c].has(id)) throw new ConflictError("FIXTURE_RECORD_EXISTS");
    this.state[c].set(id, clone(record));
    this.bump(c);
    return clone(record);
  }

  private bump(c: CollectionName): void {
    this.rev += 1;
    this.collectionRevs.set(c, this.collectionRevision(c) + 1);
  }
}
