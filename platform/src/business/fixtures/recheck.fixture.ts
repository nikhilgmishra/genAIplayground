/**
 * LOCAL FIXTURE — SYNTHETIC DATA ONLY. Not vendor adapters; the production configuration
 * guard rejects every local_fixture component (OPS-04).
 *
 * - LocalAccountStateFixture: AccountStateLookup over the LOCAL FIXTURE identity directory.
 *   The IdentityDirectory port is keyed by account id; the SYNTHETIC directory people map an
 *   actor or subject to it. The CURRENT state is always read from the directory
 *   (setAccountState in tests takes effect immediately). Unknown people read as null
 *   (the recheck fails closed with ACCOUNT_STATE_UNKNOWN). The live lookup is BLOCKED on the
 *   identity owner's account APIs (PRQ-005).
 * - LocalConsentRegistryFixture: in-memory consent registry (per tenant and person ref) of
 *   consent changes recorded AFTER work was accepted; empty by default. A revocation applies
 *   to the next recheck. The live registry is BLOCKED (privacy counsel PRQ-026, identity owner).
 */
import type { IdentityDirectory } from "../../adapters/ports.js";
import { syntheticDirectoryPeople } from "../../adapters/local/identity-directory.js";
import { ConsentValue, OpaqueId } from "../../protocol/index.js";
import { iso, systemClock, type Clock } from "../../shared/clock.js";
import { ValidationError } from "../../shared/errors.js";
import type { AccountStateLookup, AccountStateValue, ConsentRegistry } from "../recheck.js";

export const RECHECK_FIXTURE_LABEL = "LOCAL FIXTURE — SYNTHETIC DATA ONLY";

export interface FixturePersonAccount {
  actorId: string;
  accountId: string;
  subjectId: string | null;
}

export class LocalAccountStateFixture implements AccountStateLookup {
  readonly kind = "local_fixture" as const;
  readonly label = RECHECK_FIXTURE_LABEL;
  private readonly byActor = new Map<string, string>();
  private readonly bySubject = new Map<string, string>();

  constructor(
    private readonly directory: Pick<IdentityDirectory, "accountState">,
    people: readonly FixturePersonAccount[] = syntheticDirectoryPeople(),
  ) {
    for (const p of people) {
      this.byActor.set(p.actorId, p.accountId);
      if (p.subjectId !== null) this.bySubject.set(p.subjectId, p.accountId);
    }
  }

  async forActor(actorId: string): Promise<AccountStateValue | null> {
    const account = this.byActor.get(actorId);
    return account ? this.directory.accountState(account) : null;
  }

  async forSubject(subjectId: string): Promise<AccountStateValue | null> {
    const account = this.bySubject.get(subjectId);
    return account ? this.directory.accountState(account) : null;
  }
}

export class LocalConsentRegistryFixture implements ConsentRegistry {
  readonly kind = "local_fixture" as const;
  readonly label = RECHECK_FIXTURE_LABEL;
  private readonly records = new Map<string, { automatedProcessing: ConsentValue; recordedAt: string }>();

  constructor(private readonly clock: Clock = systemClock) {}

  private static key(tenantId: string, personRef: string): string {
    if (!OpaqueId.safeParse(tenantId).success || !OpaqueId.safeParse(personRef).success) throw new ValidationError("CONSENT_REGISTRY_INPUT_INVALID");
    return `${tenantId}\u0000${personRef}`;
  }

  async current(tenantId: string, personRef: string): Promise<{ automatedProcessing: ConsentValue; recordedAt: string } | null> {
    const r = this.records.get(LocalConsentRegistryFixture.key(tenantId, personRef));
    return r ? { ...r } : null;
  }

  /** Records a consent change for a person (LOCAL FIXTURE control: the trusted consent flow in deployment). */
  record(tenantId: string, personRef: string, automatedProcessing: ConsentValue): void {
    this.records.set(LocalConsentRegistryFixture.key(tenantId, personRef), { automatedProcessing: ConsentValue.parse(automatedProcessing), recordedAt: iso(this.clock.now()) });
  }

  /** The person withdraws consent for automated processing and disclosure. */
  revoke(tenantId: string, personRef: string): void {
    this.record(tenantId, personRef, "DECLINED");
  }
}
