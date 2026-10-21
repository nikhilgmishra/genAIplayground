import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics } from "../observability/metrics.js";
import { PolicyDecision } from "../protocol/policy.js";
import type { PolicyInput } from "../protocol/policy.js";
import { sha256Hex } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import {
  AUTHZ_ENTRYPOINT,
  CONSOLE_ENTRYPOINT,
  FailClosedPolicyEngine,
  OpaWasmPolicyEngine,
  PolicyBundleLoadError,
  canonicalTimestamp,
  loadPolicyEngineOrFailClosed,
  type PolicyEvaluator,
} from "./engine.js";
import { ensurePolicyBundle } from "./ensure-bundle.js";
import {
  ACME,
  DIGEST_A,
  DIGEST_B,
  EARLIER,
  LATER,
  NORTH,
  NOW,
  OTHER_TENANT_ID,
  P,
  TENANT_ID,
  anonymous,
  auth,
  averyAppointment,
  averyCommit,
  danaParental,
  emeryExpired,
  emeryRenewed,
  fact,
  loadTestEngine,
  morganAppointment,
  quinnAffiliation,
  req,
  resource,
  selfFact,
  withAuth,
  withKs,
  withResource,
} from "./fixtures/inputs.fixture.js";

let engine: OpaWasmPolicyEngine;
let bundleDir: string;

beforeAll(async () => {
  bundleDir = ensurePolicyBundle().bundleDir;
  engine = await loadTestEngine();
});

const decide = (x: unknown) => engine.decideSync(x);

describe("policy engine: deny by default", () => {
  it("[AUTH-02] unknown action is denied by default", async () => {
    const d = await engine.decide({ ...averyAppointment(), action: "records:export_all" });
    expect(d.allow).toBe(false);
    expect(d.reasonCodes).toEqual(["ACTION_UNKNOWN", "DEFAULT_DENY"]);
    expect(d.fieldMask).toEqual([]);
  });

  it("[AUTH-02] raw SQL, broad search and generic update are not catalogue actions", () => {
    for (const action of ["db:raw_query", "crm:search_all", "record:update", "http:fetch", "shell:exec"]) {
      expect(decide({ ...averyAppointment(), action }).allow).toBe(false);
    }
  });

  it("[AUTH-02] every protected allow carries a decision id, version and timestamp that validate", () => {
    const d = engine.withOptions({ clock: new FakeClock(NOW) }).decideSync(averyAppointment());
    expect(PolicyDecision.safeParse(d).success).toBe(true);
    expect(d.decisionId).toMatch(/^pdc_[A-Za-z0-9_-]{16,64}$/);
    expect(d.policyVersion).toBe(engine.policyVersion);
    expect(d.evaluatedAt).toBe(NOW);
  });

  it("[AUTH-02] human-boundary actions always deny with REQUIRE_HUMAN", () => {
    for (const action of ["account:change_payout_destination", "account:change_tax_info", "credentialing:decide", "clinical_record:read", "identity:recover", "credential:reset"]) {
      const d = decide(withAuth({ ...averyAppointment(), action }, { assurance: "A3" }));
      // FO-05-06: the high-risk list holds whatever the tier (A3 here), next to the class rule.
      expect(d, action).toMatchObject({ allow: false, reasonCodes: ["HIGH_RISK_HUMAN_ONLY", "HUMAN_BOUNDARY"], obligations: ["REQUIRE_HUMAN"] });
    }
  });
});

describe("policy engine: relationships (AUTH-05)", () => {
  it("[AUTH-05] provider with a treating relationship reads only that client's appointment facts", () => {
    const d = decide(morganAppointment());
    expect(d).toMatchObject({ allow: true, reasonCodes: ["ALLOW_TREATING_PROVIDER"] });
  });

  it("[AUTH-05] provider cannot read an unrelated client even when the identifiers are known", () => {
    const d = decide(morganAppointment(P.blake.subjectId));
    expect(d).toMatchObject({ allow: false, reasonCodes: ["RELATIONSHIP_NOT_ESTABLISHED"], fieldMask: [] });
  });

  it("[AUTH-05] treating provider gets no invoice, claim or clinical record of the client", () => {
    const base = morganAppointment();
    expect(decide({ ...base, action: "invoice:read", resource: resource("invoice", P.avery.subjectId, null, "FINANCIAL") }).allow).toBe(false);
    expect(decide({ ...base, action: "claim:read", resource: resource("claim", P.avery.subjectId, null, "PHI") }).allow).toBe(false);
    expect(decide({ ...base, action: "clinical_record:read", resource: resource("clinical_record", P.avery.subjectId, null, "PHI_RESTRICTED") })).toMatchObject({ allow: false, reasonCodes: ["HIGH_RISK_HUMAN_ONLY", "HUMAN_BOUNDARY"] });
  });

  it("[AUTH-05] partner is denied an unrelated client's records and any individual record", () => {
    const partnerAuth = auth(P.quinn.actorId, "partner", null, ACME);
    const appointment = decide(req("appointment:read", "partner_administration", partnerAuth, resource("appointment", P.avery.subjectId, ACME, "PHI"), [quinnAffiliation]));
    expect(appointment.allow).toBe(false);
    expect(appointment.reasonCodes).toContain("PARTNER_NO_INDIVIDUAL_ACCESS");
    const individualCase = decide(req("case:read", "partner_administration", partnerAuth, resource("support_case", P.avery.subjectId, ACME, "PHI"), [quinnAffiliation]));
    expect(individualCase.allow).toBe(false);
    expect(individualCase.reasonCodes).toContain("PARTNER_NO_INDIVIDUAL_ACCESS");
    const orgCase = decide(req("case:read", "partner_administration", partnerAuth, resource("support_case", null, ACME, "INTERNAL"), [quinnAffiliation]));
    expect(orgCase).toMatchObject({ allow: true, reasonCodes: ["ALLOW_PARTNER_AFFILIATION"] });
  });

  it("[AUTH-05] an employer partner never gains treatment status through an organization case", () => {
    const d = decide(req("case:read", "partner_administration", auth(P.quinn.actorId, "partner", null, ACME), resource("support_case", null, ACME, "PHI"), [quinnAffiliation]));
    expect(d).toMatchObject({ allow: false, reasonCodes: ["CLASSIFICATION_NOT_PERMITTED"] });
  });

  it("[AUTH-05] expired proxy authority is denied and routed to a human", () => {
    const d = decide(req("appointment:read", "representative_access", auth(P.emery.actorId, "personal_representative", null, null), resource("appointment", P.blake.subjectId, null, "PHI"), [emeryExpired]));
    expect(d).toMatchObject({ allow: false, reasonCodes: ["AUTHORIZATION_EXPIRED"], obligations: ["REQUIRE_HUMAN"] });
    const renewed = decide(req("appointment:read", "representative_access", auth(P.emery.actorId, "personal_representative", null, null), resource("appointment", P.blake.subjectId, null, "PHI"), [emeryRenewed]));
    expect(renewed).toMatchObject({ allow: true, reasonCodes: ["ALLOW_REPRESENTATIVE"] });
  });

  it("[AUTH-05] minor confidentiality review forces REQUIRE_HUMAN", () => {
    const d = decide(req("appointment:read", "representative_access", auth(P.dana.actorId, "personal_representative", null, null), resource("appointment", P.casey.subjectId, null, "PHI"), [danaParental]));
    expect(d).toMatchObject({ allow: false, reasonCodes: ["MINOR_CONFIDENTIALITY_REVIEW"], obligations: ["REQUIRE_HUMAN"] });
  });

  it("[AUTH-05] custody dispute forces REQUIRE_HUMAN", () => {
    const d = decide(req("appointment:read", "representative_access", auth(P.dana.actorId, "personal_representative", null, null), resource("appointment", P.casey.subjectId, null, "PHI"), [{ ...danaParental, constraints: ["CUSTODY_DISPUTE"] }]));
    expect(d).toMatchObject({ allow: false, reasonCodes: ["CUSTODY_DISPUTE"], obligations: ["REQUIRE_HUMAN"] });
  });

  it("[AUTH-05] practice delegation reaches exactly its organization", () => {
    const riley = auth(P.riley.actorId, "practice_staff", null, NORTH);
    const delegate = fact("practice_delegate", P.riley.actorId, null, NORTH, ["remittance:read"], "delegation_registry");
    expect(decide(req("remittance:read", "delegated_practice_administration", riley, resource("remittance", null, NORTH, "FINANCIAL"), [delegate])).allow).toBe(true);
    expect(decide(req("remittance:read", "delegated_practice_administration", riley, resource("remittance", null, "org_synthPracticeSouth1", "FINANCIAL"), [delegate])).allow).toBe(false);
  });

  it("[SPEC-4.single-role] a multi-role user's privileges are never combined", () => {
    const asClient = withAuth(morganAppointment(), { selectedRole: "client" });
    expect(decide(asClient)).toMatchObject({ allow: false, reasonCodes: ["RELATIONSHIP_NOT_ESTABLISHED"] });
  });
});

describe("policy engine: safety and human routes (SAFE-02)", () => {
  const allEngaged = { aiAdmission: true, writes: true, intents: ["safety_handoff", "human_handoff"], integrations: ["talkdesk-telephony", "salesforce"] };
  const allFlags = ["RECENT_NUMBER_CHANGE", "OTP_ABUSE_SUSPECTED", "ENUMERATION_SUSPECTED", "SHARED_DEVICE_POSSIBLE", "PARTICIPANT_CHANGED", "ACCOUNT_RECOVERY_IN_PROGRESS", "FRAUD_REVIEW", "SAFETY_ESCALATION_ACTIVE"] as const;

  for (const [action, reason] of [
    ["safety:route", "SAFETY_ROUTE_ALWAYS_AVAILABLE"],
    ["human:request", "HUMAN_ROUTE_ALWAYS_AVAILABLE"],
  ] as const) {
    it(`[SAFE-02] ${action} is allowed at A0 with no role or actor`, () => {
      expect(decide(anonymous(action, action === "safety:route" ? "safety_routing" : "human_handoff"))).toMatchObject({ allow: true, reasonCodes: [reason] });
    });

    it(`[SAFE-02] ${action} is allowed with a revoked and expired session`, () => {
      const x = withAuth(averyAppointment(), { revoked: true, expiresAt: EARLIER });
      expect(decide({ ...x, action })).toMatchObject({ allow: true, reasonCodes: [reason] });
    });

    it(`[SAFE-02] ${action} is allowed when the caller declined recording and processing`, () => {
      const x = withAuth(anonymous(action, "human_handoff"), { consentRecording: "DECLINED", consentAutomatedProcessing: "DECLINED" });
      expect(decide(x)).toMatchObject({ allow: true, reasonCodes: [reason] });
    });

    it(`[SAFE-02] ${action} is allowed with every kill switch engaged`, () => {
      expect(decide(withKs(anonymous(action, "human_handoff"), allEngaged))).toMatchObject({ allow: true, reasonCodes: [reason] });
    });

    it(`[SAFE-02] [SAFE-03] ${action} survives every failure at once (tenant, risk, A3 tool, secret classification, production)`, () => {
      const x = withResource(
        withAuth(withKs({ ...anonymous(action, "audit_review"), environment: "production", tool: { name: "synthetic_probe_tool", version: "1.0.0", minAssurance: "A3", consequential: true } }, allEngaged), {
          revoked: true,
          expiresAt: EARLIER,
          riskFlags: [...allFlags],
          consentRecording: "DECLINED",
          consentAutomatedProcessing: "DECLINED",
          tenantId: OTHER_TENANT_ID,
        }),
        { classification: "VERIFICATION_SECRET", subjectId: P.avery.subjectId },
      );
      expect(decide(x)).toMatchObject({ allow: true, reasonCodes: [reason] });
    });
  }

  it("[SAFE-02] the safety route creates a restricted record and discloses only routing fields", () => {
    const d = decide(anonymous("safety:route", "safety_routing"));
    expect(d.obligations).toEqual(["RESTRICTED_RECORD"]);
    expect(d.fieldMask).toEqual(["destinationPurpose", "status", "transferId"]);
  });
});

describe("policy engine: session, tenant, consent, risk and kill switches", () => {
  it("[AUTH-04] expired session fails closed before TTL cleanup", () => {
    expect(decide(withAuth(averyAppointment(), { expiresAt: EARLIER }))).toMatchObject({ allow: false, reasonCodes: ["SESSION_INVALID"] });
    expect(decide(withAuth(averyAppointment(), { expiresAt: NOW }))).toMatchObject({ allow: false, reasonCodes: ["SESSION_INVALID"] });
  });

  it("[AUTH-04] revoked session fails closed", () => {
    expect(decide(withAuth(averyAppointment(), { revoked: true }))).toMatchObject({ allow: false, reasonCodes: ["SESSION_INVALID"] });
  });

  it("[AUTH-04] non-canonical but valid timestamps are normalized before evaluation", () => {
    expect(decide(withAuth(averyAppointment(), { expiresAt: "2026-10-17T15:30:00Z" })).allow).toBe(true);
    expect(decide(withAuth(averyAppointment(), { expiresAt: "2026-10-17T15:00:00Z" })).allow).toBe(false);
    expect(decide({ ...withAuth(averyAppointment(), { expiresAt: "2026-10-17T15:00:00.0005Z" }) }).allow).toBe(false);
  });

  it("[SPEC-7.organization-isolation] tenant mismatch denies", () => {
    expect(decide(withResource(averyAppointment(), { tenantId: OTHER_TENANT_ID }))).toMatchObject({ allow: false, reasonCodes: ["TENANT_MISMATCH"] });
  });

  it("[DATA-03] consent declined leaves only safety, human, public and intake (policy default pending counsel)", () => {
    const declined = { consentAutomatedProcessing: "DECLINED" as const };
    expect(decide(withAuth(averyAppointment(), declined))).toMatchObject({ allow: false, reasonCodes: ["CONSENT_DECLINED_ALTERNATIVE_ROUTE"], obligations: ["REQUIRE_HUMAN"] });
    expect(decide(withAuth(anonymous("public:read", "public_information", "knowledge_article", "PUBLIC"), declined)).allow).toBe(true);
    expect(decide(withAuth(anonymous("intake:create", "caller_self_service", "support_request"), declined)).allow).toBe(true);
    expect(decide(withAuth(anonymous("verification:begin", "caller_self_service", "verification_challenge"), declined)).allow).toBe(false);
  });

  it("[DATA-03] consent UNKNOWN is never consent for protected work", () => {
    expect(decide(withAuth(averyAppointment(), { consentAutomatedProcessing: "UNKNOWN" }))).toMatchObject({ allow: false, reasonCodes: ["CONSENT_NOT_ESTABLISHED"] });
  });

  it("[SPEC-7.risk] fraud review and account recovery deny protected actions; safety escalation revokes mutations", () => {
    expect(decide(withAuth(averyAppointment(), { riskFlags: ["FRAUD_REVIEW"] })).reasonCodes).toEqual(["RISK_FRAUD_REVIEW"]);
    expect(decide(withAuth(averyAppointment(), { riskFlags: ["ACCOUNT_RECOVERY_IN_PROGRESS"] })).reasonCodes).toEqual(["RISK_ACCOUNT_RECOVERY_IN_PROGRESS"]);
    expect(decide(withAuth(averyAppointment(), { riskFlags: ["SAFETY_ESCALATION_ACTIVE"] })).allow).toBe(true);
    expect(decide(withAuth(averyCommit(), { riskFlags: ["SAFETY_ESCALATION_ACTIVE"] })).reasonCodes).toEqual(["SAFETY_MODE_MUTATIONS_REVOKED"]);
  });

  it("[SPEC-13.kill-switch] AI admission, writes, intent and integration switches", () => {
    expect(decide(withKs(averyAppointment(), { aiAdmission: true })).reasonCodes).toEqual(["KILL_SWITCH_AI_ADMISSION"]);
    expect(decide(withKs(averyAppointment(), { writes: true })).allow).toBe(true);
    expect(decide(withKs(averyCommit(), { writes: true })).reasonCodes).toEqual(["KILL_SWITCH_WRITES"]);
    expect(decide(withKs(averyAppointment(), { intents: ["appointment_lookup"] })).reasonCodes).toEqual(["KILL_SWITCH_INTENT"]);
    expect(decide(withKs(averyAppointment(), { integrations: ["scheduling"] })).reasonCodes).toEqual(["KILL_SWITCH_INTEGRATION"]);
  });

  it("[AUTH-06] verification secrets never flow through tools", () => {
    for (const environment of ["local", "production"] as const) {
      const d = decide({ ...withResource(anonymous("verification:begin", "caller_self_service", "verification_challenge"), { classification: "VERIFICATION_SECRET" }), environment });
      expect(d.allow).toBe(false);
      expect(d.reasonCodes).toContain("VERIFICATION_SECRET_PROHIBITED");
    }
  });

  it("[AUTH-02] multiple deny reasons are all reported", () => {
    const x = withKs(withResource(withAuth(averyCommit(), { expiresAt: EARLIER, riskFlags: ["FRAUD_REVIEW"] }), { tenantId: OTHER_TENANT_ID }), { aiAdmission: true, writes: true });
    expect(decide(x).reasonCodes).toEqual(["KILL_SWITCH_AI_ADMISSION", "KILL_SWITCH_WRITES", "RISK_FRAUD_REVIEW", "SESSION_INVALID", "TENANT_MISMATCH"]);
  });
});

describe("policy engine: prepared actions and step-up (ACT-01)", () => {
  const a3Tool = { name: "commit_appointment_change", version: "1.0.0", minAssurance: "A3" as const, consequential: true };

  it("[ACT-01] commit requires the prepared-action digest and carries REQUIRE_CONFIRMATION", () => {
    expect(decide(averyCommit())).toMatchObject({ allow: true, obligations: ["REQUIRE_CONFIRMATION"] });
    expect(decide(withResource(averyCommit(), { actionDigest: null }))).toMatchObject({ allow: false, reasonCodes: ["ACTION_DIGEST_REQUIRED"] });
  });

  it("[ACT-01] A3 step-up counts only for the digest it verified and only until it expires", () => {
    const base = { ...averyCommit(), tool: a3Tool };
    expect(decide(withAuth(base, { assurance: "A3", stepUpDigest: DIGEST_A, stepUpExpiresAt: LATER })).allow).toBe(true);
    expect(decide(withAuth(base, { assurance: "A3", stepUpDigest: DIGEST_B, stepUpExpiresAt: LATER }))).toMatchObject({ allow: false, reasonCodes: ["ASSURANCE_INSUFFICIENT", "STEP_UP_DIGEST_MISMATCH"], obligations: ["REQUIRE_STEP_UP"] });
    expect(decide(withAuth(base, { assurance: "A3", stepUpDigest: DIGEST_A, stepUpExpiresAt: NOW }))).toMatchObject({ allow: false, reasonCodes: ["ASSURANCE_INSUFFICIENT", "STEP_UP_EXPIRED"] });
    expect(decide(base)).toMatchObject({ allow: false, reasonCodes: ["ASSURANCE_INSUFFICIENT", "STEP_UP_REQUIRED"] });
  });

  it("[ACT-01] billing review never implies a refund: confirmation required and no refund field disclosed", () => {
    const d = decide({ ...averyCommit(), action: "billing:submit_review", resource: resource("invoice", P.avery.subjectId, null, "FINANCIAL", DIGEST_A) });
    expect(d.allow).toBe(true);
    expect(d.obligations).toEqual(["REQUIRE_CONFIRMATION"]);
    expect(d.fieldMask.some((f) => /refund/i.test(f))).toBe(false);
  });
});

describe("policy engine: server-established input only (AUTH-03)", () => {
  it("[AUTH-03] a model-proposed field such as callerClaimedRole makes the input invalid", () => {
    const d = decide({ ...averyAppointment(), callerClaimedRole: "provider" });
    expect(d).toMatchObject({ allow: false, reasonCodes: ["POLICY_INPUT_INVALID"], fieldMask: [] });
  });

  it("[AUTH-03] extra fields inside auth, resource, tool or a relationship fact are rejected", () => {
    const x = averyAppointment();
    expect(decide({ ...x, auth: { ...x.auth, modelSuggestedAssurance: "A3" } }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide({ ...x, resource: { ...x.resource, ownerClaim: P.avery.subjectId } }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide({ ...x, tool: { name: "t", version: "1.0.0", minAssurance: "A0", consequential: false, override: true } }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide({ ...x, relationships: [{ ...selfFact(P.avery), statedByCaller: true }] }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
  });

  it("[AUTH-03] a caller-stated relationship without an authoritative fact establishes nothing", () => {
    const x = req("appointment:read", "representative_access", auth(P.emery.actorId, "personal_representative", null, null), resource("appointment", P.blake.subjectId, null, "PHI"), []);
    expect(decide(x)).toMatchObject({ allow: false, reasonCodes: ["RELATIONSHIP_NOT_ESTABLISHED"] });
  });

  it("[AUTH-03] malformed values (bad enum, bad id, oversized) are invalid, never interpreted", () => {
    const x = averyAppointment();
    expect(decide({ ...x, purpose: "anything" }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide(withAuth(x, { actorId: "Avery Synthetic-Client" })).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide({ ...x, tool: { name: "x".repeat(70_000), version: "1", minAssurance: "A0", consequential: false } }).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide(null).reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
    expect(decide("appointment:read").reasonCodes).toEqual(["POLICY_INPUT_INVALID"]);
  });
});

describe("policy engine: version, digest and fail-closed behaviour (OPS-06)", () => {
  it("[OPS-06] engine reports the bundle revision from policy/VERSION and the sha256 of bundle.tar.gz", () => {
    const version = readFileSync(join(bundleDir, "..", "VERSION"), "utf8").trim();
    expect(engine.policyVersion).toBe(version);
    expect(engine.bundleDigest).toBe(sha256Hex(readFileSync(join(bundleDir, "bundle.tar.gz"))));
    expect(engine.describe()).toMatchObject({ kind: "live", policyVersion: version, entrypoints: [AUTHZ_ENTRYPOINT, CONSOLE_ENTRYPOINT].sort() });
  });

  it("[OPS-06] pinned version and digest are enforced at load", async () => {
    await expect(OpaWasmPolicyEngine.load({ bundleDir, expectedDigest: "0".repeat(64) })).rejects.toMatchObject({ reasonCode: "POLICY_BUNDLE_DIGEST_MISMATCH" });
    await expect(OpaWasmPolicyEngine.load({ bundleDir, expectedVersion: "1999.01.01-1" })).rejects.toMatchObject({ reasonCode: "POLICY_VERSION_MISMATCH" });
    const ok = await OpaWasmPolicyEngine.load({ bundleDir, expectedDigest: engine.bundleDigest, expectedVersion: engine.policyVersion });
    expect(ok.bundleDigest).toBe(engine.bundleDigest);
  });

  it("[OPS-06] accepts the policy/ directory and resolves its build/ subdirectory", async () => {
    const e = await OpaWasmPolicyEngine.load({ bundleDir: join(bundleDir, "..") });
    expect(e.bundleDigest).toBe(engine.bundleDigest);
  });

  describe("tampered bundles refuse to load", () => {
    let dir: string;
    const copyBundle = () => {
      dir = mkdtempSync(join(tmpdir(), "vsp-policy-"));
      for (const f of ["bundle.tar.gz", "bundle.sha256", "policy.wasm", "data.json", ".manifest"]) copyFileSync(join(bundleDir, f), join(dir, f));
      return dir;
    };
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    it("[OPS-06] bundle.sha256 not matching the archive", async () => {
      copyBundle();
      writeFileSync(join(dir, "bundle.sha256"), `${"1".repeat(64)}  bundle.tar.gz\n`);
      await expect(OpaWasmPolicyEngine.load({ bundleDir: dir })).rejects.toMatchObject({ reasonCode: "POLICY_BUNDLE_DIGEST_MISMATCH" });
      cleanup();
    });

    it("[OPS-06] extracted policy.wasm that differs from the archive", async () => {
      copyBundle();
      writeFileSync(join(dir, "policy.wasm"), Buffer.from("not the evaluated module"));
      await expect(OpaWasmPolicyEngine.load({ bundleDir: dir })).rejects.toMatchObject({ reasonCode: "POLICY_BUNDLE_EXTRACT_MISMATCH" });
      cleanup();
    });

    it("[OPS-06] corrupted archive", async () => {
      copyBundle();
      const bytes = readFileSync(join(dir, "bundle.tar.gz"));
      bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
      writeFileSync(join(dir, "bundle.tar.gz"), bytes);
      writeFileSync(join(dir, "bundle.sha256"), `${sha256Hex(bytes)}  bundle.tar.gz\n`);
      await expect(OpaWasmPolicyEngine.load({ bundleDir: dir })).rejects.toBeInstanceOf(PolicyBundleLoadError);
      cleanup();
    });

    it("[OPS-06] missing bundle yields a fail-closed engine instead of an open one", async () => {
      dir = mkdtempSync(join(tmpdir(), "vsp-policy-empty-"));
      const e = await loadPolicyEngineOrFailClosed({ bundleDir: dir });
      expect(e).toBeInstanceOf(FailClosedPolicyEngine);
      const d = await e.decide(anonymous("safety:route", "safety_routing"));
      expect(d).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      expect((e as FailClosedPolicyEngine).loadReasonCode).toBe("POLICY_BUNDLE_NOT_FOUND");
      cleanup();
    });
  });

  describe("evaluation faults (fault-injected evaluator)", () => {
    const stub = (evaluate: PolicyEvaluator["evaluate"], opts = {}) =>
      OpaWasmPolicyEngine.fromEvaluator({ policyVersion: engine.policyVersion, bundleDigest: engine.bundleDigest, catalogue: engine.catalogue, evaluator: { entrypoints: [AUTHZ_ENTRYPOINT, CONSOLE_ENTRYPOINT], evaluate } }, opts);

    it("[AUTH-02][FAULT:POLICY_ENGINE_ERROR seam] tighten-only, field mask: a decorated mask inside the catalogue but wider than the loaded decision's is refused", () => {
      // The loaded (stub) policy allows with a narrow mask; the catalogue allows more, so only the seam rule can refuse.
      const loaded = stub(() => [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: ["appointmentId"], obligations: ["AUDIT_READ"] } }]);
      expect(loaded.decideSync(averyAppointment())).toMatchObject({ allow: true, fieldMask: ["appointmentId"] });
      const catalogueMask = [...engine.catalogue.actions["appointment:read"]!.fieldMask];
      expect(catalogueMask.length).toBeGreaterThan(1);
      const widen = loaded.decorateEvaluator(() => ({ entrypoints: [AUTHZ_ENTRYPOINT, CONSOLE_ENTRYPOINT], evaluate: () => [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: catalogueMask, obligations: ["AUDIT_READ"] } }] }), { environment: "ci" });
      expect(loaded.decideSync(averyAppointment())).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [] });
      widen.remove();
      expect(loaded.decideSync(averyAppointment())).toMatchObject({ allow: true, fieldMask: ["appointmentId"] });
    });

    it("[OPS-06] engine error -> deny POLICY_ENGINE_ERROR, never a throw", async () => {
      const { logger, records } = createMemoryLogger();
      const e = stub(() => {
        throw "opa_abort: synthetic failure";
      }, { logger });
      const d = await e.decide(averyAppointment());
      expect(d).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [] });
      expect(PolicyDecision.safeParse(d).success).toBe(true);
      expect(records.some((r) => r.event === "policy.decision.fail_closed" && r.fields.reasonCode === "POLICY_ENGINE_ERROR")).toBe(true);
    });

    it("[OPS-06] malformed or empty result sets deny", () => {
      for (const result of [[], [{}], [{ result: { allow: "yes" } }], [{ result: { allow: true, reasonCodes: [], fieldMask: [], obligations: [] } }], [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: [], obligations: [], extra: 1 } }], null, "allow"]) {
        expect(stub(() => result).decideSync(averyAppointment())).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      }
    });

    it("[AUTH-04] TypeScript guard turns an allow for an expired session into a deny", () => {
      const allowEverything = () => [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: ["status"], obligations: [] } }];
      const e = stub(allowEverything);
      expect(e.decideSync(withAuth(averyAppointment(), { expiresAt: EARLIER }))).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      expect(e.decideSync(withAuth(averyAppointment(), { revoked: true })).allow).toBe(false);
      expect(e.decideSync(withResource(averyAppointment(), { tenantId: OTHER_TENANT_ID })).allow).toBe(false);
      expect(e.decideSync(withKs(averyAppointment(), { aiAdmission: true })).allow).toBe(false);
      expect(e.decideSync(withKs(averyCommit(), { writes: true })).allow).toBe(false);
      expect(e.decideSync(withResource(averyAppointment(), { classification: "VERIFICATION_SECRET" })).allow).toBe(false);
      expect(e.decideSync(averyAppointment()).allow).toBe(true);
    });

    it("[DATA-01] TypeScript guard rejects a field mask wider than the catalogue", () => {
      const e = stub(() => [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: ["status", "diagnosis"], obligations: [] } }]);
      expect(e.decideSync(averyAppointment())).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
    });

    it("[OPS-06] a broken clock fails closed; a throwing metrics sink never changes a decision", () => {
      const brokenClock = { now: () => new Date(Number.NaN) };
      const brokenMetrics = { increment: () => { throw new Error("metrics down"); }, observe: () => undefined, gauge: () => undefined };
      const brokenTime = engine.withOptions({ clock: brokenClock }).decideSync(averyAppointment());
      expect(brokenTime).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      expect(PolicyDecision.safeParse(brokenTime).success).toBe(true);
      const brokenSink = engine.withOptions({ metrics: brokenMetrics }).decideSync(averyAppointment());
      expect(brokenSink.allow).toBe(true);
    });

    it("[OPS-06] reason lists longer than the protocol bound are truncated, never dropped silently", () => {
      const many = Array.from({ length: 30 }, (_, i) => `REASON_${String.fromCharCode(65 + (i % 26))}${i}`);
      const d = stub(() => [{ result: { allow: false, reasonCodes: many, fieldMask: [], obligations: [] } }]).decideSync(averyAppointment());
      expect(d.allow).toBe(false);
      expect(d.reasonCodes).toHaveLength(16);
      expect(d.reasonCodes[15]).toBe("REASON_CODES_TRUNCATED");
    });

    it("[OPS-06] the catalogue is validated even for an injected evaluator", () => {
      expect(() => OpaWasmPolicyEngine.fromEvaluator({ policyVersion: "x", bundleDigest: "0".repeat(64), catalogue: { schemaVersion: 1 }, evaluator: { entrypoints: [], evaluate: () => [] } })).toThrow();
    });
  });

  describe("evaluator decoration seam (fault injection on the loaded WASM engine)", () => {
    it("[FAULT:POLICY_ENGINE_ERROR seam][OPS-06] the default engine has no decoration; a throwing or undefined decoration of the loaded WASM evaluator denies with POLICY_ENGINE_ERROR and removal restores identical decisions", async () => {
      const e = await loadTestEngine();
      expect(e.evaluatorDecorated).toBe(false);
      expect(engine.evaluatorDecorated).toBe(false);
      const baseline = e.decideSync(averyAppointment());
      expect(baseline.allow).toBe(true);
      const { logger, records } = createMemoryLogger();
      const logged = e.withOptions({ logger });
      expect(logged.evaluatorDecorated).toBe(false);

      let mode: "THROW" | "UNDEFINED" | null = "THROW";
      let calls = 0;
      const handle = logged.decorateEvaluator(
        (inner) => ({
          entrypoints: inner.entrypoints,
          evaluate: (input, entrypoint) => {
            calls += 1;
            if (mode === "THROW") throw new Error("synthetic evaluation fault");
            if (mode === "UNDEFINED") return undefined;
            return inner.evaluate(input, entrypoint);
          },
        }),
        { environment: "ci" },
      );
      expect(logged.evaluatorDecorated).toBe(true);
      expect(handle.active).toBe(true);
      expect(logged.decideSync(averyAppointment())).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [] });
      expect(records.some((r) => r.event === "policy.decision.fail_closed" && r.fields.detailCode === "POLICY_EVALUATION_FAILED")).toBe(true);
      mode = "UNDEFINED";
      expect(logged.decideSync(averyAppointment())).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      expect(records.some((r) => r.event === "policy.decision.fail_closed" && r.fields.detailCode === "POLICY_RESULT_MALFORMED")).toBe(true);
      // The console entrypoint goes through the same seam and fails closed the same way.
      const consoleInput = { action: "console:session", origin: "workforce_console" as const, environment: "local" as const, now: NOW, staff: { staffId: "stf_synthetic0001", tenantId: TENANT_ID, roles: ["supervisor" as const], mfa: true, authenticatedAt: NOW, breakGlass: null }, resource: { type: "console_session", tenantId: null, killSwitchScope: null, initiatorStaffId: null, assignedStaffId: null } };
      expect((await e.decideConsole(consoleInput)).allow).toBe(true);
      const consoleDecision = await logged.decideConsole(consoleInput);
      expect(consoleDecision).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      // Pass-through: decisions are identical to the undecorated engine.
      mode = null;
      expect(logged.decideSync(averyAppointment())).toMatchObject({ allow: baseline.allow, reasonCodes: baseline.reasonCodes, fieldMask: baseline.fieldMask });
      expect(calls).toBeGreaterThanOrEqual(4);
      // The decoration belongs to the instance it was installed on (the parent engine is untouched).
      expect(e.evaluatorDecorated).toBe(false);
      expect(e.decideSync(averyAppointment()).allow).toBe(true);
      // A copy made while decorated is built over the undecorated evaluator.
      mode = "THROW";
      expect(logged.withOptions({}).decideSync(averyAppointment()).allow).toBe(true);
      handle.remove();
      handle.remove();
      expect(handle.active).toBe(false);
      expect(logged.evaluatorDecorated).toBe(false);
      expect(logged.decideSync(averyAppointment()).allow).toBe(true);
    });

    it("[OPS-06] one decoration at a time; a decoration that changes the entrypoints is refused", async () => {
      const e = await loadTestEngine();
      const local = { environment: "local" as const };
      const h = e.decorateEvaluator((inner) => inner, local);
      expect(() => e.decorateEvaluator((inner) => inner, local)).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_ALREADY_DECORATED" }));
      h.remove();
      expect(() => e.decorateEvaluator((inner) => ({ entrypoints: [AUTHZ_ENTRYPOINT], evaluate: inner.evaluate }), local)).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_DECORATION_INVALID" }));
      expect(() => e.decorateEvaluator(() => ({}) as PolicyEvaluator, local)).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_DECORATION_INVALID" }));
      expect(e.evaluatorDecorated).toBe(false);
      expect(e.decideSync(averyAppointment()).allow).toBe(true);
    });

    it("[OPS-04][FAULT:POLICY_ENGINE_ERROR seam] the seam is local/ci only: refused for a deployed environment, and on an engine loaded for one whatever the caller claims", async () => {
      const e = await loadTestEngine();
      for (const environment of ["sandbox", "staging", "production"] as const) {
        expect(() => e.decorateEvaluator((inner) => inner, { environment })).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_SEAM_NOT_ALLOWED" }));
      }
      expect(() => e.decorateEvaluator((inner) => inner, undefined as unknown as { environment: "ci" })).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_SEAM_NOT_ALLOWED" }));
      const deployed = e.withOptions({ environment: "production" });
      expect(() => deployed.decorateEvaluator((inner) => inner, { environment: "ci" })).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_SEAM_NOT_ALLOWED" }));
      // A copy of the deployed engine keeps its environment.
      expect(() => deployed.withOptions({}).decorateEvaluator((inner) => inner, { environment: "local" })).toThrow(expect.objectContaining({ reasonCode: "POLICY_EVALUATOR_SEAM_NOT_ALLOWED" }));
      expect(e.evaluatorDecorated).toBe(false);
      expect(deployed.evaluatorDecorated).toBe(false);
    });

    it("[AUTH-02][OPS-06][FAULT:POLICY_ENGINE_ERROR seam] tighten-only: a decoration can never allow what the loaded policy denies, widen the field mask or drop an obligation", async () => {
      const e = await loadTestEngine();
      const allowed = averyAppointment();
      const baseline = e.decideSync(allowed);
      expect(baseline.allow).toBe(true);
      // An A0 protected read is denied by the loaded policy.
      const denied: PolicyInput = { ...allowed, auth: { ...allowed.auth, assurance: "A0" } };
      const deniedBaseline = e.decideSync(denied);
      expect(deniedBaseline).toMatchObject({ allow: false });
      expect(deniedBaseline.reasonCodes).toContain("ASSURANCE_INSUFFICIENT");
      // Capture the loaded evaluator's raw ALLOW result to replay it (the widening adversary).
      let capturedAllow: unknown = null;
      const capture = e.decorateEvaluator(
        (inner) => ({
          entrypoints: inner.entrypoints,
          evaluate: (input, entrypoint) => {
            const out = inner.evaluate(input, entrypoint);
            if (entrypoint === AUTHZ_ENTRYPOINT && capturedAllow === null) capturedAllow = structuredClone(out);
            return out;
          },
        }),
        { environment: "ci" },
      );
      expect(e.decideSync(allowed)).toMatchObject({ allow: true, reasonCodes: baseline.reasonCodes, fieldMask: baseline.fieldMask });
      capture.remove();
      expect(capturedAllow).not.toBeNull();
      const { logger, records } = createMemoryLogger();
      const logged = e.withOptions({ logger });
      type Raw = [{ result: { allow: boolean; reasonCodes: string[]; fieldMask: string[]; obligations: string[] } }];
      let rewrite: (raw: Raw) => unknown = (raw) => raw;
      const widen = logged.decorateEvaluator(
        (inner) => ({
          entrypoints: inner.entrypoints,
          evaluate: (input, entrypoint) => (entrypoint === AUTHZ_ENTRYPOINT ? rewrite(structuredClone(capturedAllow) as Raw) : inner.evaluate(input, entrypoint)),
        }),
        { environment: "ci" },
      );
      // 1. The captured allow replayed for the A0 request: never an allow.
      expect(logged.decideSync(denied)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [] });
      expect(records.some((r) => r.event === "policy.decision.fail_closed" && r.fields.detailCode === "POLICY_EVALUATOR_DECORATION_WIDENED")).toBe(true);
      // 2. A wider field mask than the loaded decision's, even where the loaded policy allows.
      rewrite = (raw) => [{ result: { ...raw[0].result, fieldMask: [...raw[0].result.fieldMask, "subjectId"] } }];
      expect(logged.decideSync(allowed)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      // 3. A dropped obligation (AUDIT_READ) is a widening too.
      expect(baseline.obligations).toContain("AUDIT_READ");
      rewrite = (raw) => [{ result: { ...raw[0].result, obligations: [] } }];
      expect(logged.decideSync(allowed)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      // 4. Narrowing is allowed (a subset of the mask, extra obligations), with the loaded policy's reasons.
      rewrite = (raw) => [{ result: { ...raw[0].result, reasonCodes: ["ALLOW_FORGED_REASON"], fieldMask: raw[0].result.fieldMask.slice(0, 1) } }];
      const narrowed = logged.decideSync(allowed);
      expect(narrowed).toMatchObject({ allow: true, reasonCodes: baseline.reasonCodes, fieldMask: baseline.fieldMask.slice(0, 1) });
      // 5. A decorated deny stays a deny.
      rewrite = (raw) => [{ result: { ...raw[0].result, allow: false, reasonCodes: ["INJECTED_DENY"] } }];
      expect(logged.decideSync(allowed)).toMatchObject({ allow: false, reasonCodes: ["INJECTED_DENY"] });
      widen.remove();
      expect(logged.decideSync(denied)).toMatchObject({ allow: false, reasonCodes: deniedBaseline.reasonCodes });
      // The console entrypoint: a replayed allow for a denied console request is refused the same way.
      // Prohibited for everyone (spec section 16): secret values are never displayed.
      const consoleDenied = { action: "secret:view", origin: "workforce_console" as const, environment: "local" as const, now: NOW, staff: { staffId: "stf_synthetic0001", tenantId: TENANT_ID, roles: ["supervisor" as const], mfa: true, authenticatedAt: NOW, breakGlass: null }, resource: { type: "secret", tenantId: null, killSwitchScope: null, initiatorStaffId: null, assignedStaffId: null } };
      expect((await e.decideConsole(consoleDenied)).allow).toBe(false);
      const forgeConsole = logged.decorateEvaluator(
        (inner) => ({ entrypoints: inner.entrypoints, evaluate: (input, entrypoint) => (entrypoint === CONSOLE_ENTRYPOINT ? [{ result: { allow: true, reasonCodes: ["ALLOW_FORGED"], obligations: [] } }] : inner.evaluate(input, entrypoint)) }),
        { environment: "ci" },
      );
      expect(await logged.decideConsole(consoleDenied)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      forgeConsole.remove();
    });

    it("[AUTH-02][OPS-06] the tighten-only rule binds ANY substituted evaluator, including one swapped in without the seam", async () => {
      const e = (await loadTestEngine()).withOptions({});
      const allowed = averyAppointment();
      const denied: PolicyInput = { ...allowed, auth: { ...allowed.auth, assurance: "A0" } };
      const forged = [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: ["appointmentId"], obligations: ["AUDIT_READ"] } }];
      // Labelled adversary: replaces the private evaluator field directly (what a cast-based injector would do).
      const holder = e as unknown as { evaluator: PolicyEvaluator };
      const original = holder.evaluator;
      holder.evaluator = { entrypoints: original.entrypoints, evaluate: () => forged };
      try {
        expect(e.decideSync(denied)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      } finally {
        holder.evaluator = original;
      }
      expect(e.decideSync(allowed).allow).toBe(true);
    });

    it("[AUTH-02][AUTH-04][OPS-06][FAULT:POLICY_ENGINE_ERROR seam] input isolation: a decoration that rewrites the input it is handed (assurance, revocation, tenant) never turns the loaded policy's deny into an allow", async () => {
      const e = await loadTestEngine();
      const allowed = averyAppointment();
      expect(e.decideSync(allowed).allow).toBe(true);
      const cases: { name: string; input: PolicyInput; rewrite: (i: { auth: Record<string, unknown>; resource: Record<string, unknown> }) => void }[] = [
        { name: "assurance A0 -> A2", input: withAuth(averyAppointment(), { assurance: "A0" }), rewrite: (i) => void (i.auth.assurance = "A2") },
        { name: "revoked -> false", input: withAuth(averyAppointment(), { revoked: true }), rewrite: (i) => void (i.auth.revoked = false) },
        { name: "foreign tenant -> own", input: { ...averyAppointment(), resource: { ...averyAppointment().resource, tenantId: OTHER_TENANT_ID } }, rewrite: (i) => void (i.resource.tenantId = allowed.resource.tenantId) },
      ];
      for (const c of cases) {
        const base = e.decideSync(c.input);
        expect(base.allow, c.name).toBe(false);
        // (a) In place, on the object the decoration is handed (the verifier's probe P9): it is frozen.
        let threw: unknown = null;
        const inPlace = e.decorateEvaluator(
          (inner) => ({
            entrypoints: inner.entrypoints,
            evaluate: (input, entrypoint) => {
              if (entrypoint === AUTHZ_ENTRYPOINT) {
                try {
                  c.rewrite(input as { auth: Record<string, unknown>; resource: Record<string, unknown> });
                } catch (err) {
                  threw = err;
                  throw err;
                }
              }
              return inner.evaluate(input, entrypoint);
            },
          }),
          { environment: "local" },
        );
        expect(e.decideSync(c.input), c.name).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [] });
        expect(threw, c.name).toBeInstanceOf(TypeError);
        inPlace.remove();
        // (b) On its own rewritten copy, so the loaded evaluator inside the decoration really allows: the rule
        //     re-asks the loaded evaluator with the engine's pristine input and refuses the widening.
        const onCopy = e.decorateEvaluator(
          (inner) => ({
            entrypoints: inner.entrypoints,
            evaluate: (input, entrypoint) => {
              const mine = structuredClone(input) as { auth: Record<string, unknown>; resource: Record<string, unknown> };
              if (entrypoint === AUTHZ_ENTRYPOINT) c.rewrite(mine);
              return inner.evaluate(mine, entrypoint);
            },
          }),
          { environment: "local" },
        );
        expect(e.decideSync(c.input), c.name).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [] });
        onCopy.remove();
        expect(e.decideSync(c.input), c.name).toMatchObject({ allow: false, reasonCodes: base.reasonCodes });
      }
      // The console entrypoint: a supervisor rewritten into a security_admin on the shared input (in place) and
      // on a copy is refused the same way.
      const consoleInput = { action: "recovery_identity:approve", origin: "workforce_console" as const, environment: "local" as const, now: NOW, staff: { staffId: "stf_synthetic0001", tenantId: TENANT_ID, roles: ["supervisor" as const], mfa: true, authenticatedAt: NOW, breakGlass: null }, resource: { type: "recovery_identity", tenantId: TENANT_ID, killSwitchScope: null, initiatorStaffId: "stf_synthetic0002", assignedStaffId: null } };
      expect((await e.decideConsole(consoleInput)).allow).toBe(false);
      expect((await e.decideConsole({ ...consoleInput, staff: { ...consoleInput.staff, roles: ["security_admin" as const] } as unknown as typeof consoleInput.staff })).allow).toBe(true);
      for (const copy of [false, true]) {
        const h = e.decorateEvaluator(
          (inner) => ({
            entrypoints: inner.entrypoints,
            evaluate: (input, entrypoint) => {
              if (entrypoint !== CONSOLE_ENTRYPOINT) return inner.evaluate(input, entrypoint);
              const target = (copy ? structuredClone(input) : input) as { staff: { roles: string[] } };
              target.staff.roles = ["security_admin"];
              return inner.evaluate(target, entrypoint);
            },
          }),
          { environment: "local" },
        );
        expect(await e.decideConsole(consoleInput)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
        h.remove();
      }
    });

    it("[AUTH-02][OPS-06] a decoration cannot alter the loaded evaluator it is handed: `inner` is frozen and the rule consults a private copy", async () => {
      const e = await loadTestEngine();
      const denied = withAuth(averyAppointment(), { assurance: "A0" });
      const forged = [{ result: { allow: true, reasonCodes: ["ALLOW_SELF"], fieldMask: ["appointmentId"], obligations: ["AUDIT_READ"] } }];
      expect(() =>
        e.decorateEvaluator((inner) => {
          (inner as { evaluate: PolicyEvaluator["evaluate"] }).evaluate = () => forged;
          return inner;
        }, { environment: "local" }),
      ).toThrow(TypeError);
      expect(e.evaluatorDecorated).toBe(false);
      expect(() =>
        e.decorateEvaluator((inner) => {
          (inner.entrypoints as string[]).push("vsp/forged");
          return inner;
        }, { environment: "local" }),
      ).toThrow(TypeError);
      // A cast-based swap of the field the engine USES cannot reach the private loaded copy either.
      const holder = e as unknown as { evaluator: PolicyEvaluator; baseEvaluator?: PolicyEvaluator };
      const original = holder.evaluator;
      holder.baseEvaluator = { entrypoints: original.entrypoints, evaluate: () => forged };
      holder.evaluator = { entrypoints: original.entrypoints, evaluate: () => forged };
      try {
        expect(e.decideSync(denied)).toMatchObject({ allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"] });
      } finally {
        holder.evaluator = original;
        delete holder.baseEvaluator;
      }
      expect(e.decideSync(denied)).toMatchObject({ allow: false, reasonCodes: expect.arrayContaining(["ASSURANCE_INSUFFICIENT"]) });
    });
  });

  it("[OPS-06] decisions are counted with allowlisted labels only", () => {
    const metrics = new InMemoryMetrics();
    const e = engine.withOptions({ metrics, clock: new FakeClock(NOW) });
    expect(e.decideSync(averyAppointment()).evaluatedAt).toBe(NOW);
    e.decideSync({ ...averyAppointment(), action: "records:export_all" });
    expect(metrics.droppedCalls).toBe(0);
  });
});

describe("timestamp normalization", () => {
  it("[OPS-03] canonical form or null; calendar rollovers rejected", () => {
    expect(canonicalTimestamp("2026-10-17T15:00:00Z")).toBe("2026-10-17T15:00:00.000Z");
    expect(canonicalTimestamp("2026-10-17T15:00:00.123456Z")).toBe("2026-10-17T15:00:00.123Z");
    expect(canonicalTimestamp("2026-02-30T00:00:00.000Z")).toBeNull();
    expect(canonicalTimestamp("not a time")).toBeNull();
  });
});
