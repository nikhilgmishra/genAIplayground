/**
 * LOCAL FIXTURE — restricted identity directory over the SYNTHETIC world
 * (platform/src/fixtures/synthetic-world.ts). NOT REAL PEOPLE, NOT PHI.
 *
 * Models the restricted verification service of spec section 7: name + date of
 * birth (or a portal username hint) LOCATE candidate records; they never
 * authenticate. Matching is exact after normalisation (Unicode NFKC, case fold,
 * whitespace collapse, hyphen/apostrophe variants unified); there is no partial,
 * fuzzy or prefix matching, so the directory cannot be used to explore names.
 *
 * Production configuration rejects this adapter (OPS-04). The live directory is
 * BLOCKED on the identity owner's account-linking and registered-channel APIs.
 */
import { z } from "zod";
import { PEOPLE } from "../../fixtures/synthetic-world.js";
import type { SyntheticPerson } from "../../fixtures/synthetic-world.js";
import type { Role } from "../../protocol/index.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import type { AccountCandidate, AdapterHealth, IdentityDirectory, RegisteredChannel } from "../ports.js";

export interface DirectoryPersonFixture extends Omit<SyntheticPerson, "role" | "channels"> {
  /** A multi-role person holds several roles; the caller selects one, privileges are never combined. */
  roles: Role[];
  portalUsername: string | null;
  channels: RegisteredChannel[];
}

/** Synthetic portal usernames (fixture-only; no real naming scheme implied). */
const SYNTHETIC_USERNAMES: Record<string, string> = {
  [PEOPLE.avery.actorId]: "avery.synthetic",
  [PEOPLE.blake.actorId]: "blake.synthetic",
  [PEOPLE.dana.actorId]: "dana.synthetic",
  [PEOPLE.emery.actorId]: "emery.synthetic",
  [PEOPLE.morgan.actorId]: "morgan.synthetic",
  [PEOPLE.newbie.actorId]: "newbie.synthetic",
  [PEOPLE.riley.actorId]: "riley.synthetic",
  [PEOPLE.quinn.actorId]: "quinn.synthetic",
};

export function syntheticDirectoryPeople(): DirectoryPersonFixture[] {
  return Object.values(PEOPLE).map((p: SyntheticPerson) => ({
    actorId: p.actorId,
    accountId: p.accountId,
    subjectId: p.subjectId,
    roles: [p.role],
    displayName: p.displayName,
    fullName: p.fullName,
    dateOfBirth: p.dateOfBirth,
    idpIssuer: p.idpIssuer,
    idpSubject: p.idpSubject,
    channels: p.channels.map((c) => ({ ...c })),
    organizationId: p.organizationId,
    accountState: p.accountState,
    ...(p.isMinor === undefined ? {} : { isMinor: p.isMinor }),
    portalUsername: SYNTHETIC_USERNAMES[p.actorId] ?? null,
  }));
}

/** Strict locator: name + DOB, or a username hint. Unknown fields (phone numbers, NPI, ...) are rejected. */
export const DirectoryLocator = z.union([
  z.strictObject({
    fullName: z.string().min(1).max(200),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.strictObject({ portalUsernameHint: z.string().min(3).max(64) }),
]);

export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’ʼ]/g, "'")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

const normalizeUsername = (u: string): string => u.normalize("NFKC").toLocaleLowerCase("en-US").trim();

export interface LocalIdentityDirectoryOptions {
  /** Additional SYNTHETIC people for tests (e.g. a duplicate name + DOB to exercise "many matches"). */
  extraPeople?: DirectoryPersonFixture[];
}

export class LocalIdentityDirectoryFixture implements IdentityDirectory {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "identity-directory";
  private readonly people: DirectoryPersonFixture[];
  private unavailable = false;
  /** Count of lookups, so tests can show that enumeration controls stop lookups. */
  lookups = 0;

  constructor(opts: LocalIdentityDirectoryOptions = {}) {
    this.people = [...syntheticDirectoryPeople(), ...(opts.extraPeople ?? []).map((p) => structuredClone(p))];
  }

  async health(): Promise<AdapterHealth> {
    return this.unavailable ? { healthy: false, reasonCode: "FIXTURE_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async findCandidates(locator: { fullName: string; dateOfBirth: string } | { portalUsernameHint: string }): Promise<AccountCandidate[]> {
    this.assertAvailable();
    const parsed = DirectoryLocator.safeParse(locator);
    if (!parsed.success) throw new ValidationError("DIRECTORY_LOCATOR_INVALID");
    this.lookups++;
    const l = parsed.data;
    const matches =
      "fullName" in l
        ? this.people.filter((p) => p.dateOfBirth !== null && p.dateOfBirth === l.dateOfBirth && normalizeName(p.fullName) === normalizeName(l.fullName))
        : this.people.filter((p) => p.portalUsername !== null && normalizeUsername(p.portalUsername) === normalizeUsername(l.portalUsernameHint));
    return matches.map((p) => ({ accountId: p.accountId, actorId: p.actorId, roles: [...p.roles] }));
  }

  async registeredChannels(accountId: string): Promise<RegisteredChannel[]> {
    this.assertAvailable();
    return (this.byAccount(accountId)?.channels ?? []).map((c) => ({ ...c }));
  }

  async accountState(accountId: string): Promise<"ACTIVE" | "LOCKED" | "RECOVERY_IN_PROGRESS" | "CLOSED"> {
    this.assertAvailable();
    // Unknown accounts read as CLOSED: fail closed, never "ACTIVE".
    return this.byAccount(accountId)?.accountState ?? "CLOSED";
  }

  async actorForIdpSubject(issuer: string, sub: string): Promise<string | null> {
    this.assertAvailable();
    const p = this.people.find((x) => x.idpIssuer === issuer && x.idpSubject === sub);
    return p ? p.actorId : null;
  }

  async selfSubjectId(actorId: string, role: Role): Promise<string | null> {
    this.assertAvailable();
    const p = this.byActor(actorId);
    if (!p || !p.roles.includes(role)) return null;
    // Only client and provider records have a "self" subject; staff, partners and representatives act for others via delegation.
    return role === "client" || role === "provider" ? p.subjectId : null;
  }

  async organizationFor(actorId: string, role: Role): Promise<string | null> {
    this.assertAvailable();
    const p = this.byActor(actorId);
    if (!p || !p.roles.includes(role)) return null;
    return p.organizationId;
  }

  // ---------------- test controls (LOCAL FIXTURE only) ----------------

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  setAccountState(accountId: string, state: DirectoryPersonFixture["accountState"]): void {
    const p = this.byAccount(accountId);
    if (!p) throw new ValidationError("FIXTURE_ACCOUNT_UNKNOWN");
    p.accountState = state;
  }

  setChannels(accountId: string, channels: RegisteredChannel[]): void {
    const p = this.byAccount(accountId);
    if (!p) throw new ValidationError("FIXTURE_ACCOUNT_UNKNOWN");
    p.channels = channels.map((c) => ({ ...c }));
  }

  /** Every verified registered channel ref (for the notification fixture's registry). */
  allVerifiedChannelRefs(): string[] {
    return this.people.flatMap((p) => p.channels.filter((c) => c.verified).map((c) => c.channelRef));
  }

  private byAccount(accountId: string): DirectoryPersonFixture | undefined {
    return this.people.find((p) => p.accountId === accountId);
  }

  private byActor(actorId: string): DirectoryPersonFixture | undefined {
    return this.people.find((p) => p.actorId === actorId);
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new DependencyError("IDENTITY_DIRECTORY_UNAVAILABLE", "NOT_STARTED");
  }
}
