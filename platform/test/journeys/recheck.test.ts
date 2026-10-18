/**
 * [SPEC-9.recheck] Pre-disclosure / material-change recheck on the LOCAL FIXTURE composition
 * (src/business/recheck.ts wired into the container's PgWorkflowEngine). SYNTHETIC people,
 * LOCAL FIXTURE registries; nothing here is sandbox or production evidence.
 *
 * Durable work accepted during real calls (complaint, partner onboarding, billing review) is
 * driven to its guarded transition; the recheck re-evaluates, at that moment, the grant's
 * actor and subject against CURRENT representation, account state, consent and policy.
 * A deny records POLICY_CHANGED_PENDING_ACTION and the pending action stays with a human.
 * The policy-change cases load a deliberately changed copy of the bundle (built in a temp
 * directory with the pinned OPA, as in src/policy/golden-gate.test.ts) into a second engine
 * over the same database: "the deployment now runs a newer policy".
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantActionsFor } from "../../src/business/grants.js";
import { LocalAccountStateFixture } from "../../src/business/fixtures/recheck.fixture.js";
import { BusinessPreDisclosureRecheck } from "../../src/business/recheck.js";
import { INVOICES, ORGANIZATIONS, PEOPLE, STAFF } from "../../src/fixtures/synthetic-world.js";
import { OpaWasmPolicyEngine, REPO_ROOT } from "../../src/policy/engine.js";
import { ensurePolicyBundle } from "../../src/policy/ensure-bundle.js";
import { addMs } from "../../src/shared/clock.js";
import { newId } from "../../src/shared/ids.js";
import { PgWorkflowEngine, WorkflowRecheckDeniedError } from "../../src/workflows/engine.js";
import { createDefaultRegistry } from "../../src/workflows/registry.js";
import { AVERY, QUINN, createJourneyHarness } from "./harness.js";
import type { JourneyHarness } from "./harness.js";

let h: JourneyHarness;
const tmpRoots: string[] = [];
let previousOpaBin: string | undefined;

beforeAll(async () => {
  previousOpaBin = process.env.OPA_BIN;
  process.env.OPA_BIN = join(REPO_ROOT, ".tools", "opa");
  h = await createJourneyHarness({ ingestKnowledge: false });
}, 180_000);
afterAll(async () => {
  await h?.close();
  if (previousOpaBin === undefined) delete process.env.OPA_BIN;
  else process.env.OPA_BIN = previousOpaBin;
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const SYSTEM = { kind: "system" as const, ref: "wrk_synthJourneyWorker01" };
const SUPERVISOR = () => ({ staffId: STAFF.supervisor.staffId, roles: ["supervisor" as const], mfa: true, authenticatedAt: h.clock.now().toISOString(), breakGlass: null });
const tenant = () => h.c.config.tenantId;

async function signal(workflowId: string, ...events: string[]): Promise<void> {
  for (const event of events) await h.c.workflows.signal({ tenantId: tenant(), workflowId, event, actor: SYSTEM });
  expect((await h.c.workflows.get(tenant(), workflowId))?.state).toBe("WAITING_FOR_HUMAN");
}

/** The SYNTHETIC supervisor completes the workflow's open human task through `engine` (default: the container's). */
async function decide(workflowId: string, decision: "APPROVE" | "REJECT", engine: PgWorkflowEngine = h.c.workflows) {
  const task = (await engine.openTasks(tenant(), ["supervisor"])).find((t) => t.workflowId === workflowId);
  expect(task, "open human task").toBeDefined();
  const staff = SUPERVISOR();
  const issued = await engine.issueTaskToken({ tenantId: tenant(), taskId: task?.taskId as string, staff });
  return engine.completeHumanTask({ tenantId: tenant(), taskId: task?.taskId as string, taskToken: issued.taskToken, decision, staff });
}

async function denialOf(p: Promise<unknown>): Promise<WorkflowRecheckDeniedError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorkflowRecheckDeniedError);
  return err as WorkflowRecheckDeniedError;
}

async function policyChangedReasons(workflowId: string): Promise<string[]> {
  const rows = await h.q<{ reason_code: string | null }>("select reason_code from workflow_events where workflow_id = $1 and trigger = 'POLICY_CHANGED_PENDING_ACTION' order by seq", [workflowId]);
  return rows.map((r) => r.reason_code ?? "");
}

async function workflowFor(type: string, correlationId: string): Promise<string> {
  const [wf] = await h.q<{ workflow_id: string }>("select workflow_id from workflow_instances where workflow_type = $1 and correlation_id = $2", [type, correlationId]);
  expect(wf?.workflow_id, `${type} workflow`).toMatch(/^wf_/);
  return wf?.workflow_id as string;
}

async function srIdOf(reference: string): Promise<string> {
  const sr = await h.c.business.supportRequests.getByReference(tenant(), reference);
  expect(sr, "support request").not.toBeNull();
  return sr?.supportRequestId as string;
}

const refOf = (data: unknown): string => JSON.stringify(data).match(/SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/)?.[0] as string;

/** A confirmed and committed billing review of Avery's invoice in a real call; returns the action id. */
async function acceptedAveryReview(): Promise<string> {
  h.c.fixtures.store.update("invoices", INVOICES[0].invoiceId, (inv: { status: string }) => {
    inv.status = "OPEN";
  });
  const call = h.call();
  await call.start();
  await call.role("client");
  expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
  const prep = await call.tool("prepare_billing_review", { invoiceId: INVOICES[0].invoiceId, reasonCategory: "AMOUNT_INCORRECT" });
  expect(prep.status).toBe("SUCCESS");
  await call.confirmPending();
  const done = await call.tool("submit_billing_review", { actionId: prep.data?.actionId as string, digest: prep.data?.actionDigest as string });
  expect(done.status).toBe("SUCCESS");
  await call.end();
  return prep.data?.actionId as string;
}

/** Copy of the policy sources with `mutate` applied and VERSION set, built with the pinned OPA into a temp dir. */
function variantBundle(version: string, mutate: (catalogue: { actions: Record<string, { purposes: string[]; access: { purposes: string[] }[] }> }) => void): string {
  const root = mkdtempSync(join(tmpdir(), "vsp-recheck-policy-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO_ROOT, "scripts", "policy.sh"), join(root, "scripts", "policy.sh"));
  const policyDir = join(root, "policy");
  mkdirSync(policyDir);
  cpSync(join(REPO_ROOT, "policy", "vsp"), join(policyDir, "vsp"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "policy", "wasm-capabilities.json"), join(policyDir, "wasm-capabilities.json"));
  writeFileSync(join(policyDir, "VERSION"), `${version}\n`);
  const dataPath = join(policyDir, "vsp", "data.json");
  const doc = JSON.parse(readFileSync(dataPath, "utf8")) as { vsp: { catalogue: Parameters<typeof mutate>[0] } };
  mutate(doc.vsp.catalogue);
  writeFileSync(dataPath, JSON.stringify(doc, null, 2));
  return ensurePolicyBundle({ repoRoot: root }).bundleDir;
}

/** A second engine over the same database whose recheck evaluates `policy` (the newer bundle). */
function engineWithPolicy(policy: OpaWasmPolicyEngine): PgWorkflowEngine {
  const recheck = new BusinessPreDisclosureRecheck({
    policy,
    directory: h.c.identity.directory,
    relationships: h.c.fixtures.relationships,
    billing: h.c.fixtures.billing,
    accounts: new LocalAccountStateFixture(h.c.identity.directory),
    consent: h.c.recheck.consent,
    environment: h.c.environment,
  });
  return new PgWorkflowEngine({ db: h.c.db, registry: createDefaultRegistry(), audit: h.c.audit, clock: h.clock, grantStore: h.c.grants, recheck });
}

describe("[SPEC-9.recheck] pre-disclosure recheck on the local composition", () => {
  it("[SPEC-9.recheck][SPEC-7.durable-grant] a verified client's complaint response (case:read, durable_follow_up) passes the current recheck and completes", async () => {
    const call = h.call();
    await call.start();
    await call.role("client");
    expect((await call.verify(AVERY, "avery.synthetic")).bound).toBe(true);
    const r = await call.tool("submit_complaint", { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" });
    expect(r.status).toBe("SUCCESS");
    expect(r.data?.linkedToAccount).toBe(true);
    await call.end();
    const workflowId = await workflowFor("complaint_review", await srIdOf(refOf(r.data)));
    await signal(workflowId, "VALIDATE", "TRIAGED");
    expect((await decide(workflowId, "APPROVE")).state).toBe("COMPLETED");
    expect(await policyChangedReasons(workflowId)).toEqual([]);
  }, 120_000);

  it("[SPEC-9.recheck][AUTH-01] an unverified caller's complaint has no verified account to disclose to: the response waits for a human (RECHECK_SUBJECT_NOT_ESTABLISHED)", async () => {
    const call = h.call();
    await call.start();
    const r = await call.tool("submit_complaint", { category: "SERVICE_EXPERIENCE", wantsCallback: true, language: "en" });
    expect(r.status).toBe("SUCCESS");
    expect(r.data?.linkedToAccount).toBe(false);
    await call.end();
    const workflowId = await workflowFor("complaint_review", await srIdOf(refOf(r.data)));
    await signal(workflowId, "VALIDATE", "TRIAGED");
    const err = await denialOf(decide(workflowId, "APPROVE"));
    expect(err.reasonCode).toBe("RECHECK_SUBJECT_NOT_ESTABLISHED");
    expect(err.instance.state).toBe("WAITING_FOR_HUMAN");
    expect(await policyChangedReasons(workflowId)).toEqual(["RECHECK_SUBJECT_NOT_ESTABLISHED"]);
  }, 120_000);

  it("[SPEC-9.recheck][AUTH-05] partner onboarding decision notice: allowed with a current affiliation; after the partner contract registry ends the affiliation the next notice is denied (AUTHORIZATION_EXPIRED)", async () => {
    const call = h.call();
    await call.start();
    await call.role("partner");
    expect((await call.verify(QUINN, "quinn.synthetic")).bound).toBe(true);
    const first = await call.tool("submit_partner_intake", { requestType: "NEW_PARTNER_ONBOARDING", urgency: "STANDARD", language: "en" });
    const second = await call.tool("submit_partner_intake", { requestType: "NEW_PARTNER_ONBOARDING", urgency: "URGENT", language: "en" });
    expect([first.status, second.status]).toEqual(["SUCCESS", "SUCCESS"]);
    await call.end();
    const wf1 = await workflowFor("partner_onboarding", await srIdOf(refOf(first.data)));
    const wf2 = await workflowFor("partner_onboarding", await srIdOf(refOf(second.data)));
    expect(wf1).not.toBe(wf2);

    await signal(wf1, "VALIDATE", "CONTRACT_VERIFIED");
    expect((await decide(wf1, "REJECT")).state).toBe("COMPLETED");

    // The partner contract registry ends Quinn's affiliation with Acme (LOCAL FIXTURE registry change).
    h.c.fixtures.relationships.revokeGrant("gnt_synthQuinnAcmeAffiliation", addMs(h.clock.now(), -1000).toISOString());
    await signal(wf2, "VALIDATE", "CONTRACT_VERIFIED");
    const err = await denialOf(decide(wf2, "REJECT"));
    expect(err.reasonCode).toBe("AUTHORIZATION_EXPIRED");
    expect(await policyChangedReasons(wf2)).toEqual(["AUTHORIZATION_EXPIRED"]);
    const [grant] = await h.q<{ subject_id: string }>("select g.subject_id from durable_action_grants g join workflow_instances w on w.grant_ref = g.grant_id where w.workflow_id = $1", [wf2]);
    expect(grant?.subject_id).toBe(ORGANIZATIONS.partnerAcme.organizationId);
  }, 120_000);

  it("[SPEC-9.recheck][AUTH-05][SPEC-4.audience] a representative-held review grant: expired legal authority denies the decision notice (AUTHORIZATION_EXPIRED); renewed authority in the registry allows it", async () => {
    // LOCAL FIXTURE setup: no current business flow issues a representative-held billing grant (billing
    // review commits are client-only), but the recheck must still enforce representation for one.
    const tenantId = tenant();
    const blake = PEOPLE.blake;
    const emery = PEOPLE.emery;
    const blakeInvoice = INVOICES[1].invoiceId;
    const sourceAction = newId("act");
    const workflowId = await h.c.db.tx(
      async (tx) => {
        const { grantRef } = await h.c.grants.issue(
          { tenantId, subjectId: blake.subjectId, actorId: emery.actorId, actions: grantActionsFor("billing_dispute_review"), expiresAt: addMs(h.clock.now(), 86_400_000), sourceRef: sourceAction },
          tx,
        );
        const wf = await h.c.workflows.start({ tenantId, type: "billing_dispute_review", correlationId: sourceAction, sourceRecordRefs: [sourceAction, blakeInvoice, grantRef], grantRef }, tx);
        return wf.workflowId;
      },
      { role: "app_runtime", rls: { tenantId } },
    );
    // Current consent for the represented subject is on record (trusted consent registry, LOCAL FIXTURE).
    h.c.recheck.consent.record(tenantId, blake.subjectId, "GRANTED");
    await signal(workflowId, "VALIDATE", "VALIDATION_PASSED");

    // Emery's legal authority over Blake ended on 2026-06-30 (SYNTHETIC registry record).
    const err = await denialOf(decide(workflowId, "REJECT"));
    expect(err.reasonCode).toBe("AUTHORIZATION_EXPIRED");
    expect(await policyChangedReasons(workflowId)).toEqual(["AUTHORIZATION_EXPIRED"]);

    // The legal-authority registry records renewed authority: the same notice is now allowed.
    h.c.fixtures.relationships.addGrant({
      grantId: "gnt_synthEmeryBlakeRenewed01",
      kind: "legal_representative",
      actorId: emery.actorId,
      subjectId: blake.subjectId,
      organizationId: null,
      scopes: ["appointment:read", "invoice:read"],
      source: "legal_authority_registry",
      validFrom: "2026-10-01T00:00:00.000Z",
      validUntil: "2027-06-30T23:59:59.000Z",
      constraints: [],
    });
    expect((await decide(workflowId, "REJECT")).state).toBe("COMPLETED");
  }, 120_000);

  it("[SPEC-9.recheck][OPS-06] a policy changed after acceptance: the newer bundle that no longer permits durable follow-up denies the pending notice (POLICY_CHANGED_PENDING_ACTION, new version recorded); a newer bundle that still permits it is recorded as POLICY_VERSION_CHANGED", async () => {
    const tenantId = tenant();
    const actionId = await acceptedAveryReview();
    const workflowId = await workflowFor("billing_dispute_review", actionId);
    const [snap] = await h.q<{ policy_snapshot_version: string | null }>("select policy_snapshot_version from workflow_instances where workflow_id = $1", [workflowId]);
    expect(snap?.policy_snapshot_version).toBe(h.c.policy.policyVersion);
    await signal(workflowId, "VALIDATE", "VALIDATION_PASSED");

    // Newer policy: invoice:read no longer serves the durable_follow_up purpose (SYNTHETIC test variant).
    const restricted = await OpaWasmPolicyEngine.load({
      bundleDir: variantBundle("2026.10.19-1", (c) => {
        const a = c.actions["invoice:read"];
        if (!a) throw new Error("invoice:read missing");
        a.purposes = a.purposes.filter((p) => p !== "durable_follow_up");
        for (const p of a.access) p.purposes = p.purposes.filter((x) => x !== "durable_follow_up");
      }),
    });
    expect(restricted.policyVersion).not.toBe(h.c.policy.policyVersion);
    const err = await denialOf(decide(workflowId, "REJECT", engineWithPolicy(restricted)));
    expect(err.reasonCode).toBe("PURPOSE_NOT_PERMITTED");
    expect(err.instance.state).toBe("WAITING_FOR_HUMAN");
    expect(await policyChangedReasons(workflowId)).toEqual(["PURPOSE_NOT_PERMITTED"]);
    const audits = await h.c.auditQuery.search({ tenantId, correlationId: actionId, limit: 50 });
    expect(audits.find((e) => e.action === "workflow.recheck.denied")).toMatchObject({ outcome: "DENIED", reasonCode: "PURPOSE_NOT_PERMITTED", policyDecision: { allow: false, policyVersion: restricted.policyVersion } });
    expect(audits.some((e) => e.action === "workflow.policy_changed_pending_action" && e.reasonCode === "PURPOSE_NOT_PERMITTED")).toBe(true);

    // Newer policy, same rules: the notice proceeds and the version change is recorded as evidence.
    const same = await OpaWasmPolicyEngine.load({ bundleDir: variantBundle("2026.10.19-2", () => undefined) });
    expect((await decide(workflowId, "REJECT", engineWithPolicy(same))).state).toBe("COMPLETED");
    const allowed = (await h.c.auditQuery.search({ tenantId, correlationId: actionId, limit: 50 })).find((e) => e.action === "workflow.recheck.allowed");
    expect(allowed).toMatchObject({ outcome: "ALLOWED", reasonCode: "POLICY_VERSION_CHANGED", policyDecision: { allow: true, policyVersion: same.policyVersion } });
  }, 240_000);

  it("[SPEC-9.recheck][OPS-03] fail closed: a grant action without a recheck rule is denied (RECHECK_RULE_UNDEFINED) and a recheck outside the transition's transaction refuses to run", async () => {
    const tenantId = tenant();
    const base = {
      tenantId,
      workflowId: newId("wf"),
      workflowType: "callback_request" as const,
      definitionVersion: "1.0.0",
      fromState: "VALIDATING" as const,
      toState: "WAITING_FOR_CALLER" as const,
      event: "CONSENT_CONFIRMED",
      guard: "disclosure" as const,
      grantRef: newId("grt"),
      grantAction: "callback.outreach",
      sourceRecordRefs: [],
      policySnapshotVersion: null,
      actor: SYSTEM,
      now: h.clock.now().toISOString(),
    };
    const undefinedRule = await h.c.db.tx((tx) => h.c.recheck.service.recheck({ ...base, tx }), { role: "app_runtime", rls: { tenantId } });
    expect(undefinedRule).toMatchObject({ allow: false, reasonCode: "RECHECK_RULE_UNDEFINED" });
    await expect(h.c.recheck.service.recheck(base)).rejects.toMatchObject({ reasonCode: "RECHECK_TRANSACTION_REQUIRED" });
  }, 60_000);
});
