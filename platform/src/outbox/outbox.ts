/**
 * Transactional outbox (spec section 8). `enqueue` runs inside the caller's transaction so a
 * message exists if and only if the state change it announces committed. Duplicate logical
 * messages (same dedupeKey within the tenant) are ignored at enqueue time.
 *
 * Payloads are restricted to opaque references and codes: free text (anything with spaces,
 * phone-number-like or date-of-birth-like values) is rejected so PHI cannot ride the transport.
 */
import { z } from "zod";
import type { Queryable } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { canonicalJson, digestOf } from "../shared/canonical.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { Outbox, OutboxMessageInput } from "./ports.js";

export const OUTBOX_TOPICS = [
  "support_request.sync",
  "workflow.start",
  "workflow.signal",
  "notification.send",
  "audit.ship",
  "action.committed",
] as const satisfies readonly OutboxMessageInput["topic"][];

export const OUTBOX_MAX_PAYLOAD_BYTES = 8 * 1024;

const OPAQUE_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const UPPER_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const LOWER_TOKEN = /^[a-z][a-z0-9_.:@/-]{0,127}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SUPPORT_REF = /^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const DIGIT_RUN = /\d{4,}/;

/** A string value is allowed only in an opaque/code shape (never free text). */
export function isOpaquePayloadString(v: string): boolean {
  if (OPAQUE_ID.test(v) || UPPER_CODE.test(v) || ISO_TS.test(v) || SHA256.test(v) || SEMVER.test(v) || SUPPORT_REF.test(v)) return true;
  return LOWER_TOKEN.test(v) && !DIGIT_RUN.test(v);
}

const PAYLOAD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function validatePayloadValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 200 && isOpaquePayloadString(value);
  if (Array.isArray(value)) return value.length <= 32 && value.every((v) => validatePayloadValue(v, depth + 1));
  if (typeof value === "object") {
    if (depth >= 3) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 32 && entries.every(([k, v]) => PAYLOAD_KEY.test(k) && validatePayloadValue(v, depth + 1));
  }
  return false;
}

export const OutboxPayload = z
  .record(z.string(), z.unknown())
  .refine((p) => validatePayloadValue(p, 0), { message: "OUTBOX_PAYLOAD_NOT_OPAQUE" })
  .refine((p) => Buffer.byteLength(canonicalJson(p)) <= OUTBOX_MAX_PAYLOAD_BYTES, { message: "OUTBOX_PAYLOAD_TOO_LARGE" });

export const OutboxMessageInputSchema = z.strictObject({
  topic: z.enum(OUTBOX_TOPICS),
  key: z.string().regex(/^[A-Za-z0-9_.:@/-]{1,128}$/),
  payload: OutboxPayload,
  dedupeKey: z.string().regex(/^[A-Za-z0-9_.:@/-]{8,200}$/),
});

export interface PgOutboxOptions {
  clock: Clock;
  logger?: Logger;
}

export class PgOutbox implements Outbox {
  private readonly logger: Logger;
  constructor(private readonly opts: PgOutboxOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  async enqueue(tx: Queryable, message: OutboxMessageInput): Promise<string> {
    const parsed = OutboxMessageInputSchema.safeParse(message);
    if (!parsed.success) {
      const notOpaque = parsed.error.issues.some((i) => i.message === "OUTBOX_PAYLOAD_NOT_OPAQUE");
      const tooLarge = parsed.error.issues.some((i) => i.message === "OUTBOX_PAYLOAD_TOO_LARGE");
      throw new ValidationError(notOpaque ? "OUTBOX_PAYLOAD_NOT_OPAQUE" : tooLarge ? "OUTBOX_PAYLOAD_TOO_LARGE" : "OUTBOX_MESSAGE_INVALID");
    }
    const m = parsed.data;
    const tenant = (await tx.query<{ t: string | null }>("select app_tenant() as t")).rows[0]?.t ?? null;
    if (!tenant) throw new ValidationError("OUTBOX_TENANT_CONTEXT_REQUIRED");
    const messageId = newId("msg");
    const now = iso(this.opts.clock.now());
    const inserted = await tx.query<{ message_id: string }>(
      `insert into outbox_messages (message_id, tenant_id, topic, key, payload, dedupe_key, status, attempts,
                                    next_attempt_at, created_at, updated_at)
       values ($1, app_tenant(), $2, $3, $4::jsonb, $5, 'PENDING', 0, $6, $6, $6)
       on conflict (tenant_id, dedupe_key) do nothing
       returning message_id`,
      [messageId, m.topic, m.key, JSON.stringify(m.payload), m.dedupeKey, now],
    );
    if (inserted.rows[0]) return inserted.rows[0].message_id;
    const existing = await tx.query<{ message_id: string; topic: string; payload: unknown }>(
      "select message_id, topic, payload from outbox_messages where tenant_id = app_tenant() and dedupe_key = $1",
      [m.dedupeKey],
    );
    const row = existing.rows[0];
    if (!row) throw new ValidationError("OUTBOX_DEDUPE_LOOKUP_FAILED");
    if (row.topic !== m.topic || digestOf(row.payload) !== digestOf(m.payload)) {
      this.logger.warn("outbox.enqueue.dedupe_conflict", { messageId: row.message_id, topic: m.topic });
    }
    return row.message_id;
  }
}
