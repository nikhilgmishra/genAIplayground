/**
 * Content-free console read models (spec sections 13 and 16).
 *
 * Active calls and call-investigation timelines are DERIVED from audit event
 * METADATA (the `audit_event_metadata` security-barrier view, read as
 * app_console) keyed by callId: session lifecycle (SESSION_AUDIT_ACTIONS),
 * `tool.invoke`, `transfer.*`, `action.*`, policy decisions, and safety events
 * from the safety module's `safety_events` table. Audit events cannot carry
 * transcript text or free text (strict writer grammar) and every view below is
 * built from an explicit field allowlist, so no caller words, recordings or
 * summaries can appear in a console response.
 */
import { z } from "zod";
import { AuditEvent } from "../protocol/index.js";
import type { AuditEvent as AuditEventT, StaffRole } from "../protocol/index.js";
import type { Db } from "../db/types.js";
import { SESSION_AUDIT_ACTIONS } from "../business/contract.js";
import type { TransferJourney } from "../workflows/transfer.js";
import { sha256Hex } from "../shared/canonical.js";
import { iso } from "../shared/clock.js";
import type {
  ActionKind,
  ActionState,
  CallSummary,
  CallTimelineEvent,
  CommitOutcome,
  SafetyEventView,
  ToolStatus,
  TransferState,
  VersionSetView,
} from "./contract.js";
import { consoleTx } from "./stores.js";

const OPAQUE = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const TYPED_REF = /^([a-z][a-z0-9_]{1,31}):([a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})$/;
const LEDGER_URI = /^ledger:\/\/actions\/(act_[A-Za-z0-9_-]{16,64})$/;
const TOOL_POINTER = /^db:\/\/tool_catalog\/([a-z][a-z0-9_.]{2,63})\/(\d+\.\d+\.\d+)$/;

/** Window for the active-call index (calls longer than this need an explicit lookup by id). */
export const ACTIVE_CALL_WINDOW_HOURS = 12;
const MAX_EVENTS_PER_CALL = 1000;

/* ------------------------------------------------------------------------ */
/* Audit metadata reader                                                     */
/* ------------------------------------------------------------------------ */

export class ConsoleAuditReader {
  constructor(private readonly db: Db) {}

  private parse(rows: { event: unknown }[], tenantId: string): AuditEventT[] {
    const out: AuditEventT[] = [];
    for (const r of rows) {
      const raw = typeof r.event === "string" ? (JSON.parse(r.event) as unknown) : r.event;
      const ev = AuditEvent.safeParse(raw);
      // An unparseable stored event is an integrity problem for the audit module; it is never shown.
      if (ev.success && ev.data.tenantId === tenantId) out.push(ev.data);
    }
    return out;
  }

  async eventsForCalls(tenantId: string, staffId: string, callIds: readonly string[], limit = MAX_EVENTS_PER_CALL): Promise<AuditEventT[]> {
    if (callIds.length === 0) return [];
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<{ event: unknown }>(
        `select event from audit_event_metadata where tenant_id = $1 and call_id = any($2::text[])
          order by occurred_at, source_stream, sequence limit $3`,
        [tenantId, [...callIds], limit],
      ),
    );
    return this.parse(rows.rows, tenantId);
  }

  /** Latest audit event id for an action, by correlation id and/or evidence pointer (both optional, one required). */
  async findEventId(tenantId: string, staffId: string, f: { action: string; correlationId?: string; pointer?: string }): Promise<string | null> {
    if (!f.correlationId && !f.pointer) return null;
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<{ event_id: string }>(
        `select event_id from audit_event_metadata
          where tenant_id = $1 and action = $2
            and ($3::text is null or correlation_id = $3)
            and ($4::text is null or (event -> 'evidencePointers') @> jsonb_build_array($4::text))
          order by occurred_at desc, sequence desc limit 1`,
        [tenantId, f.action, f.correlationId ?? null, f.pointer ?? null],
      ),
    );
    return rows.rows[0]?.event_id ?? null;
  }

  /** Calls with a session start in the window and no session end. */
  async activeCallIds(tenantId: string, staffId: string, since: Date, limit = 2000): Promise<string[]> {
    const rows = await consoleTx(this.db, tenantId, staffId, (tx) =>
      tx.query<{ call_id: string }>(
        `select call_id from audit_event_metadata
          where tenant_id = $1 and call_id is not null and occurred_at >= $2::timestamptz
          group by call_id
         having bool_or(action = $3) and not bool_or(action = $4)
          order by min(occurred_at) limit $5`,
        [tenantId, iso(since), SESSION_AUDIT_ACTIONS.started, SESSION_AUDIT_ACTIONS.ended, limit],
      ),
    );
    return rows.rows.map((r) => r.call_id).filter((c) => OPAQUE.test(c));
  }
}

/* ------------------------------------------------------------------------ */
/* Pointers                                                                  */
/* ------------------------------------------------------------------------ */

export function typedRefs(ev: Pick<AuditEventT, "evidencePointers">, kind: string): string[] {
  const out: string[] = [];
  for (const p of ev.evidencePointers) {
    const m = TYPED_REF.exec(p);
    if (m && m[1] === kind && m[2]) out.push(m[2]);
    if (kind === "action") {
      const l = LEDGER_URI.exec(p);
      if (l?.[1]) out.push(l[1]);
    }
  }
  return [...new Set(out)];
}

/** Deterministic opaque timeline entry id derived from the audit event id. */
const entryId = (auditEventId: string, kind: string): string => `tle_${sha256Hex(`${auditEventId}:${kind}`).slice(0, 32)}`;

/* ------------------------------------------------------------------------ */
/* Timeline                                                                  */
/* ------------------------------------------------------------------------ */

const SESSION_CHANGE: Readonly<Record<string, Extract<CallTimelineEvent, { kind: "session" }>["change"]>> = {
  [SESSION_AUDIT_ACTIONS.started]: "STARTED",
  [SESSION_AUDIT_ACTIONS.roleSelected]: "ROLE_SELECTED",
  [SESSION_AUDIT_ACTIONS.consentRecorded]: "CONSENT_RECORDED",
  [SESSION_AUDIT_ACTIONS.verificationBound]: "VERIFIED",
  [SESSION_AUDIT_ACTIONS.changed]: "GENERATION_CHANGED",
  [SESSION_AUDIT_ACTIONS.revoked]: "REVOKED",
  [SESSION_AUDIT_ACTIONS.ended]: "ENDED",
};

const ACTION_STATE_BY_AUDIT: Readonly<Record<string, ActionState>> = {
  "action.prepare": "PREPARED",
  "action.confirm": "CONFIRMED",
  [SESSION_AUDIT_ACTIONS.confirmationCaptured]: "CONFIRMED",
  "action.commit.started": "COMMITTING",
  "action.commit.succeeded": "COMMITTED",
  "action.commit.unknown": "UNKNOWN",
  "action.commit.failed": "FAILED",
  "action.commit.not_started": "CONFIRMED",
  "action.invalidate": "INVALIDATED",
  "action.expire": "EXPIRED",
  "action.cancel": "CANCELLED",
  "action.reconcile.inconclusive": "UNKNOWN",
};

function toolStatusFor(ev: AuditEventT): ToolStatus {
  switch (ev.outcome) {
    case "SUCCEEDED":
    case "ALLOWED":
      return "SUCCESS";
    case "DENIED":
      return "POLICY_DENIED";
    case "PENDING":
      return "PENDING";
    case "UNKNOWN":
      return "UNKNOWN_OUTCOME";
    case "FAILED":
      return ev.reasonCode !== null && /(TIMEOUT|UNAVAILABLE|RETRY|RATE_LIMIT|HTTP_429|HTTP_503)/.test(ev.reasonCode) ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE";
    default:
      return "UNKNOWN_OUTCOME";
  }
}

function commitOutcomeFor(state: ActionState): CommitOutcome | null {
  if (state === "COMMITTED") return "COMMITTED";
  if (state === "UNKNOWN") return "UNKNOWN";
  if (state === "FAILED") return "FAILED";
  return null;
}

export interface TimelineLookups {
  /** Current ledger view of an action (kind is immutable; state is the fallback for reconciliation events). */
  action(actionId: string): Promise<{ kind: ActionKind; state: ActionState; receiptId: string | null } | null>;
  journey(handoffId: string): Promise<TransferJourney | null>;
  supportRequest(supportRequestId: string): Promise<{ referenceNumber: string; syncState: Extract<CallTimelineEvent, { kind: "support_request" }>["syncState"] } | null>;
}

export interface SafetyRow {
  incident_id: string;
  call_id: string;
  phase: "SIGNAL_VALIDATED" | "ROUTE_INITIATED" | "OUTCOME";
  route: "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";
  signal_sources: string[];
  rule_ids: string[];
  strongest_strength: "CREDIBLE" | "UNRESOLVED" | null;
  destination_id: string;
  locale: string;
  locale_supported: boolean;
  after_hours: boolean;
  detected_at: Date | string;
  route_initiated_at: Date | string | null;
  latency_ms: number | null;
  target_ms: number;
  within_target: boolean | null;
  outcome: SafetyEventView["outcome"] | null;
  audit_event_id: string | null;
  audit_status: "RECORDED" | "AUDIT_UNAVAILABLE";
  recorded_at: Date | string;
  turn_id: string | null;
  session_generation: number;
  event_id: string;
}

const SAFETY_COLUMNS = `event_id, incident_id, call_id, phase, route, signal_sources, rule_ids, strongest_strength, destination_id, locale,
  locale_supported, after_hours, detected_at, route_initiated_at, latency_ms, target_ms, within_target, outcome, audit_event_id,
  audit_status, recorded_at, turn_id, session_generation`;

export async function safetyRowsForCalls(db: Db, tenantId: string, staffId: string, callIds: readonly string[]): Promise<SafetyRow[]> {
  if (callIds.length === 0) return [];
  const rows = await consoleTx(db, tenantId, staffId, (tx) =>
    tx.query<SafetyRow>(`select ${SAFETY_COLUMNS} from safety_events where call_id = any($1::text[]) order by recorded_at, event_id`, [[...callIds]]),
  );
  return rows.rows;
}

export async function recentSafetyRows(db: Db, tenantId: string, staffId: string, since: Date, limit = 2000): Promise<SafetyRow[]> {
  const rows = await consoleTx(db, tenantId, staffId, (tx) =>
    tx.query<SafetyRow>(`select ${SAFETY_COLUMNS} from safety_events where detected_at >= $1::timestamptz order by detected_at desc, event_id limit $2`, [iso(since), limit]),
  );
  return rows.rows;
}

const toIso = (v: Date | string): string => new Date(v).toISOString();

/** Builds the content-free timeline for one call from its audit metadata and safety rows. */
export async function buildTimeline(events: readonly AuditEventT[], safety: readonly SafetyRow[], lookups: TimelineLookups): Promise<{ timeline: CallTimelineEvent[]; supportRequestRefs: string[] }> {
  const timeline: CallTimelineEvent[] = [];
  const supportRefs = new Set<string>();
  const actionCache = new Map<string, Awaited<ReturnType<TimelineLookups["action"]>>>();
  const journeyCache = new Map<string, TransferJourney | null>();

  for (const ev of events) {
    const base = { at: ev.occurredAt, auditEventId: ev.eventId, turnId: ev.turnId, sessionGeneration: ev.sessionGeneration };
    if (ev.policyDecision) {
      timeline.push({
        ...base,
        eventId: entryId(ev.eventId, "policy_decision"),
        kind: "policy_decision",
        decisionId: ev.policyDecision.decisionId,
        policyAction: ev.action,
        allow: ev.policyDecision.allow,
        reasonCodes: [...ev.policyDecision.reasonCodes],
        policyVersion: ev.policyDecision.policyVersion,
        obligations: [],
      });
    }
    const change = SESSION_CHANGE[ev.action];
    if (change) {
      timeline.push({ ...base, eventId: entryId(ev.eventId, "session"), kind: "session", change, assurance: ev.assurance ?? "A0" });
      continue;
    }
    if (ev.action === SESSION_AUDIT_ACTIONS.toolInvoke) {
      const tool = ev.evidencePointers.map((p) => TOOL_POINTER.exec(p)).find((m) => m !== null);
      timeline.push({
        ...base,
        eventId: entryId(ev.eventId, "tool_invocation"),
        kind: "tool_invocation",
        tool: { name: tool?.[1] ?? "unrecorded.tool", version: tool?.[2] ?? "unrecorded" },
        status: toolStatusFor(ev),
        reasonCode: ev.reasonCode,
        policyDecisionId: ev.policyDecision?.decisionId ?? null,
        latencyMs: null,
      });
      continue;
    }
    if (ev.action.startsWith("action.") || ev.action === SESSION_AUDIT_ACTIONS.confirmationCaptured) {
      for (const actionId of typedRefs(ev, "action")) {
        if (!actionCache.has(actionId)) actionCache.set(actionId, await lookups.action(actionId));
        const current = actionCache.get(actionId) ?? null;
        if (!current) continue;
        const reconciledCommit = ev.action === "action.reconciled" && ev.outcome === "RECONCILED" && typedRefs(ev, "receipt").length > 0;
        const state: ActionState = ACTION_STATE_BY_AUDIT[ev.action] ?? (reconciledCommit ? "COMMITTED" : current.state);
        const receiptId = typedRefs(ev, "receipt")[0] ?? (state === "COMMITTED" ? current.receiptId : null);
        timeline.push({
          ...base,
          eventId: entryId(ev.eventId, `action:${actionId}`),
          kind: "action",
          actionId,
          actionKind: current.kind,
          state,
          receiptId,
          commitOutcome: commitOutcomeFor(state),
        });
      }
      continue;
    }
    if (ev.action.startsWith("transfer.")) {
      const handoffId = typedRefs(ev, "transfer_journey")[0];
      const transferId = typedRefs(ev, "transfer")[0];
      if (!handoffId || !transferId) continue;
      if (!journeyCache.has(handoffId)) journeyCache.set(handoffId, await lookups.journey(handoffId));
      const j = journeyCache.get(handoffId) ?? null;
      const attempt = j?.attempts.find((a) => a.transferId === transferId);
      if (!j || !attempt) continue;
      const atEvent = [...attempt.history].reverse().find((h) => Date.parse(h.at) <= Date.parse(ev.occurredAt));
      timeline.push({
        ...base,
        eventId: entryId(ev.eventId, "transfer"),
        kind: "transfer",
        transferId,
        destinationId: attempt.destinationId,
        transferState: (atEvent?.state ?? attempt.state) as TransferState,
        reason: j.reason,
        receiverAcknowledgedPackage: attempt.receiverAcknowledgedPackage,
      });
      continue;
    }
    if (ev.action.startsWith("support_request.")) {
      for (const id of typedRefs(ev, "support_request")) {
        const sr = await lookups.supportRequest(id);
        if (!sr) continue;
        supportRefs.add(sr.referenceNumber);
        timeline.push({ ...base, eventId: entryId(ev.eventId, `support_request:${id}`), kind: "support_request", referenceNumber: sr.referenceNumber, syncState: sr.syncState });
      }
    }
  }

  for (const s of safety) {
    timeline.push({
      eventId: entryId(s.event_id, "safety_event"),
      at: toIso(s.recorded_at),
      auditEventId: s.audit_event_id,
      turnId: s.turn_id,
      sessionGeneration: s.session_generation,
      kind: "safety_event",
      incidentId: s.incident_id,
      phase: s.phase,
      route: s.route,
      latencyMs: s.latency_ms,
      withinTarget: s.within_target,
    });
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.eventId < b.eventId ? -1 : 1));
  return { timeline: timeline.slice(0, 2000), supportRequestRefs: [...supportRefs].slice(0, 32) };
}

/* ------------------------------------------------------------------------ */
/* Call summaries                                                            */
/* ------------------------------------------------------------------------ */

export function summarizeCall(callId: string, events: readonly AuditEventT[], safety: readonly SafetyRow[], journeys: readonly TransferJourney[], localFixture: boolean): CallSummary | null {
  const mine = events.filter((e) => e.callId === callId);
  const started = mine.find((e) => e.action === SESSION_AUDIT_ACTIONS.started);
  if (!started) return null;
  const ended = mine.some((e) => e.action === SESSION_AUDIT_ACTIONS.ended);
  const withAssurance = [...mine].reverse().find((e) => e.assurance !== null);
  const generation = Math.max(0, ...mine.map((e) => e.sessionGeneration ?? 0));
  const callJourneys = journeys.filter((j) => j.callId === callId).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const latestJourney = callJourneys.at(-1) ?? null;
  const latestAttempt = latestJourney?.attempts.at(-1) ?? null;
  const routing = latestJourney !== null && latestJourney.status === "ROUTING";
  const safetyFlag =
    safety.some((s) => s.call_id === callId) ||
    mine.some((e) => e.action.startsWith("safety.") || e.action === "transfer.safety_route_initiated") ||
    callJourneys.some((j) => j.priority === "SAFETY");
  return {
    callId,
    state: ended ? "ENDED" : routing ? "IN_TRANSFER" : "ACTIVE",
    assurance: withAssurance?.assurance ?? "A0",
    // Intent category and language are not carried by content-free audit metadata.
    intentCategory: null,
    safetyFlag,
    startedAt: started.occurredAt,
    transferState: latestAttempt?.state ?? null,
    sessionGeneration: generation,
    language: "und",
    localFixture,
  };
}

export function latestVersions(events: readonly AuditEventT[]): VersionSetView | null {
  const v = [...events].reverse().find((e) => e.versions !== null)?.versions;
  return v ? { ...v } : null;
}

/* ------------------------------------------------------------------------ */
/* Safety events                                                             */
/* ------------------------------------------------------------------------ */

const SignalSources = z.array(z.enum(["EXPLICIT_PHRASE", "SEMANTIC_SIGNAL", "ASR_UNCERTAIN", "CALLER_REQUEST", "HUMAN_INTERVENTION", "FAIL_SAFE"]));

/** One content-free view per incident (validated signal, route initiation, latest outcome). */
export function safetyEventViews(rows: readonly SafetyRow[]): SafetyEventView[] {
  const byIncident = new Map<string, SafetyRow[]>();
  for (const r of rows) byIncident.set(r.incident_id, [...(byIncident.get(r.incident_id) ?? []), r]);
  const out: SafetyEventView[] = [];
  for (const [incidentId, list] of byIncident) {
    const first = list.find((r) => r.phase === "SIGNAL_VALIDATED") ?? list[0];
    if (!first) continue;
    const initiated = list.find((r) => r.phase === "ROUTE_INITIATED") ?? null;
    const outcome = [...list].reverse().find((r) => r.phase === "OUTCOME") ?? null;
    const sources = SignalSources.safeParse(first.signal_sources);
    out.push({
      incidentId,
      callId: first.call_id,
      detectedAt: toIso(first.detected_at),
      route: first.route,
      signalSources: sources.success ? sources.data : [],
      ruleIds: [...first.rule_ids],
      strongestStrength: first.strongest_strength,
      destinationId: first.destination_id,
      routeInitiatedAt: initiated?.route_initiated_at ? toIso(initiated.route_initiated_at) : null,
      latencyMs: initiated?.latency_ms ?? null,
      targetMs: first.target_ms,
      withinTarget: initiated?.within_target ?? null,
      outcome: outcome?.outcome ?? "IN_PROGRESS",
      auditStatus: list.some((r) => r.audit_status === "AUDIT_UNAVAILABLE") ? "AUDIT_UNAVAILABLE" : "RECORDED",
      afterHours: first.after_hours,
      locale: first.locale,
      localeSupported: first.locale_supported,
    });
  }
  return out.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1));
}

/* ------------------------------------------------------------------------ */
/* Pending actions (console column allowlist on action_ledger, migration 0900) */
/* ------------------------------------------------------------------------ */

export interface PendingRow {
  action_id: string;
  call_id: string;
  kind: ActionKind;
  system: string;
  record_type: string;
  digest: string;
  state: "PREPARED" | "CONFIRMED" | "COMMITTING";
  requires_step_up: boolean;
  prepared_at: Date | string;
  expires_at: Date | string;
}

export async function pendingActionRows(db: Db, tenantId: string, staffId: string, now: Date, limit = 500): Promise<PendingRow[]> {
  const rows = await consoleTx(db, tenantId, staffId, (tx) =>
    tx.query<PendingRow>(
      `select action_id, call_id, kind, target->>'system' as system, target->>'recordType' as record_type, digest, state,
              requires_step_up, prepared_at, expires_at
         from action_ledger
        where state in ('PREPARED', 'CONFIRMED', 'COMMITTING') and (state = 'COMMITTING' or expires_at > $1::timestamptz)
        order by prepared_at, action_id limit $2`,
      [iso(now), limit],
    ),
  );
  return rows.rows;
}

export async function pendingActionRow(db: Db, tenantId: string, staffId: string, actionId: string): Promise<(PendingRow & { all_state: string }) | null> {
  const rows = await consoleTx(db, tenantId, staffId, (tx) =>
    tx.query<PendingRow & { all_state: string }>(
      `select action_id, call_id, kind, target->>'system' as system, target->>'recordType' as record_type, digest, state, state as all_state,
              requires_step_up, prepared_at, expires_at
         from action_ledger where action_id = $1`,
      [actionId],
    ),
  );
  return rows.rows[0] ?? null;
}

/* ------------------------------------------------------------------------ */
/* Queue health                                                              */
/* ------------------------------------------------------------------------ */

export const QUEUE_AGE_ELEVATED_SECONDS = 120;

export function queueIdFor(destinationId: string): string {
  return `q_${destinationId.replace(/^dst_/, "")}`.slice(0, 42);
}

/** Roles in a staff identity that are journey roles (for owner-scoped rules). */
export const isSupervisor = (roles: readonly StaffRole[]): boolean => roles.includes("supervisor");
