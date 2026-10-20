/**
 * Independent fault-reach evaluation (FO-17-11, FO-17-24; follow-on prompt section 17 "SCORER REPAIR":
 * "A fault scenario passes only if the intended failure path was reached AND its postconditions were
 * asserted. If a crash-after-commit injection never reached commit, it is NOT proof of crash safety").
 *
 * The driver's `faultsInjected` is its own report that it armed or fired a fault. It is required but
 * never sufficient: a plan's `reachEvidence` rules are evaluated here over backend-recorded evidence
 * only (fault-plan.ts ReachEvidence), and the scorer records the first matching observation as
 * `reachedFault` with the source that observed it. No rule, or no matching record, means the fault was
 * not independently observed: the result is INCONCLUSIVE, never PASS.
 *
 * A `driver_self_report` rule (the driver's own count of an injection it performed) is evaluated only to
 * say so: when it is the only signal, the observation is reached:null with an observedBy that names it a
 * driver self-report (`driver_notes.<note> (driver self-report)`), so it can never become `reachedFault`
 * and is never labelled emulator or backend evidence.
 */
import { isIndependentReachRule } from "./fault-plan.js";
import type { FaultPlan, ReachEvidence } from "./fault-plan.js";
import type { CallEvidence } from "./runner.js";

export interface ReachObservation {
  faultId: string;
  /** true: a rule matched a backend record; false: evidence collected, no rule matched; null: required evidence not collected or no rule. */
  reached: boolean | null;
  /** Source that observed the fault point (lower-case dotted id), e.g. `gateway.tool_response`, `action_ledger`. */
  observedBy: string | null;
  /** Pointer into the call evidence (`<evidenceRef>#<path>`) or the audit event that records it. */
  evidenceRef: string | null;
  detail: string;
}

/** observedBy label of a driver self-report (never a reach source). */
export const selfReportLabel = (note: string): string => `driver_notes.${note} (driver self-report)`;

interface RuleResult {
  /** SELF_REPORTED: a driver_self_report rule found the driver's own note (never reach evidence). */
  status: "MATCH" | "NO_MATCH" | "NOT_COLLECTED" | "SELF_REPORTED";
  observedBy: string;
  pointer: string | null;
}

const asArray = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const POINTER_SAFE = /[^A-Za-z0-9._~:/#@+=-]/g;
const pointer = (base: string, path: string): string => `${base}#${path}`.replace(POINTER_SAFE, "_").slice(0, 256);

function evaluateRule(rule: ReachEvidence, e: CallEvidence, base: string): RuleResult {
  switch (rule.source) {
    case "tool_response": {
      const by = "gateway.tool_response";
      if (e.toolCalls === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = e.toolCalls.findIndex(
        (c) =>
          (rule.tools === null || rule.tools.includes(c.name)) &&
          (rule.statuses === null || rule.statuses.includes(c.status)) &&
          (rule.reasonCodes === null || (c.reasonCode !== null && rule.reasonCodes.includes(c.reasonCode))) &&
          (rule.sessionStates === null || (c.sessionState !== null && rule.sessionStates.includes(c.sessionState))),
      );
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      const audit = e.toolCalls[i]?.auditEventId ?? null;
      return { status: "MATCH", observedBy: by, pointer: audit ? pointer("audit_event", audit) : pointer(base, `toolCalls/${i}`) };
    }
    case "ambiguous_commit_with_effect": {
      const by = "action_ledger";
      if (e.toolCalls === null || e.committedActions === null || e.committedStateSource !== "authoritative_backend") return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const ambiguous = e.toolCalls.some((c) => rule.tools.includes(c.name) && c.status === "UNKNOWN_OUTCOME");
      const j = e.committedActions.findIndex((a) => a.effectCount >= 1);
      if (!ambiguous || j < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "MATCH", observedBy: by, pointer: pointer(base, `committedActions/${j}`) };
    }
    case "transfer_states": {
      const by = "transfer_store";
      if (e.transfer === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const [a, b] = rule.adjacent;
      const i = e.transfer.states.findIndex((s, k) => s === a && e.transfer?.states[k + 1] === b);
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "MATCH", observedBy: by, pointer: pointer(base, `transfer/states/${i}`) };
    }
    case "support_request_kind": {
      const by = "support_records";
      if (e.supportRequests === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = e.supportRequests.findIndex((r) => r.kind === rule.kind);
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      const audit = e.supportRequests[i]?.auditEventId ?? null;
      return { status: "MATCH", observedBy: by, pointer: audit ? pointer("audit_event", audit) : pointer(base, `supportRequests/${i}`) };
    }
    case "verification_not_completed": {
      const by = "session_service";
      if (e.toolCalls === null || e.assurance === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = e.toolCalls.findIndex((c) => c.name === "begin_verification" && c.status === "SUCCESS");
      if (i < 0 || e.assurance !== "A0") return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "MATCH", observedBy: by, pointer: pointer(base, `toolCalls/${i}+assurance/A0`) };
    }
    case "backend_record": {
      const by = `backend_record.${rule.collection.toLowerCase()}`;
      if (e.committedStateSource !== "authoritative_backend" || e.committedState === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const rows = asArray(e.committedState[rule.collection]);
      if (rows === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = rows.findIndex((row) => {
        if (row === null || typeof row !== "object") return false;
        const r = row as Record<string, unknown>;
        return Object.entries(rule.where).every(([field, allowed]) => allowed.some((v) => r[field] === v));
      });
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "MATCH", observedBy: by, pointer: pointer(base, `committedState/${rule.collection}/${i}`) };
    }
    case "response_template": {
      const by = "response_gate";
      if (e.committedStateSource !== "authoritative_backend" || e.committedState === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const spoken = asArray(e.committedState.spokenTemplates);
      if (spoken === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = spoken.findIndex((t) => typeof t === "string" && t.endsWith(":RENDERED") && rule.templateIds.some((id) => t.startsWith(`${id}:`)));
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "MATCH", observedBy: by, pointer: pointer(base, `committedState/spokenTemplates/${i}`) };
    }
    case "emulator_log": {
      // The telephony emulator's delivery log counted by the evidence collector (fault-plan.ts ReachEvidence):
      // the counter is computed from the emulator's own delivered-event log and CARRIED in the driver's notes
      // (committedState.driverNotes) until the collector records it as a typed field (WP-34). The driver's
      // `faultsInjected` is never accepted, and of its notes only this counter is reach evidence.
      const by = "emulator_log.telephony_delivered";
      if (e.committedState === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const notes = asArray(e.committedState.driverNotes);
      if (notes === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = notes.findIndex((n) => typeof n === "string" && /^TELEPHONY_DUPLICATE_EVENTS_[1-9]\d*$/.test(n));
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "MATCH", observedBy: by, pointer: pointer(base, `committedState/driverNotes/${i}`) };
    }
    case "driver_self_report": {
      // The driver's own count of an injection it performed (DUPLICATE_REDELIVERIES_<n>: outbox messages the
      // LOCAL FIXTURE driver re-published). Never reach evidence: SELF_REPORTED only labels the observation.
      const by = selfReportLabel(rule.note);
      if (e.committedState === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const notes = asArray(e.committedState.driverNotes);
      if (notes === null) return { status: "NOT_COLLECTED", observedBy: by, pointer: null };
      const i = notes.findIndex((n) => typeof n === "string" && /^DUPLICATE_REDELIVERIES_[1-9]\d*$/.test(n));
      if (i < 0) return { status: "NO_MATCH", observedBy: by, pointer: null };
      return { status: "SELF_REPORTED", observedBy: by, pointer: pointer(base, `committedState/driverNotes/${i}`) };
    }
  }
}

/** Evaluates a plan's reach rules over backend-recorded evidence. */
export function evaluateFaultReach(plan: FaultPlan, e: CallEvidence, evidenceBase = "call-evidence"): ReachObservation {
  const faultId = plan.faultId;
  const all = plan.reachEvidence.map((r) => ({ rule: r, res: evaluateRule(r, e, evidenceBase) }));
  const results = all.filter((x) => isIndependentReachRule(x.rule));
  const hit = results.find((x) => x.res.status === "MATCH");
  if (hit) return { faultId, reached: true, observedBy: hit.res.observedBy, evidenceRef: hit.res.pointer, detail: `fault point observed by ${hit.res.observedBy}` };
  // Only the driver says the fault happened: recorded as such, never as reach (reachedFault stays null).
  const self = all.find((x) => x.res.status === "SELF_REPORTED");
  if (self) {
    const independent = results.length === 0 ? "the plan has no independent local reach rule" : `no ${[...new Set(results.map((x) => x.res.observedBy))].join("/")} record matches`;
    return {
      faultId,
      reached: null,
      observedBy: self.res.observedBy,
      evidenceRef: self.res.pointer,
      detail: `fault ${faultId} reported only by the driver itself (${self.res.observedBy}); a driver self-report is not independent evidence and ${independent}`,
    };
  }
  if (results.length === 0) {
    return { faultId, reached: null, observedBy: null, evidenceRef: null, detail: `no independent local reach rule for ${faultId}; only its Layer-2 run (owner ${plan.registry.layer2Owner}) can prove it` };
  }
  const uncollected = results.filter((x) => x.res.status === "NOT_COLLECTED").map((x) => x.res.observedBy);
  if (uncollected.length === results.length) {
    return { faultId, reached: null, observedBy: null, evidenceRef: null, detail: `reach evidence not collected (${[...new Set(uncollected)].join(",")})` };
  }
  return {
    faultId,
    reached: false,
    observedBy: null,
    evidenceRef: null,
    detail: `fault ${faultId} not independently observed: no ${[...new Set(results.map((x) => x.res.observedBy))].join("/")} record matches its reach rules`,
  };
}
