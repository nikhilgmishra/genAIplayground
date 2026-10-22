/**
 * Unit (Docker-free): domain authority (FO-01-25, FO-01-26; AUTH-02, AUTH-03, AUTH-05). The acting party comes
 * from the server-established session only; a provider's approval is never a client's consent.
 */
import { describe, expect, it } from "vitest";
import { AccessDeniedError } from "../shared/errors.js";
import { actingPartyFor, authorityFor, commitAuthorityOf, inScope, ledgerKindOf } from "./authority.js";
import { DomainActionKind } from "./contracts.js";

const ctx = (o: Partial<{ selectedRole: string; subjectId: string | null; actorId: string | null; revoked: boolean }> = {}) =>
  ({ selectedRole: "client", subjectId: "sub_synthUnitClient00001", actorId: "sub_synthUnitClient00001", revoked: false, ...o }) as Parameters<typeof actingPartyFor>[0];

describe("domain authority", () => {
  it("[AUTH-03] the acting party is the session's selected role and subject; revoked, subject-less and delegated roles have no domain authority", () => {
    expect(actingPartyFor(ctx())).toEqual({ role: "client", partyRef: "sub_synthUnitClient00001" });
    expect(actingPartyFor(ctx({ selectedRole: "provider", subjectId: "prv_synthUnitProvider0001" }))).toEqual({ role: "provider", partyRef: "prv_synthUnitProvider0001" });
    expect(() => actingPartyFor(ctx({ revoked: true }))).toThrow("SESSION_REVOKED");
    expect(() => actingPartyFor(ctx({ subjectId: null }))).toThrow("DOMAIN_SUBJECT_REQUIRED");
    expect(() => actingPartyFor(ctx({ actorId: null }))).toThrow("DOMAIN_SUBJECT_REQUIRED");
    for (const role of ["representative", "practice_staff", "partner", "payer"]) expect(() => actingPartyFor(ctx({ selectedRole: role }))).toThrow("DOMAIN_ROLE_NOT_SUPPORTED");
  });

  it("[AUTH-02][FO-01-25] each action kind needs its own authority family, refused before any I/O", () => {
    const client = { role: "client" as const, partyRef: "sub_a" };
    const provider = { role: "provider" as const, partyRef: "prv_a" };
    for (const kind of DomainActionKind.options) {
      if (kind.startsWith("provider.")) {
        expect(authorityFor(kind, provider)).toBe("PROVIDER_APPROVED");
        expect(() => authorityFor(kind, client)).toThrow("CLIENT_CANNOT_APPROVE_PROVIDER_ACTION");
      } else {
        expect(authorityFor(kind, client)).toBe("CLIENT_CONFIRMED");
        expect(() => authorityFor(kind, provider)).toThrow("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
      }
    }
  });

  it("[AUTH-05] record scope: a client sees their own records, a provider their own schedule", () => {
    const rec = { subjectId: "sub_a", providerRef: "prv_a" };
    expect(inScope({ role: "client", partyRef: "sub_a" }, rec)).toBe(true);
    expect(inScope({ role: "client", partyRef: "sub_b" }, rec)).toBe(false);
    expect(inScope({ role: "provider", partyRef: "prv_a" }, rec)).toBe(true);
    expect(inScope({ role: "provider", partyRef: "sub_a" }, rec)).toBe(false);
  });

  it("[FO-01-26] provider-approved reschedule and cancel share the ledger's kinds; the availability block has none yet", () => {
    expect(ledgerKindOf("provider.appointment.reschedule")).toBe("appointment.reschedule");
    expect(ledgerKindOf("provider.appointment.cancel")).toBe("appointment.cancel");
    expect(ledgerKindOf("provider.availability.block")).toBeNull();
    expect(ledgerKindOf("billing.review.submit")).toBe("billing.review.submit");
  });

  it("[AUTH-02][ACT-01] at commit the digest-bound authority must be the subject's own, and bookings or billing reviews only CLIENT_CONFIRMED", () => {
    const base = { kind: "appointment.reschedule" as const, subjectId: "sub_a", change: {} };
    // A business-prepared action (no authority field): a client action confirmed by its subject.
    expect(commitAuthorityOf(base)).toEqual({ authority: "CLIENT_CONFIRMED", actingPartyRef: "sub_a" });
    expect(commitAuthorityOf({ ...base, change: { authority: "PROVIDER_APPROVED", actingPartyRef: "sub_a" } })).toEqual({ authority: "PROVIDER_APPROVED", actingPartyRef: "sub_a" });
    expect(() => commitAuthorityOf({ ...base, change: { authority: "CLIENT_CONFIRMED", actingPartyRef: "sub_b" } })).toThrow(AccessDeniedError);
    expect(() => commitAuthorityOf({ ...base, change: { authority: "STAFF_OVERRIDE" } })).toThrow("DOMAIN_AUTHORITY_INVALID");
    expect(() => commitAuthorityOf({ ...base, kind: "appointment.create", change: { authority: "PROVIDER_APPROVED" } })).toThrow("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
    expect(() => commitAuthorityOf({ ...base, kind: "billing.review.submit", change: { authority: "PROVIDER_APPROVED" } })).toThrow("PROVIDER_APPROVAL_IS_NOT_CLIENT_CONSENT");
  });
});
