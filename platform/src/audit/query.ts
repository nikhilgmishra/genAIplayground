/**
 * Metadata-only audit search for console auditors (spec sections 13 and 16).
 *
 * Reads go through the `audit_event_metadata` view as app_auditor (default) or
 * app_console. The view filters by the transaction's RLS tenant and is a
 * security barrier; those roles have no privilege on the underlying tables, so an
 * audit-view user can read but never rewrite evidence. Audit events hold security
 * metadata only (the writer's strict schema rejects free text); sensitive content
 * lives in separately access-controlled stores referenced by evidence pointers.
 */
import { z } from "zod";
import type { Db } from "../db/types.js";
import { AuditEvent, IsoDateTime, OpaqueId, StaffRole } from "../protocol/index.js";
import type { AuditEvent as AuditEventType } from "../protocol/index.js";
import { AccessDeniedError, PlatformError, ValidationError } from "../shared/errors.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { buildAuditInput } from "./build-input.js";
import type { AuditQuery, AuditWriter } from "./ports.js";
import { guardStorage } from "./internal.js";
import { AuditAction } from "./schema.js";

export const MAX_AUDIT_QUERY_LIMIT = 200;

export const AuditSearchFilter = z
  .strictObject({
    tenantId: OpaqueId,
    correlationId: OpaqueId.optional(),
    callId: OpaqueId.optional(),
    action: AuditAction.optional(),
    from: IsoDateTime.optional(),
    to: IsoDateTime.optional(),
    limit: z.number().int().min(1).max(MAX_AUDIT_QUERY_LIMIT),
  })
  .refine((f) => !f.from || !f.to || Date.parse(f.from) <= Date.parse(f.to), { message: "from must not be after to" });
export type AuditSearchFilter = z.infer<typeof AuditSearchFilter>;

export class PgAuditQuery implements AuditQuery {
  constructor(
    private readonly db: Db,
    private readonly role: "app_auditor" | "app_console" = "app_auditor",
  ) {}

  async search(filter: Parameters<AuditQuery["search"]>[0]): Promise<AuditEventType[]> {
    const parsed = AuditSearchFilter.safeParse(filter);
    if (!parsed.success) throw new ValidationError("AUDIT_QUERY_INVALID");
    const f = parsed.data;
    const rows = await guardStorage("AUDIT_QUERY_UNAVAILABLE", () => this.db.tx(
      async (tx) =>
        (
          await tx.query<{ event: unknown }>(
            `select event from audit_event_metadata
              where tenant_id = $1
                and ($2::text is null or correlation_id = $2)
                and ($3::text is null or call_id = $3)
                and ($4::text is null or action = $4)
                and ($5::timestamptz is null or occurred_at >= $5::timestamptz)
                and ($6::timestamptz is null or occurred_at < $6::timestamptz)
              order by occurred_at desc, source_stream, sequence desc
              limit $7`,
            [f.tenantId, f.correlationId ?? null, f.callId ?? null, f.action ?? null, f.from ?? null, f.to ?? null, f.limit],
          )
        ).rows,
      { role: this.role, rls: { tenantId: f.tenantId } },
    ));
    return rows.map((r) => {
      const ev = AuditEvent.safeParse(r.event);
      // A stored event that no longer parses is an integrity problem; surface it rather than hide evidence.
      if (!ev.success || ev.data.tenantId !== f.tenantId) throw new PlatformError("AUDIT_EVENT_CORRUPT");
      return ev.data;
    });
  }
}

export interface AuditAccessor {
  tenantId: string;
  staffRef: string;
  role: z.infer<typeof StaffRole>;
  correlationId: string;
}

/**
 * Runs a search and records the access itself as audit evidence ("audit access
 * to both"). Fails closed: if the access event cannot be written, no results are
 * returned. Cross-tenant searches are refused.
 */
export async function auditedSearch(
  query: AuditQuery,
  writer: AuditWriter,
  clock: Clock,
  accessor: AuditAccessor,
  filter: Parameters<AuditQuery["search"]>[0],
): Promise<AuditEventType[]> {
  if (accessor.tenantId !== filter.tenantId) throw new AccessDeniedError("AUDIT_QUERY_CROSS_TENANT");
  if (accessor.role !== "auditor" && accessor.role !== "security_admin" && accessor.role !== "supervisor") {
    throw new AccessDeniedError("AUDIT_QUERY_ROLE_DENIED");
  }
  const results = await query.search(filter);
  await writer.appendStandalone(
    buildAuditInput({
      occurredAt: iso(clock.now()),
      tenantId: accessor.tenantId,
      correlationId: accessor.correlationId,
      sourceComponent: "console",
      actorRef: accessor.staffRef,
      role: accessor.role,
      action: "audit.query.executed",
      outcome: "SUCCEEDED",
    }),
  );
  return results;
}
