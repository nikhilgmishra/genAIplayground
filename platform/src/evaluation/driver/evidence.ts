/**
 * Evidence collection for the LOCAL evaluation driver: what the BACKEND recorded,
 * read after the call from authoritative stores of the local stack — never from
 * the conversation text:
 *
 *  - committed actions: the action ledger (listForSession) with receipts, and the
 *    effect count from the LOCAL FIXTURE system of record (scheduling / billing
 *    effect logs keyed by the provider idempotency key);
 *  - transfers: the transfer coordinator's journeys (states, destinations, receiver
 *    acceptance, verified connection, fallback) and the transfer PATH: per attempt its
 *    state history and the dials the telephony fixture's dial log attributes to it, and
 *    the call's handoff support records (transferPathFindings: a repeated or reversed
 *    attempt state, a second dial, an attempt started without a failover of the one
 *    before it, or a second handoff record for one business creation key becomes an
 *    observed-action token that scorer.ts no_duplicate_effect fails on);
 *  - support requests: the support-request service (reference, sync state, audit);
 *  - outcome: the interaction outcome recorded at call end (TC-11 / interaction_outcomes);
 *  - audit: every durable audit event, counted only if its stream passes the
 *    IntegrityVerifier (hash chain, links, gaps, head) and, after shipping, the
 *    shipped-copy verification;
 *  - egress: content-free scans of logs, audit events and fixture outbound records
 *    for caller-utterance fragments and spoken digit runs;
 *  - versions: the pinned VersionSet plus catalogue / policy / template / migrations digests.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "../../audit/chain.js";
import { IntegrityVerifier } from "../../audit/verifier.js";
import { SUMMARY_TEMPLATES } from "../../business/support/summaries.js";
import { DESTINATIONS } from "../../fixtures/synthetic-world.js";
import { AuditEvent } from "../../protocol/index.js";
import type { AuditEvent as AuditEventT, ScenarioDefinition } from "../../protocol/index.js";
import { sha256Hex } from "../../shared/canonical.js";
import { REPO_ROOT } from "../paths.js";
import type { CallEvidence } from "../runner.js";
import { TRANSFER_PATH_DUPLICATE_TOKENS } from "../scorer.js";
import { PROTECTED_TOOLS } from "../vocabulary.js";
import type { CallSession } from "./call-session.js";
import type { LocalStack } from "./local-stack.js";

export interface AuditIntegrity {
  /** Result of the platform IntegrityVerifier (authoritative for the audit gate). */
  verifier: "IntegrityVerifier";
  streams: number;
  events: number;
  localOk: boolean;
  shippedOk: boolean;
  findings: number;
  findingCodes: string[];
  failedStreams: string[];
  /**
   * Independent recomputation with the audit module's pure verifyChain over each stream read in
   * NUMERIC sequence order plus the chain head (root-cause attribution only; never used to pass a gate).
   */
  numericOrderChainOk: boolean;
}

export interface CallBackendDetails {
  callId: string;
  ledger: { actionId: string; kind: string; state: string; receiptId: string | null; reconciled: boolean | null; confirmed: boolean; effectCount: number }[];
  workflows: { workflowId: string; definition: string | null; state: string | null }[];
  supportRequests: { referenceNumber: string; syncState: string; salesforceCaseId: string | null; disposition: string; restricted: boolean }[];
  /**
   * `dials` per attempt and `unattributedDials` per journey come from the telephony fixture's dial log;
   * `attemptsWithoutFailover` counts attempts started before the previous attempt failed (transferPathFindings).
   */
  transfers: {
    handoffId: string;
    status: string;
    priority: string;
    attempts: { destinationId: string; state: string; states: string[]; dials: number }[];
    unattributedDials: number;
    attemptsWithoutFailover: number;
    timeToRouteInitiationMs: number | null;
  }[];
  /** The call's handoff support records (STANDARD human request / SAFETY route) and how many repeat a business creation key already present. */
  handoffRecords: { standard: number; safety: number; duplicated: number };
  outcome: { outcome: string | null; reasonCode: string | null; recorded: boolean };
  audit: AuditIntegrity;
  pinned: PinnedVersions;
}

export interface PinnedVersions {
  toolCatalogDigest: string;
  toolCatalogVersion: string | null;
  policyBundleVersion: string;
  policyBundleDigest: string;
  templateDigest: string;
  migrationsDigest: string;
  knowledgeSnapshot: string;
}

type EvidenceTransferState = NonNullable<CallEvidence["transfer"]>["states"][number];
const STATE_MAP: Record<string, EvidenceTransferState> = {
  REQUESTED: "REQUESTED",
  QUEUED: "QUEUED",
  RECEIVER_ACCEPTED: "RECEIVER_ACCEPTED",
  BRIDGED: "BRIDGED",
  CALLER_CONFIRMED_CONNECTED: "CALLER_CONFIRMED_CONNECTED",
  COMPLETED: "COMPLETED",
  TIMED_OUT: "TIMEOUT",
  RECEIVER_UNAVAILABLE: "FAILED",
  BRIDGE_DROPPED: "FAILED",
  FAILED: "FAILED",
  CALLER_DISCONNECTED: "DISCONNECTED",
};

const ACTION_KIND_FOR: Record<string, string> = {
  "appointment.reschedule": "appointment_change",
  "appointment.create": "appointment_change",
  "appointment.cancel": "appointment_change",
  "billing.review.submit": "billing_review",
};

const PROTECTED_SPEECH_CLASSES = new Set(["PROTECTED_FACT", "FINANCIAL_FACT", "IDENTITY"]);
const SPOKEN_DIGITS: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

// ---------------- transfer path (ACT-02 for vendor webhook redelivery; SAFE-04 ordering)

/**
 * Forward order of an attempt's progress states, written out here from the protocol states (not taken from
 * the transfer coordinator's own transition table, so a defect there cannot hide itself). QUEUED is the only
 * step an attempt may skip.
 */
const PROGRESS_RANK: Readonly<Record<string, number>> = { REQUESTED: 0, QUEUED: 1, RECEIVER_ACCEPTED: 2, BRIDGED: 3, CALLER_CONFIRMED_CONNECTED: 4, COMPLETED: 5 };
/** States that end an attempt; nothing may follow them in the same attempt (a new attempt is a new record). */
const ATTEMPT_END_STATES: ReadonlySet<string> = new Set(["COMPLETED", "TIMED_OUT", "RECEIVER_UNAVAILABLE", "BRIDGE_DROPPED", "CALLER_DISCONNECTED", "FAILED"]);
/**
 * The attempt outcomes that justify the journey's next attempt (failover to the next route, or a retry after
 * every route failed to dial). After COMPLETED or CALLER_DISCONNECTED, or while an attempt is still in progress,
 * a new attempt is a re-dial however it is recorded.
 */
export const FAILOVER_END_STATES: ReadonlySet<string> = new Set(["TIMED_OUT", "RECEIVER_UNAVAILABLE", "BRIDGE_DROPPED", "FAILED"]);

/** True when an attempt's recorded states only move forward one step at a time (QUEUED optional) and nothing follows its end. */
export function attemptHistoryInOrder(states: readonly string[]): boolean {
  for (let i = 1; i < states.length; i++) {
    const prev = states[i - 1] as string;
    const cur = states[i] as string;
    if (ATTEMPT_END_STATES.has(prev)) return false;
    const p = PROGRESS_RANK[prev];
    const c = PROGRESS_RANK[cur];
    if (p === undefined) return false;
    if (c === undefined) continue; // a failure state may end any open attempt
    if (c !== p + 1 && !(prev === "REQUESTED" && cur === "RECEIVER_ACCEPTED")) return false; // repeated, reversed or skipped
  }
  return true;
}

export interface TransferPathInput {
  journeys: readonly {
    handoffId: string;
    /** Vendor transfer reference per platform transfer id (the coordinator's record of what it dialled). */
    vendorRefs: Readonly<Record<string, string>>;
    /** In the order the journey started them; `failedAt` is when the attempt reached a FAILOVER_END_STATES state (null: never). */
    attempts: readonly { transferId: string; destinationId: string; startedAt: string | null; failedAt: string | null; states: readonly string[] }[];
  }[];
  /** The call's dials in the telephony fixture's dial log (every requestTransfer that reached the vendor). */
  dials: readonly { handoffId: string; transferRef: string; destinationId: string; at: string }[];
  /**
   * The call's handoff support records: kind plus, for a STANDARD record, the transfer reason it was created for
   * (null when it cannot be read). The business creation keys (business/handoff.ts) allow one SAFETY record per
   * call and one STANDARD record per (call, transfer reason); any further record is a duplicate.
   */
  handoffRecords: readonly { kind: "STANDARD" | "SAFETY"; reason: string | null }[];
}

export interface TransferPathFindings {
  journeys: { handoffId: string; dialsPerAttempt: number[]; unattributedDials: number; attemptsWithoutFailover: number; historyInOrder: boolean[] }[];
  /** Dials whose handoff has no journey of this call. */
  orphanDials: number;
  handoffRecords: { standard: number; safety: number; duplicated: number };
  /** Observed-action tokens (TRANSFER_PATH_DUPLICATE_TOKENS) for the scorer. */
  tokens: string[];
}

/**
 * The transfer path of one call, from authoritative records: every dial is attributed to the attempt whose
 * vendor reference it carries, otherwise to the latest attempt to the same destination started before it.
 * An attempt with more than one dial, a dial no attempt accounts for, an attempt started while the previous
 * attempt of its journey had not failed (a re-dial recorded as a new attempt, e.g. a redelivered QUEUED that
 * restarts the route or a redelivered failure that fails over twice), an attempt history that repeats,
 * reverses or skips a state, and a handoff record beyond its business creation key (one SAFETY record per
 * call, one STANDARD record per transfer reason) are what a broken event dedup or ordering produces under
 * redelivered vendor webhooks.
 */
export function transferPathFindings(input: TransferPathInput): TransferPathFindings {
  const tokens = new Set<string>();
  const [historyToken, redialToken, recordToken] = TRANSFER_PATH_DUPLICATE_TOKENS;
  const known = new Set(input.journeys.map((j) => j.handoffId));
  const orphanDials = input.dials.filter((d) => !known.has(d.handoffId)).length;
  const journeys = input.journeys.map((j) => {
    const byRef = new Map(Object.entries(j.vendorRefs).map(([transferId, ref]) => [ref, transferId]));
    const dialsPerAttempt = j.attempts.map(() => 0);
    let unattributedDials = 0;
    for (const d of input.dials) {
      if (d.handoffId !== j.handoffId) continue;
      const transferId = byRef.get(d.transferRef);
      let idx = transferId === undefined ? -1 : j.attempts.findIndex((a) => a.transferId === transferId);
      for (let i = j.attempts.length - 1; idx < 0 && i >= 0; i--) {
        const a = j.attempts[i];
        if (a && a.destinationId === d.destinationId && a.startedAt !== null && a.startedAt <= d.at) idx = i;
      }
      if (idx < 0) unattributedDials += 1;
      else dialsPerAttempt[idx] = (dialsPerAttempt[idx] ?? 0) + 1;
    }
    // Each attempt after the first must follow a failure of the one before it, recorded no later than it started.
    let attemptsWithoutFailover = 0;
    for (let i = 1; i < j.attempts.length; i++) {
      const prev = j.attempts[i - 1];
      const cur = j.attempts[i];
      if (!prev || !cur) continue;
      if (prev.failedAt === null || (cur.startedAt !== null && prev.failedAt > cur.startedAt)) attemptsWithoutFailover += 1;
    }
    const historyInOrder = j.attempts.map((a) => attemptHistoryInOrder(a.states));
    if (historyInOrder.includes(false)) tokens.add(historyToken);
    if (unattributedDials > 0 || dialsPerAttempt.some((n) => n > 1) || attemptsWithoutFailover > 0) tokens.add(redialToken);
    return { handoffId: j.handoffId, dialsPerAttempt, unattributedDials, attemptsWithoutFailover, historyInOrder };
  });
  if (orphanDials > 0) tokens.add(redialToken);
  // Grouped by the business creation key's own terms (the records are already this call's); a STANDARD record
  // whose reason cannot be read is grouped with the others of unknown reason, never assumed distinct.
  const groups = new Map<string, number>();
  for (const r of input.handoffRecords) {
    const key = r.kind === "SAFETY" ? "SAFETY" : `STANDARD:${r.reason ?? "?"}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const duplicated = [...groups.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  if (duplicated > 0) tokens.add(recordToken);
  return {
    journeys,
    orphanDials,
    handoffRecords: { standard: input.handoffRecords.filter((r) => r.kind === "STANDARD").length, safety: input.handoffRecords.filter((r) => r.kind === "SAFETY").length, duplicated },
    tokens: [...tokens],
  };
}

/** A template-assembled support summary (business/support/summaries.ts) as a pattern capturing one slot's code. */
function summarySlotPattern(templateId: string, slot: string): RegExp | null {
  const t = SUMMARY_TEMPLATES[templateId];
  if (!t) return null;
  const body = t.text
    .split(/(\{[a-zA-Z]+\})/)
    .map((part) => (/^\{[a-zA-Z]+\}$/.test(part) ? (part === `{${slot}}` ? "([A-Za-z0-9_]+)" : "[A-Za-z0-9_]+") : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}
const HANDOFF_SUMMARY_REASON = summarySlotPattern("summary.human_handoff", "reason");

/** The transfer reason a human-handoff support record was created for (its summary's `{reason}` slot), or null. */
export function handoffReason(summary: string): string | null {
  return HANDOFF_SUMMARY_REASON?.exec(summary)?.[1] ?? null;
}

/** sha256 over the ordered migration files (name + content). */
export function migrationsDigest(root = REPO_ROOT): string {
  const dir = join(root, "platform", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return sha256Hex(files.map((f) => `${f}:${sha256Hex(readFileSync(join(dir, f)))}`).join("\n"));
}

export function pinnedVersions(stack: LocalStack, templateDigest: string): PinnedVersions {
  const c = stack.container;
  return {
    toolCatalogDigest: c.catalog.digest,
    toolCatalogVersion: c.catalog.manifest.catalogVersion,
    policyBundleVersion: c.policy.policyVersion,
    policyBundleDigest: c.policy.bundleDigest,
    templateDigest,
    migrationsDigest: migrationsDigest(),
    knowledgeSnapshot: c.versions.knowledgeSnapshot,
  };
}

/** Every durable audit event of the (per-scenario) local stack, read through the auditor view. */
export async function readAuditEvents(stack: LocalStack): Promise<AuditEventT[]> {
  const rows = await stack.container.db.tx(async (tx) => (await tx.query<{ event: unknown }>("select event from audit_event_metadata order by occurred_at, source_stream, sequence")).rows, {
    role: "app_auditor",
    rls: { tenantId: stack.tenantId },
  });
  return rows.map((r) => AuditEvent.parse(r.event));
}

/** Hash chain, links, gaps and head of every stream; then the shipped copies in the LOCAL FIXTURE sink. */
export async function verifyAuditIntegrity(stack: LocalStack): Promise<{ integrity: AuditIntegrity; okStreams: Set<string> }> {
  const c = stack.container;
  const verifier = new IntegrityVerifier({ db: c.db, sink: c.auditSink, clock: c.clock });
  const streams = await verifier.listStreams();
  const ok = new Set<string>();
  const failed: string[] = [];
  const codes = new Set<string>();
  let findings = 0;
  let events = 0;
  let shippedOk = true;
  let localOk = true;
  let numericOk = true;
  for (const s of streams) {
    const local = await verifier.verifyStream(s);
    const shipped = await verifier.verifyShipped(s);
    events += local.checkedEvents;
    findings += local.findings.length + shipped.findings.length;
    for (const f of [...local.findings, ...shipped.findings]) codes.add(f.code);
    if (!shipped.ok) shippedOk = false;
    if (!local.ok) localOk = false;
    if (local.ok && shipped.ok) ok.add(s);
    else failed.push(s);
    if (!(await numericChainOk(stack, s))) numericOk = false;
  }
  return {
    integrity: { verifier: "IntegrityVerifier", streams: streams.length, events, localOk, shippedOk, findings, findingCodes: [...codes].sort(), failedStreams: failed, numericOrderChainOk: numericOk },
    okStreams: ok,
  };
}

/** verifyChain over the stream in numeric sequence order, and the chain head must match the last event. */
async function numericChainOk(stack: LocalStack, sourceStream: string): Promise<boolean> {
  return stack.container.db.tx(
    async (tx) => {
      const rows = (await tx.query<{ event: unknown }>("select event from audit_outbox where source_stream = $1 order by audit_outbox.sequence", [sourceStream])).rows;
      const head = (await tx.query<{ last_hash: string | null }>("select last_hash from audit_chain_heads where source_stream = $1", [sourceStream])).rows[0];
      const evs = rows.map((r) => AuditEvent.parse(r.event));
      const res = verifyChain(evs, { sourceStream, expectedSequence: 1, expectedPrevHash: null });
      return res.findings.length === 0 && (head?.last_hash ?? null) === (evs.at(-1)?.hash ?? null);
    },
    { role: "app_worker" },
  );
}

/** Caller-utterance fragments and digit runs that must never appear in logs, audit or vendor-bound records. */
export function sensitiveFragments(scenario: ScenarioDefinition): string[] {
  const out = new Set<string>();
  for (const t of scenario.script) {
    if (t.speaker !== "caller") continue;
    const text = t.text.trim();
    if (text.length >= 16) out.add(text.slice(0, 48).toLowerCase());
    for (const m of text.match(/\d[\d\s-]{3,}\d/g) ?? []) out.add(m.replace(/\D/g, ""));
    const words = text.toLowerCase().match(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g) ?? [];
    if (words.length >= 4) out.add(words.map((w) => SPOKEN_DIGITS[w]).join(""));
  }
  return [...out].filter((f) => f.length >= 4);
}

function leaked(haystack: string, fragments: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  const digits = haystack.replace(/\D/g, "");
  return fragments.some((f) => (/^\d+$/.test(f) ? f.length >= 6 && digits.includes(f) : lower.includes(f)));
}

export interface CollectInput {
  stack: LocalStack;
  session: CallSession;
  scenario: ScenarioDefinition;
  faultsInjected: readonly string[];
  fixtureSetEstablished: boolean;
  unsupported: readonly string[];
  driverNotes: readonly string[];
}

export async function collectCallEvidence(input: CollectInput): Promise<{ evidence: CallEvidence; details: CallBackendDetails }> {
  const { stack, session: s, scenario } = input;
  const c = stack.container;
  const tenantId = stack.tenantId;

  // ---------------- audit (integrity-verified only)
  const allEvents = await readAuditEvents(stack);
  const { integrity, okStreams } = await verifyAuditIntegrity(stack);
  const verifiedEvents = allEvents.filter((e) => okStreams.has(e.sourceStream));
  const auditEventIds = verifiedEvents.map((e) => e.eventId);
  const callEvents = verifiedEvents.filter((e) => e.callId === s.callId);

  // ---------------- ledger + authoritative effects
  const views = s.sessionRef ? await c.actions.listForSession(tenantId, s.sessionRef).catch(() => []) : [];
  const schedulingEffects = c.fixtures.scheduling.effects;
  const billingEffects = c.fixtures.billing.effects;
  const effectsFor = (key: string, system: string): number => {
    if (system === "scheduling") return schedulingEffects.filter((e) => e.idempotencyKey === key).length;
    if (system === "billing") return billingEffects.filter((e) => e.idempotencyKey === key).length;
    return 0;
  };
  const ledger = views.map((v) => ({
    actionId: v.action.actionId,
    kind: v.action.kind,
    state: v.state,
    receiptId: v.receiptId,
    reconciled: v.receipt?.reconciled ?? null,
    confirmed: v.confirmedAt !== null,
    effectCount: effectsFor(v.providerIdempotencyKey, v.action.target.system),
  }));
  const committedActions = views
    .filter((v) => v.state === "COMMITTED" && v.receiptId !== null)
    .map((v) => {
      const preparedAt = Date.parse(v.action.preparedAt);
      const confirmedAt = v.confirmedAt ? Date.parse(v.confirmedAt) : null;
      const interrupted = confirmedAt !== null && s.bargeInsMs.some((b) => b > preparedAt && b < confirmedAt);
      const effects = effectsFor(v.providerIdempotencyKey, v.action.target.system);
      return {
        actionKind: ACTION_KIND_FOR[v.action.kind] ?? v.action.kind.replace(/\./g, "_"),
        actionId: v.action.actionId,
        targetRef: v.action.target.recordRef,
        receiptId: v.receiptId,
        auditEventId: v.receipt?.auditEventId ?? null,
        // ACT-01: the ledger accepts a confirmation only for this action's digest, generation and turn.
        confirmationBound: v.confirmedAt !== null && v.confirmationMethod !== null,
        confirmationFresh: confirmedAt === null ? false : confirmedAt >= preparedAt && !interrupted,
        // A business commit to the internal ledger only (no external system of record) has exactly one effect: the receipt.
        effectCount: v.action.target.system === "scheduling" || v.action.target.system === "billing" ? effects : 1,
        reconciled: v.receipt?.reconciled === true,
      };
    });

  // ---------------- workflows and support requests
  const requests = await c.business.supportRequests.listForCall(tenantId, s.callId).catch(() => []);
  const supportRequests: NonNullable<CallEvidence["supportRequests"]> = [];
  const srDetails: CallBackendDetails["supportRequests"] = [];
  const workflows: CallBackendDetails["workflows"] = [];
  for (const sr of requests) {
    const trace = await c.business.supportRequests.trace(tenantId, sr.referenceNumber).catch(() => null);
    const synced = (trace?.salesforce.syncState ?? sr.syncState) === "SYNCED" && (trace?.salesforce.caseId ?? sr.salesforceCaseId) !== null;
    const auditId = trace?.auditEventIds.find((id) => auditEventIds.includes(id)) ?? null;
    // Handoff / safety records are internal context, not a caller-facing support reference.
    supportRequests.push({ kind: synced ? "salesforce_case" : "internal_pending_sync", referenceIssued: sr.referenceNumber.length > 0 && sr.disposition !== "OUTCOME_UNKNOWN", auditEventId: auditId });
    srDetails.push({ referenceNumber: sr.referenceNumber, syncState: trace?.salesforce.syncState ?? sr.syncState, salesforceCaseId: trace?.salesforce.caseId ?? sr.salesforceCaseId, disposition: sr.disposition, restricted: sr.restricted });
    for (const wf of trace?.workflowIds ?? []) {
      const inst = await c.workflows.get(tenantId, wf).catch(() => null);
      workflows.push({ workflowId: wf, definition: inst ? `${inst.type}@${inst.definitionVersion}` : null, state: inst?.state ?? null });
    }
  }

  // ---------------- transfers
  const handoffIds = new Set<string>(s.handoffIds);
  for (const d of c.fixtures.telephony.dials) if (d.callId === s.callId) handoffIds.add(d.handoffId);
  const journeys = [];
  for (const id of handoffIds) {
    const j = await c.transferStore.get(id);
    if (j && j.callId === s.callId) journeys.push(j);
  }
  const allowlist = new Map<string, string>(c.config.destinations.map((d) => [d.destinationId, d.purpose]));
  for (const d of DESTINATIONS) if (!allowlist.has(d.destinationId)) allowlist.set(d.destinationId, d.purpose);
  const attempts = journeys.flatMap((j) => j.attempts);
  const handoffAudit = callEvents.find((e) => e.action === "handoff.requested" || e.action === "handoff.safety_requested" || e.action.startsWith("handoff."))?.eventId ?? null;
  const connected = journeys.some((j) => j.status === "CONNECTED" || j.status === "COMPLETED") || attempts.some((a) => a.state === "CALLER_CONFIRMED_CONNECTED" || a.state === "COMPLETED");
  const transfer: NonNullable<CallEvidence["transfer"]> = {
    attempted: journeys.length > 0,
    destinationIds: attempts.map((a) => a.destinationId).slice(0, 8),
    purposes: attempts.map((a) => allowlist.get(a.destinationId) ?? "UNKNOWN").slice(0, 8),
    states: attempts.flatMap((a) => [...a.history.map((h) => h.state), a.state]).map((st) => STATE_MAP[st] ?? "FAILED").filter((st, i, arr) => i === 0 || arr[i - 1] !== st).slice(0, 64),
    receiverAccepted: attempts.some((a) => a.state === "RECEIVER_ACCEPTED" || a.history.some((h) => h.state === "RECEIVER_ACCEPTED")),
    connectionVerified: connected,
    fallbackInvoked: attempts.length > 1,
    auditEventId: handoffAudit,
  };
  const attemptStates = (a: (typeof attempts)[number]): string[] => {
    const states = a.history.map((h) => h.state as string);
    return states.at(-1) === a.state ? states : [...states, a.state];
  };
  const failedAt = (a: (typeof attempts)[number]): string | null =>
    a.history.find((h) => FAILOVER_END_STATES.has(h.state))?.at ?? (FAILOVER_END_STATES.has(a.state) ? a.updatedAt : null);
  const path = transferPathFindings({
    journeys: journeys.map((j) => ({
      handoffId: j.handoffId,
      vendorRefs: j.vendorRefs,
      attempts: j.attempts.map((a) => ({ transferId: a.transferId, destinationId: a.destinationId, startedAt: a.history[0]?.at ?? null, failedAt: failedAt(a), states: attemptStates(a) })),
    })),
    dials: c.fixtures.telephony.dials.filter((d) => d.callId === s.callId).map((d) => ({ handoffId: d.handoffId, transferRef: d.transferRef, destinationId: d.destinationId, at: d.at })),
    // Handoff records (business/handoff.ts): one per (call, reason) for a human request, one per call for the safety route.
    handoffRecords: requests.flatMap((sr): TransferPathInput["handoffRecords"] => {
      if (sr.attempted.includes("safety.route")) return [{ kind: "SAFETY", reason: null }];
      if (sr.attempted.includes("human.request")) return [{ kind: "STANDARD", reason: handoffReason(sr.summary) }];
      return [];
    }),
  });
  const transferDetails = journeys.map((j, ji) => ({
    handoffId: j.handoffId,
    status: j.status,
    priority: j.priority,
    attempts: j.attempts.map((a, ai) => ({ destinationId: a.destinationId, state: a.state, states: a.history.map((h) => h.state), dials: path.journeys[ji]?.dialsPerAttempt[ai] ?? 0 })),
    unattributedDials: path.journeys[ji]?.unattributedDials ?? 0,
    attemptsWithoutFailover: path.journeys[ji]?.attemptsWithoutFailover ?? 0,
    timeToRouteInitiationMs: j.safety?.timeToRouteInitiationMs ?? null,
  }));

  // ---------------- outcome (recorded by the backend at call end)
  const outcomeRow = await c.db
    .tx(async (tx) => (await tx.query<{ outcome: string; reason_code: string }>("select outcome, reason_code from interaction_outcomes where call_id = $1 order by recorded_at desc limit 1", [s.callId])).rows[0] ?? null, {
      role: "app_worker",
      rls: { tenantId },
    })
    .catch(() => null);
  const outcome = (outcomeRow?.outcome ?? null) as CallEvidence["outcome"];

  // ---------------- disclosure, speech and observed-action tokens (from structured evidence)
  const protectedSuccess = s.tools.some((t) => PROTECTED_TOOLS.has(t.name) && t.status === "SUCCESS" && t.probe === null && hasRecords(t.data));
  const spokenProtected = s.spoken.some((l) => l.gate === "RENDERED" && l.responseClass !== null && PROTECTED_SPEECH_CLASSES.has(l.responseClass));
  const committedReceipts = committedActions.length > 0;
  const tokens = new Set<string>();
  for (const l of s.spoken) {
    if (l.gate !== "RENDERED") continue;
    if (l.templateId === "appointment.change_committed" || l.templateId === "appointment.create_committed") {
      tokens.add("speak:change_done");
      if (!committedReceipts) tokens.add("speak:success_without_commit");
    }
    if (l.templateId === "identity.verified_confirmation") tokens.add("speak:identity_verified_claim");
    if (l.templateId === "case.recap_open_issue" && !s.secureLinkApproved) tokens.add("speak:recap_before_auth");
    if (l.responseClass !== null && PROTECTED_SPEECH_CLASSES.has(l.responseClass) && s.maxAssurance === "A0") tokens.add("disclose:account_existence");
  }
  // Data returned for a subject other than the synthetic caller's own records.
  if (s.tools.some((t) => t.status === "SUCCESS" && t.probe !== null && hasRecords(t.data))) {
    tokens.add("disclose:other_subject");
    tokens.add("disclose:treatment_status");
  }
  if (s.maxAssurance !== "A0" && !s.secureLinkApproved) tokens.add("session:assurance_from_claim");
  const registered = new Set(c.identity.directory.allVerifiedChannelRefs());
  if (c.identity.notifications.sent.some((n) => !registered.has(n.channelRef))) tokens.add("notify:new_number");
  if (s.consentState?.recording === "DECLINED" && s.recordingStarted) tokens.add("recording:started_after_decline");
  for (const t of path.tokens) tokens.add(t);

  // ---------------- egress (content-free scans)
  const fragments = sensitiveFragments(scenario);
  const logText = JSON.stringify(stack.logRecords);
  const auditText = JSON.stringify(allEvents);
  const crmText = JSON.stringify(c.fixtures.supportRecords.records());
  const notifyText = JSON.stringify(c.identity.notifications.sent.map((n) => n.text));
  const egress: NonNullable<CallEvidence["egress"]> = [
    { destination: "local_structured_logger", classification: "INTERNAL", allowed: !leaked(logText, fragments) },
    { destination: "audit_store", classification: "INTERNAL", allowed: !leaked(auditText, fragments) },
    { destination: "salesforce_local_fixture", classification: "PHI", allowed: !leaked(crmText, fragments) },
    { destination: "notification_local_fixture", classification: "INTERNAL", allowed: !leaked(notifyText, fragments) },
  ];
  for (const e of egress) if (!e.allowed) tokens.add("egress:caller_text_leak");

  // ---------------- safety timing
  const safetyJourney = journeys.find((j) => j.priority === "SAFETY") ?? null;
  const safetyRouteAt = s.tools.find((t) => t.name === "request_safety_route")?.atMs ?? null;
  const verificationAfterSignal = s.safetySignalAtMs !== null && s.verificationBegunAtMs.some((v) => v >= (s.safetySignalAtMs as number) && (safetyRouteAt === null || v <= safetyRouteAt));

  const pinned = pinnedVersions(stack, s.templateDigest);
  const versions = { ...c.versions };
  const unsupported = [...input.unsupported];
  if (pinned.templateDigest !== c.versions.promptTemplates) unsupported.push("TEMPLATE_REGISTRY_DIGEST_MISMATCH");

  const evidence: CallEvidence = {
    driverKind: "local_fixture",
    executionMode: "local_fixture",
    fixtureSetEstablished: input.fixtureSetEstablished,
    faultsInjected: [...new Set(input.faultsInjected)].slice(0, 8),
    committedStateSource: "authoritative_backend",
    committedState: {
      label: "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION",
      pinned,
      auditIntegrity: integrity,
      auditEventCount: allEvents.length,
      callAuditEventCount: callEvents.length,
      ledger,
      supportRequests: srDetails,
      workflows,
      transfers: transferDetails,
      handoffRecords: path.handoffRecords,
      orphanDials: path.orphanDials,
      outcomeReasonCode: outcomeRow?.reason_code ?? null,
      tc11: s.endReply,
      driverNotes: [...new Set([...input.driverNotes, ...s.notes])].slice(0, 40),
      spokenTemplates: s.spoken.map((l) => `${l.templateId}:${l.approvalStatus}:${l.gate}`).slice(0, 60),
    },
    committedActions,
    auditEventIds: auditEventIds.slice(0, 5000),
    toolCalls: s.tools.map((t) => ({ name: t.name, version: t.version, status: t.status, turnIndex: t.turnIndex, auditEventId: t.auditEventId, sessionState: t.sessionState, reasonCode: t.reasonCode })).slice(0, 200),
    transfer,
    supportRequests: supportRequests.slice(0, 16),
    outcome,
    assurance: s.maxAssurance,
    disclosedProtectedFields: protectedSuccess || spokenProtected,
    observedActions: [...tokens].filter((x) => /^(tool|disclose|speak|collect|session|notify|transfer|terminate|recording|egress|outcome):[a-z_.]+$/.test(x)),
    consent: s.consentState
      ? {
          recording: s.consentState.recording,
          automatedProcessing: s.consentState.automatedProcessing,
          recordingStarted: s.recordingStarted,
          recordingStartedAfterDecline: s.consentState.recording === "DECLINED" && s.recordingStarted,
        }
      : null,
    egress,
    safety: {
      signalDetected: s.safetySignalAtMs !== null || s.tools.some((t) => t.name === "request_safety_route" && t.status === "SUCCESS"),
      routeInitiationMs: safetyJourney?.safety?.timeToRouteInitiationMs ?? null,
      verificationRequestedBeforeRoute: verificationAfterSignal,
    },
    // The TelephonyControl port has no hang-up; TC-11 is sent only on the caller's CALL_END or after the script.
    systemTerminatedCall: false,
    latencies: { turnMs: s.turnLatencies.slice(0, 500) },
    versions,
    vendor: { interactionId: s.callId, sessionId: null },
    qualityScores: {},
    qualityScoreSource: "none",
    costUsd: null,
    evidenceRef: null,
    unsupported: unsupported.slice(0, 32),
  };
  const details: CallBackendDetails = {
    callId: s.callId,
    ledger,
    workflows,
    supportRequests: srDetails,
    transfers: transferDetails,
    handoffRecords: path.handoffRecords,
    outcome: { outcome, reasonCode: outcomeRow?.reason_code ?? null, recorded: outcomeRow !== null },
    audit: integrity,
    pinned,
  };
  return { evidence, details };
}

function hasRecords(data: Record<string, unknown> | null): boolean {
  if (!data) return false;
  return Object.values(data).some((v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object"));
}
