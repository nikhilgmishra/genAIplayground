/**
 * Domain authority (WP-23; FO-01-25, FO-01-26; AUTH-02, AUTH-03, AUTH-05).
 *
 * The acting party of a domain read or change is derived from the server-established AuthContext only (never from
 * tool arguments or model text, AUTH-03): its selected role and its subject. Two families exist on the same
 * action contracts:
 *   client actions             CLIENT_CONFIRMED: the client changes their own record, confirmed by that client;
 *   provider-approved actions  PROVIDER_APPROVED: a provider changes their own schedule, approved by that provider.
 * A provider's approval is never a client's consent: a provider cannot prepare or commit a client action, and a
 * client action committed with provider authority is refused. A role switch starts a new session generation, so
 * an action prepared under one role is invalidated by the ledger and cannot carry its authority into the other
 * (platform/src/identity selectRole; the commit protocol's generation check).
 *
 * Record scope (AUTH-05): a client sees only records whose subject is that client; a provider only records whose
 * provider is that provider. A record outside the scope reads as absent (no existence disclosure).
 */
import type { ActionKind, AuthContext, PreparedAction } from "../protocol/index.js";
import { AccessDeniedError } from "../shared/errors.js";
import type { DomainActionKind, DomainAuthority } from "./contracts.js";
import { AUTHORITY_OF_KIND, DomainAuthority as DomainAuthoritySchema } from "./contracts.js";

export interface ActingParty {
  readonly role: "client" | "provider";
  /** The party's own reference at the system of record (the client's or the provider's subject). */
  readonly partyRef: string;
}

/** The acting party of a session; refuses roles without a domain authority of their own. */
export function actingPartyFor(ctx: Pick<AuthContext, "selectedRole" | "subjectId" | "actorId" | "revoked">): ActingParty {
  if (ctx.revoked) throw new AccessDeniedError("SESSION_REVOKED");
  if (ctx.actorId === null || ctx.subjectId === null) throw new AccessDeniedError("DOMAIN_SUBJECT_REQUIRED");
  if (ctx.selectedRole === "client") return { role: "client", partyRef: ctx.subjectId };
  if (ctx.selectedRole === "provider") return { role: "provider", partyRef: ctx.subjectId };
  // Representatives, practice staff, partners and payers act through delegated authority the business layer
  // evaluates; they have no domain write authority of their own here.
  throw new AccessDeniedError("DOMAIN_ROLE_NOT_SUPPORTED");
}

/** True when the record is within the party's scope (AUTH-05). */
export function inScope(party: ActingParty, record: { subjectId: string; providerRef: string }): boolean {
  return party.role === "client" ? record.subjectId === party.partyRef : record.providerRef === party.partyRef;
}

/** The authority a kind needs, refusing a party of the other family before any I/O. */
export function authorityFor(kind: DomainActionKind, party: ActingParty): DomainAuthority {
  const needed = AUTHORITY_OF_KIND[kind];
  if (needed === "CLIENT_CONFIRMED" && party.role !== "client") throw new AccessDeniedError("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
  if (needed === "PROVIDER_APPROVED" && party.role !== "provider") throw new AccessDeniedError("CLIENT_CANNOT_APPROVE_PROVIDER_ACTION");
  return needed;
}

/**
 * The ledger ActionKind a domain kind is prepared under. Provider-approved reschedule and cancel share the client
 * kinds' contract (the authority is digest-bound in the change); the availability block has no ledger kind until
 * the action-contract owner adds it (WP-25), so it runs only through `DomainCommitPort.commitCommand`.
 */
export function ledgerKindOf(kind: DomainActionKind): ActionKind | null {
  switch (kind) {
    case "appointment.create":
    case "appointment.reschedule":
    case "appointment.cancel":
    case "billing.review.submit":
      return kind;
    case "provider.appointment.reschedule":
      return "appointment.reschedule";
    case "provider.appointment.cancel":
      return "appointment.cancel";
    case "provider.availability.block":
      return null;
  }
}

/**
 * The authority a prepared action was confirmed under, checked at commit (the action is digest-bound, so these
 * fields are exactly what the party confirmed). An action prepared by the business layer before this package
 * carries no authority field: it is a client action (provider tools were read-only), CLIENT_CONFIRMED by its subject.
 */
export function commitAuthorityOf(action: { kind: ActionKind | DomainActionKind; subjectId: string; change: PreparedAction["change"] }): { authority: DomainAuthority; actingPartyRef: string } {
  const rawAuthority = action.change.authority;
  const authority = rawAuthority === undefined || rawAuthority === null ? "CLIENT_CONFIRMED" : DomainAuthoritySchema.safeParse(rawAuthority);
  const value = typeof authority === "string" ? authority : authority.success ? authority.data : null;
  if (value === null) throw new AccessDeniedError("DOMAIN_AUTHORITY_INVALID");
  const actingPartyRef = action.change.actingPartyRef ?? action.subjectId;
  // The acting party is the action's own subject: a party never acts on someone else's behalf here.
  if (typeof actingPartyRef !== "string" || actingPartyRef !== action.subjectId) throw new AccessDeniedError("DOMAIN_ACTING_PARTY_MISMATCH");
  if ((action.kind === "appointment.create" || action.kind === "billing.review.submit") && value !== "CLIENT_CONFIRMED") throw new AccessDeniedError("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
  return { authority: value, actingPartyRef };
}
