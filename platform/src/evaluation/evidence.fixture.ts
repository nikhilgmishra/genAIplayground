/**
 * TEST FIXTURES (labelled): an "ideal" CallEvidence derived from a scenario's own
 * expectations, and a scripted ConversationDriver that replays canned evidence.
 *
 * These are NOT a driver for the platform. They exist so the runner, scorer and
 * corpus-consistency tests can exercise every code path without a stack. They
 * report kind "local_fixture" and can never claim a vendor or PSTN mode.
 */
import type { ScenarioDefinition, ScenarioTurn, VersionSet } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { loadFaultPlans } from "./fault-plan.js";
import type { FaultPlan, ReachEvidence } from "./fault-plan.js";
import { repoPaths } from "./paths.js";
import type { CallEvidence, CallHandle, ConversationDriver, FaultAck, StartCallInput, TurnAck } from "./runner.js";
import { ALWAYS_AVAILABLE_TOOLS, PROTECTED_TOOLS } from "./vocabulary.js";

export const FIXTURE_VERSIONS: VersionSet = {
  agentConfig: "local-fixture",
  model: "local-fixture",
  voice: "local-fixture",
  promptTemplates: "local-fixture",
  policyBundle: "local-fixture",
  toolCatalog: sha256Hex("local-fixture-tool-catalog"),
  knowledgeSnapshot: "local-fixture",
  schema: "2026-10-17.1",
};

const DESTINATION_FOR: Record<string, { id: string; purpose: string }> = {
  SAFETY_PRIORITY: { id: "dst_safety_priority", purpose: "SAFETY_PRIORITY" },
  CLINICAL_ROUTE: { id: "dst_clinical_route", purpose: "CLINICAL_ROUTE" },
  INTERPRETER: { id: "dst_interpreter", purpose: "INTERPRETER" },
  STANDARD_HUMAN: { id: "dst_support_general", purpose: "STANDARD_SUPPORT" },
  NONE: { id: "dst_support_general", purpose: "STANDARD_SUPPORT" },
};

/**
 * Evidence exactly matching what the scenario expects (every hard gate satisfied). With `plans`, the
 * fixture also carries, for each requested fault, the backend record its plan's first reach rule looks
 * for (fault-plan.ts ReachEvidence), placed where the scenario's own expected flow allows it; a fault the
 * expected flow cannot reach gets no record, so the scorer reports it INCONCLUSIVE (never PASS). Without
 * `plans` the committed registry (scenarios/fixtures/failures) is used.
 */
export function idealEvidenceFixture(s: ScenarioDefinition, plans: ReadonlyMap<string, FaultPlan> = committedPlans()): CallEvidence {
  const base = idealWithoutReach(s);
  for (const faultId of s.initialState.faults) {
    const rule = plans.get(faultId)?.reachEvidence[0];
    if (rule) addReachRecord(s, base, rule);
  }
  return base;
}

let cachedPlans: ReadonlyMap<string, FaultPlan> | null = null;
const committedPlans = (): ReadonlyMap<string, FaultPlan> => (cachedPlans ??= loadFaultPlans(repoPaths().failures));

const TRANSFER_CONNECTED = ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED"] as const;

/** Adds the backend record a reach rule looks for when the scenario's expected flow allows it (fixture only). */
function addReachRecord(s: ScenarioDefinition, e: CallEvidence, rule: ReachEvidence): void {
  const calls = e.toolCalls ?? [];
  const auditId = `aud_reach_${calls.length}`;
  switch (rule.source) {
    case "tool_response": {
      // A refused or failed read is consistent with any expectation (it neither discloses nor takes effect):
      // the rule's own tool when the flow uses it, else the first expected tool that is not a safety or human
      // route (those stay available under every fault), else a generic protected read.
      const routes = new Set<string>(ALWAYS_AVAILABLE_TOOLS);
      const name =
        rule.tools?.find((t) => s.expectedToolSequence.includes(t)) ??
        rule.tools?.[0] ??
        s.expectedToolSequence.find((t) => !routes.has(t)) ??
        "get_appointment_options";
      calls.push({ name, version: "1.0.0", status: rule.statuses?.[0] ?? "POLICY_DENIED", turnIndex: null, auditEventId: auditId, sessionState: rule.sessionStates?.[0] ?? (PROTECTED_TOOLS.has(name) ? "valid" : "none"), reasonCode: rule.reasonCodes?.[0] ?? null });
      e.auditEventIds?.push(auditId);
      return;
    }
    case "ambiguous_commit_with_effect": {
      const name = rule.tools.find((t) => s.expectedToolSequence.includes(t));
      if (!name || (e.committedActions ?? []).length === 0) return;
      calls.push({ name, version: "1.0.0", status: "UNKNOWN_OUTCOME", turnIndex: null, auditEventId: auditId, sessionState: "valid", reasonCode: "COMMIT_OUTCOME_UNKNOWN" });
      e.auditEventIds?.push(auditId);
      return;
    }
    case "transfer_states": {
      if (!e.transfer?.attempted) return;
      const [a, b] = rule.adjacent;
      const failed = a === "REQUESTED" ? [] : [...TRANSFER_CONNECTED.slice(0, TRANSFER_CONNECTED.indexOf(a as (typeof TRANSFER_CONNECTED)[number]) + 1), b];
      const connected = a === "REQUESTED" ? ["REQUESTED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED"] : [...TRANSFER_CONNECTED];
      e.transfer = { ...e.transfer, states: [...failed, ...connected] as typeof e.transfer.states, fallbackInvoked: failed.length > 0 };
      return;
    }
    case "support_request_kind":
      if ((e.supportRequests ?? []).length > 0) e.supportRequests = (e.supportRequests ?? []).map((r) => ({ ...r, kind: rule.kind }));
      return;
    case "verification_not_completed": {
      // Verification begun and never completed: assurance stays A0, which never exceeds the expected tier.
      if (!calls.some((c) => c.name === "begin_verification" && c.status === "SUCCESS")) {
        calls.push({ name: "begin_verification", version: "1.0.0", status: "SUCCESS", turnIndex: null, auditEventId: auditId, sessionState: "none", reasonCode: null });
        e.auditEventIds?.push(auditId);
      }
      if (!calls.some((c) => PROTECTED_TOOLS.has(c.name) && c.status === "SUCCESS")) e.assurance = "A0";
      return;
    }
    case "backend_record": {
      const row = Object.fromEntries(Object.entries(rule.where).map(([k, v]) => [k, v[0]]));
      const cs = (e.committedState ?? {}) as Record<string, unknown>;
      cs[rule.collection] = [...((cs[rule.collection] as unknown[] | undefined) ?? []), row];
      e.committedState = cs;
      return;
    }
    case "response_template": {
      const cs = (e.committedState ?? {}) as Record<string, unknown>;
      cs.spokenTemplates = [...((cs.spokenTemplates as unknown[] | undefined) ?? []), `${rule.templateIds[0]}:APPROVED:RENDERED`];
      e.committedState = cs;
      return;
    }
    case "emulator_log": {
      const cs = (e.committedState ?? {}) as Record<string, unknown>;
      cs.driverNotes = [...((cs.driverNotes as unknown[] | undefined) ?? []), "TELEPHONY_DUPLICATE_EVENTS_1"];
      e.committedState = cs;
      return;
    }
    case "driver_self_report": {
      // The driver's own note (never reach evidence): the scorer reports the fault INCONCLUSIVE.
      const cs = (e.committedState ?? {}) as Record<string, unknown>;
      cs.driverNotes = [...((cs.driverNotes as unknown[] | undefined) ?? []), "DUPLICATE_REDELIVERIES_1"];
      e.committedState = cs;
      return;
    }
  }
}

function idealWithoutReach(s: ScenarioDefinition): CallEvidence {
  const fs = s.expectedFinalState;
  const committedActions = fs.committedActions.map((k, i) => ({
    actionKind: k,
    actionId: `act_fixture_${i}`,
    targetRef: null,
    receiptId: `rcp_fixture_${i}`,
    auditEventId: `aud_commit_${i}`,
    confirmationBound: true,
    confirmationFresh: true,
    effectCount: 1,
    reconciled: true,
  }));
  const toolCalls = s.expectedToolSequence.map((name, i) => ({
    name,
    version: "1.0.0",
    status: "SUCCESS" as const,
    turnIndex: null,
    auditEventId: `aud_tool_${i}`,
    sessionState: PROTECTED_TOOLS.has(name) ? ("valid" as const) : ("none" as const),
    reasonCode: null,
  }));
  const transferred = s.requiredHandoff !== "NONE" || fs.outcome === "TRANSFERRED";
  const dest = DESTINATION_FOR[s.requiredHandoff] ?? { id: "dst_support_general", purpose: "STANDARD_SUPPORT" };
  const declined = s.script.some((t) => t.speaker === "system_event" && t.text.startsWith("RECORDING_DECLINED"));
  const supportRequests = fs.supportRequestCreated
    ? [{ kind: s.initialState.faults.includes("SALESFORCE_OUTAGE") ? ("internal_pending_sync" as const) : ("salesforce_case" as const), referenceIssued: true, auditEventId: "aud_support_request" }]
    : [];
  return {
    driverKind: "local_fixture",
    executionMode: "local_fixture",
    fixtureSetEstablished: true,
    faultsInjected: [...s.initialState.faults],
    committedStateSource: "authoritative_backend",
    committedState: {},
    committedActions,
    auditEventIds: [
      ...committedActions.map((a) => a.auditEventId),
      ...toolCalls.map((c) => c.auditEventId),
      ...(transferred ? ["aud_transfer"] : []),
      ...supportRequests.map((r) => r.auditEventId),
    ],
    toolCalls,
    transfer: transferred
      ? {
          attempted: true,
          destinationIds: [dest.id],
          purposes: [dest.purpose],
          states: ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED", "COMPLETED"],
          receiverAccepted: true,
          connectionVerified: true,
          fallbackInvoked: false,
          auditEventId: "aud_transfer",
        }
      : { attempted: false, destinationIds: [], purposes: [], states: [], receiverAccepted: false, connectionVerified: false, fallbackInvoked: false, auditEventId: null },
    supportRequests,
    outcome: fs.outcome,
    assurance: s.expectedAssurance,
    disclosedProtectedFields: fs.disclosedProtectedFields,
    observedActions: [],
    consent: declined
      ? { recording: "DECLINED", automatedProcessing: "GRANTED", recordingStarted: false, recordingStartedAfterDecline: false }
      : { recording: "GRANTED", automatedProcessing: "GRANTED", recordingStarted: true, recordingStartedAfterDecline: false },
    egress: [{ destination: "local_audit_sink", classification: "INTERNAL", allowed: true }],
    safety: { signalDetected: s.requiredHandoff === "SAFETY_PRIORITY", routeInitiationMs: s.requiredHandoff === "SAFETY_PRIORITY" ? 300 : null, verificationRequestedBeforeRoute: false },
    systemTerminatedCall: false,
    latencies: { turnMs: [400, 600, 800, 1200] },
    versions: FIXTURE_VERSIONS,
    vendor: { interactionId: null, sessionId: null },
    qualityScores: {},
    qualityScoreSource: "none",
    costUsd: null,
    evidenceRef: null,
    unsupported: [],
  };
}

export interface DriverCall {
  callRef: string;
  scenarioId: string;
  repetition: number;
  turns: number[];
  faults: { faultId: string; phase: "arm" | "now"; beforeTurn: number }[];
  ended: boolean;
}

/**
 * ScriptedConversationDriverFixture: records what the runner asked it to do and
 * returns evidence from `evidenceFor` (default: idealEvidenceFixture). Behaviour
 * hooks let tests simulate driver errors, rejected faults and bad evidence.
 */
export class ScriptedConversationDriverFixture implements ConversationDriver {
  readonly kind = "local_fixture" as const;
  readonly executionMode = "local_fixture" as const;
  readonly calls: DriverCall[] = [];
  private n = 0;

  constructor(
    private readonly opts: {
      evidenceFor?: (s: ScenarioDefinition, repetition: number) => unknown;
      rejectFaults?: readonly string[];
      throwOnStart?: (s: ScenarioDefinition) => boolean;
    } = {},
  ) {}

  private readonly scenarios = new Map<string, { s: ScenarioDefinition; repetition: number }>();

  async startCall(input: StartCallInput): Promise<CallHandle> {
    if (this.opts.throwOnStart?.(input.scenario)) throw new Error("fixture driver failure");
    const callRef = `call_fixture_${++this.n}`;
    this.scenarios.set(callRef, { s: input.scenario, repetition: input.repetition });
    this.calls.push({ callRef, scenarioId: input.scenario.scenarioId, repetition: input.repetition, turns: [], faults: [], ended: false });
    return { callRef };
  }

  private call(h: CallHandle): DriverCall {
    const c = this.calls.find((x) => x.callRef === h.callRef);
    if (!c) throw new Error("unknown call");
    return c;
  }

  async sendTurn(h: CallHandle, _turn: ScenarioTurn, index: number): Promise<TurnAck> {
    this.call(h).turns.push(index);
    return { delivered: true };
  }

  async injectFault(h: CallHandle, plan: FaultPlan, phase: "arm" | "now"): Promise<FaultAck> {
    const c = this.call(h);
    c.faults.push({ faultId: plan.faultId, phase, beforeTurn: c.turns.length });
    if (this.opts.rejectFaults?.includes(plan.faultId)) return { accepted: false, reasonCode: "FIXTURE_CANNOT_INJECT" };
    return { accepted: true };
  }

  async endCall(h: CallHandle): Promise<void> {
    this.call(h).ended = true;
  }

  async collectEvidence(h: CallHandle): Promise<unknown> {
    const entry = this.scenarios.get(h.callRef);
    if (!entry) throw new Error("unknown call");
    return this.opts.evidenceFor ? this.opts.evidenceFor(entry.s, entry.repetition) : idealEvidenceFixture(entry.s);
  }
}
