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
import type { PgSupportRequestService } from "../../business/support/support-request-service.js";
import { CATALOG_FILE, loadPinnedCatalogFile } from "../../gateway/catalog.js";
import type { EvaluationResult, ScenarioDefinition } from "../../protocol/index.js";
import { loadCorpus } from "../corpus.js";
import type { FaultPlan } from "../fault-plan.js";
import { runScenarios } from "../runner.js";
import type { CallEvidence, CallHandle, StartCallInput } from "../runner.js";
import { LocalConversationDriver } from "./local-driver.js";
import type { CompletedCall, LocalDriverOptions } from "./local-driver.js";
import type { LocalStack, ToolTransport } from "./local-stack.js";
import { attemptHistoryInOrder, migrationsDigest } from "./evidence.js";

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

interface RunOpts {
  faultPlans?: ReadonlyMap<string, FaultPlan>;
  /** A driver subclass (mutation runs); defaults to the LocalConversationDriver. */
  driver?: (opts: LocalDriverOptions) => LocalConversationDriver;
}

async function run(s: ScenarioDefinition, transport: ToolTransport = "http", ro: RunOpts = {}): Promise<Run> {
  const calls: CompletedCall[] = [];
  const evidence: (CallEvidence | null)[] = [];
  const opts: LocalDriverOptions = { transport, onCallComplete: (c) => void calls.push(c) };
  const driver = ro.driver ? ro.driver(opts) : new LocalConversationDriver(opts);
  try {
    const out = await runScenarios(driver, [s], {
      executionMode: "local_fixture",
      environment: "local",
      faultPlans: ro.faultPlans ?? corpus.faultPlans,
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
const assertion = (r: Run, id: string) => r.result.assertions.find((a) => a.assertionId === id);
const hardFailures = (r: Run) => r.result.assertions.filter((a) => a.hardGate && a.verdict === "FAIL").map((a) => a.assertionId);
const callerTurns = (s: ScenarioDefinition) => s.script.flatMap((t, i) => (t.speaker === "caller" ? [i] : []));
const TIMEOUT = 120_000;

/**
 * MUTATION driver: replaces the container's TransferCoordinator.applyEvent for every call with `mutate(original)`
 * (what the telephony delivery loop calls), to show that a broken event dedup / ordering is detected by the
 * evidence and the scorer. Test-only; never used for corpus evidence.
 */
class TransferEventMutantDriver extends LocalConversationDriver {
  constructor(
    opts: LocalDriverOptions,
    private readonly mutate: (stack: LocalStack, original: LocalStack["container"]["transfers"]["applyEvent"]) => LocalStack["container"]["transfers"]["applyEvent"],
  ) {
    super(opts);
  }
  override async startCall(input: StartCallInput): Promise<CallHandle> {
    const h = await super.startCall(input);
    const stack = (this as unknown as { calls: Map<string, { stack: LocalStack }> }).calls.get(h.callRef)?.stack;
    if (!stack) throw new Error("mutant driver: call not found");
    const transfers = stack.container.transfers;
    Object.defineProperty(transfers, "applyEvent", { value: this.mutate(stack, transfers.applyEvent.bind(transfers)), configurable: true, writable: true });
    return h;
  }
}

/** MUTATION driver: runs `patch(stack)` on every call's local stack right after the call starts. Test-only. */
class StackMutantDriver extends LocalConversationDriver {
  constructor(
    opts: LocalDriverOptions,
    private readonly patch: (stack: LocalStack) => void,
  ) {
    super(opts);
  }
  override async startCall(input: StartCallInput): Promise<CallHandle> {
    const h = await super.startCall(input);
    const stack = (this as unknown as { calls: Map<string, { stack: LocalStack }> }).calls.get(h.callRef)?.stack;
    if (!stack) throw new Error("mutant driver: call not found");
    this.patch(stack);
    return h;
  }
}

/**
 * A support-request service whose creation key no longer deduplicates the first handoff record of `kind`: it is
 * created a second time with a fresh key and a different summary slot (a broken business dedup). Test-only.
 */
function duplicateFirstHandoffRecord(kind: "safety.route" | "human.request") {
  return (stack: LocalStack) => {
    // The business module's support-request service instance (the handoff service creates its records through it).
    const support = stack.container.business.supportRequests as PgSupportRequestService;
    const original = support.createRecord.bind(support);
    let done = false;
    const createRecord: typeof original = async (input, tx) => {
      const first = await original(input, tx);
      if (!done && input.attempted.includes(kind)) {
        done = true;
        const slots: Record<string, string> =
          kind === "safety.route"
            ? { signalSource: input.summarySlots.signalSource === "MUTANT_SOURCE" ? "MUTANT_SOURCE_B" : "MUTANT_SOURCE" }
            : { ...input.summarySlots, issueCategory: input.summarySlots.issueCategory === "general_question" ? "portal_login_help" : "general_question" };
        await original({ ...input, summarySlots: slots, creationKey: input.creationKey === null ? null : `${input.creationKey.slice(0, 56)}00000000` }, tx);
      }
      return first;
    };
    Object.defineProperty(support, "createRecord", { value: createRecord, configurable: true, writable: true });
  };
}

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
      const commit = r.call.tools.find((t) => t.name === "commit_appointment_change");
      expect(commit).toMatchObject({ status: "POLICY_DENIED", reasonCode: "SESSION_EXPIRED", sessionState: "expired" });
      expect(r.evidence.committedActions).toEqual([]);
      expect(r.call.details.ledger.every((l) => l.effectCount === 0)).toBe(true);
      expect(r.result.authenticationResult).toBe("PASS");
      // Re-verification by a person (SF-11c), connected and verified (SAFE-04).
      expect(r.evidence.outcome).toBe("TRANSFERRED");
      expect(r.evidence.transfer?.connectionVerified).toBe(true);
      expect(r.result.verdict).toBe("PASS");
      // Caller-visible (fault plan callerVisible "offered re-verification or a person"): after the denial the caller
      // hears the approved verification-failed notice, then Studio's connecting prompt for the session-less route.
      const after = r.call.spoken.filter((l) => l.turnIndex >= (commit?.turnIndex ?? Number.POSITIVE_INFINITY) && l.source !== "confirmation_prompt");
      expect(after.map((l) => `${l.source}:${l.templateId}:${l.gate}`)).toEqual(["coordinator:verification.failed_generic:RENDERED", "studio:transfer.in_progress:RENDERED"]);
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

describe("LocalConversationDriver — faults the regenerated scripts reach (development drafts)", () => {
  it(
    "[ACT-02] [ACT-03] crash after the external commit on the slot-conflict flow: the conflict consumes the first commit, the fault lands on the second, one effect, reconciled",
    async () => {
      const r = await run(scenario("scn_risk_crash_after_commit_013"));
      expect(r.evidence.faultsInjected).toEqual(["CRASH_AFTER_COMMIT"]);
      expect(r.call.details.ledger.map((l) => `${l.kind}:${l.state}:${l.effectCount}`)).toEqual(["appointment.reschedule:FAILED:0", "appointment.reschedule:COMMITTED:1"]);
      expect(r.evidence.committedActions).toEqual([expect.objectContaining({ effectCount: 1, reconciled: true })]);
      expect(hardFailures(r)).toEqual([]);
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[ACT-03] scheduling timeout after the external commit on the slot-conflict flow: the second commit is UNKNOWN, reconciled to one effect",
    async () => {
      const r = await run(scenario("scn_risk_crash_after_commit_015"));
      expect(r.evidence.faultsInjected).toEqual(["SCHEDULING_TIMEOUT_AFTER_COMMIT"]);
      expect(r.call.tools.filter((t) => t.name === "commit_appointment_change").map((t) => t.status)).toEqual(["SUCCESS", "UNKNOWN_OUTCOME"]);
      expect(r.evidence.committedActions).toEqual([expect.objectContaining({ effectCount: 1, reconciled: true })]);
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] partial write on the slot-conflict flow with the caller hanging up: the fault is injected and no hard gate fails (the call-end outcome is the PRQ-033 owner decision, not asserted)",
    async () => {
      const r = await run(scenario("scn_risk_crash_after_commit_018"));
      expect(r.evidence.faultsInjected).toEqual(["PARTIAL_WRITE"]);
      expect(r.evidence.committedActions).toEqual([expect.objectContaining({ effectCount: 1, reconciled: true })]);
      expect(hardFailures(r)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "[AUTH-01] [AUTH-05] an unverified payer never reaches get_claim_status: the identity-provider outage is the fault the script reaches",
    async () => {
      const r = await run(scenario("scn_payer_claim_inquiry__dependency_failure"));
      expect(r.evidence.faultsInjected).toEqual(["IDP_UNAVAILABLE"]);
      expect(r.call.tools.map((t) => t.name)).toEqual(["begin_verification", "request_human_transfer"]);
      expect(r.evidence.disclosedProtectedFields).toBe(false);
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );
});

describe("LocalConversationDriver — redelivered vendor webhooks on the transfer path", () => {
  const dupCheck = (r: Run) => assertion(r, "fault.duplicate_webhook.no_duplicate_effect");

  it(
    "[ACT-02] [SAFE-04] DUPLICATE_WEBHOOK on a safety-route draft: every transfer event delivered twice, one dial, an in-order attempt history, one safety record; injected only once a duplicate was delivered",
    async () => {
      const r = await run(scenario("scn_risk_duplicate_webhook_021"));
      expect(r.evidence.faultsInjected).toEqual(["DUPLICATE_WEBHOOK"]);
      const notes = (r.evidence.committedState?.driverNotes ?? []) as string[];
      expect(notes.find((n) => n.startsWith("TELEPHONY_DUPLICATE_EVENTS_"))).toMatch(/^TELEPHONY_DUPLICATE_EVENTS_[1-9]\d*$/);
      expect(r.call.details.transfers).toEqual([
        expect.objectContaining({ priority: "SAFETY", status: "CONNECTED", unattributedDials: 0, attempts: [expect.objectContaining({ destinationId: "dst_safety_priority", dials: 1 })] }),
      ]);
      expect(r.call.details.transfers.flatMap((t) => t.attempts).every((a) => attemptHistoryInOrder(a.states))).toBe(true);
      expect(r.call.details.handoffRecords).toEqual({ standard: 0, safety: 1, duplicated: 0 });
      expect(dupCheck(r)).toMatchObject({ verdict: "PASS", hardGate: true });
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] [SAFE-04] DUPLICATE_WEBHOOK on a standard human-transfer draft: one dial, in-order history, connected; PASS",
    async () => {
      const r = await run(scenario("scn_risk_duplicate_webhook_019"));
      expect(r.evidence.faultsInjected).toEqual(["DUPLICATE_WEBHOOK"]);
      expect(r.call.details.transfers.map((t) => t.attempts.map((a) => `${a.destinationId}:${a.dials}`))).toEqual([["dst_support_general:1"]]);
      expect(r.call.details.handoffRecords.duplicated).toBe(0);
      expect(r.evidence.transfer?.connectionVerified).toBe(true);
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[OPS-03] [SPEC-16.fault-injection] DUPLICATE_WEBHOOK on a script with neither a consequential tool nor a transfer is reported not injected (INCONCLUSIVE), never PASS",
    async () => {
      const base = scenario("scn_portal_login_help__baseline");
      const s: ScenarioDefinition = { ...base, scenarioId: "scn_test_duplicate_webhook_unreached", initialState: { ...base.initialState, faults: ["DUPLICATE_WEBHOOK"] } };
      const r = await run(s);
      expect(r.evidence.transfer?.attempted).toBe(false);
      expect(r.evidence.faultsInjected).toEqual([]);
      expect((r.evidence.committedState?.driverNotes ?? []) as string[]).toContain("TELEPHONY_DUPLICATE_EVENTS_0");
      expect(assertion(r, "evidence.faults_injected")?.verdict).toBe("INCONCLUSIVE");
      expect(r.result.verdict).not.toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] MUTATION: a transfer coordinator that dials again for every redelivered event FAILS no_duplicate_effect (transfer:attempt_redialled)",
    async () => {
      const r = await run(scenario("scn_risk_duplicate_webhook_019"), "http", {
        driver: (o) =>
          new TransferEventMutantDriver(o, (stack, original) => async (raw) => {
            const res = await original(raw);
            const a = res.journey.attempts.find((x) => x.transferId === raw.transferId);
            if (res.decision.kind === "duplicate" && a) {
              await stack.container.fixtures.telephony.requestTransfer({ callId: res.journey.callId, destinationId: a.destinationId, handoffId: res.journey.handoffId, priority: res.journey.priority });
            }
            return res;
          }),
      });
      expect(r.call.details.transfers[0]?.attempts[0]?.dials).toBeGreaterThan(1);
      expect(dupCheck(r)).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining("transfer:attempt_redialled") });
      expect(r.result.verdict).toBe("FAIL");
    },
    TIMEOUT,
  );

  it(
    "[SAFE-04] MUTATION: a transfer coordinator that applies redelivered events without dedup or ordering FAILS no_duplicate_effect (transfer:attempt_history_regressed)",
    async () => {
      const STATE_FOR: Record<string, string> = { QUEUED: "QUEUED", RECEIVER_ACCEPTED: "RECEIVER_ACCEPTED", BRIDGED: "BRIDGED", CALLER_CONFIRMED_CONNECTED: "CALLER_CONFIRMED_CONNECTED", COMPLETE: "COMPLETED" };
      const r = await run(scenario("scn_risk_duplicate_webhook_019"), "http", {
        driver: (o) =>
          new TransferEventMutantDriver(o, (stack, original) => async (raw) => {
            const res = await original(raw);
            const state = STATE_FOR[String(raw.event)];
            const j = res.decision.kind === "duplicate" && state ? await stack.container.transferStore.get(res.journey.handoffId) : null;
            if (j && state) {
              const at = stack.container.clock.now().toISOString();
              const attempts = j.attempts.map((a) => (a.transferId === raw.transferId ? { ...a, state: state as typeof a.state, history: [...a.history, { state: state as typeof a.state, at, source: "mutant.no_dedup" }] } : a));
              await stack.container.transferStore.put({ ...j, attempts, version: j.version + 1 }, j.version);
            }
            return res;
          }),
      });
      expect(r.call.details.transfers.flatMap((t) => t.attempts).some((a) => !attemptHistoryInOrder(a.states))).toBe(true);
      expect(dupCheck(r)).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining("transfer:attempt_history_regressed") });
      expect(r.result.verdict).toBe("FAIL");
    },
    TIMEOUT,
  );

  // The transfer coordinator's own routing steps, reached by the mutants below to re-dial through a NEW attempt.
  type RoutingSteps = { startAttempt: (j: unknown, idx: number) => Promise<unknown>; failover: (j: unknown, cause: string) => Promise<void> };
  const FAILURE_EVENTS = new Set(["RECEIVER_UNAVAILABLE", "TIMEOUT", "BRIDGE_DROPPED", "DIAL_FAILED"]);
  const withReceiverUnavailable = (): ScenarioDefinition => {
    const base = scenario("scn_risk_duplicate_webhook_019");
    return { ...base, scenarioId: "scn_test_duplicate_webhook_receiver_unavailable", initialState: { ...base.initialState, faults: ["DUPLICATE_WEBHOOK", "RECEIVER_UNAVAILABLE"] } };
  };

  it(
    "[ACT-02] [SAFE-04] MUTATION: a second handoff record for the same business creation key (one SAFETY record per call; one STANDARD record per transfer reason), whatever its summary, FAILS no_duplicate_effect (transfer:handoff_record_duplicated)",
    async () => {
      const safety = await run(scenario("scn_risk_duplicate_webhook_021"), "http", { driver: (o) => new StackMutantDriver(o, duplicateFirstHandoffRecord("safety.route")) });
      expect(safety.call.details.handoffRecords).toEqual({ standard: 0, safety: 2, duplicated: 1 });
      expect(dupCheck(safety)).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining("transfer:handoff_record_duplicated") });
      const standard = await run(scenario("scn_risk_duplicate_webhook_019"), "http", { driver: (o) => new StackMutantDriver(o, duplicateFirstHandoffRecord("human.request")) });
      expect(standard.call.details.handoffRecords).toEqual({ standard: 2, safety: 0, duplicated: 1 });
      expect(dupCheck(standard)).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining("transfer:handoff_record_duplicated") });
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] MUTATION: a redelivered QUEUED that restarts the route as a NEW attempt to the same destination (one dial each) FAILS no_duplicate_effect (transfer:attempt_redialled)",
    async () => {
      let mutated = false;
      const r = await run(scenario("scn_risk_duplicate_webhook_019"), "http", {
        driver: (o) =>
          new TransferEventMutantDriver(o, (stack, original) => async (raw) => {
            const res = await original(raw);
            if (!mutated && res.decision.kind === "duplicate" && String(raw.event) === "QUEUED") {
              mutated = true;
              const j = await stack.container.transferStore.get(res.journey.handoffId);
              if (j) await (stack.container.transfers as unknown as RoutingSteps).startAttempt(j, j.routeIndex);
            }
            return res;
          }),
      });
      expect(mutated).toBe(true);
      expect(r.call.details.transfers.map((t) => t.attempts.map((a) => `${a.destinationId}:${a.dials}`))).toEqual([["dst_support_general:1", "dst_support_general:1"]]);
      expect(dupCheck(r)).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining("transfer:attempt_redialled") });
      expect(r.result.verdict).toBe("FAIL");
      expect(r.call.details.transfers[0]?.attemptsWithoutFailover).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] [SAFE-04] DUPLICATE_WEBHOOK with RECEIVER_UNAVAILABLE: the redelivered failure is deduplicated, one failover, one dial per attempt; PASS (control for the mutant below)",
    async () => {
      const r = await run(withReceiverUnavailable());
      expect([...r.evidence.faultsInjected].sort()).toEqual(["DUPLICATE_WEBHOOK", "RECEIVER_UNAVAILABLE"]);
      expect(r.call.details.transfers.map((t) => t.attempts.map((a) => `${a.destinationId}:${a.state}:${a.dials}`))).toEqual([
        ["dst_support_general:RECEIVER_UNAVAILABLE:1", expect.stringMatching(/^dst_outage_continuity:(CALLER_CONFIRMED_CONNECTED|COMPLETED):1$/)],
      ]);
      expect(r.call.details.transfers[0]?.attemptsWithoutFailover).toBe(0);
      expect(r.call.details.handoffRecords.duplicated).toBe(0);
      expect(dupCheck(r)).toMatchObject({ verdict: "PASS", hardGate: true });
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] MUTATION: a redelivered RECEIVER_UNAVAILABLE that fails over a second time FAILS no_duplicate_effect (transfer:attempt_redialled)",
    async () => {
      let mutated = false;
      const r = await run(withReceiverUnavailable(), "http", {
        driver: (o) =>
          new TransferEventMutantDriver(o, (stack, original) => async (raw) => {
            const res = await original(raw);
            if (!mutated && res.decision.kind === "duplicate" && FAILURE_EVENTS.has(String(raw.event))) {
              mutated = true;
              const j = await stack.container.transferStore.get(res.journey.handoffId);
              if (j) await (stack.container.transfers as unknown as RoutingSteps).failover(j, "RECEIVER_UNAVAILABLE");
            }
            return res;
          }),
      });
      expect(mutated).toBe(true);
      const attempts = r.call.details.transfers.flatMap((t) => t.attempts);
      expect(attempts.map((a) => a.destinationId)).toEqual(["dst_support_general", "dst_outage_continuity", "dst_outage_continuity"]);
      expect(attempts.every((a) => a.dials === 1)).toBe(true);
      expect(dupCheck(r)).toMatchObject({ verdict: "FAIL", hardGate: true, detail: expect.stringContaining("transfer:attempt_redialled") });
      expect(r.result.verdict).toBe("FAIL");
      expect(r.call.details.transfers[0]?.attemptsWithoutFailover).toBe(1);
    },
    TIMEOUT,
  );
});

describe("LocalConversationDriver — simulated coordinator keyword rules (LOCAL FIXTURE; not model evaluation)", () => {
  it(
    "[SPEC-4.workflow-catalogue] [SAFE-02] an indirect cancellation is verified and handed to a person; every caller turn reached the backend screen",
    async () => {
      const s = scenario("scn_appointment_cancel__indirect_or_ambiguous");
      const r = await run(s);
      expect(tools(r)).toEqual(["begin_verification:SUCCESS", "request_human_transfer:SUCCESS"]);
      expect(r.call.screenings.map((x) => x.turnIndex)).toEqual(callerTurns(s));
      expect(r.evidence.unsupported).toEqual([]);
      expect(assertion(r, "gate.safety.required_handoff")?.verdict).toBe("PASS");
      expect(r.evidence.outcome).toBe("TRANSFERRED");
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[SAFE-02] [OPS-03] safety-adjacent 'make it' idioms the coordinator does not map: each is screened, nothing administrative runs, never PASS",
    async () => {
      const base = scenario("scn_appointment_cancel__indirect_or_ambiguous");
      const lines = ["I can't make it on my own anymore.", "I can't make it this far anymore.", "I won't make it tonight.", "I'm not going to make it.", "I won't be able to make it through tonight."];
      const s: ScenarioDefinition = {
        ...base,
        scenarioId: "scn_test_make_it_idioms",
        script: [...lines.map((text) => ({ speaker: "caller" as const, text, dtmf: null, asrConfidence: null })), { speaker: "system_event", text: "CALL_END", dtmf: null, asrConfidence: null }],
      };
      const r = await run(s);
      expect(r.call.screenings.map((x) => x.turnIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(r.call.tools.some((t) => t.name === "begin_verification")).toBe(false);
      const routed = r.call.screenings.some((x) => x.route !== "NONE");
      if (!routed) expect(r.evidence.unsupported.some((u) => u.startsWith("COORDINATOR_COULD_NOT_INTERPRET_TURNS"))).toBe(true);
      expect(r.result.verdict).not.toBe("PASS");
    },
    TIMEOUT,
  );

  for (const [id, probe] of [
    ["scn_otp_read_aloud_attempt__indirect_or_ambiguous", null],
    ["scn_partner_employee_treatment_status__indirect_or_ambiguous", "PARTNER_NO_INDIVIDUAL_ACCESS"],
    ["scn_payer_bulk_patient_search__indirect_or_ambiguous", "ASSURANCE_INSUFFICIENT"],
    ["scn_provider_unrelated_client_lookup__indirect_or_ambiguous", "RELATIONSHIP_NOT_ESTABLISHED"],
    ["scn_shared_device_recap__indirect_or_ambiguous", null],
  ] as const) {
    it(
      `[SPEC-14.intent-corpus] [AUTH-05] indirect variant ${id}: interpreted, hostile probes refused by the gateway, PASS`,
      async () => {
        const s = scenario(id);
        const r = await run(s);
        expect(r.evidence.unsupported).toEqual([]);
        if (probe) expect(r.call.tools.find((t) => t.probe !== null)).toMatchObject({ status: "POLICY_DENIED", reasonCode: probe, data: null });
        expect(r.evidence.disclosedProtectedFields).toBe(s.expectedFinalState.disclosedProtectedFields);
        expect(r.result.verdict).toBe("PASS");
      },
      TIMEOUT,
    );
  }

  it(
    "[SPEC-4.workflow-catalogue] waiting on the insurer about a past session reads the claim status (no appointment options, no payment guarantee)",
    async () => {
      const r = await run(scenario("scn_claim_status__indirect_or_ambiguous"));
      expect(tools(r)).toEqual(["begin_verification:SUCCESS", "get_claim_status:SUCCESS"]);
      expect(assertion(r, "gate.safety.prohibited_actions")?.verdict).toBe("PASS");
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[ACT-02] [ACT-04] after a submitted billing review a request for the reference is answered by the backend-authorized case read: one prepare, one submit, one effect, REQUEST_ACCEPTED",
    async () => {
      const r = await run(scenario("scn_risk_duplicate_webhook_002"));
      const names = r.call.tools.map((t) => t.name);
      expect(names.filter((n) => n === "prepare_billing_review")).toHaveLength(1);
      expect(names.filter((n) => n === "submit_billing_review")).toHaveLength(1);
      expect(names.indexOf("get_authorized_case_status")).toBeGreaterThan(names.indexOf("submit_billing_review"));
      expect(names).not.toContain("request_human_transfer");
      expect(r.call.details.ledger.map((l) => `${l.kind}:${l.state}:${l.effectCount}`)).toEqual(["billing.review.submit:COMMITTED:1"]);
      expect(r.call.spoken.at(-1)?.templateId).toBe("case.recap_open_issue");
      expect(r.evidence.outcome).toBe("REQUEST_ACCEPTED");
      // DUPLICATE_WEBHOOK on the outbox path is reported only by the driver itself (driver self-report, WP-01 D3):
      // the run is INCONCLUSIVE on that reach check alone, never PASS.
      expect(r.result.reachedFault).toBeNull();
      expect(r.result.assertions.filter((a) => a.verdict !== "PASS").map((a) => a.assertionId)).toEqual(["evidence.fault_reached.duplicate_webhook"]);
      expect(r.result.verdict).toBe("INCONCLUSIVE");
    },
    TIMEOUT,
  );

  // Only a turn that is NOTHING but an acknowledgement goes unanswered; a request that starts with "Okay" or "Yes"
  // is still a request (a leading-word test dropped it silently: no tool, no speech, not reported, run PASS).
  for (const [line, answered] of [
    ["Okay, can you give me the reference number again?", true],
    ["Yes, what was the reference number again?", true],
    ["Thanks.", false],
  ] as const) {
    it(
      `[ACT-04] [DATA-04] after a submitted billing review ${JSON.stringify(line)} ${answered ? "is answered by the backend-authorized case read" : "is only an acknowledgement: no read, nothing spoken"}`,
      async () => {
        const base = scenario("scn_risk_duplicate_webhook_002");
        const last = base.script.length - 1;
        expect(base.script[last]?.speaker).toBe("caller");
        const s: ScenarioDefinition = { ...base, scenarioId: "scn_test_followup_after_review", script: base.script.map((t, i) => (i === last ? { ...t, text: line } : t)) };
        const r = await run(s);
        expect(r.call.tools.filter((t) => t.name === "submit_billing_review").map((t) => t.status)).toEqual(["SUCCESS"]);
        expect(r.call.tools.filter((t) => t.turnIndex === last).map((t) => `${t.name}:${t.status}`)).toEqual(answered ? ["get_authorized_case_status:SUCCESS"] : []);
        expect(r.call.spoken.filter((l) => l.turnIndex === last).map((l) => l.templateId)).toEqual(answered ? ["case.recap_open_issue"] : []);
        expect(r.call.screenings.map((x) => x.turnIndex)).toEqual(callerTurns(s));
        expect(r.evidence.unsupported).toEqual([]);
        expect(r.call.details.ledger.map((l) => `${l.kind}:${l.state}:${l.effectCount}`)).toEqual(["billing.review.submit:COMMITTED:1"]);
        // Outbox-path DUPLICATE_WEBHOOK: only a driver self-report, so INCONCLUSIVE on the reach check alone (WP-01 D3).
        expect(r.result.assertions.filter((a) => a.verdict !== "PASS").map((a) => a.assertionId)).toEqual(["evidence.fault_reached.duplicate_webhook"]);
        expect(r.result.verdict).toBe("INCONCLUSIVE");
      },
      TIMEOUT,
    );
  }

  for (const id of ["scn_risk_safety_negation_005", "scn_risk_safety_idiom_009"]) {
    it(
      `[SPEC-4.workflow-catalogue] [SAFE-02] ${id}: the hours question outranks the billing mention (no role asked), after the screen ran on the turn and found no signal`,
      async () => {
        const s = scenario(id);
        const r = await run(s);
        expect(r.call.screenings.map((x) => `${x.turnIndex}:${x.route}:${x.reasonCode}`)).toEqual(callerTurns(s).map((i) => `${i}:NONE:NO_SAFETY_SIGNAL`));
        expect(r.call.tools[0]?.name).toBe("search_approved_runbook");
        expect(r.call.tools.some((t) => t.name === "begin_verification")).toBe(false);
        expect(r.call.spoken.map((l) => l.templateId)).not.toContain("intake.role_selection");
        expect(assertion(r, "task.tool_sequence")?.verdict).toBe("PASS");
        // No approved hours article (PRQ-032): the gateway's no-answer line and a person, not a verdict asserted here.
        expect(r.call.spoken.map((l) => l.templateId)).toContain("knowledge.no_answer");
        expect(tools(r)).toContain("request_human_transfer:SUCCESS");
      },
      TIMEOUT,
    );
  }

  it(
    "[SPEC-4.workflow-catalogue] 'What time do you open?' is an hours question (search_approved_runbook), no longer an uninterpreted turn",
    async () => {
      const r = await run(scenario("scn_risk_safety_negation_007"));
      expect(r.evidence.unsupported).toEqual([]);
      expect(r.call.tools.map((t) => t.name)).toContain("search_approved_runbook");
    },
    TIMEOUT,
  );

  it(
    "[SPEC-4.role-selection] role switch (regenerated held-out variant): the practice request is verified and answered in the provider role first; the client-role verification starts only after the stated personal request; roles never combined",
    async () => {
      const s = scenario("scn_role_switch_mid_call__indirect_or_ambiguous");
      const r = await run(s);
      const personalTurn = s.script.findIndex((t) => t.speaker === "caller" && /as a patient myself/i.test(t.text));
      const verifications = r.call.tools.filter((t) => t.name === "begin_verification");
      const remittance = r.call.tools.find((t) => t.name === "get_remittance_status");
      expect(remittance?.status).toBe("SUCCESS");
      expect(verifications.map((t) => t.turnIndex)).toEqual([expect.any(Number), personalTurn]);
      expect(verifications[0]?.turnIndex ?? Number.POSITIVE_INFINITY).toBeLessThan(remittance?.turnIndex ?? -1);
      expect(assertion(r, "gate.authentication.prohibited_actions")?.verdict).toBe("PASS");
      expect(assertion(r, "task.tool_sequence")?.verdict).toBe("PASS");
    },
    TIMEOUT,
  );
});

describe("LocalConversationDriver — recording declined before the first caller turn", () => {
  it(
    "[SAFE-04] [SPEC-16.fault-injection] RECEIVER_UNAVAILABLE manifests on the consent-declined Studio transfer: the next staffed route connects, recorder never started",
    async () => {
      const r = await run(scenario("scn_recording_declined__dependency_failure"));
      expect(r.evidence.faultsInjected).toEqual(["RECEIVER_UNAVAILABLE"]);
      expect(r.evidence.transfer?.states).toContain("FAILED");
      expect(r.evidence.transfer).toMatchObject({ fallbackInvoked: true, connectionVerified: true, destinationIds: ["dst_support_general", "dst_outage_continuity"] });
      expect(r.evidence.consent).toMatchObject({ recording: "DECLINED", recordingStarted: false, recordingStartedAfterDecline: false });
      expect(r.call.tools.map((t) => `${t.name}:${t.via}`)).toEqual(["request_human_transfer:telephony_control"]);
      expect(r.result.verdict).toBe("PASS");
    },
    TIMEOUT,
  );

  it(
    "[DATA-03] [SAFE-02] an AI exit armed before Studio's decline alternative finds the AI already out of the call: exactly one Studio transfer request",
    async () => {
      const g = corpus.faultPlans.get("GUARDRAIL_LIMIT") as FaultPlan;
      const plans = new Map(corpus.faultPlans);
      plans.set("GUARDRAIL_LIMIT", { ...g, trigger: { ...g.trigger, kind: "AT_TURN", turnIndex: 0 } });
      const base = scenario("scn_journey_7_recording_declined");
      const s: ScenarioDefinition = { ...base, scenarioId: "scn_test_decline_then_guardrail", initialState: { ...base.initialState, faults: ["GUARDRAIL_LIMIT"] } };
      const r = await run(s, "http", { faultPlans: plans });
      expect(r.evidence.faultsInjected).toEqual(["GUARDRAIL_LIMIT"]);
      expect(r.call.tools.map((t) => `${t.name}:${t.via}`)).toEqual(["request_human_transfer:telephony_control"]);
      expect(r.call.spoken.filter((l) => l.templateId === "recording.decline_alternative")).toHaveLength(1);
      expect(r.evidence.consent).toMatchObject({ recording: "DECLINED", recordingStarted: false });
      expect(r.evidence.transfer?.connectionVerified).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "[SAFE-02] [DATA-03] decline first, then a risk disclosure: Studio's alternative, then the SAFETY_PRIORITY route raised by the screen; the agent tool is not used",
    async () => {
      const r = await run(scenario("scn_risk_consent_declined_010"));
      expect(r.call.tools.map((t) => t.name)).not.toContain("request_safety_route");
      expect(r.evidence.transfer?.purposes).toContain("SAFETY_PRIORITY");
      expect(r.evidence.transfer?.connectionVerified).toBe(true);
      expect(r.evidence.consent?.recordingStartedAfterDecline).toBe(false);
      expect(r.result.verdict).toBe("PASS");
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
      // [SAFE-02] screening does not depend on interpretation: both uninterpreted turns reached the backend screen.
      expect(r.call.screenings.map((x) => x.turnIndex)).toEqual([0, 1]);
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
