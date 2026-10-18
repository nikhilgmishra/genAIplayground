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
import type { FaultPlan } from "./fault-plan.js";
import type { CallEvidence, CallHandle, ConversationDriver, FaultAck, StartCallInput, TurnAck } from "./runner.js";
import { PROTECTED_TOOLS } from "./vocabulary.js";

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

/** Evidence exactly matching what the scenario expects (every hard gate satisfied). */
export function idealEvidenceFixture(s: ScenarioDefinition): CallEvidence {
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
