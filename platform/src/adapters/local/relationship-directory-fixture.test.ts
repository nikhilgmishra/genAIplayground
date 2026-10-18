import { beforeEach, describe, expect, it } from "vitest";
import { DELEGATIONS, ORGANIZATIONS, PEOPLE } from "../../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../../observability/logger.js";
import { RelationshipFact } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { PlatformError, ValidationError } from "../../shared/errors.js";
import { FaultInjector } from "./faults.js";
import { RelationshipDirectoryFixture } from "./relationship-directory-fixture.js";
import { SyntheticStore } from "./synthetic-store.js";

let store: SyntheticStore;
let clock: FakeClock;
let faults: FaultInjector;
let mem: ReturnType<typeof createMemoryLogger>;
let dir: RelationshipDirectoryFixture;

beforeEach(() => {
  store = new SyntheticStore();
  clock = new FakeClock("2026-10-17T15:00:00.000Z");
  faults = new FaultInjector();
  mem = createMemoryLogger();
  dir = new RelationshipDirectoryFixture({ store, clock, faults, logger: mem.logger });
});

const types = (facts: RelationshipFact[]) => facts.map((f) => f.type);

describe("RelationshipDirectoryFixture (LOCAL FIXTURE, SYNTHETIC registries)", () => {
  it("[AUTH-05] a client has only the self relationship, strictly valid against the protocol RelationshipFact schema", async () => {
    const facts = await dir.relationshipsFor(PEOPLE.avery.actorId, "client");
    expect(facts).toEqual([
      {
        type: "self",
        actorId: PEOPLE.avery.actorId,
        subjectId: PEOPLE.avery.subjectId,
        organizationId: null,
        scopes: ["appointment:read", "appointment:write", "invoice:read", "billing_review:create", "claim:read", "case:read", "case:create"],
        source: "identity_provider",
        validUntil: null,
        constraints: [],
      },
    ]);
    for (const f of facts) expect(RelationshipFact.parse(f)).toEqual(f);
  });

  it("[AUTH-05] a provider gets practice membership, self and treating relationships from enrollment records only", async () => {
    const facts = await dir.relationshipsFor(PEOPLE.morgan.actorId, "provider");
    expect(types(facts)).toEqual(["practice_member", "self", "treating_provider"]);
    expect(facts.find((f) => f.type === "practice_member")).toMatchObject({ organizationId: ORGANIZATIONS.practiceNorth.organizationId, source: "enrollment_system", validUntil: null });
    expect(facts.find((f) => f.type === "treating_provider")).toMatchObject({ subjectId: PEOPLE.avery.subjectId, scopes: ["appointment:read", "appointment:list_options"], constraints: [] });
    // No treating relationship with Blake exists in the enrollment system, so no fact appears for Blake.
    expect(facts.some((f) => f.subjectId === PEOPLE.blake.subjectId)).toBe(false);
  });

  it("[AUTH-05] privileges are never combined across roles: a delegate's facts appear only for the selected role", async () => {
    expect(types(await dir.relationshipsFor(PEOPLE.riley.actorId, "practice_staff"))).toEqual(["practice_delegate"]);
    expect(await dir.relationshipsFor(PEOPLE.riley.actorId, "provider")).toEqual([]);
    expect(await dir.relationshipsFor(PEOPLE.avery.actorId, "personal_representative")).toEqual([]);
    expect(await dir.relationshipsFor("act_synthNobodyAtAll001", "client")).toEqual([]);
  });

  it("[AUTH-05] expired proxy authority is returned with validUntil and AUTHORIZATION_EXPIRED so policy can deny it", async () => {
    const [fact] = await dir.relationshipsFor(PEOPLE.emery.actorId, "personal_representative");
    expect(fact).toMatchObject({
      type: "legal_representative",
      subjectId: PEOPLE.blake.subjectId,
      validUntil: "2026-06-30T23:59:59.000Z",
      constraints: ["AUTHORIZATION_EXPIRED"],
    });
  });

  it("[AUTH-05] partner affiliation carries its contract end; after it passes the fact is marked expired", async () => {
    const before = await dir.relationshipsFor(PEOPLE.quinn.actorId, "partner");
    expect(before).toEqual([expect.objectContaining({ type: "partner_affiliate", organizationId: ORGANIZATIONS.partnerAcme.organizationId, validUntil: "2026-12-31T23:59:59.000Z", constraints: [] })]);
    clock.set("2027-01-01T00:00:00.000Z");
    expect((await dir.relationshipsFor(PEOPLE.quinn.actorId, "partner"))[0]?.constraints).toEqual(["AUTHORIZATION_EXPIRED"]);
  });

  it("[SPEC-4.audience] parental authority over a minor carries MINOR_CONFIDENTIALITY_REVIEW (forces human review)", async () => {
    const [fact] = await dir.relationshipsFor(PEOPLE.dana.actorId, "personal_representative");
    expect(fact).toMatchObject({ type: "parental_authority", subjectId: PEOPLE.casey.subjectId, constraints: ["MINOR_CONFIDENTIALITY_REVIEW"], validUntil: null });
    // Even when the registry omits it, a representative fact over a minor gets the constraint.
    dir.addGrant({
      grantId: "gnt_synthEmeryCaseyNoConstraint",
      kind: "legal_representative",
      actorId: PEOPLE.emery.actorId,
      subjectId: PEOPLE.casey.subjectId,
      organizationId: null,
      scopes: ["appointment:read"],
      source: "legal_authority_registry",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: null,
      constraints: [],
    });
    const emery = await dir.relationshipsFor(PEOPLE.emery.actorId, "personal_representative");
    expect(emery.find((f) => f.subjectId === PEOPLE.casey.subjectId)?.constraints).toEqual(["MINOR_CONFIDENTIALITY_REVIEW"]);
  });

  it("[AUTH-05] fail closed: unknown constraints drop the whole fact, future grants are omitted, revocation marks expiry", async () => {
    dir.addGrant({
      grantId: "gnt_synthDanaBlakeCustody0001",
      kind: "legal_representative",
      actorId: PEOPLE.dana.actorId,
      subjectId: PEOPLE.blake.subjectId,
      organizationId: null,
      scopes: ["invoice:read"],
      source: "legal_authority_registry",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: null,
      constraints: ["COURT_ORDER_PENDING_REVIEW"],
    });
    dir.addGrant({
      grantId: "gnt_synthDanaBlakeFuture00001",
      kind: "legal_representative",
      actorId: PEOPLE.dana.actorId,
      subjectId: PEOPLE.blake.subjectId,
      organizationId: null,
      scopes: ["appointment:read"],
      source: "legal_authority_registry",
      validFrom: "2027-01-01T00:00:00.000Z",
      validUntil: null,
      constraints: [],
    });
    const facts = await dir.relationshipsFor(PEOPLE.dana.actorId, "personal_representative");
    expect(facts.map((f) => f.subjectId)).toEqual([PEOPLE.casey.subjectId]);
    expect(mem.records.some((r) => r.event === "fixture.relationships.constraint_unmapped" && r.fields.grantId === "gnt_synthDanaBlakeCustody0001")).toBe(true);

    dir.revokeGrant(DELEGATIONS[0].grantId, "2026-10-17T15:00:00.000Z");
    expect((await dir.relationshipsFor(PEOPLE.riley.actorId, "practice_staff"))[0]?.constraints).toEqual(["AUTHORIZATION_EXPIRED"]);
  });

  it("[DATA-01] logs carry opaque record refs and reason codes only — never names or dates of birth", async () => {
    store.update("delegations", DELEGATIONS[1].grantId, (d) => {
      d.constraints = ["UNKNOWN_CODE"];
    });
    await dir.relationshipsFor(PEOPLE.morgan.actorId, "provider");
    const logged = JSON.stringify(mem.records);
    expect(logged).toContain("RELATIONSHIP_CONSTRAINT_UNMAPPED");
    for (const p of Object.values(PEOPLE)) {
      expect(logged).not.toContain(p.fullName);
      if (p.dateOfBirth) expect(logged).not.toContain(p.dateOfBirth);
    }
  });

  it("[SPEC-14.faults] stale registry reads and outages are injectable; inputs are strictly validated", async () => {
    dir.revokeGrant(DELEGATIONS[0].grantId, "2026-10-01T00:00:00.000Z");
    faults.inject({ integrationId: "relationship-directory", operation: "relationshipsFor", kind: "STALE_READ" });
    expect((await dir.relationshipsFor(PEOPLE.riley.actorId, "practice_staff"))[0]?.constraints).toEqual([]);
    expect((await dir.relationshipsFor(PEOPLE.riley.actorId, "practice_staff"))[0]?.constraints).toEqual(["AUTHORIZATION_EXPIRED"]);
    faults.inject({ integrationId: "relationship-directory", operation: "relationshipsFor", kind: "OUTAGE" });
    await expect(dir.relationshipsFor(PEOPLE.riley.actorId, "practice_staff")).rejects.toSatisfy((e: unknown) => e instanceof PlatformError && e.reasonCode === "CONNECTION_REFUSED");
    await expect(dir.relationshipsFor("Riley", "practice_staff")).rejects.toBeInstanceOf(ValidationError);
    await expect(dir.relationshipsFor(PEOPLE.riley.actorId, "admin" as never)).rejects.toBeInstanceOf(ValidationError);
  });
});
