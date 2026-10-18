/**
 * Property tests over randomly generated SYNTHETIC policy inputs, evaluated
 * through the real WASM bundle. Deterministic: fixed fast-check seed.
 */
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { RelationshipFact, RiskFlag } from "../protocol/auth.js";
import { Assurance, Classification, Environment, Role } from "../protocol/common.js";
import { PolicyDecision, PolicyInput, PolicyPurpose } from "../protocol/policy.js";
import { isAlwaysAvailableAction } from "./catalogue.js";
import type { OpaWasmPolicyEngine } from "./engine.js";
import { generateProbes } from "./golden-matrix.js";
import { ACME, DIGEST_A, DIGEST_B, EARLIER, LATER, NORTH, NOW, OTHER_TENANT_ID, P, SOUTH, TENANT_ID, loadTestEngine } from "./fixtures/inputs.fixture.js";

let engine: OpaWasmPolicyEngine;
let actions: string[];
let intents: string[];
let integrations: string[];
let allowedInputs: PolicyInput[];

beforeAll(async () => {
  engine = await loadTestEngine();
  allowedInputs = generateProbes(engine.catalogue)
    .filter((p) => p.entrypoint === "authz" && p.expected.allow && !isAlwaysAvailableAction(p.input.action))
    .map((p) => p.input as PolicyInput);
  actions = Object.keys(engine.catalogue.actions);
  intents = [...new Set(Object.values(engine.catalogue.actions).map((a) => a.intent))];
  integrations = [...new Set(Object.values(engine.catalogue.actions).flatMap((a) => a.integrations))];
});

const RUNS = { numRuns: 400, seed: 20261017 } as const;
const actors = [P.avery.actorId, P.blake.actorId, P.morgan.actorId, P.riley.actorId, P.quinn.actorId, P.emery.actorId, P.dana.actorId];
const subjects = [P.avery.subjectId, P.blake.subjectId, P.casey.subjectId, P.morgan.subjectId, P.newbie.subjectId];
const orgs = [NORTH, SOUTH, ACME];
const types = ["appointment", "appointment_options", "invoice", "billing_review", "claim", "provider_onboarding", "remittance", "partner_intake", "support_case", "support_request", "knowledge_article", "verification_challenge", "call_session", "complaint"];
const times = [EARLIER, NOW, LATER];
const scopes = ["appointment:read", "invoice:read", "remittance:read", "onboarding:read", "case:read", "partner_intake:create", "support_request:create"];
const consent = fc.constantFrom("GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED" as const);
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null });

const factArb: fc.Arbitrary<RelationshipFact> = fc.record({
  type: fc.constantFrom(...RelationshipFact.shape.type.options),
  actorId: fc.constantFrom(...actors),
  subjectId: opt(fc.constantFrom(...subjects)),
  organizationId: opt(fc.constantFrom(...orgs)),
  scopes: fc.subarray(scopes),
  source: fc.constantFrom(...RelationshipFact.shape.source.options),
  validUntil: opt(fc.constantFrom(...times)),
  constraints: fc.subarray([...RelationshipFact.shape.constraints.element.options]),
});

const inputArb = (): fc.Arbitrary<PolicyInput> =>
  fc.record({
    action: fc.oneof(fc.constantFrom(...actions), fc.constantFrom("records:export_all", "record:update")),
    purpose: fc.constantFrom(...PolicyPurpose.options),
    environment: fc.constantFrom(...Environment.options),
    now: fc.constant(NOW),
    tool: opt(fc.record({ name: fc.constant("synthetic_probe_tool"), version: fc.constant("1.0.0"), minAssurance: fc.constantFrom(...Assurance.options), consequential: fc.boolean() })),
    auth: fc.record({
      tenantId: fc.constantFrom(TENANT_ID, TENANT_ID, OTHER_TENANT_ID),
      sessionGeneration: fc.integer({ min: 1, max: 5 }),
      actorId: opt(fc.constantFrom(...actors)),
      selectedRole: opt(fc.constantFrom(...Role.options)),
      subjectId: opt(fc.constantFrom(...subjects)),
      organizationId: opt(fc.constantFrom(...orgs)),
      permittedScopes: fc.subarray(scopes),
      assurance: fc.constantFrom(...Assurance.options),
      authenticatedAt: opt(fc.constant("2026-10-17T14:55:00.000Z")),
      expiresAt: fc.constantFrom(...times),
      revoked: fc.boolean(),
      riskFlags: fc.subarray([...RiskFlag.options]),
      consentRecording: consent,
      consentAutomatedProcessing: consent,
      stepUpDigest: opt(fc.constantFrom(DIGEST_A, DIGEST_B)),
      stepUpExpiresAt: opt(fc.constantFrom(...times)),
    }),
    resource: fc.record({
      type: fc.constantFrom(...types),
      tenantId: fc.constantFrom(TENANT_ID, TENANT_ID, OTHER_TENANT_ID),
      subjectId: opt(fc.constantFrom(...subjects)),
      organizationId: opt(fc.constantFrom(...orgs)),
      classification: fc.constantFrom(...Classification.options),
      actionDigest: opt(fc.constantFrom(DIGEST_A, DIGEST_B)),
    }),
    relationships: fc.array(factArb, { maxLength: 4 }),
    killSwitches: fc.record({ aiAdmission: fc.boolean(), writes: fc.boolean(), intents: fc.subarray(intents), integrations: fc.subarray(integrations) }),
  });

/** Picks undefined (no change) most of the time, otherwise a value from `arb`. */
const sometimes = <T>(arb: fc.Arbitrary<T>, weight = 1): fc.Arbitrary<T | undefined> => fc.oneof({ arbitrary: fc.constant(undefined), weight: 8 }, { arbitrary: arb, weight });

/**
 * Inputs near the allow/deny boundary: start from a curated ALLOWED golden
 * probe input and randomly mutate a few fields (role, assurance, subject,
 * organization, classification, facts, consent, switches, ...).
 */
const plausibleArb = (): fc.Arbitrary<PolicyInput> =>
  fc
    .record({
      base: fc.constantFrom(...allowedInputs),
      action: sometimes(fc.constantFrom(...actions)),
      purpose: sometimes(fc.constantFrom(...PolicyPurpose.options)),
      role: sometimes(opt(fc.constantFrom(...Role.options))),
      assurance: sometimes(fc.constantFrom(...Assurance.options), 2),
      subjectId: sometimes(opt(fc.constantFrom(...subjects)), 2),
      organizationId: sometimes(opt(fc.constantFrom(...orgs))),
      classification: sometimes(fc.constantFrom(...Classification.options)),
      type: sometimes(fc.constantFrom(...types)),
      relationships: sometimes(fc.array(factArb, { maxLength: 3 }), 2),
      factPatch: sometimes(fc.record({ scopes: fc.subarray(scopes), validUntil: opt(fc.constantFrom(...times)), constraints: fc.subarray([...RelationshipFact.shape.constraints.element.options]) }), 2),
      expiresAt: sometimes(fc.constantFrom(...times)),
      revoked: sometimes(fc.boolean()),
      consentAutomatedProcessing: sometimes(consent),
      riskFlags: sometimes(fc.subarray([...RiskFlag.options])),
      tool: sometimes(opt(fc.record({ name: fc.constant("synthetic_probe_tool"), version: fc.constant("1.0.0"), minAssurance: fc.constantFrom(...Assurance.options), consequential: fc.boolean() }))),
      stepUpDigest: sometimes(opt(fc.constantFrom(DIGEST_A, DIGEST_B))),
      writes: sometimes(fc.boolean()),
    })
    .map((m) => {
      const x = structuredClone(m.base);
      if (m.action !== undefined) x.action = m.action;
      if (m.purpose !== undefined) x.purpose = m.purpose;
      if (m.role !== undefined) x.auth.selectedRole = m.role;
      if (m.assurance !== undefined) x.auth.assurance = m.assurance;
      if (m.subjectId !== undefined) x.resource.subjectId = m.subjectId;
      if (m.organizationId !== undefined) x.resource.organizationId = m.organizationId;
      if (m.classification !== undefined) x.resource.classification = m.classification;
      if (m.type !== undefined) x.resource.type = m.type;
      if (m.relationships !== undefined) x.relationships = m.relationships;
      if (m.factPatch !== undefined && x.relationships[0]) x.relationships[0] = { ...x.relationships[0], ...m.factPatch };
      if (m.expiresAt !== undefined) x.auth.expiresAt = m.expiresAt;
      if (m.revoked !== undefined) x.auth.revoked = m.revoked;
      if (m.consentAutomatedProcessing !== undefined) x.auth.consentAutomatedProcessing = m.consentAutomatedProcessing;
      if (m.riskFlags !== undefined) x.auth.riskFlags = m.riskFlags;
      if (m.tool !== undefined) x.tool = m.tool;
      if (m.stepUpDigest !== undefined) {
        x.auth.stepUpDigest = m.stepUpDigest;
        x.auth.stepUpExpiresAt = m.stepUpDigest === null ? null : LATER;
      }
      if (m.writes !== undefined) x.killSwitches.writes = m.writes;
      return x;
    });

const decide = (x: unknown) => engine.decideSync(x);

describe("policy engine properties", () => {
  it("[OPS-03] the generators exercise non-exempt allows, so allow-side properties are not vacuous", () => {
    const sample = fc.sample(plausibleArb(), { numRuns: 2000, seed: RUNS.seed });
    const allowed = sample.filter((x) => !isAlwaysAvailableAction(x.action) && decide(x).allow);
    const targeted = allowed.filter((x) => x.resource.subjectId !== null || x.resource.organizationId !== null);
    const denied = sample.filter((x) => !decide(x).allow);
    process.stdout.write(`property sample: ${sample.length} inputs, ${allowed.length} non-exempt allows (${targeted.length} subject/org-targeted), ${denied.length} denies\n`);
    expect(allowed.length).toBeGreaterThan(200);
    expect(targeted.length).toBeGreaterThan(100);
    expect(denied.length).toBeGreaterThan(200);
  });

  it("[OPS-06] decide never throws and always returns a valid decision; denials disclose no fields", () => {
    fc.assert(
      fc.property(inputArb(), (x) => {
        const d = decide(x);
        expect(PolicyDecision.safeParse(d).success).toBe(true);
        if (!d.allow) expect(d.fieldMask).toEqual([]);
        expect(PolicyInput.safeParse(x).success).toBe(true);
      }),
      RUNS,
    );
  });

  it("[SAFE-02] safety and human routes are allowed for every possible input", () => {
    fc.assert(
      fc.property(inputArb(), fc.constantFrom("safety:route", "human:request"), (x, action) => {
        expect(decide({ ...x, action }).allow).toBe(true);
      }),
      RUNS,
    );
  });

  it("[AUTH-04] [AUTH-02] any non-exempt allow has a live session, tenant match, no AI-admission switch and no declined consent", () => {
    fc.assert(
      fc.property(fc.oneof(inputArb(), plausibleArb()), (x) => {
        const d = decide(x);
        if (!d.allow || isAlwaysAvailableAction(x.action)) return;
        expect(x.auth.revoked).toBe(false);
        expect(Date.parse(x.auth.expiresAt)).toBeGreaterThan(Date.parse(x.now));
        expect(x.auth.tenantId).toBe(x.resource.tenantId);
        expect(x.killSwitches.aiAdmission).toBe(false);
        expect(x.resource.classification).not.toBe("VERIFICATION_SECRET");
        const def = engine.catalogue.actions[x.action]!;
        if (!["PUBLIC_READ", "INTAKE"].includes(def.class)) {
          expect(x.auth.consentAutomatedProcessing === "GRANTED" || x.auth.consentAutomatedProcessing === "NOT_REQUIRED").toBe(true);
          expect(x.auth.consentRecording).not.toBe("DECLINED");
        }
        if (def.killSwitchClass === "WRITE") {
          expect(x.killSwitches.writes).toBe(false);
          expect(x.auth.riskFlags).not.toContain("SAFETY_ESCALATION_ACTIVE");
        }
        expect(x.killSwitches.intents).not.toContain(def.intent);
        expect(d.fieldMask.every((f) => def.fieldMask.includes(f))).toBe(true);
      }),
      RUNS,
    );
  });

  it("[AUTH-05] an allow that targets a person or organization is backed by an authoritative fact of this actor", () => {
    fc.assert(
      fc.property(plausibleArb(), (x) => {
        const d = decide(x);
        if (!d.allow || isAlwaysAvailableAction(x.action)) return;
        if (x.resource.subjectId === null && x.resource.organizationId === null) return;
        const backed = x.relationships.some(
          (f) =>
            f.actorId === x.auth.actorId &&
            ((x.resource.subjectId !== null && f.subjectId === x.resource.subjectId) || (x.resource.organizationId !== null && f.organizationId === x.resource.organizationId)) &&
            !f.constraints.includes("AUTHORIZATION_EXPIRED") &&
            !f.constraints.includes("MINOR_CONFIDENTIALITY_REVIEW") &&
            !f.constraints.includes("CUSTODY_DISPUTE"),
        );
        expect(backed).toBe(true);
        expect(["A2", "A3"]).toContain(x.auth.assurance);
        if (x.auth.selectedRole === "partner" || x.auth.selectedRole === "payer_representative") expect(x.resource.subjectId).toBeNull();
      }),
      RUNS,
    );
  });

  it("[AUTH-02] tightening the context never turns a deny into an allow (monotonic)", () => {
    const tighten: ((x: PolicyInput) => PolicyInput)[] = [
      (x) => ({ ...x, auth: { ...x.auth, revoked: true } }),
      (x) => ({ ...x, auth: { ...x.auth, expiresAt: EARLIER } }),
      (x) => ({ ...x, killSwitches: { ...x.killSwitches, aiAdmission: true } }),
      (x) => ({ ...x, killSwitches: { ...x.killSwitches, writes: true } }),
      (x) => ({ ...x, auth: { ...x.auth, riskFlags: [...new Set([...x.auth.riskFlags, "FRAUD_REVIEW" as const])] } }),
      (x) => ({ ...x, auth: { ...x.auth, consentAutomatedProcessing: "DECLINED" } }),
      (x) => ({ ...x, auth: { ...x.auth, assurance: x.auth.assurance === "A3" ? "A2" : x.auth.assurance === "A2" ? "A1" : "A0" } }),
      (x) => ({ ...x, relationships: [] }),
      (x) => ({ ...x, tool: { name: "synthetic_probe_tool", version: "1.0.0", minAssurance: "A3", consequential: true } }),
    ];
    fc.assert(
      fc.property(fc.oneof(inputArb(), plausibleArb()), fc.integer({ min: 0, max: tighten.length - 1 }), (x, i) => {
        if (decide(tighten[i]!(x)).allow) expect(decide(x).allow).toBe(true);
      }),
      RUNS,
    );
  });

  it("[AUTH-03] any extra top-level or auth field is rejected rather than interpreted", () => {
    fc.assert(
      fc.property(plausibleArb(), fc.constantFrom("callerClaimedRole", "subjectOverride", "assuranceClaim", "isAuthenticated"), fc.boolean(), (x, key, inAuth) => {
        const tampered = inAuth ? { ...x, auth: { ...x.auth, [key]: "A3" } } : { ...x, [key]: "provider" };
        expect(decide(tampered)).toMatchObject({ allow: false, reasonCodes: ["POLICY_INPUT_INVALID"] });
      }),
      RUNS,
    );
  });

  it("[OPS-06] decisions are deterministic for the same input", () => {
    fc.assert(
      fc.property(inputArb(), (x) => {
        const a = decide(x);
        const b = decide(structuredClone(x));
        expect({ ...a, decisionId: "", evaluatedAt: "" }).toEqual({ ...b, decisionId: "", evaluatedAt: "" });
      }),
      { ...RUNS, numRuns: 200 },
    );
  });
});
