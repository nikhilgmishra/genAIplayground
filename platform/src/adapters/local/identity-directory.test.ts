import { describe, expect, it } from "vitest";
import { IDP, PEOPLE } from "../../fixtures/synthetic-world.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import { LocalIdentityDirectoryFixture, normalizeName } from "./identity-directory.js";

describe("LocalIdentityDirectoryFixture (LOCAL FIXTURE over SYNTHETIC people)", () => {
  it("[SPEC-7.DIRECTORY] declares kind local_fixture and the identity-directory integration id", async () => {
    const d = new LocalIdentityDirectoryFixture();
    expect(d.kind).toBe("local_fixture");
    expect(d.integrationId).toBe("identity-directory");
    expect(await d.health()).toEqual({ healthy: true, reasonCode: null });
  });

  it("[AUTH-01] name + DOB match exactly after normalisation and only locate a candidate", async () => {
    const d = new LocalIdentityDirectoryFixture();
    const variants = ["Avery Synthetic-Client", "  avery   synthetic-client ", "AVERY SYNTHETIC‐CLIENT", "Ａｖｅｒｙ Synthetic-Client"];
    for (const fullName of variants) {
      expect(await d.findCandidates({ fullName, dateOfBirth: PEOPLE.avery.dateOfBirth })).toEqual([
        { accountId: PEOPLE.avery.accountId, actorId: PEOPLE.avery.actorId, roles: ["client"] },
      ]);
    }
    expect(normalizeName("O’Neil  Synthetic")).toBe("o'neil synthetic");
  });

  it("[SPEC-14.ENUMERATION] no partial, prefix or DOB-only matching", async () => {
    const d = new LocalIdentityDirectoryFixture();
    expect(await d.findCandidates({ fullName: "Avery", dateOfBirth: PEOPLE.avery.dateOfBirth })).toEqual([]);
    expect(await d.findCandidates({ fullName: "Avery Synthetic-Clien", dateOfBirth: PEOPLE.avery.dateOfBirth })).toEqual([]);
    expect(await d.findCandidates({ fullName: PEOPLE.avery.fullName, dateOfBirth: "1990-01-02" })).toEqual([]);
    // Providers without a DOB on file cannot be located by name + DOB at all.
    expect(await d.findCandidates({ fullName: PEOPLE.morgan.fullName, dateOfBirth: "1970-01-01" })).toEqual([]);
  });

  it("[SPEC-7.DIRECTORY] portal username hint locates exactly one account; strict locators reject extra fields", async () => {
    const d = new LocalIdentityDirectoryFixture();
    expect(await d.findCandidates({ portalUsernameHint: "Morgan.Synthetic" })).toEqual([{ accountId: PEOPLE.morgan.accountId, actorId: PEOPLE.morgan.actorId, roles: ["provider"] }]);
    expect(await d.findCandidates({ portalUsernameHint: "morgan" })).toEqual([]);
    await expect(d.findCandidates({ fullName: "x", dateOfBirth: "1990-01-01", phone: "+15555550101" } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(d.findCandidates({ npi: "1234567893" } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(d.findCandidates({ fullName: "x", dateOfBirth: "01/01/1990" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-7.DIRECTORY] registered channels, account state, IdP subject mapping and role-scoped self subject / organization", async () => {
    const d = new LocalIdentityDirectoryFixture();
    expect(await d.registeredChannels(PEOPLE.blake.accountId)).toEqual(PEOPLE.blake.channels.map((c) => ({ ...c })));
    expect(await d.registeredChannels("acc_unknownAccount000001")).toEqual([]);
    expect(await d.accountState(PEOPLE.avery.accountId)).toBe("ACTIVE");
    expect(await d.accountState("acc_unknownAccount000001")).toBe("CLOSED");
    expect(await d.actorForIdpSubject(IDP.clientIssuer, PEOPLE.avery.idpSubject)).toBe(PEOPLE.avery.actorId);
    // The same subject string from another issuer is a different identity.
    expect(await d.actorForIdpSubject(IDP.providerIssuer, PEOPLE.avery.idpSubject)).toBeNull();
    expect(await d.selfSubjectId(PEOPLE.avery.actorId, "client")).toBe(PEOPLE.avery.subjectId);
    expect(await d.selfSubjectId(PEOPLE.avery.actorId, "provider")).toBeNull();
    expect(await d.selfSubjectId(PEOPLE.riley.actorId, "practice_staff")).toBeNull();
    expect(await d.organizationFor(PEOPLE.riley.actorId, "practice_staff")).toBe(PEOPLE.riley.organizationId);
    expect(await d.organizationFor(PEOPLE.riley.actorId, "client")).toBeNull();
  });

  it("[SPEC-7.DIRECTORY] test controls: outage, account state and channel changes", async () => {
    const d = new LocalIdentityDirectoryFixture();
    d.setAccountState(PEOPLE.avery.accountId, "LOCKED");
    expect(await d.accountState(PEOPLE.avery.accountId)).toBe("LOCKED");
    d.setChannels(PEOPLE.avery.accountId, []);
    expect(await d.registeredChannels(PEOPLE.avery.accountId)).toEqual([]);
    d.setUnavailable(true);
    await expect(d.findCandidates({ portalUsernameHint: "avery.synthetic" })).rejects.toBeInstanceOf(DependencyError);
    expect((await d.health()).healthy).toBe(false);
    // The fixture never mutates the shared SYNTHETIC world.
    expect(PEOPLE.avery.channels).toHaveLength(1);
    expect(new LocalIdentityDirectoryFixture().allVerifiedChannelRefs()).toContain(PEOPLE.avery.channels[0].channelRef);
  });
});
