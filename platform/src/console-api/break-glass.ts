/**
 * Break-glass grants (spec section 7): emergency access is time-bound,
 * justified, approved by someone else and reviewed; the model can never request
 * or grant it. The console only READS authoritative grant records
 * (migration 0900 `console_break_glass_grants`, written by the separate audited
 * access process) and maps them into the console policy input. It has no grant
 * or request endpoint, and a break-glass grant never adds a role.
 *
 * Expired, not-yet-valid, over-long and self-granted grants are passed to the
 * policy unchanged so that it denies with the precise reason
 * (BREAK_GLASS_EXPIRED, BREAK_GLASS_SELF_GRANTED, ...). The database also
 * refuses self-granted rows (`approved_by <> staff_id`).
 */
import type { Db } from "../db/types.js";
import type { Logger } from "../observability/ports.js";
import { BreakGlassJustification } from "../policy/catalogue.js";
import type { ConsoleBreakGlass } from "../policy/console.js";
import { iso } from "../shared/clock.js";

export interface BreakGlassGrantSource {
  readonly kind: "local_fixture" | "live";
  /** The grant to evaluate for this staff member now (prefers a currently valid one), or null. */
  grantFor(tenantId: string, staffId: string, now: Date): Promise<ConsoleBreakGlass | null>;
}

interface GrantRow {
  grant_id: string;
  approved_by: string;
  justification_code: string;
  granted_at: Date | string;
  expires_at: Date | string;
}

const toIso = (v: Date | string): string => new Date(v).toISOString();

/** Reads `console_break_glass_grants` as app_console under tenant RLS. */
export class PgBreakGlassGrantSource implements BreakGlassGrantSource {
  readonly kind = "live" as const;

  constructor(
    private readonly db: Db,
    private readonly logger?: Logger,
  ) {}

  async grantFor(tenantId: string, staffId: string, now: Date): Promise<ConsoleBreakGlass | null> {
    const rows = await this.db.tx(
      async (tx) =>
        (
          await tx.query<GrantRow>(
            `select grant_id, approved_by, justification_code, granted_at, expires_at
               from console_break_glass_grants
              where tenant_id = $1 and staff_id = $2 and revoked_at is null
              order by (granted_at <= $3::timestamptz and expires_at > $3::timestamptz) desc, granted_at desc
              limit 1`,
            [tenantId, staffId, iso(now)],
          )
        ).rows,
      { role: "app_console", rls: { tenantId, actorId: staffId } },
    );
    const r = rows[0];
    if (!r) return null;
    const justification = BreakGlassJustification.safeParse(r.justification_code);
    if (!justification.success) {
      // Not a recognised justification: the grant cannot authorize anything; treat as absent.
      this.logger?.warn("console.break_glass.justification_unrecognised", { grantId: r.grant_id, reasonCode: "BREAK_GLASS_JUSTIFICATION_INVALID" });
      return null;
    }
    return { grantId: r.grant_id, approvedBy: r.approved_by, justificationCode: justification.data, grantedAt: toIso(r.granted_at), expiresAt: toIso(r.expires_at) };
  }
}

/** Currently valid (started, unexpired, not self-granted) grant, or null. Used for display and downstream StaffActor. */
export function activeGrant(grant: ConsoleBreakGlass | null, staffId: string, now: Date): ConsoleBreakGlass | null {
  if (!grant) return null;
  if (grant.approvedBy === staffId) return null;
  const t = now.getTime();
  return Date.parse(grant.grantedAt) <= t && Date.parse(grant.expiresAt) > t ? grant : null;
}
