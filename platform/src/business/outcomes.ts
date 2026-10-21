/**
 * Interaction outcomes with evidence rules (spec section 4; ACT-04, SAFE-04).
 *
 * - RESOLVED only when the contract's success evidence exists: for a commit contract,
 *   a COMMITTED receipt of the contract's action kind recorded for THIS call (verified
 *   against the per-call action index, not taken on trust from the caller).
 * - Read-only contracts end in INFORMATION_PROVIDED; workflow acceptance, case or
 *   support-request creation end in REQUEST_ACCEPTED, never RESOLVED.
 * - TRANSFERRED only after CALLER_CONFIRMED_CONNECTED (transferConnected).
 * - A hang-up, an HTTP 200 or a created Case alone never set RESOLVED; anything without
 *   evidence is OUTCOME_UNKNOWN.
 * - A commit of this call still COMMITTING or UNKNOWN in the ledger (or committed there but its
 *   receipt not yet recorded for the call) at call end is OUTCOME_UNKNOWN
 *   (COMMIT_OUTCOME_UNKNOWN), never INFORMATION_PROVIDED (ACT-03: nothing is announced before
 *   reconciliation).
 * - Outcomes are append-only (migration 0300 trigger): when the reconciler later records the
 *   action COMMITTED, the action.committed consumer calls reviseAfterCommit(), which appends a
 *   REVISION row (evidence.revision names the outcome it revises, the trigger and the action)
 *   whenever the decision with the now-verified receipt differs. Nothing is overwritten; the
 *   latest row (recorded_at, strictly increasing per call) is the current outcome.
 * - record() and reviseAfterCommit() write a call's rows under ONE per-call transaction-scoped
 *   advisory lock (CALL_LOCK_SQL, key interaction_outcomes:<tenant>:<call>), so under READ COMMITTED
 *   two concurrent writers for one call cannot both see "no earlier row" (or the same latest row).
 *   PGlite runs one transaction at a time, so that race cannot be reproduced offline.
 *
 * Resolution metrics (spec section 13; SPEC-13.resolution-metrics). Labels are code constants only
 * (outcome, contract intent, window); a subject, call or session id is never a label (DATA-01).
 * - Verified resolution (vsp_verified_resolutions_total) counts only RESOLVED, which decideOutcome()
 *   reaches only with the contract's committed receipt verified for the call. REQUEST_ACCEPTED (an
 *   accepted workflow, a created Case or support request) is never a resolution (ACT-04); it stays a
 *   separate outcome class of vsp_interaction_outcomes_total. A call counts once, at its first
 *   RESOLVED row: a call-end row (source "call_end") or a revision (source "reconciliation"); a later
 *   RESOLVED row of a call that already had one is not counted again.
 * - Containment (vsp_contained_interactions_total) is measured apart: a call with no human or safety
 *   transfer attempted, whatever its outcome. "Attempted" is read server-side from the call's transfer
 *   journeys (deps.transfers.journeysForCall: any journey, any status, so a transfer the caller
 *   abandoned while queued or a safety route still in progress at call end is not contained; a failed
 *   lookup counts as attempted), plus connected or failed transfer evidence. This is the evaluation
 *   aggregate's definition (isContainedResult: transferOutcome NOT_ATTEMPTED). It is never a success
 *   measure; a contained call without verified evidence is not a resolution.
 * - Containment and repeat contact are counted per call, at the call's FIRST recorded outcome
 *   (vsp_interaction_outcomes_total keeps counting every recorded row).
 * - Repeat contact (vsp_repeat_contacts_total, denominator vsp_repeat_contact_checks_total): at a
 *   call's FIRST recorded outcome, the call's authorized subject (authorizedSubject(): server-side
 *   records only; stored as interaction_outcomes.subject_ref, migration 0301) is looked up for an
 *   earlier call's outcome inside each configured window (tenant-scoped, as app_runtime under RLS).
 *   Windows: RepeatContactPolicy (placeholder default pending PRQ-001). The check never affects the
 *   recorded outcome.
 */
import { z } from "zod";
import { buildAuditInput } from "../audit/build-input.js";
import { REPEAT_CONTACT_WINDOWS } from "../observability/metrics.js";
import type { RepeatContactWindow } from "../observability/metrics.js";
import type { ActionKind, Outcome, PreparedAction } from "../protocol/index.js";
import { OpaqueId } from "../protocol/index.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { ValidationError } from "../shared/errors.js";
import type { InteractionOutcomeService, ToolDeps } from "./contract.js";
import { contractById } from "./contracts/index.js";
import type { InteractionActionRecord, InteractionIndex } from "./interactions.js";
import { reasonOf } from "./shared.js";

/** Action kinds whose COMMITTED receipt is the success evidence of each RESOLVED contract. */
export const RESOLVING_ACTION_KINDS: Readonly<Record<string, readonly ActionKind[]>> = Object.freeze({
  "appointment_reschedule@1": ["appointment.reschedule"],
  "appointment_create@1": ["appointment.create"],
});

/** Duration of each repeat-contact window id (the id is its duration; label `window`). */
export const REPEAT_CONTACT_WINDOW_MS: Readonly<Record<RepeatContactWindow, number>> = Object.freeze({
  "24h": 24 * 3_600_000,
  "72h": 72 * 3_600_000,
  "7d": 7 * 86_400_000,
  "14d": 14 * 86_400_000,
  "30d": 30 * 86_400_000,
});

export interface RepeatContactPolicy {
  /** Windows measured, each a `window` label of vsp_repeat_contacts_total. */
  readonly windows: readonly RepeatContactWindow[];
}

/**
 * PLACEHOLDER pending the support / operations owner's success-measure definitions (PRQ-001:
 * "success measures (verified resolution, repeat contact, CSAT response rate)"). The windows are the
 * two spec section 13 names (24-hour and 7-day repeat contact). Everything else is an engineering
 * default, not an approved definition: a contact is any call whose first outcome is recorded for an
 * authorized subject, of any intent and outcome (transfers and safety routes included), with no
 * exclusion for scheduled callbacks or follow-ups the organisation initiated.
 */
export const DEFAULT_REPEAT_CONTACT_POLICY: RepeatContactPolicy = Object.freeze({ windows: Object.freeze(["24h", "7d"] as RepeatContactWindow[]) });

const RepeatContactPolicySchema = z.strictObject({ windows: z.array(z.enum(REPEAT_CONTACT_WINDOWS)).min(1).max(REPEAT_CONTACT_WINDOWS.length) });

const Input = z.strictObject({
  tenantId: OpaqueId,
  callId: OpaqueId,
  contractId: z.string().regex(/^[a-z_]+@\d+$/).nullable(),
  /**
   * Optional: the subject of the call's AUTHORIZED session (AuthContext.subjectId at A2+), passed only
   * by a trusted server component that holds that session; never a caller, model or tool value.
   */
  subjectRef: OpaqueId.nullable().optional(),
  evidence: z.strictObject({
    commitReceiptIds: z.array(OpaqueId).max(16),
    informationProvided: z.boolean(),
    requestAccepted: z.boolean(),
    transferConnected: z.boolean(),
    callerDisconnected: z.boolean(),
    policyDeclined: z.boolean(),
    failed: z.boolean(),
  }),
});

type Decision = { outcome: Outcome; reasonCode: string };
type Evidence = z.infer<typeof Input>["evidence"];

/**
 * InteractionOutcomeService.record input plus the optional trusted `subjectRef` (see Input). Absent,
 * the subject is resolved from this call's own server-side records (BusinessOutcomeService.authorizedSubject).
 */
export type OutcomeRecordInput = Parameters<InteractionOutcomeService["record"]>[0] & { subjectRef?: string | null };

/**
 * Verified resolution: RESOLVED only, which decideOutcome() reaches only with the contract's committed
 * receipt verified for the call. Workflow acceptance and case creation are not resolution (ACT-04).
 */
export const isVerifiedResolution = (outcome: Outcome): boolean => outcome === "RESOLVED";

/**
 * Containment: no human or safety transfer was attempted for the call (`transferAttempted`: the call has
 * a transfer journey of any status, or its lookup failed), none connected and no failed transfer journey
 * (`failed` evidence is treated as a transfer attempt, so containment is never inflated by it). It says
 * nothing about resolution and is never counted as success.
 */
export const isContained = (call: Pick<Evidence, "transferConnected" | "failed"> & { transferAttempted: boolean }): boolean =>
  !call.transferAttempted && !call.transferConnected && !call.failed;

/**
 * Pure decision given verified committed receipt kinds (exported for property tests).
 * `unresolvedCommits`: this call's actions whose commit outcome is not settled (ledger COMMITTING /
 * UNKNOWN, or committed but not yet recorded for the call); any => OUTCOME_UNKNOWN unless the call
 * was transferred or already resolved by verified evidence.
 */
export function decideOutcome(
  contractId: string | null,
  evidence: Evidence,
  verifiedCommittedKinds: readonly ActionKind[],
  unresolvedCommits = 0,
): Decision {
  if (evidence.transferConnected) return { outcome: "TRANSFERRED", reasonCode: "CALLER_CONFIRMED_CONNECTED" };
  const contract = contractId ? contractById(contractId) : null;
  if (contractId && !contract) return { outcome: "OUTCOME_UNKNOWN", reasonCode: "CONTRACT_UNKNOWN" };
  if (contract?.resolvedOutcome === "RESOLVED") {
    const kinds = RESOLVING_ACTION_KINDS[contract.contractId] ?? [];
    if (kinds.length > 0 && verifiedCommittedKinds.some((k) => kinds.includes(k))) return { outcome: "RESOLVED", reasonCode: "COMMITTED_RECEIPT_VERIFIED" };
  }
  // An ambiguous commit is reconciled before anything is announced (ACT-03): not "information provided".
  if (unresolvedCommits > 0) return { outcome: "OUTCOME_UNKNOWN", reasonCode: "COMMIT_OUTCOME_UNKNOWN" };
  // Workflow acceptance, case or support-request creation is never resolution (ACT-04).
  if (evidence.requestAccepted) return { outcome: "REQUEST_ACCEPTED", reasonCode: "REQUEST_ACCEPTED_NOT_RESOLUTION" };
  if (evidence.informationProvided) return { outcome: "INFORMATION_PROVIDED", reasonCode: "INFORMATION_PROVIDED" };
  if (evidence.policyDeclined) return { outcome: "DECLINED_BY_POLICY", reasonCode: "POLICY_DECLINED" };
  if (evidence.callerDisconnected) return { outcome: "CALLER_DISCONNECTED", reasonCode: "CALLER_DISCONNECTED" };
  if (evidence.failed) return { outcome: "FAILED", reasonCode: "FAILED" };
  return { outcome: "OUTCOME_UNKNOWN", reasonCode: evidence.commitReceiptIds.length > 0 ? "RECEIPT_NOT_VERIFIED" : "NO_SUCCESS_EVIDENCE" };
}

/** Contract of the call's verified committed actions: a resolving contract first, else the first recorded one. */
function inferContract(records: readonly { contractId: string | null }[]): string | null {
  const ids = records.map((r) => r.contractId).filter((c): c is string => c !== null && contractById(c) !== null);
  return ids.find((c) => (RESOLVING_ACTION_KINDS[c]?.length ?? 0) > 0) ?? ids[0] ?? null;
}

/** Ledger states of a call's action whose commit outcome is not settled for the call yet. */
const UNSETTLED_STATES: ReadonlySet<string> = new Set(["COMMITTING", "UNKNOWN", "COMMITTED"]);

/** Evidence stored with an outcome (the record() input evidence plus server-side derivations). */
const StoredEvidence = Input.shape.evidence.extend({
  verifiedCommittedKinds: z.array(z.string()).max(16).optional(),
  contractInferred: z.boolean().optional(),
  unresolvedActionIds: z.array(OpaqueId).max(32).optional(),
  revision: z.unknown().optional(),
});

interface OutcomeRow {
  outcome_id: string;
  contract_id: string | null;
  outcome: Outcome;
  reason_code: string;
  evidence: unknown;
  recorded_at: Date | string;
  subject_ref: string | null;
}

interface PriorContactRow {
  recorded_at: Date | string;
  outcome: Outcome;
  contract_id: string | null;
}

/** The call's authorized subject: exactly one, none, several (never guessed) or not determinable. */
type SubjectResolution = { kind: "subject"; subjectRef: string } | { kind: "none" } | { kind: "ambiguous" } | { kind: "unavailable" };

/** Ledger entry of each of a call's actions: null = no such action, undefined = unreadable. */
type CallLedger = ReadonlyMap<string, PreparedAction | null | undefined>;

const msOf = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const intentOf = (contractId: string | null): string => (contractId ? (contractById(contractId)?.intent ?? "unknown") : "unknown");

/** Per-call writer lock shared by record() and reviseAfterCommit() (transaction-scoped; released at commit). */
const CALL_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended($1, 0))";
const callLockKey = (tenantId: string, callId: string): string => `interaction_outcomes:${tenantId}:${callId}`;

/** Whether any earlier row of the call is RESOLVED: a call counts once as a verified resolution. */
const CALL_RESOLVED_SQL = "select exists (select 1 from interaction_outcomes where call_id = $1 and outcome = 'RESOLVED') as resolved";

/**
 * The most recent EARLIER call of the same subject inside [from, to], with that call's current outcome.
 * A call's contact time is its call-end row; revision rows (evidence.revision) are not contacts.
 */
const PRIOR_CONTACT_SQL = `select c.recorded_at, l.outcome, l.contract_id
    from interaction_outcomes c
    cross join lateral (
      select o.outcome, o.contract_id from interaction_outcomes o
       where o.tenant_id = c.tenant_id and o.call_id = c.call_id
       order by o.recorded_at desc, o.outcome_id desc limit 1
    ) l
   where c.tenant_id = $1 and c.subject_ref = $2 and c.call_id <> $3 and not (c.evidence ? 'revision')
     and c.recorded_at >= $4 and c.recorded_at <= $5
   order by c.recorded_at desc, c.outcome_id desc
   limit 1`;

export class BusinessOutcomeService implements InteractionOutcomeService {
  private readonly repeatContact: RepeatContactPolicy;

  constructor(
    private readonly deps: ToolDeps,
    private readonly interactions: InteractionIndex,
    opts: { repeatContact?: RepeatContactPolicy } = {},
  ) {
    const policy = RepeatContactPolicySchema.safeParse(opts.repeatContact ?? DEFAULT_REPEAT_CONTACT_POLICY);
    if (!policy.success || new Set(policy.data.windows).size !== policy.data.windows.length) throw new ValidationError("REPEAT_CONTACT_POLICY_INVALID");
    this.repeatContact = Object.freeze({ windows: Object.freeze([...policy.data.windows]) });
  }

  /** Ledger entry of each given action (one read each; a failed read is undefined, never guessed). */
  private async ledgerOf(tenantId: string, callActions: readonly InteractionActionRecord[]): Promise<CallLedger> {
    const out = new Map<string, PreparedAction | null | undefined>();
    for (const a of callActions) out.set(a.actionId, await this.deps.actions.get(tenantId, a.actionId).catch(() => undefined));
    return out;
  }

  /**
   * This call's actions whose commit is not settled for the call: no COMMITTED receipt recorded in the
   * per-call index while the ledger says COMMITTING, UNKNOWN or COMMITTED (receipt not yet indexed). An
   * unreadable ledger row counts as unsettled (never a guessed outcome).
   */
  private unsettledCommits(callActions: readonly InteractionActionRecord[], ledger: CallLedger): string[] {
    const out: string[] = [];
    for (const a of callActions) {
      if (a.receiptOutcome === "COMMITTED") continue;
      const action = ledger.get(a.actionId);
      if (action === undefined || (action !== null && UNSETTLED_STATES.has(action.state))) out.push(a.actionId);
    }
    return out;
  }

  /**
   * The call's AUTHORIZED subject from server-side records only: the trusted session subject when a
   * trusted component passed it, the subjects of this call's ledger actions (prepared only after a
   * policy allow for that subject) and the subject links of this call's support requests (set only at
   * A2+; restricted rows stay invisible to app_runtime under RLS). Exactly one distinct subject is the
   * answer; several are ambiguous and an unreadable ledger entry makes it undeterminable.
   */
  private async authorizedSubject(tenantId: string, callId: string, ledger: CallLedger, trusted: string | null | undefined): Promise<SubjectResolution> {
    const subjects = new Set<string>();
    if (trusted) subjects.add(trusted);
    for (const entry of ledger.values()) {
      if (entry === undefined) return { kind: "unavailable" };
      if (entry !== null) subjects.add(entry.subjectId);
    }
    const linked = await this.deps.db.tx(
      (q) =>
        q.query<{ subject_ref: string }>(
          `select distinct subject_ref from support_requests
            where (call_id = $1 or source_call_ids @> jsonb_build_array($1::text)) and subject_ref is not null limit 4`,
          [callId],
        ),
      { role: "app_runtime", rls: { tenantId } },
    );
    for (const r of linked.rows) subjects.add(r.subject_ref);
    const [only, ...more] = [...subjects];
    if (only === undefined) return { kind: "none" };
    return more.length > 0 ? { kind: "ambiguous" } : { kind: "subject", subjectRef: only };
  }

  async record(raw: OutcomeRecordInput): Promise<{ outcome: Outcome; reasonCode: string }> {
    const p = Input.safeParse(raw);
    if (!p.success) throw new ValidationError("OUTCOME_INPUT_INVALID");
    const input = p.data;
    const callActions = await this.interactions.forCall(input.tenantId, input.callId);
    const ledger = await this.ledgerOf(input.tenantId, callActions);
    const verifiedRecords = callActions.filter((a) => a.receiptOutcome === "COMMITTED" && a.receiptId !== null && input.evidence.commitReceiptIds.includes(a.receiptId));
    const verified = verifiedRecords.map((a) => a.actionKind);
    const unsettled = this.unsettledCommits(callActions, ledger);
    // Call end (TC-11) names no contract: infer it from this call's own verified committed actions,
    // preferring a contract whose success evidence is a commit (never from caller or model input).
    const contractId = input.contractId ?? inferContract(verifiedRecords);
    const decision = decideOutcome(contractId, input.evidence, verified, unsettled.length);
    // Measurement only: a failed subject lookup never changes or blocks the outcome.
    const subject = await this.authorizedSubject(input.tenantId, input.callId, ledger, input.subjectRef).catch((): SubjectResolution => ({ kind: "unavailable" }));
    const now = this.deps.clock.now();
    const outcomeId = newId("ioc");
    const written = await this.deps.db.tx(
      async (tx) => {
        // One writer at a time per call (same key as reviseAfterCommit): under READ COMMITTED two concurrent
        // TC-11 requests for one call would otherwise both see no earlier row and both count the call.
        await tx.query(CALL_LOCK_SQL, [callLockKey(input.tenantId, input.callId)]);
        const earlier = (
          await tx.query<{ n: number; last_at: Date | string | null; resolved: boolean | null }>(
            "select count(*)::int as n, max(recorded_at) as last_at, bool_or(outcome = 'RESOLVED') as resolved from interaction_outcomes where call_id = $1",
            [input.callId],
          )
        ).rows[0];
        // Strictly later than the call's latest row, so "latest" is unambiguous even within one millisecond.
        const recordedAt = earlier?.last_at ? new Date(Math.max(now.getTime(), msOf(earlier.last_at) + 1)) : now;
        await tx.query(
          `insert into interaction_outcomes (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at, subject_ref)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [
            outcomeId,
            input.tenantId,
            input.callId,
            contractId,
            decision.outcome,
            decision.reasonCode,
            JSON.stringify({ ...input.evidence, verifiedCommittedKinds: verified, contractInferred: input.contractId === null && contractId !== null, unresolvedActionIds: unsettled }),
            iso(recordedAt),
            subject.kind === "subject" ? subject.subjectRef : null,
          ],
        );
        await this.deps.audit.append(
          tx,
          buildAuditInput(
            {
              tenantId: input.tenantId,
              correlationId: outcomeId,
              sourceComponent: "gateway",
              action: "interaction.outcome_recorded",
              outcome: "SUCCEEDED",
              callId: input.callId,
              evidencePointers: [`db://interaction_outcomes/${outcomeId}`, ...input.evidence.commitReceiptIds.slice(0, 8).map((r) => `receipt:${r}`)],
              reasonCode: decision.reasonCode,
              versions: this.deps.versions,
            },
            this.deps.clock,
          ),
        );
        return { firstForCall: Number(earlier?.n ?? 0) === 0, alreadyResolved: earlier?.resolved === true };
      },
      { role: "app_runtime", rls: { tenantId: input.tenantId } },
    );
    const intent = intentOf(contractId);
    this.deps.metrics.increment("vsp_interaction_outcomes_total", { outcome: decision.outcome, intent });
    // A call is a verified resolution once, at its first RESOLVED row (a repeated record() that resolves a
    // call recorded unresolved before counts; one already resolved, at call end or by a revision, does not).
    if (isVerifiedResolution(decision.outcome) && !written.alreadyResolved) this.deps.metrics.increment("vsp_verified_resolutions_total", { intent, source: "call_end" });
    // Per call, at its first recorded outcome: a repeated record() for the same call is not another
    // contact or contained call. Containment is measured apart from resolution and is never success.
    if (written.firstForCall) {
      const contained = isContained({ ...input.evidence, transferAttempted: await this.transferAttempted(input.tenantId, input.callId) });
      if (contained) this.deps.metrics.increment("vsp_contained_interactions_total", { outcome: decision.outcome, intent });
      await this.measureRepeatContact(input.tenantId, input.callId, subject, now);
    }
    return decision;
  }

  /**
   * Whether a human or safety transfer was attempted for the call, from the server's own transfer
   * journeys (any journey of the call, any status: routing, holding, connected, completed, abandoned by
   * the caller or superseded). Never from caller, model or tool input. A failed lookup is an attempt, so
   * an unreadable transfer store never inflates containment; it is logged without any identifier.
   */
  private async transferAttempted(tenantId: string, callId: string): Promise<boolean> {
    try {
      return (await this.deps.transfers.journeysForCall(tenantId, callId)).length > 0;
    } catch (err) {
      this.deps.logger.warn("business.outcome.transfer_lookup_failed", { reasonCode: reasonOf(err, "TRANSFER_LOOKUP_FAILED") });
      return true;
    }
  }

  /**
   * Repeat contact for one call's first recorded outcome: the most recent earlier call of the same
   * authorized subject inside the longest configured window, counted once per window it falls in.
   * Never throws; a failed lookup is counted as check_failed and logged without any identifier.
   */
  private async measureRepeatContact(tenantId: string, callId: string, subject: SubjectResolution, at: Date): Promise<void> {
    const check = (result: string) => this.deps.metrics.increment("vsp_repeat_contact_checks_total", { result });
    if (subject.kind === "none") return check("no_authorized_subject");
    if (subject.kind === "ambiguous") return check("subject_ambiguous");
    if (subject.kind === "unavailable") return check("check_failed");
    const longest = Math.max(...this.repeatContact.windows.map((w) => REPEAT_CONTACT_WINDOW_MS[w]));
    let prior: PriorContactRow | undefined;
    try {
      const r = await this.deps.db.tx((q) => q.query<PriorContactRow>(PRIOR_CONTACT_SQL, [tenantId, subject.subjectRef, callId, iso(new Date(at.getTime() - longest)), iso(at)]), {
        role: "app_runtime",
        rls: { tenantId },
      });
      prior = r.rows[0];
    } catch (err) {
      this.deps.logger.warn("business.outcome.repeat_contact_check_failed", { reasonCode: reasonOf(err, "REPEAT_CONTACT_LOOKUP_FAILED") });
      return check("check_failed");
    }
    if (!prior) return check("first_contact");
    const elapsed = at.getTime() - msOf(prior.recorded_at);
    const labels = { prior_outcome: prior.outcome, prior_intent: intentOf(prior.contract_id) };
    for (const window of this.repeatContact.windows) {
      if (elapsed <= REPEAT_CONTACT_WINDOW_MS[window]) this.deps.metrics.increment("vsp_repeat_contacts_total", { window, ...labels });
    }
    check("repeat");
  }

  /**
   * Append-only outcome revision after the reconciler records `actionId` COMMITTED (called by the
   * action.committed consumer, idempotent and safe on redelivery). The call's CURRENT outcome is
   * re-decided with the now-recorded receipt; when the decision differs, a revision row is appended
   * (evidence.revision = { revises, previousOutcome, trigger, actionId }) with its own audit event.
   * No outcome yet (the call is still live) => nothing to revise: call end decides with the receipt.
   */
  async reviseAfterCommit(tenantId: string, actionId: string): Promise<{ revised: boolean; outcome: Outcome | null; reasonCode: string }> {
    if (!OpaqueId.safeParse(tenantId).success || !OpaqueId.safeParse(actionId).success) throw new ValidationError("OUTCOME_REVISION_INPUT_INVALID");
    const rec = await this.interactions.get(tenantId, actionId);
    if (!rec || rec.receiptOutcome !== "COMMITTED" || rec.receiptId === null) return { revised: false, outcome: null, reasonCode: "RECEIPT_NOT_RECORDED" };
    const receiptId = rec.receiptId;
    // Server-side facts first (each read opens its own transaction; none may run inside the revision's).
    const callActions = await this.interactions.forCall(tenantId, rec.callId);
    const unsettled = this.unsettledCommits(callActions, await this.ledgerOf(tenantId, callActions.filter((a) => a.receiptOutcome !== "COMMITTED")));
    const now = this.deps.clock.now();
    const result = await this.deps.db.tx(
      async (tx) => {
        // One writer at a time per call (concurrent consumers, redeliveries or a call-end record()).
        await tx.query(CALL_LOCK_SQL, [callLockKey(tenantId, rec.callId)]);
        const latest = (
          await tx.query<OutcomeRow>(
            "select outcome_id, contract_id, outcome, reason_code, evidence, recorded_at, subject_ref from interaction_outcomes where call_id = $1 order by recorded_at desc, outcome_id desc limit 1",
            [rec.callId],
          )
        ).rows[0];
        if (!latest) return { revised: false, outcome: null, reasonCode: "NO_OUTCOME_RECORDED", newlyVerified: null };
        const prior = StoredEvidence.safeParse(typeof latest.evidence === "string" ? (JSON.parse(latest.evidence) as unknown) : latest.evidence);
        if (!prior.success) return { revised: false, outcome: latest.outcome, reasonCode: "OUTCOME_EVIDENCE_UNREADABLE", newlyVerified: null };
        const evidence = {
          commitReceiptIds: [...new Set([...prior.data.commitReceiptIds, receiptId])].slice(0, 16),
          informationProvided: prior.data.informationProvided,
          requestAccepted: prior.data.requestAccepted,
          transferConnected: prior.data.transferConnected,
          callerDisconnected: prior.data.callerDisconnected,
          policyDeclined: prior.data.policyDeclined,
          failed: prior.data.failed,
        };
        const verifiedRecords = callActions.filter((a) => a.receiptOutcome === "COMMITTED" && a.receiptId !== null && evidence.commitReceiptIds.includes(a.receiptId));
        const verified = verifiedRecords.map((a) => a.actionKind);
        const contractId = inferContract(verifiedRecords) ?? latest.contract_id;
        const decision = decideOutcome(contractId, evidence, verified, unsettled.length);
        if (decision.outcome === latest.outcome && decision.reasonCode === latest.reason_code) return { revised: false, outcome: latest.outcome, reasonCode: latest.reason_code, newlyVerified: null };
        // A call counts once as a verified resolution: here only when no EARLIER row of the call is RESOLVED
        // (not only the latest: a call resolved at call end, then recorded again without its receipt, is
        // restored to RESOLVED by this revision but was already counted). Read before this revision's insert.
        const alreadyResolved =
          isVerifiedResolution(decision.outcome) && (await tx.query<{ resolved: boolean }>(CALL_RESOLVED_SQL, [rec.callId])).rows[0]?.resolved === true;
        const outcomeId = newId("ioc");
        // Strictly later than the outcome it revises, so "latest" is unambiguous even with a frozen clock.
        const recordedAt = new Date(Math.max(now.getTime(), msOf(latest.recorded_at) + 1));
        await tx.query(
          `insert into interaction_outcomes (outcome_id, tenant_id, call_id, contract_id, outcome, reason_code, evidence, recorded_at, subject_ref)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [
            outcomeId,
            tenantId,
            rec.callId,
            contractId,
            decision.outcome,
            decision.reasonCode,
            JSON.stringify({
              ...evidence,
              verifiedCommittedKinds: verified,
              contractInferred: contractId !== null,
              unresolvedActionIds: unsettled,
              revision: { revises: latest.outcome_id, previousOutcome: latest.outcome, trigger: "ACTION_COMMITTED_AFTER_CALL_END", actionId },
            }),
            iso(recordedAt),
            // The revision keeps the subject of the outcome it revises (it is not a new contact).
            latest.subject_ref,
          ],
        );
        await this.deps.audit.append(
          tx,
          buildAuditInput(
            {
              tenantId,
              correlationId: outcomeId,
              sourceComponent: "gateway",
              action: "interaction.outcome_revised",
              outcome: "SUCCEEDED",
              callId: rec.callId,
              evidencePointers: [`db://interaction_outcomes/${outcomeId}`, `db://interaction_outcomes/${latest.outcome_id}`, `receipt:${receiptId}`],
              reasonCode: decision.reasonCode,
              versions: this.deps.versions,
            },
            this.deps.clock,
          ),
        );
        const newlyVerified = isVerifiedResolution(decision.outcome) && !alreadyResolved ? { intent: intentOf(contractId) } : null;
        return { revised: true, outcome: decision.outcome, reasonCode: decision.reasonCode, newlyVerified };
      },
      // interaction_outcomes accepts inserts from the runtime role only (migration 0300); the revision is the
      // outcome service's own write, in the tenant's RLS context.
      { role: "app_runtime", rls: { tenantId } },
    );
    if (result.revised) this.deps.logger.info("business.outcome.revised", { reasonCode: result.reasonCode, outcome: result.outcome ?? null });
    if (result.newlyVerified) this.deps.metrics.increment("vsp_verified_resolutions_total", { ...result.newlyVerified, source: "reconciliation" });
    return { revised: result.revised, outcome: result.outcome, reasonCode: result.reasonCode };
  }
}
