/**
 * Durable, encrypted inbound event inbox (follow-on FO-07-17, FO-07-18, FO-07-19, FO-07-22, FO-03-21;
 * ACT-02, DATA-01, DATA-02, OPS-01). Migration 2041.
 *
 * `accept` runs AFTER authentication and BEFORE the sender is acknowledged:
 *   1. Under a transaction-scoped advisory lock on (tenant, source, event id), so concurrent deliveries of
 *      one event serialize:
 *   2. a delivery of an event already in the inbox is a DUPLICATE: the row's duplicate_count is raised and
 *      an inbound_deliveries row records it (with whether its bytes match the first delivery). Nothing is
 *      re-processed; a duplicate whose bytes differ is recorded, never applied (DUPLICATE_WEBHOOK);
 *   (before either: a token-authenticated delivery's replay key is recorded in the durable replay cache
 *    inbound_replay_keys with the digest of its bytes; the same key over other bytes is refused with
 *    InboxReplayRefusedError, INGRESS_REPLAYED, and nothing is stored — migration 2043)
 *   3. a new event is encrypted (KMS envelope, AAD bound to the row identity), an audit event
 *      ingress.event.accepted / ingress.event.quarantined is appended carrying the payload digest, the
 *      contract id/version and the authentication mechanism and credential version (FO-07-19), and the
 *      row is inserted (RECEIVED, or QUARANTINED with its reason) — all in ONE transaction.
 * Only when that transaction commits does the caller answer 2xx; a crash before it means no ack, so the
 * sender redelivers, and a crash after it means the redelivery is a duplicate. An acknowledged event is
 * therefore never lost and never applied twice.
 *
 * Logs and metrics carry inbox ids, source ids, digests and reason codes, never payload content or a
 * credential.
 */
import { createHash } from "node:crypto";
import type { AuditWriter } from "../audit/ports.js";
import { buildAuditInput } from "../audit/build-input.js";
import type { Db, DbRole, Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import { noopMetrics } from "../observability/metrics.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Clock } from "../shared/clock.js";
import { addMs, iso } from "../shared/clock.js";
import { AccessDeniedError, DependencyError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { PayloadCipher } from "./cipher.js";
import type { Classification } from "./contracts.js";
import type { AuthMechanism, SourceProfile } from "./profile.js";
import type { ReplayKey } from "./verifiers.js";

/** A token was presented again over different bytes (durable replay cache): refused, nothing stored. */
export class InboxReplayRefusedError extends AccessDeniedError {
  constructor() {
    super("INGRESS_REPLAYED");
  }
}

export interface AcceptInput {
  profile: SourceProfile;
  classification: Classification;
  rawBody: Buffer;
  auth: { mechanism: AuthMechanism; credentialVersion: string | null };
  /** Position of the record in its stream, for stream sources. */
  stream?: { partition: string; position: string } | null;
  /** Replay key of a token-authenticated delivery (InboundVerifier); recorded in the same transaction. */
  replay?: ReplayKey | null;
}

export interface AcceptResult {
  inboxId: string;
  duplicate: boolean;
  /** For a duplicate: whether its bytes equal the first delivery's. */
  digestMatches: boolean;
  status: "RECEIVED" | "QUARANTINED" | "PROCESSED" | "INBOUND_DEAD";
  auditEventId: string | null;
}

export interface PgInboxOptions {
  db: Db;
  cipher: PayloadCipher;
  audit: AuditWriter;
  clock: Clock;
  /** Role of the accepting process: app_runtime (gateway ingress) or app_worker (stream ingestion). */
  role?: Extract<DbRole, "app_runtime" | "app_worker">;
  /** Audit stream of the accepting instance (e.g. auditStreamName("gateway", instanceId)). */
  auditStream?: string;
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * Row-level legal-hold predicate over `inbound_events e` (RetentionJob semantics, see purgeExpiredPayloads); the
 * dataset name is the bound parameter $2 or $3.
 */
const HELD_BY_LEGAL_HOLD_P2 = `exists (select 1 from legal_holds h where h.tenant_id = e.tenant_id and h.released_at is null and (h.dataset is null or h.dataset = $2)
                 and h.subject_id is null and (h.record_key is null or h.record_key = e.inbox_id))`;
const HELD_BY_LEGAL_HOLD_P3 = `exists (select 1 from legal_holds h where h.tenant_id = e.tenant_id and h.released_at is null and (h.dataset is null or h.dataset = $3)
                 and h.subject_id is null and (h.record_key is null or h.record_key = e.inbox_id))`;

/** Advisory-lock key space of the per-event accept lock (pg_locks.classid of a waiting accept). */
export const ACCEPT_LOCK_NAMESPACE = 7300042;

export const sha256HexOf = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const AUTH_LABEL: Record<AuthMechanism, string> = {
  HMAC_SHA256_HEADER: "hmac_sha256_header",
  HMAC_SHA1_HEADER: "hmac_sha1_header",
  JWT_BEARER: "jwt_bearer",
  MTLS: "mtls",
  RECONCILE_BY_LOOKUP: "reconcile_by_lookup",
  STREAM_IAM: "stream_iam",
};
const QUARANTINE_LABEL: Record<string, string> = {
  UNKNOWN_EVENT_TYPE: "unknown_event_type",
  SCHEMA_VIOLATION: "schema_violation",
  UNKNOWN_FIELD: "unknown_field",
  PAYLOAD_UNPARSEABLE: "payload_unparseable",
  CONTRACT_UNAVAILABLE: "other",
};

export class PgInbox {
  private readonly role: Extract<DbRole, "app_runtime" | "app_worker">;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(private readonly opts: PgInboxOptions) {
    this.role = opts.role ?? "app_runtime";
    this.logger = (opts.logger ?? silentLogger).child({ component: "inbox" });
    this.metrics = opts.metrics ?? noopMetrics;
  }

  async accept(input: AcceptInput): Promise<AcceptResult> {
    const { profile, classification: c } = input;
    const tenantId = profile.tenantId;
    const digest = sha256HexOf(input.rawBody);
    const now = this.opts.clock.now();
    // Encrypt before the transaction (a KMS call never holds row locks); unused for a duplicate.
    let sealed: Awaited<ReturnType<PayloadCipher["encrypt"]>> | null = null;
    const existing = await this.lookup(tenantId, profile.sourceId, c.eventId);
    if (!existing) sealed = await this.opts.cipher.encrypt(input.rawBody, { tenantId, sourceId: profile.sourceId, eventId: c.eventId, payloadDigest: digest });
    const result = await this.opts.db.tx(
      async (tx) => {
        await tx.query("select pg_advisory_xact_lock($1, hashtext($2))", [ACCEPT_LOCK_NAMESPACE, `${tenantId}|${profile.sourceId}|${c.eventId}`]);
        if (input.replay) await this.recordReplayKey(tx, tenantId, profile.sourceId, input.replay, digest, now);
        const dup = await this.duplicateIn(tx, tenantId, profile.sourceId, c.eventId);
        if (dup) return this.recordDuplicate(tx, dup, digest, input, now);
        // The inbox never deletes rows, so an event seen by the lookup is found here; never insert without ciphertext.
        if (!sealed) throw new DependencyError("INBOX_STATE_INCONSISTENT", "FAILED", false);
        const inboxId = newId("inb");
        const quarantined = c.quarantine !== null;
        const audit = await this.opts.audit.append(
          tx,
          buildAuditInput(
            {
              tenantId,
              correlationId: inboxId,
              sourceComponent: this.role === "app_worker" ? "worker" : "gateway",
              action: quarantined ? "ingress.event.quarantined" : "ingress.event.accepted",
              outcome: quarantined ? "FAILED" : "SUCCEEDED",
              reasonCode: quarantined ? `INBOX_QUARANTINED_${c.quarantine}` : null,
              evidencePointers: [`inbox:${inboxId}`],
              dataClass: "SECURITY_AUDIT",
              ingress: {
                sourceId: profile.sourceId,
                payloadDigest: digest,
                schemaId: c.contract?.contractId ?? null,
                schemaVersion: c.contract?.version ?? null,
                authMechanism: input.auth.mechanism,
                credentialVersion: input.auth.credentialVersion,
              },
              ...(input.stream ? { sourceSequence: { sourceId: profile.sourceId, position: input.stream.position } } : c.sourceVersion ? { sourceSequence: { sourceId: profile.sourceId, position: c.sourceVersion } } : {}),
            },
            this.opts.clock,
          ),
          this.opts.auditStream,
        );
        await tx.query(
          `insert into inbound_events (inbox_id, tenant_id, source_id, event_id, event_type, schema_id, schema_version, entity_key, source_version,
             occurred_at, received_at, payload_digest, payload_bytes, payload_ciphertext, encrypted_data_key, payload_key_ref, payload_iv, payload_tag,
             cipher_kind, raw_retain_until, auth_mechanism, credential_version, stream_partition, stream_position, status, next_attempt_at,
             quarantine_reason, audit_event_id, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::timestamptz, $11::timestamptz, $12, $13, $14, $15, $16, $17, $18, $19,
             $20::timestamptz, $21, $22, $23, $24::numeric, $25, $11::timestamptz, $26, $27, $11::timestamptz)`,
          [
            inboxId,
            tenantId,
            profile.sourceId,
            c.eventId,
            c.eventType,
            c.contract?.contractId ?? null,
            c.contract?.version ?? null,
            c.entityKey,
            c.sourceVersion,
            c.occurredAt,
            iso(now),
            digest,
            input.rawBody.length,
            sealed.ciphertext,
            sealed.encryptedDataKey,
            sealed.keyRef,
            sealed.iv,
            sealed.tag,
            this.opts.cipher.kind,
            iso(addMs(now, profile.rawRetentionDays * 86_400_000)),
            input.auth.mechanism,
            input.auth.credentialVersion,
            input.stream?.partition ?? null,
            input.stream?.position ?? null,
            quarantined ? "QUARANTINED" : "RECEIVED",
            c.quarantine,
            audit.eventId,
          ],
        );
        await this.insertDelivery(tx, inboxId, tenantId, now, false, digest, true, input);
        return { inboxId, duplicate: false, digestMatches: true, status: quarantined ? ("QUARANTINED" as const) : ("RECEIVED" as const), auditEventId: audit.eventId };
      },
      { role: this.role, rls: { tenantId } },
    );
    this.count(result, input, c);
    return result;
  }

  /**
   * Durable replay cache: the first use of a token's replay key records the digest of its bytes; a later use
   * over the same bytes passes (a redelivery, deduplicated below), over other bytes it is refused. Concurrent
   * first uses serialize on the primary key (the loser waits for the winner's commit, then compares).
   */
  private async recordReplayKey(tx: Queryable, tenantId: string, sourceId: string, key: ReplayKey, digest: string, now: Date): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key.keyDigest) || Number.isNaN(key.expiresAt.getTime())) throw new DependencyError("INBOX_REPLAY_KEY_INVALID", "FAILED", false);
    const inserted = await tx.query(
      `insert into inbound_replay_keys (tenant_id, source_id, key_digest, payload_digest, first_seen_at, expires_at)
       values ($1, $2, $3, $4, $5::timestamptz, greatest($6::timestamptz, $5::timestamptz))
       on conflict (tenant_id, source_id, key_digest) do nothing returning key_digest`,
      [tenantId, sourceId, key.keyDigest, digest, iso(now), iso(key.expiresAt)],
    );
    if (inserted.rows.length === 1) return;
    const prior = await tx.query<{ payload_digest: string }>("select payload_digest from inbound_replay_keys where tenant_id = $1 and source_id = $2 and key_digest = $3", [tenantId, sourceId, key.keyDigest]);
    if (prior.rows[0]?.payload_digest === digest) return;
    this.logger.warn("inbox.replay_refused", { integration: sourceId, reasonCode: "INGRESS_REPLAYED" });
    throw new InboxReplayRefusedError();
  }

  /** Deletes replay keys whose token expired (worker role, per tenant). */
  async purgeExpiredReplayKeys(tenantId: string, limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new DependencyError("INBOX_PURGE_LIMIT_INVALID", "NOT_STARTED", false);
    const now = iso(this.opts.clock.now());
    const r = await this.opts.db.tx(
      (tx) =>
        tx.query(
          `delete from inbound_replay_keys where (tenant_id, source_id, key_digest) in (
             select tenant_id, source_id, key_digest from inbound_replay_keys where tenant_id = $1 and expires_at < $2::timestamptz order by expires_at limit $3)`,
          [tenantId, now, limit],
        ),
      { role: "app_worker", rls: { tenantId } },
    );
    return r.rowCount;
  }

  private async lookup(tenantId: string, sourceId: string, eventId: string): Promise<{ inbox_id: string } | null> {
    const r = await this.opts.db.tx(
      (tx) => tx.query<{ inbox_id: string }>("select inbox_id from inbound_events where tenant_id = $1 and source_id = $2 and event_id = $3", [tenantId, sourceId, eventId]),
      { role: this.role, rls: { tenantId } },
    );
    return r.rows[0] ?? null;
  }

  private async duplicateIn(tx: Queryable, tenantId: string, sourceId: string, eventId: string): Promise<{ inbox_id: string; payload_digest: string; status: AcceptResult["status"] } | null> {
    const r = await tx.query<{ inbox_id: string; payload_digest: string; status: AcceptResult["status"] }>(
      "select inbox_id, payload_digest, status from inbound_events where tenant_id = $1 and source_id = $2 and event_id = $3",
      [tenantId, sourceId, eventId],
    );
    return r.rows[0] ?? null;
  }

  private async recordDuplicate(
    tx: Queryable,
    row: { inbox_id: string; payload_digest: string; status: AcceptResult["status"] },
    digest: string,
    input: AcceptInput,
    now: Date,
  ): Promise<AcceptResult> {
    const matches = row.payload_digest === digest;
    await tx.query("update inbound_events set duplicate_count = duplicate_count + 1, updated_at = $2::timestamptz where inbox_id = $1", [row.inbox_id, iso(now)]);
    await this.insertDelivery(tx, row.inbox_id, input.profile.tenantId, now, true, digest, matches, input);
    if (!matches) this.logger.warn("inbox.duplicate_conflict", { inboxId: row.inbox_id, integration: input.profile.sourceId, reasonCode: "INBOX_DUPLICATE_DIGEST_MISMATCH" });
    return { inboxId: row.inbox_id, duplicate: true, digestMatches: matches, status: row.status, auditEventId: null };
  }

  private async insertDelivery(tx: Queryable, inboxId: string, tenantId: string, now: Date, duplicate: boolean, digest: string, matches: boolean, input: AcceptInput): Promise<void> {
    await tx.query(
      `insert into inbound_deliveries (delivery_id, inbox_id, tenant_id, received_at, duplicate, payload_digest, digest_matches, auth_mechanism, credential_version)
       values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9)`,
      [newId("idl"), inboxId, tenantId, iso(now), duplicate, digest, matches, input.auth.mechanism, input.auth.credentialVersion],
    );
  }

  private count(r: AcceptResult, input: AcceptInput, c: Classification): void {
    try {
      const result = r.duplicate ? (r.digestMatches ? "duplicate" : "duplicate_conflict") : r.status === "QUARANTINED" ? "quarantined" : "accepted";
      this.metrics.increment("vsp_inbox_events_total", { result, auth: AUTH_LABEL[input.auth.mechanism] });
      if (!r.duplicate && c.quarantine) this.metrics.increment("vsp_inbox_quarantined_total", { reason: QUARANTINE_LABEL[c.quarantine] ?? "other" });
    } catch {
      // metrics never change what is stored
    }
    if (!r.duplicate && c.quarantine) this.logger.warn("inbox.quarantined", { inboxId: r.inboxId, integration: input.profile.sourceId, reasonCode: `INBOX_QUARANTINED_${c.quarantine}` });
  }

  /**
   * Purges raw payloads whose retention expired, for one tenant (terminal rows only; digests and evidence
   * columns stay). Worker role under the tenant's RLS context. An active LEGAL HOLD keeps the payload (DATA-03),
   * with the predicate semantics of RetentionJob (platform/src/retention/job.ts): a hold of the tenant that is not
   * released applies when its dataset is unset or names this dataset (INBOUND_RAW_PAYLOAD_DATASET) and its record
   * key is unset or names the inbox row. A raw payload can carry any data class (business records, conversation
   * events), so a hold of ANY data class applies — over-holding, never under-holding. Inbound rows have no
   * subject column, so a subject-scoped hold cannot be resolved per row: as in RetentionJob it holds every
   * expired payload of the tenant (LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE).
   */
  async purgeExpiredPayloads(tenantId: string, limit = 500): Promise<RawPurgeReport> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new DependencyError("INBOX_PURGE_LIMIT_INVALID", "NOT_STARTED", false);
    const now = iso(this.opts.clock.now());
    const expired = `e.raw_purged_at is null and e.raw_retain_until <= $1::timestamptz and e.status in ('PROCESSED', 'INBOUND_DEAD', 'QUARANTINED')`;
    const report = await this.opts.db.tx(
      async (tx) => {
        const subjectHolds = await tx.query<{ n: number }>(
          "select count(*)::int as n from legal_holds h where h.tenant_id = $1 and h.released_at is null and h.subject_id is not null and (h.dataset is null or h.dataset = $2)",
          [tenantId, INBOUND_RAW_PAYLOAD_DATASET],
        );
        if ((subjectHolds.rows[0]?.n ?? 0) > 0) {
          const n = await tx.query<{ n: number }>(`select count(*)::int as n from inbound_events e where ${expired}`, [now]);
          return { purged: 0, held: n.rows[0]?.n ?? 0, reasonCode: "LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE" };
        }
        const heldCount = await tx.query<{ n: number }>(`select count(*)::int as n from inbound_events e where ${expired} and ${HELD_BY_LEGAL_HOLD_P2}`, [now, INBOUND_RAW_PAYLOAD_DATASET]);
        const r = await tx.query(
          `update inbound_events set payload_ciphertext = null, encrypted_data_key = null, payload_iv = null, payload_tag = null,
                  payload_key_ref = null, raw_purged_at = $1::timestamptz, updated_at = $1::timestamptz
            where inbox_id in (select e.inbox_id from inbound_events e
                                where ${expired} and not ${HELD_BY_LEGAL_HOLD_P3}
                                order by e.raw_retain_until limit $2 for update skip locked)`,
          [now, limit, INBOUND_RAW_PAYLOAD_DATASET],
        );
        return { purged: r.rowCount, held: heldCount.rows[0]?.n ?? 0, reasonCode: (heldCount.rows[0]?.n ?? 0) > 0 ? "LEGAL_HOLD_ACTIVE" : null };
      },
      { role: "app_worker", rls: { tenantId } },
    );
    if (report.held > 0) this.logger.info("inbox.purge.held", { reasonCode: report.reasonCode, held: report.held, purged: report.purged });
    return report;
  }
}

/** Dataset name of the raw replay payloads for legal holds (legal_holds.dataset). */
export const INBOUND_RAW_PAYLOAD_DATASET = "inbound_raw_payloads";

export interface RawPurgeReport {
  purged: number;
  /** Expired payloads kept because a legal hold applies. */
  held: number;
  /** LEGAL_HOLD_ACTIVE or LEGAL_HOLD_SUBJECT_SCOPE_UNRESOLVABLE when something was held; null otherwise. */
  reasonCode: string | null;
}

/** Metric label of an authentication mechanism. */
export const authLabel = (m: AuthMechanism): string => AUTH_LABEL[m];
