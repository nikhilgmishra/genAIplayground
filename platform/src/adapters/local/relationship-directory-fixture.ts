/**
 * LOCAL FIXTURE — RelationshipDirectory over the SYNTHETIC enrollment,
 * delegation, partner-contract and legal-authority registries
 * (DELEGATIONS, TREATING_RELATIONSHIPS and self relationships in
 * platform/src/fixtures/synthetic-world.ts). NOT a vendor adapter; rejected by
 * the production configuration guard (OPS-04). The live directory is BLOCKED
 * (live/business-systems-blocked.ts; PRQ-005 identity owner, PRQ-007).
 *
 * Relationship facts come ONLY from these authoritative records, never from a
 * caller's statement, a provider identifier or an e-mail domain (spec section 4,
 * AUTH-05). Every fact is strictly validated against the protocol
 * RelationshipFact schema before it is returned.
 *
 * Mapping (registry record -> fact):
 *   self (person with a subject record, role must match)  -> "self"               source identity_provider
 *   treating relationship (provider -> client)            -> "treating_provider"  source enrollment_system
 *   practice_delegation from enrollment_system            -> "practice_member"    (role provider)
 *   practice_delegation from delegation_registry          -> "practice_delegate"  (role practice_staff)
 *   partner_affiliation from partner_contract_registry    -> "partner_affiliate"  (role partner / payer_representative)
 *   legal_representative / parental_authority             -> same type            (role personal_representative)
 * A multi-role user selects one role; facts for other roles are never returned
 * (privileges are never combined silently, spec section 4).
 *
 * Fail-closed rules:
 *  - expired grants are RETURNED with `validUntil` and the AUTHORIZATION_EXPIRED
 *    constraint so policy can deny and route to a human ("expired authorization"
 *    is a human boundary in spec section 4) instead of silently forgetting them;
 *  - grants that are not yet effective (validFrom in the future) are omitted;
 *  - a registry constraint the protocol cannot represent drops the WHOLE fact
 *    (dropping only the constraint would widen access);
 *  - representative facts over a minor subject always carry
 *    MINOR_CONFIDENTIALITY_REVIEW (conservative LOCAL FIXTURE rule pending
 *    privacy counsel's determination on minors, PRQ-027);
 *  - a record that fails the strict schema is omitted (no authority).
 *
 * Self and treating-provider scope sets below are LOCAL FIXTURE values, not an
 * approved permission matrix.
 */
import { z } from "zod";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { OpaqueId, RelationshipFact, Role } from "../../protocol/index.js";
import { systemClock, type Clock } from "../../shared/clock.js";
import { ValidationError } from "../../shared/errors.js";
import type { AdapterHealth, RelationshipDirectory } from "../ports.js";
import { READ_FAULTS, noFaults, type FaultInjector } from "./faults.js";
import { LOCAL_FIXTURE_LABEL, type StoredDelegation, type StoredPerson, type SyntheticStore } from "./synthetic-store.js";

type FactType = RelationshipFact["type"];
type FactConstraint = RelationshipFact["constraints"][number];

const KNOWN_CONSTRAINTS: ReadonlySet<string> = new Set(RelationshipFact.shape.constraints.element.options);

/** LOCAL FIXTURE self-access scopes per role (subject records only exist for clients and providers). */
export const FIXTURE_SELF_SCOPES: Partial<Record<Role, readonly string[]>> = {
  client: ["appointment:read", "appointment:write", "invoice:read", "billing_review:create", "claim:read", "case:read", "case:create"],
  /** appointment:list_options: the provider's own open administrative slots (policy path provider_own_schedule). */
  provider: ["onboarding:read", "case:read", "case:create", "appointment:list_options"],
};
/**
 * LOCAL FIXTURE scopes a treating relationship contributes (administrative appointment facts
 * and open administrative times only; policy actions appointment:read and appointment:list_options).
 */
export const FIXTURE_TREATING_SCOPES: readonly string[] = ["appointment:read", "appointment:list_options"];

interface GrantMapping {
  kind: StoredDelegation["kind"];
  source: StoredDelegation["source"];
  type: FactType;
  roles: readonly Role[];
}

export const GRANT_MAPPINGS: readonly GrantMapping[] = [
  { kind: "practice_delegation", source: "enrollment_system", type: "practice_member", roles: ["provider"] },
  { kind: "practice_delegation", source: "delegation_registry", type: "practice_delegate", roles: ["practice_staff"] },
  { kind: "partner_affiliation", source: "partner_contract_registry", type: "partner_affiliate", roles: ["partner", "payer_representative"] },
  { kind: "legal_representative", source: "legal_authority_registry", type: "legal_representative", roles: ["personal_representative"] },
  { kind: "parental_authority", source: "legal_authority_registry", type: "parental_authority", roles: ["personal_representative"] },
];

const REPRESENTATIVE_TYPES: ReadonlySet<FactType> = new Set<FactType>(["legal_representative", "parental_authority"]);

const Input = z.strictObject({ actorId: OpaqueId, role: Role });

export interface RelationshipDirectoryFixtureOptions {
  store: SyntheticStore;
  faults?: FaultInjector;
  clock?: Clock;
  logger?: Logger;
}

export const RELATIONSHIP_FIXTURE_OPERATIONS = { relationshipsFor: READ_FAULTS } as const;

export class RelationshipDirectoryFixture implements RelationshipDirectory {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "relationship-directory";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly store: SyntheticStore;
  private readonly faults: FaultInjector;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(opts: RelationshipDirectoryFixtureOptions) {
    this.store = opts.store;
    this.faults = opts.faults ?? noFaults();
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "relationship_directory_fixture" });
    this.faults.declare(this.integrationId, RELATIONSHIP_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async relationshipsFor(actorId: string, role: Role): Promise<RelationshipFact[]> {
    const parsed = Input.safeParse({ actorId, role });
    if (!parsed.success) throw new ValidationError("RELATIONSHIP_INPUT_INVALID");
    const f = this.faults.begin(this.integrationId, "relationshipsFor");
    await f.beforeSend();
    const stale = f.has("STALE_READ");
    const people = stale ? this.store.staleList("people") : this.store.list("people");
    const delegations = stale ? this.store.staleList("delegations") : this.store.list("delegations");
    const treating = stale ? this.store.staleList("treatingRelationships") : this.store.list("treatingRelationships");
    const nowMs = this.clock.now().getTime();
    const personBySubject = new Map(people.filter((p) => p.subjectId !== null).map((p) => [p.subjectId as string, p]));

    const candidates: { fact: unknown; recordRef: string }[] = [];
    const self = people.find((p) => p.actorId === actorId);
    if (self) {
      const fact = this.selfFact(self, role);
      if (fact) candidates.push({ fact, recordRef: self.actorId });
    }
    if (role === "provider") {
      for (const t of treating.filter((t) => t.providerActorId === actorId)) {
        candidates.push({
          recordRef: t.relationshipId,
          fact: {
            type: "treating_provider",
            actorId,
            subjectId: t.clientSubjectId,
            organizationId: null,
            scopes: [...FIXTURE_TREATING_SCOPES],
            source: "enrollment_system",
            validUntil: t.validUntil,
            constraints: expiryConstraints(t.validUntil, nowMs),
          },
        });
      }
    }
    for (const d of delegations.filter((x) => x.actorId === actorId)) {
      const mapping = GRANT_MAPPINGS.find((m) => m.kind === d.kind && m.source === d.source);
      if (!mapping) {
        this.logger.warn("fixture.relationships.record_unmapped", { grantId: d.grantId, reasonCode: "RELATIONSHIP_RECORD_UNMAPPED" });
        continue;
      }
      if (!mapping.roles.includes(role)) continue;
      const validFromMs = Date.parse(d.validFrom);
      if (!Number.isFinite(validFromMs) || validFromMs > nowMs) continue; // not yet effective (or unreadable): no authority
      if (d.constraints.some((c) => !KNOWN_CONSTRAINTS.has(c))) {
        this.logger.warn("fixture.relationships.constraint_unmapped", { grantId: d.grantId, reasonCode: "RELATIONSHIP_CONSTRAINT_UNMAPPED" });
        continue;
      }
      const constraints = new Set<FactConstraint>(d.constraints as FactConstraint[]);
      for (const c of expiryConstraints(d.validUntil, nowMs)) constraints.add(c);
      const subject = d.subjectId === null ? undefined : personBySubject.get(d.subjectId);
      if (REPRESENTATIVE_TYPES.has(mapping.type) && subject?.isMinor === true) constraints.add("MINOR_CONFIDENTIALITY_REVIEW");
      candidates.push({
        recordRef: d.grantId,
        fact: {
          type: mapping.type,
          actorId,
          subjectId: d.subjectId,
          organizationId: d.organizationId,
          scopes: [...d.scopes],
          source: d.source,
          validUntil: d.validUntil,
          constraints: [...constraints].sort(),
        },
      });
    }

    const facts: RelationshipFact[] = [];
    for (const c of candidates) {
      const checked = RelationshipFact.safeParse(c.fact);
      if (checked.success) facts.push(checked.data);
      else this.logger.warn("fixture.relationships.record_invalid", { recordRef: c.recordRef, reasonCode: "RELATIONSHIP_RECORD_INVALID" });
    }
    return facts.sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        (a.subjectId ?? "").localeCompare(b.subjectId ?? "") ||
        (a.organizationId ?? "").localeCompare(b.organizationId ?? ""),
    );
  }

  // ---------------- LOCAL FIXTURE test helpers ----------------

  /** Ends a grant at `at` (registry revocation). */
  revokeGrant(grantId: string, at: string): void {
    this.store.update("delegations", grantId, (d) => {
      d.validUntil = at;
    });
  }

  addGrant(record: StoredDelegation): void {
    this.store.insert("delegations", record);
  }

  private selfFact(person: StoredPerson, role: Role): unknown {
    if (person.role !== role || person.subjectId === null) return null;
    const scopes = FIXTURE_SELF_SCOPES[role];
    if (!scopes) return null;
    return {
      type: "self",
      actorId: person.actorId,
      subjectId: person.subjectId,
      organizationId: person.organizationId,
      scopes: [...scopes],
      source: "identity_provider",
      validUntil: null,
      constraints: [],
    };
  }
}

function expiryConstraints(validUntil: string | null, nowMs: number): FactConstraint[] {
  return validUntil !== null && Date.parse(validUntil) <= nowMs ? ["AUTHORIZATION_EXPIRED"] : [];
}
