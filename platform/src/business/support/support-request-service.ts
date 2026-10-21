/**
 * Internal support requests with asynchronous Salesforce synchronization
 * (spec section 8 "Salesforce behavior"; ACT-02, ACT-04, OPS-01, SPEC-8.4).
 *
 * create():
 *   one transaction: interaction row (one per call, many issues), support request
 *   row, outbox "support_request.sync" message and audit event. The caller is given
 *   the internal SR-XXXX-XXXX reference, which is a support reference pending
 *   synchronization, never a Salesforce Case number.
 *
 * handleSyncMessage():
 *   phase A (consumer-dedup transaction): claim the row (SYNCING, attempt+1);
 *   phase B (no transaction open): idempotent upsertInteraction / upsertCase by the
 *   interaction and issue external ids;
 *   phase C: settle by claim token -> SYNCED, RETRY_SCHEDULED (bounded attempts,
 *   exponential backoff) or DEAD_LETTER (operator repair). The customer's request is
 *   never lost: the internal row persists whatever Salesforce does.
 *   Kill switches (OPS-KS-02): the composition gives this service a SupportRecordSystem
 *   gated by INTEGRATION <salesforce> / WRITES (ops/integration-gate.ts). The hold is
 *   checked BEFORE the claim: a held sync makes no state transition and spends no
 *   attempt; the row records last_sync_reason KILL_SWITCH_* and a next check time
 *   (audited as support_request.sync_held) and the retry sweep re-enqueues it after the
 *   switch is released. A switch engaged between that check and the vendor call
 *   (IntegrationHeldError, nothing reached Salesforce) settles RETRY_SCHEDULED and is
 *   never dead-lettered.
 *   Restricted records (privacy / safety) are synchronized only as a MINIMAL restricted
 *   Case (fixed summary, no attempted steps or receipts, restricted=true) so they never
 *   appear as broadly visible Cases.
 *
 * observeCaseStatus() (reopened cases, spec section 13; SPEC-13.resolution-metrics):
 *   the synchronization never reads a Case back, so a reopening is measured where the platform
 *   READS the Case status: the vendor status is mapped to OPEN / CLOSED by the configured
 *   CaseStateMapping (placeholder maps nothing until PRQ-006), a support_case_observations row
 *   (migration 0302) is appended only on a change, and CLOSED -> OPEN is audited and counted
 *   (vsp_cases_reopened_total). No schedule calls it yet (Salesforce change feed or a bounded poll
 *   within the API allocation: PRQ-006, VQ-SF-07).
 *
 * Every external call happens outside an open database transaction.
 */
import { z } from "zod";
import type { AuditWriter, AuditQuery } from "../../audit/ports.js";
import { buildAuditInput } from "../../audit/build-input.js";
import type { Db, Queryable } from "../../db/types.js";
import type { SupportMemory } from "../../memory/ports.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import { noopMetrics } from "../../observability/metrics.js";
import type { Outbox } from "../../outbox/ports.js";
import { PgConsumerDedup } from "../../outbox/consumer-dedup.js";
import type { CaseFields, SupportRecordSystem } from "../../adapters/ports.js";
import {
  IssueCategory,
  OpaqueId,
  Outcome,
  SupportReference,
  SupportRequest,
  VersionSet,
} from "../../protocol/index.js";
import type {
  AuthContext,
  ConsentState,
  IssueCategory as IssueCategoryT,
  Outcome as OutcomeT,
  Role,
  SupportRequest as SupportRequestT,
  VersionSet as VersionSetT,
} from "../../protocol/index.js";
import type { Clock } from "../../shared/clock.js";
import { addMs, iso } from "../../shared/clock.js";
import { sha256Hex } from "../../shared/canonical.js";
import { AccessDeniedError, ConflictError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId, newSupportReference } from "../../shared/ids.js";
import type { SupportRequestService, SupportRequestTrace, SupportRequestTraceOptions } from "../contract.js";
import { UNKNOWN_CONSENT, atLeast, auditSessionRef, consentStatusCode, durationMs, reasonOf } from "../shared.js";
import { assembleSummary } from "./summaries.js";
import { holdReasonOf, isIntegrationHeld } from "../../ops/integration-gate.js";

export const SUPPORT_SYNC_CONSUMER = "business.support_request.sync";

export interface SupportSyncPolicy {
  /** Attempts before DEAD_LETTER (operator repair). Engineering default pending operations approval. */
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** A SYNCING claim older than this is treated as a crashed worker and re-queued. */
  claimStaleSeconds: number;
}

export const DEFAULT_SUPPORT_SYNC_POLICY: SupportSyncPolicy = Object.freeze({
  maxAttempts: 6,
  baseBackoffMs: 30_000,
  maxBackoffMs: 900_000,
  claimStaleSeconds: 120,
});

/** Service deadline per issue category, from the resolution contracts (engineering defaults). */
const CATEGORY_DEADLINE: Partial<Record<IssueCategoryT, string>> = {
  billing_dispute: "P7D",
  partner_intake: "P5D",
  complaint: "P5D",
  privacy_concern: "P5D",
};

/** Phase-B failure; `held` = an INTEGRATION / WRITES kill switch stopped the call before Salesforce (OPS-KS-02). */
type SyncFailure = { reasonCode: string; permanent: boolean; held?: boolean };
const KILL_SWITCH_HOLD_REASONS: ReadonlySet<string> = new Set(["KILL_SWITCH_INTEGRATION", "KILL_SWITCH_WRITES", "KILL_SWITCH_STATE_UNAVAILABLE"]);

/** Default horizon of the recap memory entry when the contract has no deadline (engineering default). */
const DEFAULT_MEMORY_HORIZON = "P14D";

/** Salesforce Case Status values (exact picklist values) that mean the Case is open or closed. */
export interface CaseStateMapping {
  readonly open: readonly string[];
  readonly closed: readonly string[];
}

/**
 * PLACEHOLDER: maps nothing. The tenant's Case Status picklist and which values are closed are UNKNOWN
 * until the Salesforce administrator answers VQ-SF-04 (PRQ-006); until then every observation is
 * "unmapped" and no reopening can be recorded. Never guessed from Salesforce's default picklist.
 */
export const DEFAULT_CASE_STATE_MAPPING: CaseStateMapping = Object.freeze({ open: Object.freeze([]), closed: Object.freeze([]) });

const CaseStateMappingSchema = z
  .strictObject({ open: z.array(z.string().min(1).max(255)).max(64), closed: z.array(z.string().min(1).max(255)).max(64) })
  .refine((m) => !m.open.some((v) => m.closed.includes(v)), "CASE_STATE_MAPPING_OVERLAP");

/** Result of one Case status read (observeCaseStatus). */
export interface CaseStatusObservation {
  /** A mapped state was read from the system of record (changed or not). */
  observed: boolean;
  caseState: "OPEN" | "CLOSED" | "UNMAPPED" | null;
  /** The last recorded state was CLOSED and the Case is open again. */
  reopened: boolean;
  reasonCode: string;
}

export interface PgSupportRequestServiceOptions {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  outbox: Outbox;
  supportRecords: SupportRecordSystem;
  versions: VersionSetT;
  memory?: SupportMemory | null;
  auditQuery?: AuditQuery | null;
  logger?: Logger;
  metrics?: Metrics;
  sync?: Partial<SupportSyncPolicy>;
  /** Audit stream for this component. */
  auditStream?: string;
  /** Case Status mapping for reopened-case measurement (default DEFAULT_CASE_STATE_MAPPING: placeholder, maps nothing). */
  caseStates?: CaseStateMapping;
}

/** Everything a support request needs; identity fields come only from trusted server state. */
export interface SupportRequestRecordInput {
  tenantId: string;
  callId: string;
  audience: Role | null;
  subjectRef: string | null;
  organizationRef: string | null;
  actorRef: string | null;
  sessionRef: string | null;
  sessionGeneration: number | null;
  issueCategory: IssueCategoryT;
  disposition: OutcomeT;
  summaryTemplateId: string;
  summarySlots: Record<string, string>;
  attempted: string[];
  commitReceiptIds: string[];
  nextStep: string | null;
  restricted: boolean;
  priority: SupportRequestT["priority"];
  ownerQueue: string;
  language: string;
  consent: ConsentState;
  /** sha256 hex; a retried creation with the same key returns the original request. */
  creationKey: string | null;
  links?: { kind: "action" | "workflow"; ref: string }[];
}

const CreatePortInput = z.strictObject({
  tenantId: OpaqueId,
  callId: OpaqueId,
  issueCategory: IssueCategory,
  disposition: Outcome,
  summaryTemplateId: z.string().regex(/^summary\.[a-z][a-z0-9_.]{2,60}$/),
  summarySlots: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,40}$/), z.string().max(64)),
  attempted: z.array(z.string().regex(/^[a-z_.]{3,64}$/)).max(16),
  commitReceiptIds: z.array(OpaqueId).max(16),
  nextStep: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).nullable(),
  restricted: z.boolean(),
  priority: z.enum(["P1_SAFETY", "P2_URGENT", "P3_STANDARD", "P4_LOW"]),
  ownerQueue: z.string().regex(/^q_[a-z0-9_]{2,40}$/),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
});

const SyncPayload = z.strictObject({
  tenantId: OpaqueId,
  supportRequestId: z.string().regex(/^sr_[A-Za-z0-9_-]{16,64}$/),
  attempt: z.number().int().min(0).max(1000),
});

const MESSAGE_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

interface SrRow {
  support_request_id: string;
  tenant_id: string;
  reference_number: string;
  interaction_external_id: string;
  issue_external_id: string;
  call_id: string;
  audience: Role | null;
  subject_ref: string | null;
  organization_ref: string | null;
  issue_category: IssueCategoryT;
  disposition: OutcomeT;
  owner_queue: string;
  priority: SupportRequestT["priority"];
  summary: string;
  summary_provenance: SupportRequestT["summaryProvenance"];
  attempted: string[];
  commit_receipt_ids: string[];
  source_call_ids: string[];
  language: string;
  consent: ConsentState;
  next_step: string | null;
  deadline: Date | string | null;
  versions: VersionSetT;
  restricted: boolean;
  sync_state: SupportRequestT["syncState"];
  sync_attempts: number;
  last_sync_attempt_at: Date | string | null;
  next_sync_attempt_at: Date | string | null;
  sync_claim_token: string | null;
  salesforce_case_id: string | null;
  row_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const SR_COLUMNS = `support_request_id, tenant_id, reference_number, interaction_external_id, issue_external_id, call_id, audience, subject_ref,
  organization_ref, issue_category, disposition, owner_queue, priority, summary, summary_provenance, attempted, commit_receipt_ids, source_call_ids,
  language, consent, next_step, deadline, versions, restricted, sync_state, sync_attempts, last_sync_attempt_at, next_sync_attempt_at,
  sync_claim_token, salesforce_case_id, row_version, created_at, updated_at`;

const toIso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** Fixed minimal summary for restricted records synchronized to Salesforce. */
export const RESTRICTED_CASE_SUMMARY = "Restricted record. Details are held in the internal support system for the owner queue.";

type SyncOutcome = { duplicate: boolean; syncState: SupportRequestT["syncState"] };

export class PgSupportRequestService implements SupportRequestService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly audit: AuditWriter;
  private readonly outbox: Outbox;
  private readonly supportRecords: SupportRecordSystem;
  private readonly versions: VersionSetT;
  private readonly memory: SupportMemory | null;
  private readonly auditQuery: AuditQuery | null;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly policy: SupportSyncPolicy;
  private readonly dedup: PgConsumerDedup;
  private readonly auditStream: string | undefined;
  private readonly caseStates: CaseStateMapping;

  constructor(opts: PgSupportRequestServiceOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.audit = opts.audit;
    this.outbox = opts.outbox;
    this.supportRecords = opts.supportRecords;
    this.versions = VersionSet.parse(opts.versions);
    this.memory = opts.memory ?? null;
    this.auditQuery = opts.auditQuery ?? null;
    this.logger = (opts.logger ?? silentLogger).child({ component: "support_requests" });
    this.metrics = opts.metrics ?? noopMetrics;
    this.policy = { ...DEFAULT_SUPPORT_SYNC_POLICY, ...(opts.sync ?? {}) };
    if (this.policy.maxAttempts < 1 || this.policy.maxAttempts > 50) throw new ValidationError("SUPPORT_SYNC_POLICY_INVALID");
    this.dedup = new PgConsumerDedup({ db: opts.db, clock: opts.clock, role: "app_worker" });
    this.auditStream = opts.auditStream;
    const caseStates = CaseStateMappingSchema.safeParse(opts.caseStates ?? DEFAULT_CASE_STATE_MAPPING);
    if (!caseStates.success) throw new ValidationError("CASE_STATE_MAPPING_INVALID");
    this.caseStates = Object.freeze({ open: Object.freeze([...caseStates.data.open]), closed: Object.freeze([...caseStates.data.closed]) });
  }

  // ------------------------------------------------------------------ create

  /**
   * Port entry point. The subject is linked only from the trusted context: an A2+
   * session's own subject; anything else is an unlinked (A0) intake.
   */
  async create(ctx: AuthContext | null, input: Parameters<SupportRequestService["create"]>[1], tx?: Queryable): Promise<SupportRequestT> {
    const p = CreatePortInput.safeParse(input);
    if (!p.success) throw new ValidationError("SUPPORT_REQUEST_INPUT_INVALID");
    const i = p.data;
    if (ctx && ctx.tenantId !== i.tenantId) throw new AccessDeniedError("SUPPORT_REQUEST_TENANT_MISMATCH");
    const linked = ctx !== null && ctx.subjectId !== null && atLeast(ctx.assurance, "A2");
    return this.createRecord(
      {
        tenantId: i.tenantId,
        callId: i.callId,
        audience: ctx?.selectedRole ?? null,
        subjectRef: linked ? ctx.subjectId : null,
        organizationRef: null,
        actorRef: ctx?.actorId ?? null,
        sessionRef: auditSessionRef(ctx),
        sessionGeneration: ctx?.sessionGeneration ?? null,
        issueCategory: i.issueCategory,
        disposition: i.disposition,
        summaryTemplateId: i.summaryTemplateId,
        summarySlots: i.summarySlots,
        attempted: i.attempted,
        commitReceiptIds: i.commitReceiptIds,
        nextStep: i.nextStep,
        restricted: i.restricted,
        priority: i.priority,
        ownerQueue: i.ownerQueue,
        language: i.language,
        consent: ctx?.consent ?? UNKNOWN_CONSENT,
        creationKey: null,
      },
      tx,
    );
  }

  /** Creation key for idempotent intake: the same tool call in the same turn creates one request. */
  static creationKeyFor(parts: { tenantId: string; callId: string; turnId: string; tool: string; args: string }): string {
    return sha256Hex(`vsp.support_request.creation.v1\u0000${parts.tenantId}\u0000${parts.callId}\u0000${parts.turnId}\u0000${parts.tool}\u0000${parts.args}`);
  }

  /**
   * Creates the internal record, its interaction, links, sync outbox message and audit
   * event in one transaction (the given one, or a new app_runtime transaction).
   */
  async createRecord(input: SupportRequestRecordInput, tx?: Queryable): Promise<SupportRequestT> {
    const summary = assembleSummary(input.summaryTemplateId, input.summarySlots);
    if (input.subjectRef !== null && input.organizationRef !== null) throw new ValidationError("SUPPORT_REQUEST_SCOPE_INVALID");
    const run = (q: Queryable) => this.createInTx(q, input, summary);
    const sr = tx ? await run(tx) : await this.db.tx(run, { role: "app_runtime", rls: { tenantId: input.tenantId } });
    this.metrics.increment("vsp_crm_reconciliation_total", { result: "pending" });
    this.logger.info("support_request.created", { supportRequestId: sr.supportRequestId, issueCategory: sr.issueCategory, restricted: sr.restricted });
    return sr;
  }

  private async createInTx(q: Queryable, input: SupportRequestRecordInput, summary: string): Promise<SupportRequestT> {
    const tenant = (await q.query<{ t: string | null }>("select app_tenant() as t")).rows[0]?.t ?? null;
    if (tenant !== input.tenantId) throw new AccessDeniedError("SUPPORT_REQUEST_TENANT_CONTEXT_MISMATCH");
    if (input.creationKey !== null) {
      const existing = await this.byCreationKey(q, input.creationKey);
      if (existing) return existing;
    }
    const now = this.clock.now();
    const nowIso = iso(now);
    const interactionExternalId = await this.ensureInteraction(q, input, nowIso);
    const deadlineIso = CATEGORY_DEADLINE[input.issueCategory] ? iso(addMs(now, durationMs(CATEGORY_DEADLINE[input.issueCategory] as string))) : null;

    let sr: SupportRequestT | null = null;
    for (let attempt = 0; attempt < 5 && !sr; attempt++) {
      const candidate = SupportRequest.parse({
        supportRequestId: newId("sr"),
        referenceNumber: newSupportReference(),
        tenantId: input.tenantId,
        interactionExternalId,
        issueExternalId: newId("iss"),
        audience: input.audience,
        subjectRef: input.subjectRef,
        issueCategory: input.issueCategory,
        disposition: input.disposition,
        ownerQueue: input.ownerQueue,
        priority: input.priority,
        summary,
        summaryProvenance: "template_assembled",
        attempted: input.attempted,
        commitReceiptIds: input.commitReceiptIds,
        sourceCallIds: [input.callId],
        language: input.language,
        consent: input.consent,
        nextStep: input.nextStep,
        deadline: deadlineIso,
        versions: this.versions,
        restricted: input.restricted,
        syncState: "PENDING",
        salesforceCaseId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const inserted = await q.query(
        `insert into support_requests (support_request_id, tenant_id, reference_number, interaction_external_id, issue_external_id, call_id,
            creation_key, audience, subject_ref, organization_ref, issue_category, disposition, owner_queue, priority, summary, summary_template_id,
            summary_provenance, attempted, commit_receipt_ids, source_call_ids, language, consent, next_step, deadline, versions, restricted,
            sync_state, sync_attempts, row_version, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'template_assembled',$17::jsonb,$18::jsonb,$19::jsonb,$20,$21::jsonb,$22,$23,
            $24::jsonb,$25,'PENDING',0,1,$26,$26)
         on conflict do nothing`,
        [
          candidate.supportRequestId,
          candidate.tenantId,
          candidate.referenceNumber,
          interactionExternalId,
          candidate.issueExternalId,
          input.callId,
          input.creationKey,
          candidate.audience,
          candidate.subjectRef,
          input.organizationRef,
          candidate.issueCategory,
          candidate.disposition,
          candidate.ownerQueue,
          candidate.priority,
          summary,
          input.summaryTemplateId,
          JSON.stringify(candidate.attempted),
          JSON.stringify(candidate.commitReceiptIds),
          JSON.stringify(candidate.sourceCallIds),
          candidate.language,
          JSON.stringify(candidate.consent),
          candidate.nextStep,
          candidate.deadline,
          JSON.stringify(candidate.versions),
          candidate.restricted,
          nowIso,
        ],
      );
      if (inserted.rowCount === 1) {
        sr = candidate;
        break;
      }
      // Conflict: a concurrent creation with the same key, or (very rarely) a reference collision.
      if (input.creationKey !== null) {
        const existing = await this.byCreationKey(q, input.creationKey);
        if (existing) return existing;
      }
    }
    if (!sr) throw new ConflictError("SUPPORT_REFERENCE_ALLOCATION_FAILED");

    await this.insertLink(q, sr, "interaction", interactionExternalId, nowIso);
    for (const l of input.links ?? []) await this.insertLink(q, sr, l.kind, l.ref, nowIso);
    await this.enqueueSync(q, sr.tenantId, sr.supportRequestId, 0, `support_request.sync:${sr.supportRequestId}:a0`);
    await this.audit.append(
      q,
      buildAuditInput(
        {
          tenantId: sr.tenantId,
          correlationId: sr.supportRequestId,
          sourceComponent: "gateway",
          action: "support_request.created",
          outcome: "SUCCEEDED",
          actorRef: input.actorRef,
          subjectRef: sr.subjectRef,
          role: sr.audience,
          callId: input.callId,
          sessionRef: input.sessionRef,
          sessionGeneration: input.sessionGeneration,
          versions: this.versions,
          evidencePointers: [`db://support_requests/${sr.supportRequestId}`, ...(input.links ?? []).map((l) => `${l.kind}:${l.ref}`)],
          reasonCode: sr.restricted ? "RESTRICTED_RECORD" : null,
          dataClass: "BUSINESS_RECORD",
        },
        this.clock,
      ),
      this.auditStream,
    );
    return sr;
  }

  private async ensureInteraction(q: Queryable, input: SupportRequestRecordInput, nowIso: string): Promise<string> {
    await q.query(
      `insert into support_interactions (interaction_external_id, tenant_id, call_id, language, consent_status, started_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $6) on conflict (tenant_id, call_id) do nothing`,
      [newId("int"), input.tenantId, input.callId, input.language, consentStatusCode(input.consent), nowIso],
    );
    const r = await q.query<{ interaction_external_id: string }>(
      "select interaction_external_id from support_interactions where tenant_id = $1 and call_id = $2",
      [input.tenantId, input.callId],
    );
    const id = r.rows[0]?.interaction_external_id;
    if (!id) throw new DependencyError("SUPPORT_INTERACTION_UNAVAILABLE", "UNKNOWN");
    return id;
  }

  private async insertLink(q: Queryable, sr: Pick<SupportRequestT, "supportRequestId" | "tenantId">, kind: "action" | "workflow" | "interaction", ref: string, nowIso: string): Promise<void> {
    if (!/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/.test(ref)) throw new ValidationError("SUPPORT_LINK_REF_INVALID");
    await q.query(
      `insert into support_request_links (link_id, tenant_id, support_request_id, link_kind, link_ref, created_at)
       values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
      [newId("srl"), sr.tenantId, sr.supportRequestId, kind, ref, nowIso],
    );
  }

  /** Links an existing request to an action or workflow inside the caller's transaction. */
  async linkInTx(q: Queryable, sr: Pick<SupportRequestT, "supportRequestId" | "tenantId">, kind: "action" | "workflow", ref: string): Promise<void> {
    await this.insertLink(q, sr, kind, ref, iso(this.clock.now()));
  }

  private async byCreationKey(q: Queryable, creationKey: string): Promise<SupportRequestT | null> {
    // The runtime role cannot read restricted rows; a replay of its own creation resolves the
    // earlier row through the narrow definer lookup (exact creation key, own tenant only).
    const r = await q.query<SrRow>(`select ${SR_COLUMNS} from support_request_by_creation_key($1)`, [creationKey]);
    return r.rows[0] ? this.rowToRequest(r.rows[0]) : null;
  }

  private async enqueueSync(q: Queryable, tenantId: string, supportRequestId: string, attempt: number, dedupeKey: string): Promise<void> {
    await this.outbox.enqueue(q, {
      topic: "support_request.sync",
      key: `sr:${supportRequestId}`,
      payload: { tenantId, supportRequestId, attempt },
      dedupeKey,
    });
  }

  /** Records the recap entry for an A2+ caller's own, non-restricted open request (after commit; best effort). */
  async rememberOpenIssue(ctx: AuthContext, sr: SupportRequestT): Promise<boolean> {
    if (!this.memory || sr.restricted || sr.subjectRef === null || sr.subjectRef !== ctx.subjectId || !atLeast(ctx.assurance, "A2")) return false;
    const now = this.clock.now();
    const horizon = sr.deadline ? new Date(sr.deadline) : addMs(now, durationMs(DEFAULT_MEMORY_HORIZON));
    try {
      await this.memory.record({
        tenantId: sr.tenantId,
        subjectId: sr.subjectRef,
        kind: "OPEN_ISSUE",
        value: {
          issueCategory: sr.issueCategory.toUpperCase(),
          status: "OPEN",
          supportReference: sr.referenceNumber,
          ownerQueue: sr.ownerQueue,
          openedAt: sr.createdAt,
          followUpRequired: true,
        },
        provenance: "VERIFIED",
        sourceRef: `sr://${sr.referenceNumber}`,
        expiresAt: iso(horizon.getTime() > now.getTime() ? horizon : addMs(now, durationMs(DEFAULT_MEMORY_HORIZON))),
      });
      return true;
    } catch (err) {
      this.logger.warn("support_request.memory_not_recorded", { reasonCode: reasonOf(err) });
      return false;
    }
  }

  // ------------------------------------------------------------------ reads

  async get(tenantId: string, supportRequestId: string): Promise<SupportRequestT | null> {
    if (!OpaqueId.safeParse(tenantId).success || !/^sr_[A-Za-z0-9_-]{16,64}$/.test(supportRequestId)) return null;
    const r = await this.db.tx((q) => q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where support_request_id = $1`, [supportRequestId]), {
      role: "app_runtime",
      rls: { tenantId },
    });
    return r.rows[0] ? this.rowToRequest(r.rows[0]) : null;
  }

  /** Runtime view: restricted (privacy / safety) records are never returned here. */
  async getByReference(tenantId: string, referenceNumber: string): Promise<SupportRequestT | null> {
    if (!OpaqueId.safeParse(tenantId).success || !SupportReference.safeParse(referenceNumber).success) return null;
    const r = await this.db.tx((q) => q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where reference_number = $1`, [referenceNumber]), {
      role: "app_runtime",
      rls: { tenantId },
    });
    return r.rows[0] ? this.rowToRequest(r.rows[0]) : null;
  }

  /** Non-restricted requests of one subject or organization (runtime view), newest first. */
  async listForScope(tenantId: string, scope: { subjectRef: string } | { organizationRef: string }, limit = 10): Promise<SupportRequestT[]> {
    const [col, val] = "subjectRef" in scope ? ["subject_ref", scope.subjectRef] : ["organization_ref", scope.organizationRef];
    const r = await this.db.tx(
      (q) => q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where ${col} = $1 order by created_at desc limit $2`, [val, Math.min(Math.max(limit, 1), 50)]),
      { role: "app_runtime", rls: { tenantId } },
    );
    return r.rows.map((row) => this.rowToRequest(row));
  }

  /** Support request that follows up a committed action (one per action). */
  async findByActionId(tenantId: string, actionId: string, q?: Queryable): Promise<SupportRequestT | null> {
    const sql = `select ${SR_COLUMNS.split(",").map((c) => `s.${c.trim()}`).join(", ")} from support_request_links l
                   join support_requests s on s.support_request_id = l.support_request_id
                  where l.link_kind = 'action' and l.link_ref = $1`;
    const r = q ? await q.query<SrRow>(sql, [actionId]) : await this.db.tx((t) => t.query<SrRow>(sql, [actionId]), { role: "app_worker", rls: { tenantId } });
    return r.rows[0] ? this.rowToRequest(r.rows[0]) : null;
  }

  async linkedRefs(tenantId: string, supportRequestId: string): Promise<{ actionIds: string[]; workflowIds: string[] }> {
    const r = await this.db.tx(
      (q) => q.query<{ link_kind: string; link_ref: string }>("select link_kind, link_ref from support_request_links where support_request_id = $1 order by created_at, link_id", [supportRequestId]),
      { role: "app_worker", rls: { tenantId } },
    );
    return {
      actionIds: r.rows.filter((x) => x.link_kind === "action").map((x) => x.link_ref),
      workflowIds: r.rows.filter((x) => x.link_kind === "workflow").map((x) => x.link_ref),
    };
  }

  /**
   * Operator trace. Default: worker view (app_worker, includes restricted records). The
   * console view reads the request and its links as app_console under row-level security;
   * the transaction is marked as a restricted-record reader (app.restricted_reader, migration
   * 0300) ONLY when the caller says the staff member's restricted_record:view decision
   * allowed. A row RLS hides returns null (fail closed). Outbox message ids are sync
   * metadata (ids only) read as app_worker after the request itself was visible.
   */
  async trace(tenantId: string, referenceNumber: string, options: SupportRequestTraceOptions = {}): Promise<SupportRequestTrace | null> {
    if (!OpaqueId.safeParse(tenantId).success || !SupportReference.safeParse(referenceNumber).success) return null;
    const consoleView = options.reader?.kind === "console";
    const restrictedReader = consoleView && options.reader?.restrictedReader === true;
    type TraceRow = SrRow & { last_sync_reason: string | null; synced_at: Date | string | null };
    const read = await this.db.tx(
      async (q) => {
        if (restrictedReader) await q.query("select set_config('app.restricted_reader', 'on', true)");
        const r = await q.query<TraceRow>(`select ${SR_COLUMNS}, last_sync_reason, synced_at from support_requests where reference_number = $1`, [referenceNumber]);
        const row = r.rows[0];
        if (!row) return null;
        const links = await q.query<{ link_kind: string; link_ref: string }>(
          "select link_kind, link_ref from support_request_links where support_request_id = $1 order by created_at, link_id",
          [row.support_request_id],
        );
        return { row, links: links.rows };
      },
      { role: consoleView ? "app_console" : "app_worker", rls: { tenantId } },
    );
    if (!read) return null;
    const { row } = read;
    const sr = this.rowToRequest(row);
    const links = {
      actionIds: read.links.filter((x) => x.link_kind === "action").map((x) => x.link_ref),
      workflowIds: read.links.filter((x) => x.link_kind === "workflow").map((x) => x.link_ref),
    };
    const outbox = await this.db.tx(
      (q) =>
        q.query<{ message_id: string }>("select message_id from outbox_messages where topic = 'support_request.sync' and key = $1 order by created_at, message_id limit 64", [
          `sr:${sr.supportRequestId}`,
        ]),
      { role: "app_worker", rls: { tenantId } },
    );
    let auditEventIds: string[] = [];
    if (this.auditQuery) {
      const correlations = [sr.supportRequestId, ...links.actionIds, ...links.workflowIds];
      const events = (await Promise.all(correlations.map((c) => this.auditQuery!.search({ tenantId, correlationId: c, limit: 100 }).catch(() => [])))).flat();
      auditEventIds = [...new Set(events.map((e) => e.eventId))];
    }
    const lastReasonCode = row.last_sync_reason !== null && /^[A-Z][A-Z0-9_]{2,63}$/.test(row.last_sync_reason) ? row.last_sync_reason : null;
    return {
      supportRequest: sr,
      salesforce: {
        caseId: sr.salesforceCaseId,
        syncState: sr.syncState,
        lastAttemptAt: toIso(row.last_sync_attempt_at),
        attempts: row.sync_attempts,
        lastReasonCode,
        syncedAt: sr.syncState === "SYNCED" ? toIso(row.synced_at) : null,
      },
      actionIds: links.actionIds,
      workflowIds: links.workflowIds,
      auditEventIds,
      outboxMessageIds: outbox.rows.map((x) => x.message_id),
    };
  }

  /** Requests created for, or later linked to, one call (worker view: includes restricted rows; callers gate disclosure). */
  async listForCall(tenantId: string, callId: string): Promise<SupportRequestT[]> {
    if (!OpaqueId.safeParse(tenantId).success || !OpaqueId.safeParse(callId).success) return [];
    const r = await this.db.tx(
      (q) =>
        q.query<SrRow>(
          `select ${SR_COLUMNS} from support_requests where call_id = $1 or source_call_ids @> jsonb_build_array($1::text)
            order by created_at, support_request_id limit 50`,
          [callId],
        ),
      { role: "app_worker", rls: { tenantId } },
    );
    return r.rows.map((row) => this.rowToRequest(row));
  }

  /** Reconciliation dashboard / operator repair data (worker view). */
  async listUnsynced(tenantId: string, limit: number): Promise<SupportRequestT[]> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("TENANT_INVALID");
    const n = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const r = await this.db.tx(
      (q) => q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where sync_state <> 'SYNCED' order by created_at, support_request_id limit $1`, [n]),
      { role: "app_worker", rls: { tenantId } },
    );
    return r.rows.map((row) => this.rowToRequest(row));
  }

  // ------------------------------------------------------------------ synchronization

  async handleSyncMessage(messageId: string, payload: Record<string, unknown>): Promise<SyncOutcome> {
    if (!MESSAGE_ID.test(messageId)) throw new ValidationError("SUPPORT_SYNC_MESSAGE_ID_INVALID");
    const p = SyncPayload.safeParse(payload);
    if (!p.success) throw new ValidationError("SUPPORT_SYNC_PAYLOAD_INVALID");
    const { tenantId, supportRequestId } = p.data;
    // OPS-KS-02: INTEGRATION <support records> / WRITES kill switch (unreadable state holds). Checked BEFORE
    // claiming, so a held sync spends no attempt and makes no state transition; the row keeps a durable
    // hold marker that the retry sweep re-enqueues after the switch is released.
    const hold = await holdReasonOf(this.supportRecords, true);
    if (hold) return this.holdSync(tenantId, supportRequestId, hold);
    const now = this.clock.now();
    const token = newId("scl");

    type Claim = { kind: "claimed"; row: SrRow } | { kind: "skip"; state: SupportRequestT["syncState"] } | { kind: "missing" };
    const claimed = await this.dedup.processOnceForTenant<Claim>(tenantId, SUPPORT_SYNC_CONSUMER, messageId, async (q) => {
      const r = await q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where support_request_id = $1 for update`, [supportRequestId]);
      const row = r.rows[0];
      if (!row) return { kind: "missing" };
      if (row.sync_state === "SYNCED" || row.sync_state === "DEAD_LETTER") return { kind: "skip", state: row.sync_state };
      if (row.sync_state === "SYNCING" && !this.claimStale(row, now)) return { kind: "skip", state: row.sync_state };
      const u = await q.query<SrRow>(
        `update support_requests set sync_state = 'SYNCING', sync_attempts = sync_attempts + 1, last_sync_attempt_at = $2, sync_claim_token = $3,
                row_version = row_version + 1, updated_at = $2
          where support_request_id = $1 and row_version = $4 returning ${SR_COLUMNS}`,
        [supportRequestId, iso(now), token, row.row_version],
      );
      const updated = u.rows[0];
      if (!updated) throw new ConflictError("SUPPORT_REQUEST_CONCURRENT_UPDATE", "SUPPORT_REQUEST_CONCURRENT_UPDATE", true);
      return { kind: "claimed", row: updated };
    });
    if (claimed.duplicate || !claimed.result) {
      return { duplicate: true, syncState: (await this.currentState(tenantId, supportRequestId)) ?? "PENDING" };
    }
    const c = claimed.result;
    if (c.kind === "missing") {
      this.logger.warn("support_request.sync.missing", { supportRequestId });
      throw new ValidationError("SUPPORT_REQUEST_NOT_FOUND");
    }
    if (c.kind === "skip") return { duplicate: false, syncState: c.state };

    // Phase B: idempotent upserts by external id, with no database transaction open.
    let caseId: string | null = null;
    let failure: SyncFailure | null = null;
    try {
      const row = c.row;
      await this.supportRecords.upsertInteraction(row.interaction_external_id, {
        callId: row.call_id,
        language: row.language,
        consentStatus: consentStatusCode(row.consent),
        startedAt: new Date(row.created_at).toISOString(),
      });
      const result = await this.supportRecords.upsertCase(row.issue_external_id, row.interaction_external_id, this.caseFields(row));
      caseId = result.caseId;
    } catch (err) {
      if (isIntegrationHeld(err)) {
        // OPS-KS-02: INTEGRATION / WRITES kill switch engaged (or unreadable): nothing reached Salesforce.
        // Keep the request pending without spending an attempt; resume after the switch is released.
        failure = { reasonCode: err.reasonCode, permanent: false, held: true };
      } else {
        const permanent = err instanceof ValidationError || (err instanceof ConflictError && !err.retryable) || (err instanceof DependencyError && err.outcome === "FAILED" && !err.retryable);
        failure = { reasonCode: reasonOf(err, "SALESFORCE_SYNC_FAILED"), permanent };
      }
    }

    // Phase C: settle by claim token.
    return this.settle(tenantId, supportRequestId, token, caseId, failure);
  }

  /**
   * OPS-KS-02 hold without a claim: PENDING / RETRY_SCHEDULED rows keep their state and attempt count;
   * the hold reason and the next check time are recorded (same-state update) and audited. Rows that are
   * SYNCING (another claim in flight), SYNCED or DEAD_LETTER are left untouched.
   */
  private async holdSync(tenantId: string, supportRequestId: string, reasonCode: string): Promise<SyncOutcome> {
    const now = this.clock.now();
    const state = await this.db.tx(
      async (q) => {
        const r = await q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where support_request_id = $1 for update`, [supportRequestId]);
        const row = r.rows[0];
        if (!row) throw new ValidationError("SUPPORT_REQUEST_NOT_FOUND");
        if (row.sync_state !== "PENDING" && row.sync_state !== "RETRY_SCHEDULED") return row.sync_state;
        await q.query(
          `update support_requests set next_sync_attempt_at = $2, last_sync_reason = $3, row_version = row_version + 1, updated_at = $4
            where support_request_id = $1`,
          [supportRequestId, iso(addMs(now, this.policy.baseBackoffMs)), reasonCode, iso(now)],
        );
        await this.audit.append(
          q,
          buildAuditInput(
            {
              tenantId,
              correlationId: supportRequestId,
              sourceComponent: "worker",
              action: "support_request.sync_held",
              outcome: "PENDING",
              subjectRef: row.subject_ref,
              callId: row.call_id,
              evidencePointers: [`db://support_requests/${supportRequestId}`],
              reasonCode,
              dataClass: "BUSINESS_RECORD",
            },
            this.clock,
          ),
          this.auditStream,
        );
        return row.sync_state;
      },
      { role: "app_worker", rls: { tenantId } },
    );
    this.logger.info("support_request.sync.held", { supportRequestId, syncState: state, reasonCode });
    return { duplicate: false, syncState: state };
  }

  private claimStale(row: SrRow, now: Date): boolean {
    const at = row.last_sync_attempt_at ? new Date(row.last_sync_attempt_at).getTime() : 0;
    return now.getTime() - at >= this.policy.claimStaleSeconds * 1000;
  }

  private caseFields(row: SrRow): CaseFields {
    const v = row.versions;
    const versions = `agent=${v.agentConfig};model=${v.model};voice=${v.voice};prompts=${v.promptTemplates};policy=${v.policyBundle};tools=${v.toolCatalog.slice(0, 16)};kb=${v.knowledgeSnapshot};schema=${v.schema}`;
    const minimal = row.restricted;
    return {
      subjectRef: row.subject_ref,
      audience: row.audience,
      issueCategory: row.issue_category,
      disposition: row.disposition,
      ownerQueue: row.owner_queue,
      priority: row.priority,
      summary: minimal ? RESTRICTED_CASE_SUMMARY : row.summary,
      attempted: minimal ? [] : row.attempted,
      commitReceiptIds: minimal ? [] : row.commit_receipt_ids,
      sourceCallIds: row.source_call_ids,
      language: row.language,
      consentStatus: consentStatusCode(row.consent),
      nextStep: minimal ? null : row.next_step,
      deadline: toIso(row.deadline),
      versions: versions.replace(/[^A-Za-z0-9._:+=,;@/-]/g, "_").slice(0, 512),
      restricted: row.restricted,
      supportReference: row.reference_number,
    };
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.policy.maxBackoffMs, this.policy.baseBackoffMs * 2 ** Math.max(0, attempts - 1));
  }

  private async settle(tenantId: string, supportRequestId: string, token: string, caseId: string | null, failure: SyncFailure | null): Promise<SyncOutcome> {
    const now = this.clock.now();
    const state = await this.db.tx(
      async (q) => {
        const r = await q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where support_request_id = $1 for update`, [supportRequestId]);
        const row = r.rows[0];
        if (!row) throw new ValidationError("SUPPORT_REQUEST_NOT_FOUND");
        if (row.sync_state !== "SYNCING" || row.sync_claim_token !== token) return { state: row.sync_state, changed: false };
        let next: SupportRequestT["syncState"];
        let action: string;
        let reason: string | null;
        if (caseId !== null) {
          next = "SYNCED";
          action = "support_request.synced";
          reason = null;
          await q.query(
            `update support_requests set sync_state = 'SYNCED', salesforce_case_id = $2, synced_at = $3, sync_claim_token = null, next_sync_attempt_at = null,
                    last_sync_reason = null, row_version = row_version + 1, updated_at = $3 where support_request_id = $1`,
            [supportRequestId, caseId, iso(now)],
          );
        } else {
          const f = failure ?? { reasonCode: "SALESFORCE_SYNC_FAILED", permanent: false };
          reason = f.reasonCode;
          if (f.held) {
            // OPS-KS-02: a switch engaged between the pre-claim check and the vendor call. Nothing reached
            // Salesforce; the claimed attempt stays counted (attempts never decrease) but a hold never
            // dead-letters; the retry sweep re-enqueues it once due and the switch is released.
            next = "RETRY_SCHEDULED";
            action = "support_request.sync_held";
            await q.query(
              `update support_requests set sync_state = 'RETRY_SCHEDULED', sync_claim_token = null,
                      next_sync_attempt_at = $2, last_sync_reason = $3, row_version = row_version + 1, updated_at = $4 where support_request_id = $1`,
              [supportRequestId, iso(addMs(now, this.policy.baseBackoffMs)), f.reasonCode, iso(now)],
            );
          } else if (f.permanent || row.sync_attempts >= this.policy.maxAttempts) {
            next = "DEAD_LETTER";
            action = "support_request.sync_dead_lettered";
            await q.query(
              `update support_requests set sync_state = 'DEAD_LETTER', sync_claim_token = null, next_sync_attempt_at = null, last_sync_reason = $2,
                      row_version = row_version + 1, updated_at = $3 where support_request_id = $1`,
              [supportRequestId, f.reasonCode, iso(now)],
            );
          } else {
            next = "RETRY_SCHEDULED";
            action = "support_request.sync_retry_scheduled";
            await q.query(
              `update support_requests set sync_state = 'RETRY_SCHEDULED', sync_claim_token = null, next_sync_attempt_at = $2, last_sync_reason = $3,
                      row_version = row_version + 1, updated_at = $4 where support_request_id = $1`,
              [supportRequestId, iso(addMs(now, this.backoffMs(row.sync_attempts))), f.reasonCode, iso(now)],
            );
          }
        }
        await this.audit.append(
          q,
          buildAuditInput(
            {
              tenantId,
              correlationId: supportRequestId,
              sourceComponent: "worker",
              action,
              outcome: next === "SYNCED" ? "SUCCEEDED" : next === "DEAD_LETTER" ? "FAILED" : "PENDING",
              subjectRef: row.subject_ref,
              callId: row.call_id,
              evidencePointers: [`db://support_requests/${supportRequestId}`, ...(caseId ? [`sf://cases/${caseId}`] : [])],
              reasonCode: reason,
              dataClass: "BUSINESS_RECORD",
            },
            this.clock,
          ),
          this.auditStream,
        );
        return { state: next, changed: true, createdAt: row.created_at };
      },
      { role: "app_worker", rls: { tenantId } },
    );
    if (state.changed) {
      const result = state.state === "SYNCED" ? "synced" : state.state === "DEAD_LETTER" ? "dead_lettered" : "retried";
      if (!failure?.held) this.metrics.increment("vsp_crm_reconciliation_total", { result });
      if (state.state === "SYNCED" && "createdAt" in state && state.createdAt) {
        this.metrics.observe("vsp_crm_sync_lag_ms", Math.max(0, now.getTime() - new Date(state.createdAt).getTime()));
      }
      this.logger.info("support_request.sync.settled", { supportRequestId, syncState: state.state, reasonCode: failure?.reasonCode ?? null });
    }
    return { duplicate: false, syncState: state.state };
  }

  private async currentState(tenantId: string, supportRequestId: string): Promise<SupportRequestT["syncState"] | null> {
    const r = await this.db.tx((q) => q.query<{ sync_state: SupportRequestT["syncState"] }>("select sync_state from support_requests where support_request_id = $1", [supportRequestId]), {
      role: "app_worker",
      rls: { tenantId },
    });
    return r.rows[0]?.sync_state ?? null;
  }

  /**
   * Worker sweep: re-enqueues due RETRY_SCHEDULED requests and SYNCING claims left by a
   * crashed worker. Upserts are idempotent by external id, so a repeated sync is safe.
   */
  async retryDue(tenantId: string, limit = 100): Promise<number> {
    if (!OpaqueId.safeParse(tenantId).success) throw new ValidationError("TENANT_INVALID");
    const now = this.clock.now();
    const staleBefore = iso(addMs(now, -this.policy.claimStaleSeconds * 1000));
    return this.db.tx(
      async (q) => {
        const r = await q.query<{
          support_request_id: string;
          sync_state: string;
          sync_attempts: number;
          last_sync_attempt_at: Date | string | null;
          next_sync_attempt_at: Date | string | null;
          last_sync_reason: string | null;
        }>(
          `select support_request_id, sync_state, sync_attempts, last_sync_attempt_at, next_sync_attempt_at, last_sync_reason from support_requests
            where (sync_state = 'RETRY_SCHEDULED' and next_sync_attempt_at <= $1) or (sync_state = 'SYNCING' and last_sync_attempt_at <= $2)
               or (sync_state = 'PENDING' and next_sync_attempt_at <= $1 and last_sync_reason = any($4::text[]))
            order by updated_at, support_request_id limit $3`,
          [iso(now), staleBefore, Math.min(Math.max(limit, 1), 1000), [...KILL_SWITCH_HOLD_REASONS]],
        );
        for (const row of r.rows) {
          // A kill-switch hold keeps the attempt count, so its re-enqueue needs its own dedupe key (OPS-KS-02).
          const held = (row.sync_state === "RETRY_SCHEDULED" || row.sync_state === "PENDING") && KILL_SWITCH_HOLD_REASONS.has(row.last_sync_reason ?? "");
          const suffix =
            row.sync_state === "SYNCING"
              ? `stale:${new Date(row.last_sync_attempt_at ?? 0).getTime()}`
              : held
                ? `held:${new Date(row.next_sync_attempt_at ?? 0).getTime()}`
                : "retry";
          await this.enqueueSync(q, tenantId, row.support_request_id, row.sync_attempts, `support_request.sync:${row.support_request_id}:a${row.sync_attempts}:${suffix}`);
        }
        return r.rows.length;
      },
      { role: "app_worker", rls: { tenantId } },
    );
  }

  /** Operator repair of a DEAD_LETTER request: back to PENDING with a fresh sync message. Audited, fails closed. */
  async repairDeadLetter(tenantId: string, supportRequestId: string, operator: { actorRef: string; reasonCode: string }): Promise<SupportRequestT> {
    if (!/^stf_[A-Za-z0-9_-]{16,64}$/.test(operator.actorRef) || !/^[A-Z][A-Z0-9_]{2,63}$/.test(operator.reasonCode)) throw new ValidationError("SUPPORT_REPAIR_INPUT_INVALID");
    const now = this.clock.now();
    const row = await this.db.tx(
      async (q) => {
        const r = await q.query<SrRow>(`select ${SR_COLUMNS} from support_requests where support_request_id = $1 for update`, [supportRequestId]);
        const cur = r.rows[0];
        if (!cur) throw new AccessDeniedError("SUPPORT_REQUEST_NOT_FOUND");
        if (cur.sync_state !== "DEAD_LETTER") throw new ConflictError("SUPPORT_REQUEST_NOT_DEAD_LETTERED");
        const u = await q.query<SrRow>(
          `update support_requests set sync_state = 'PENDING', sync_attempts = 0, last_sync_reason = $2, next_sync_attempt_at = null,
                  row_version = row_version + 1, updated_at = $3 where support_request_id = $1 returning ${SR_COLUMNS}`,
          [supportRequestId, operator.reasonCode, iso(now)],
        );
        const updated = u.rows[0];
        if (!updated) throw new ConflictError("SUPPORT_REQUEST_CONCURRENT_UPDATE");
        await this.enqueueSync(q, tenantId, supportRequestId, 0, `support_request.sync:${supportRequestId}:repair:${now.getTime()}`);
        await this.audit.append(
          q,
          buildAuditInput(
            {
              tenantId,
              correlationId: supportRequestId,
              sourceComponent: "console",
              action: "support_request.repair_requeued",
              outcome: "SUCCEEDED",
              actorRef: operator.actorRef,
              evidencePointers: [`db://support_requests/${supportRequestId}`],
              reasonCode: operator.reasonCode,
              dataClass: "BUSINESS_RECORD",
            },
            this.clock,
          ),
          this.auditStream,
        );
        return updated;
      },
      { role: "app_worker", rls: { tenantId } },
    );
    this.metrics.increment("vsp_crm_reconciliation_total", { result: "repaired" });
    return this.rowToRequest(row);
  }

  // ------------------------------------------------------------------ reopened cases

  /**
   * Reads the synchronized Case's status from the system of record (outside any transaction, through
   * the kill-switch-gated adapter), maps it with the configured CaseStateMapping and appends a
   * support_case_observations row only when the mapped state differs from the last recorded one. A Case
   * last recorded CLOSED and now OPEN is a reopening: audited (support_request.case_reopened) and counted
   * (vsp_cases_reopened_total{issue_category}). An unmapped value is only counted ("unmapped"); the
   * vendor status text is never stored, logged or used as a label. A failed or held read changes nothing.
   */
  async observeCaseStatus(tenantId: string, supportRequestId: string): Promise<CaseStatusObservation> {
    if (!OpaqueId.safeParse(tenantId).success || !/^sr_[A-Za-z0-9_-]{16,64}$/.test(supportRequestId)) throw new ValidationError("CASE_OBSERVATION_INPUT_INVALID");
    const notObserved = (reasonCode: string): CaseStatusObservation => ({ observed: false, caseState: null, reopened: false, reasonCode });
    type Row = { issue_external_id: string; issue_category: IssueCategoryT; subject_ref: string | null; call_id: string; salesforce_case_id: string | null };
    const sr = (
      await this.db.tx(
        (q) => q.query<Row>("select issue_external_id, issue_category, subject_ref, call_id, salesforce_case_id from support_requests where support_request_id = $1", [supportRequestId]),
        { role: "app_worker", rls: { tenantId } },
      )
    ).rows[0];
    if (!sr) return notObserved("SUPPORT_REQUEST_NOT_FOUND");
    if (sr.salesforce_case_id === null) return notObserved("CASE_NOT_SYNCED");
    let found: { caseId: string; status: string } | null;
    try {
      found = await this.supportRecords.getCaseByExternalId(sr.issue_external_id);
    } catch (err) {
      return notObserved(isIntegrationHeld(err) ? err.reasonCode : reasonOf(err, "SALESFORCE_READ_FAILED"));
    }
    if (!found) return notObserved("CASE_NOT_FOUND");
    if (found.caseId !== sr.salesforce_case_id) return notObserved("CASE_ID_MISMATCH");
    const status = found.status;
    const state = this.caseStates.closed.includes(status) ? "CLOSED" : this.caseStates.open.includes(status) ? "OPEN" : null;
    if (state === null) {
      this.metrics.increment("vsp_case_status_observations_total", { case_state: "unmapped" });
      return { observed: false, caseState: "UNMAPPED", reopened: false, reasonCode: "CASE_STATUS_UNMAPPED" };
    }
    const caseId = found.caseId;
    const now = this.clock.now();
    const reopened = await this.db.tx(
      async (q) => {
        // One observation at a time per request (concurrent reads of the same Case).
        await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`support_case_observations:${tenantId}:${supportRequestId}`]);
        const last = (
          await q.query<{ case_state: "OPEN" | "CLOSED"; observed_at: Date | string }>(
            "select case_state, observed_at from support_case_observations where support_request_id = $1 order by observed_at desc, observation_id desc limit 1",
            [supportRequestId],
          )
        ).rows[0];
        if (last?.case_state === state) return false;
        // Strictly later than the change it follows, so "last" is unambiguous even with a frozen clock.
        const observedAt = last ? new Date(Math.max(now.getTime(), new Date(last.observed_at).getTime() + 1)) : now;
        await q.query(
          `insert into support_case_observations (observation_id, tenant_id, support_request_id, case_state, previous_state, observed_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [newId("sco"), tenantId, supportRequestId, state, last?.case_state ?? null, iso(observedAt)],
        );
        const isReopening = last?.case_state === "CLOSED" && state === "OPEN";
        if (isReopening) {
          await this.audit.append(
            q,
            buildAuditInput(
              {
                tenantId,
                correlationId: supportRequestId,
                sourceComponent: "worker",
                action: "support_request.case_reopened",
                outcome: "SUCCEEDED",
                subjectRef: sr.subject_ref,
                callId: sr.call_id,
                evidencePointers: [`db://support_requests/${supportRequestId}`, `sf://cases/${caseId}`],
                reasonCode: "CASE_REOPENED_OBSERVED",
                dataClass: "BUSINESS_RECORD",
              },
              this.clock,
            ),
            this.auditStream,
          );
        }
        return isReopening;
      },
      { role: "app_worker", rls: { tenantId } },
    );
    this.metrics.increment("vsp_case_status_observations_total", { case_state: state === "OPEN" ? "open" : "closed" });
    if (reopened) {
      this.metrics.increment("vsp_cases_reopened_total", { issue_category: sr.issue_category });
      this.logger.info("support_request.case_reopened", { supportRequestId });
    }
    return { observed: true, caseState: state, reopened, reasonCode: reopened ? "CASE_REOPENED" : "CASE_STATUS_OBSERVED" };
  }

  // ------------------------------------------------------------------ mapping

  private rowToRequest(row: SrRow): SupportRequestT {
    return SupportRequest.parse({
      supportRequestId: row.support_request_id,
      referenceNumber: row.reference_number,
      tenantId: row.tenant_id,
      interactionExternalId: row.interaction_external_id,
      issueExternalId: row.issue_external_id,
      audience: row.audience,
      subjectRef: row.subject_ref,
      issueCategory: row.issue_category,
      disposition: row.disposition,
      ownerQueue: row.owner_queue,
      priority: row.priority,
      summary: row.summary,
      summaryProvenance: row.summary_provenance,
      attempted: row.attempted,
      commitReceiptIds: row.commit_receipt_ids,
      sourceCallIds: row.source_call_ids,
      language: row.language,
      consent: row.consent,
      nextStep: row.next_step,
      deadline: toIso(row.deadline),
      versions: row.versions,
      restricted: row.restricted,
      syncState: row.sync_state,
      salesforceCaseId: row.salesforce_case_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    });
  }

  /** Organization scope of a request (not part of the protocol SupportRequest). */
  async organizationOf(tenantId: string, supportRequestId: string): Promise<string | null> {
    const r = await this.db.tx((q) => q.query<{ organization_ref: string | null }>("select organization_ref from support_requests where support_request_id = $1", [supportRequestId]), {
      role: "app_runtime",
      rls: { tenantId },
    });
    return r.rows[0]?.organization_ref ?? null;
  }
}

export const isPlatformError = (e: unknown): e is PlatformError => e instanceof PlatformError;
