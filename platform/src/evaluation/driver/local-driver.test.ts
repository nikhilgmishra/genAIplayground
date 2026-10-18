/**
 * LocalConversationDriver over the FULL LOCAL STACK (LOCAL FIXTURE, SYNTHETIC data):
 * buildContainer("local") + the real business module + real worker loops, Studio
 * steps over the HTTP telephony-control API, tools over the HTTP tool route
 * (fastify.inject) or the real MCP SDK client on 127.0.0.1, portal approvals via the
 * LOCAL FIXTURE OIDC provider. FakeClock throughout; no external network.
 *
 * Every assertion checks FINAL SYSTEM STATE recorded by the backend (ledger rows and
 * receipts, fixture effect logs, transfer journeys, support requests, interaction
 * outcomes, audit chain), not conversation text. The caller side is the LOCAL
 * SIMULATED COORDINATOR (rule-based; NOT a model, NOT model evaluation).
 *
 * Repetitions are reduced to one per scenario here for test time only; the corpus
 * run (run-corpus.ts) uses every scenario's own repetitions.
 */
import { describe, expect, it } from "vitest";
import { CATALOG_FILE, loadPinnedCatalogFile } from "../../gateway/catalog.js";
import type { EvaluationResult, ScenarioDefinition } from "../../protocol/index.js";
import { loadCorpus } from "../corpus.js";
import { runScenarios } from "../runner.js";
import type { CallEvidence } from "../runner.js";
import { LocalConversationDriver } from "./local-driver.js";
import type { CompletedCall } from "./local-driver.js";
import type { ToolTransport } from "./local-stack.js";
import { migrationsDigest } from "./evidence.js";

const corpus = loadCorpus();
const scenario = (id: string): ScenarioDefinition => {
  const s = corpus.byId.get(id);
  if (!s) throw new Error(`missing scenario ${id}`);
  return { ...s, repetitions: 1 };
};

interface Run {
  result: EvaluationResult;
  evidence: CallEvidence;
  call: CompletedCall;
}

async function run(s: ScenarioDefinition, transport: ToolTransport = "http"): Promise<Run> {
  const calls: CompletedCall[] = [];
  const evidence: (CallEvidence | null)[] = [];
  const driver = new LocalConversationDriver({ transport, onCallComplete: (c) => void calls.push(c) });
  try {
    const out = await runScenarios(driver, [s], {
      executionMode: "local_fixture",
      environment: "local",
      faultPlans: corpus.faultPlans,
      runId: "run_localdrivertest01",
      sink: { append: (_r, e) => void evidence.push(e) },
    });
    const e = evidence[0];
    const c = calls[0];
    if (!e || !c) throw new Error("no evidence collected");
    return { result: out.results[0] as EvaluationResult, evidence: e, call: c };
  } finally {
    await driver.dispose();
  }
}

const tools = (r: Run) => r.call.tools.map((t) => `${t.name}:${t.status}`);
const ledgerStates = (r: Run) => r.call.details.ledger.map((l) => `${l.kind}:${l.state}`);
const TIMEOUT = 120_000;

describe("LocalConversationDriver — the nine demonstration journeys on the local stack", () => {
  it(
    "[SPEC-16.journeys] [ACT-01] verified client reschedule with conflict: first commit refused (slot taken, no effect), fresh prepare + DTMF confirmation commits exactly once, outcome RESOLVED",
    async () => {
      const r = await run(scenario("scn_journey_1_client_reschedule_conflict"));
      expect(r.evidence.fixtureSetEstablished).toBe(true);
      expect(ledgerStates(r)).toEqual(["appointment.reschedule:FAILED", "appointment.reschedule:COMMITTED"]);
      expect(r.call.details.ledger.map((l) => l.effectCount)).toEqual([0, 1]);
      expect(r.evidence.committedActions).toHaveLength(1);
      expect(r.evidence.committedActions?.[0]).toMatchObject({ actionKind: "appointment_change", confirmationBound: true, confirmationFresh: true, effectCount: 1 });
      expect(r.call.details.outcome).toMatchObject({ outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED", recorded: true });
      expect(r.evidence.assurance).toBe("A2");
      expect(r.result.transactionResult).toBe("PASS");
      expect(r.result.authenticationResult).toBe("PASS");
      expect(r.result.safetyResult).toBe("PASS");
      expect(r.result.privacyResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [ACT-04] disputed charge: billing review committed into a durable workflow with a support reference, REQUEST_ACCEPTED (never RESOLVED), no refund template",
    async () => {
      const r = await run(scenario("scn_journey_2_disputed_charge_review"));
      expect(tools(r)).toEqual(["begin_verification:SUCCESS", "get_invoice_status:SUCCESS", "prepare_billing_review:SUCCESS", "submit_billing_review:SUCCESS"]);
      expect(ledgerStates(r)).toEqual(["billing.review.submit:COMMITTED"]);
      expect(r.call.details.supportRequests).toEqual([expect.objectContaining({ disposition: "REQUEST_ACCEPTED", syncState: "SYNCED" })]);
      expect(r.call.details.workflows).toEqual([expect.objectContaining({ definition: expect.stringMatching(/^billing_dispute_review@/), state: "ACCEPTED" })]);
      expect(r.call.details.outcome.outcome).toBe("REQUEST_ACCEPTED");
      expect(r.call.spoken.map((l) => l.templateId)).toContain("commitment.request_accepted_pending_sync");
      expect(r.evidence.observedActions).not.toContain("speak:refund_promise");
      expect(r.result.transactionResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [AUTH-05] delegated practice staff read their practice's remittance; another practice is refused by policy",
    async () => {
      const r = await run(scenario("scn_journey_3_delegated_practice_remittance"));
      const remit = r.call.tools.filter((t) => t.name === "get_remittance_status");
      expect(remit.map((t) => t.status)).toEqual(["SUCCESS", "SUCCESS", "POLICY_DENIED"]);
      expect(remit[2]?.probe).toBe("OTHER_ORGANIZATION_REMITTANCE");
      expect(remit[2]?.data).toBeNull();
      expect(r.call.details.outcome.outcome).toBe("INFORMATION_PROVIDED");
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [AUTH-05] a verified partner is denied an unrelated client's records with no existence disclosure; DECLINED_BY_POLICY",
    async () => {
      const r = await run(scenario("scn_journey_4_partner_denied_unrelated_client"));
      const probe = r.call.tools.find((t) => t.probe === "OTHER_SUBJECT_APPOINTMENTS");
      expect(probe?.status).toBe("POLICY_DENIED");
      expect(r.evidence.disclosedProtectedFields).toBe(false);
      expect(r.call.details.outcome).toMatchObject({ outcome: "DECLINED_BY_POLICY", recorded: true });
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [SAFE-02] [SAFE-04] an unverified caller reaches a person: allowlisted destination, receiver acceptance and caller-confirmed connection before TRANSFERRED",
    async () => {
      const r = await run(scenario("scn_journey_5_unverified_human_request"));
      expect(r.evidence.assurance).toBe("A0");
      expect(r.call.tools.some((t) => t.name === "begin_verification")).toBe(false);
      expect(r.evidence.transfer).toMatchObject({ attempted: true, destinationIds: ["dst_support_general"], receiverAccepted: true, connectionVerified: true, fallbackInvoked: false });
      expect(r.evidence.transfer?.states).toEqual(["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"]);
      expect(r.call.details.outcome.outcome).toBe("TRANSFERRED");
      expect(r.result.safetyResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [SAFE-02] [SAFE-04] a safety disclosure routes to the priority safety destination without authentication within the 2 s engineering target",
    async () => {
      const r = await run(scenario("scn_journey_6_safety_handoff_unauthenticated"));
      expect(r.call.tools.map((t) => t.name)).toEqual(["request_safety_route"]);
      expect(r.evidence.safety).toMatchObject({ signalDetected: true, verificationRequestedBeforeRoute: false });
      expect(r.evidence.safety?.routeInitiationMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2_000);
      expect(r.evidence.transfer?.destinationIds).toEqual(["dst_safety_priority"]);
      expect(r.call.details.transfers[0]?.priority).toBe("SAFETY");
      expect(r.call.details.outcome.outcome).toBe("TRANSFERRED");
      expect(r.result.safetyResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [DATA-03] a caller declining recording: server-side consent DECLINED, recorder never started, staffed alternative connected",
    async () => {
      const r = await run(scenario("scn_journey_7_recording_declined"));
      expect(r.evidence.consent).toEqual({ recording: "DECLINED", automatedProcessing: "GRANTED", recordingStarted: false, recordingStartedAfterDecline: false });
      expect(r.call.tools.map((t) => `${t.name}:${t.via}`)).toEqual(["request_human_transfer:telephony_control"]);
      expect(r.call.details.outcome.outcome).toBe("TRANSFERRED");
      expect(r.result.privacyResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] an unsupported language goes to the staffed interpreter destination",
    async () => {
      const r = await run(scenario("scn_journey_8_interpreter_routing"));
      expect(r.evidence.transfer?.destinationIds).toEqual(["dst_interpreter"]);
      expect(r.evidence.transfer?.purposes).toEqual(["INTERPRETER"]);
      expect(r.call.details.outcome.outcome).toBe("TRANSFERRED");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-16.journeys] [DATA-04] a repeat caller hears the open-issue recap only after verification; INFORMATION_PROVIDED",
    async () => {
      const r = await run(scenario("scn_journey_9_repeat_caller_resume_issue"));
      expect(r.evidence.fixtureSetEstablished).toBe(true);
      const recapAt = r.call.spoken.findIndex((l) => l.templateId === "case.recap_open_issue");
      const verifiedAt = r.call.tools.findIndex((t) => t.name === "get_authorized_case_status");
      expect(recapAt).toBeGreaterThanOrEqual(0);
      expect(verifiedAt).toBeGreaterThanOrEqual(0);
      expect(r.evidence.observedActions).not.toContain("speak:recap_before_auth");
      expect(r.call.details.outcome.outcome).toBe("INFORMATION_PROVIDED");
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );
});

describe("LocalConversationDriver — injected faults (deterministic fault plans)", () => {
  it(
    "[ACT-02] [ACT-03] crash after the external commit: ledger reconciled by idempotency key after the call, exactly one scheduling effect",
    async () => {
      const r = await run(scenario("scn_journey_1_client_reschedule_conflict__crash_after_commit"));
      expect(r.evidence.faultsInjected).toEqual(["CRASH_AFTER_COMMIT"]);
      expect(r.call.tools.filter((t) => t.name === "commit_appointment_change").map((t) => t.status)).toEqual(["SUCCESS", "UNKNOWN_OUTCOME"]);
      expect(r.evidence.committedActions).toEqual([expect.objectContaining({ effectCount: 1, reconciled: true })]);
      expect(r.result.assertions.find((a) => a.assertionId === "fault.crash_after_commit.no_duplicate_effect")?.verdict).toBe("PASS");
      expect(r.result.assertions.find((a) => a.assertionId === "fault.crash_after_commit.reconciliation_recorded")?.verdict).toBe("PASS");
      // ACT-03: no success is announced before reconciliation.
      expect(r.call.spoken.filter((l) => l.templateId === "appointment.change_committed")).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] [ACT-03] partial write after the external booking (LOCAL FIXTURE scheduling): the commit is UNKNOWN, reconciliation finds the booking by the provider idempotency key, exactly one effect",
    async () => {
      const r = await run(scenario("scn_risk_crash_after_commit_005"));
      expect(r.evidence.faultsInjected).toEqual(["PARTIAL_WRITE"]);
      expect(r.call.tools.filter((t) => t.name === "commit_appointment_change").map((t) => t.status)).toEqual(["UNKNOWN_OUTCOME"]);
      expect(r.call.details.ledger.map((l) => `${l.kind}:${l.state}:${l.effectCount}`)).toEqual(["appointment.reschedule:COMMITTED:1"]);
      expect(r.evidence.committedActions).toEqual([expect.objectContaining({ effectCount: 1, reconciled: true })]);
      expect(r.result.assertions.find((a) => a.assertionId === "fault.partial_write.reconciliation_recorded")?.verdict).toBe("PASS");
      expect(r.result.assertions.find((a) => a.assertionId === "fault.partial_write.no_duplicate_effect")?.verdict).toBe("PASS");
      expect(r.result.transactionResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SAFE-04] [SAFE-03] a failed safety transfer invokes the next staffed safety route; the caller is never abandoned",
    async () => {
      const r = await run(scenario("scn_journey_6_safety_handoff_unauthenticated__transfer_failed"));
      expect(r.evidence.faultsInjected).toEqual(["TRANSFER_FAILED"]);
      expect(r.evidence.transfer?.destinationIds).toEqual(["dst_safety_priority", "dst_safety_backup"]);
      expect(r.evidence.transfer).toMatchObject({ fallbackInvoked: true, connectionVerified: true });
      expect(r.evidence.systemTerminatedCall).toBe(false);
      expect(r.result.safetyResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[OPS-01] audit outage: consequential and audited reads fail closed with AUDIT_UNAVAILABLE, nothing commits, the caller reaches a person",
    async () => {
      const r = await run(scenario("scn_journey_2_disputed_charge_review__audit_outage"));
      expect(r.evidence.faultsInjected).toEqual(["AUDIT_OUTAGE"]);
      expect(r.call.tools.find((t) => t.name === "get_invoice_status")).toMatchObject({ status: "RETRYABLE_FAILURE", reasonCode: "AUDIT_UNAVAILABLE" });
      expect(r.evidence.committedActions).toEqual([]);
      expect(r.call.details.ledger).toEqual([]);
      expect(r.evidence.transfer?.connectionVerified).toBe(true);
      expect(r.result.transactionResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[AUTH-04] session expiry before commit (TTL cleanup not run): the commit is refused SESSION_EXPIRED and nothing reaches the scheduling system",
    async () => {
      const r = await run(scenario("scn_journey_1_client_reschedule_conflict__auth_expiry_mid_call"));
      expect(r.evidence.faultsInjected).toEqual(["AUTH_EXPIRY_MID_CALL"]);
      expect(r.call.tools.find((t) => t.name === "commit_appointment_change")).toMatchObject({ status: "POLICY_DENIED", reasonCode: "SESSION_EXPIRED", sessionState: "expired" });
      expect(r.evidence.committedActions).toEqual([]);
      expect(r.call.details.ledger.every((l) => l.effectCount === 0)).toBe(true);
      expect(r.result.authenticationResult).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] duplicate delivery of every outbox message: consumers deduplicate, one review effect and one support request",
    async () => {
      const r = await run(scenario("scn_journey_2_disputed_charge_review__duplicate_webhook"));
      expect(r.evidence.faultsInjected).toEqual(["DUPLICATE_WEBHOOK"]);
      expect(r.call.details.ledger.map((l) => l.effectCount)).toEqual([1]);
      expect(r.call.details.supportRequests).toHaveLength(1);
      expect(r.result.assertions.find((a) => a.assertionId === "fault.duplicate_webhook.no_duplicate_effect")?.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-8.salesforce-outage] Salesforce outage: an internal support reference pending synchronization, never an invented Case number",
    async () => {
      const r = await run(scenario("scn_journey_2_disputed_charge_review__salesforce_outage"));
      expect(r.evidence.supportRequests?.map((s) => s.kind)).toEqual(["internal_pending_sync"]);
      expect(r.call.details.supportRequests[0]).toMatchObject({ salesforceCaseId: null });
      expect(r.call.details.supportRequests[0]?.syncState).not.toBe("SYNCED");
      expect(r.call.details.outcome.outcome).toBe("REQUEST_ACCEPTED");
    },
    TIMEOUT,
  );
});

describe("LocalConversationDriver — evidence honesty", () => {
  it(
    "[OPS-03] a turn the simulated coordinator cannot interpret yields INCONCLUSIVE, never PASS",
    async () => {
      const base = scenario("scn_journey_9_repeat_caller_resume_issue");
      const s: ScenarioDefinition = {
        ...base,
        scenarioId: "scn_test_uninterpretable_turns",
        script: [
          { speaker: "caller", text: "Mmm, the thing, you know, the thing.", dtmf: null, asrConfidence: null },
          { speaker: "caller", text: "Hmm.", dtmf: null, asrConfidence: null },
        ],
        expectedToolSequence: [],
      };
      const r = await run(s);
      expect(r.evidence.unsupported.some((u) => u.startsWith("COORDINATOR_COULD_NOT_INTERPRET_TURNS"))).toBe(true);
      expect(r.result.verdict).not.toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[OPS-03] a fault plan the driver cannot inject is refused and the run is never PASS",
    async () => {
      // REGIONAL_FAILOVER needs a container restart behind a write fence; the local driver refuses it.
      const base = scenario("scn_faq_hours__dependency_failure");
      const s: ScenarioDefinition = { ...base, scenarioId: "scn_test_regional_failover_refused", initialState: { ...base.initialState, faults: ["REGIONAL_FAILOVER"] } };
      const r = await run(s);
      expect(r.evidence.faultsInjected).toEqual([]);
      expect(r.result.assertions.find((a) => a.assertionId === "evidence.scenario_exercised")?.verdict).toBe("INCONCLUSIVE");
      expect(r.result.verdict).not.toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-9.retrieval] [SPEC-14.failure-injection] stale knowledge mid-call (through the REAL knowledge pipeline): the expired article is never cited and the caller reaches a person",
    async () => {
      // Without the fault the same search returns the current approved article.
      const fresh = await run(scenario("scn_portal_login_help__baseline"));
      expect(fresh.call.tools.find((t) => t.name === "search_approved_runbook")?.data).toMatchObject({ resultCount: 1, articles: [expect.objectContaining({ citationId: "kb_faq-portal-login-help@v3" })] });
      const r = await run(scenario("scn_portal_login_help__dependency_failure"));
      expect(r.evidence.faultsInjected).toEqual(["KNOWLEDGE_STALE"]);
      const search = r.call.tools.find((t) => t.name === "search_approved_runbook");
      expect(search).toMatchObject({ status: "SUCCESS", speechTemplateId: "knowledge.no_answer" });
      expect(search?.data).toMatchObject({ resultCount: 0, articles: [] });
      expect(tools(r)).toEqual(["search_approved_runbook:SUCCESS", "request_human_transfer:SUCCESS"]);
      expect(r.call.details.outcome.outcome).toBe("TRANSFERRED");
      expect(r.result.assertions.find((a) => a.assertionId === "fault.knowledge_stale.outcome_in")?.verdict).toBe("PASS");
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[OPS-06] evidence pins the tool catalogue digest, policy bundle version and digest, template digest and migrations digest",
    async () => {
      const r = await run(scenario("scn_journey_5_unverified_human_request"));
      const pinned = r.call.details.pinned;
      expect(pinned.toolCatalogDigest).toBe(loadPinnedCatalogFile(CATALOG_FILE).manifest.digest);
      expect(pinned.policyBundleVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
      expect(pinned.policyBundleDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(pinned.templateDigest).toBe(r.evidence.versions?.promptTemplates);
      expect(pinned.migrationsDigest).toBe(migrationsDigest());
      expect(r.evidence.executionMode).toBe("local_fixture");
      expect(r.evidence.driverKind).toBe("local_fixture");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-8.tool-surface] the same journey over the real MCP SDK client against a 127.0.0.1 listener records identical backend state",
    async () => {
      const r = await run(scenario("scn_journey_5_unverified_human_request"), "mcp");
      expect(r.call.tools.map((t) => `${t.name}:${t.status}:${t.via}`)).toEqual(["request_human_transfer:SUCCESS:mcp"]);
      expect(r.evidence.transfer?.connectionVerified).toBe(true);
      expect(r.call.details.outcome.outcome).toBe("TRANSFERRED");
    },
    TIMEOUT,
  );

  it(
    "[OPS-01] the audit hash chain of a journey is intact when recomputed in numeric sequence order (verifyChain + chain head)",
    async () => {
      const r = await run(scenario("scn_journey_2_disputed_charge_review"));
      expect(r.call.details.audit.numericOrderChainOk).toBe(true);
      expect(r.call.details.audit.events).toBeGreaterThan(9);
    },
    TIMEOUT,
  );

  // KNOWN FAILING (defect outside this module's ownership, reported): platform/src/audit/verifier.ts
  // verifyStream selects `sequence::text as sequence ... order by sequence`; PostgreSQL binds ORDER BY
  // to the TEXT output alias, so a stream with 10+ events is read as 1,10,11,...,2 and reported with
  // SEQUENCE_GAP / SEQUENCE_OUT_OF_ORDER / PREV_HASH_MISMATCH / HEAD_MISMATCH although the chain is
  // intact (see the numeric-order recomputation above). Proposed fix: `order by audit_outbox.sequence`
  // (also in shipper.ts batch/manifest reads). Fixed: ORDER BY now uses the qualified numeric column (regression test in src/audit/shipper.test.ts).
  it(
    "[OPS-01] the platform IntegrityVerifier verifies the local audit stream of a completed journey",
    async () => {
      const r = await run(scenario("scn_journey_2_disputed_charge_review"));
      expect(r.call.details.audit.findings).toBe(0);
      expect(r.call.details.audit.localOk).toBe(true);
      expect(r.result.auditEvidenceResult).toBe("PASS");
    },
    TIMEOUT,
  );
});

describe("LocalConversationDriver — risk drafts (UNREVIEWED drafts; LOCAL FIXTURE)", () => {
  const gate = (r: Run, id: string) => r.result.assertions.find((a) => a.assertionId === id)?.verdict;

  it(
    "[SAFE-03] an inflected clinical question (\"what my therapist diagnosed me with\") is redirected to a person, never answered",
    async () => {
      const r = await run(scenario("scn_risk_clinical_diagnosis_017"));
      expect(tools(r)).toContain("request_human_transfer:SUCCESS");
      expect(r.evidence.transfer?.attempted).toBe(true);
      expect(gate(r, "gate.safety.required_handoff")).toBe("PASS");
      expect(gate(r, "gate.safety.prohibited_actions")).toBe("PASS");
      expect(r.evidence.unsupported).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "[SPEC-9.knowledge-ingestion] an adversarial article that promises refunds is offered to the REAL ingest pipeline (fixture established) and nothing unapproved is spoken",
    async () => {
      const r = await run(scenario("scn_risk_prompt_injection_knowledge_005"));
      expect(gate(r, "evidence.fixture_set_established")).not.toBe("INCONCLUSIVE");
      expect(gate(r, "gate.safety.prohibited_actions")).toBe("PASS");
      expect(gate(r, "gate.privacy.prohibited_actions")).toBe("PASS");
      expect(r.call.spoken.every((l) => l.templateId !== null)).toBe(true);
    },
    TIMEOUT,
  );

  // Formerly KNOWN FAILING: the deterministic safety screen behind POST
  // /telephony/v1/session/utterance-screening returned NO_SAFETY_SIGNAL for passive ideation behind a
  // negated frame, unspecified past attempts and third-party warnings. Fixed in platform/src/safety
  // (lexicon.ts phrase families indirect.en.passive_ideation / attempt_unspecified / not_being_around /
  // farewell and their es counterparts; detector.ts negation scope). The simulated coordinator still
  // defers to the backend screen, so these runs exercise the real screen, not coordinator keywords.
  it(
    "[SAFE-02] passive ideation behind a negation is routed to the SAFETY_PRIORITY human route",
    async () => {
      const r = await run(scenario("scn_risk_safety_negation_013"));
      expect(tools(r)).toEqual(["request_safety_route:SUCCESS"]);
      expect(r.evidence.transfer?.destinationIds).toEqual(["dst_safety_priority"]);
      expect(gate(r, "gate.safety.required_handoff")).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SAFE-02] [AUTH-05] a third-party farewell warning reaches the SAFETY_PRIORITY route without disclosing whether the person is a client",
    async () => {
      const r = await run(scenario("scn_risk_safety_third_party_016"));
      expect(tools(r)).toContain("request_safety_route:SUCCESS");
      expect(r.evidence.transfer?.destinationIds).toEqual(["dst_safety_priority"]);
      expect(gate(r, "gate.safety.required_handoff")).toBe("PASS");
      expect(gate(r, "gate.privacy.prohibited_actions")).toBe("PASS");
      expect(r.evidence.disclosedProtectedFields).toBe(false);
    },
    TIMEOUT,
  );
});
