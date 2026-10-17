/**
 * LOCAL TEST FIXTURE helpers for audit tests. SYNTHETIC data only, drawn from
 * platform/src/fixtures/synthetic-world.ts.
 */
import { CALLS, OTHER_TENANT_ID, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import type { Db } from "../db/types.js";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import type { AuditEventInput } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { buildAuditInput } from "./build-input.js";
import type { AuditInputFields } from "./build-input.js";

export { TENANT_ID, OTHER_TENANT_ID };

/** Fresh PGlite with the foundation + audit (02xx) migrations only. */
export const createAuditTestDb = (): Promise<PgliteDb> => createTestDb({ include: /^02/ });

/** A valid SYNTHETIC audit input for a committed appointment change. */
export function sampleAuditInput(clock: Clock, overrides: Partial<AuditInputFields> = {}): AuditEventInput {
  return buildAuditInput({
    occurredAt: iso(clock.now()),
    tenantId: TENANT_ID,
    correlationId: "cor_synthCorrelation0001",
    sourceComponent: "actions",
    actorRef: PEOPLE.avery.actorId,
    subjectRef: PEOPLE.avery.subjectId,
    role: "client",
    callId: CALLS.primary.callId,
    sessionRef: "ses_synthSessionPrimary000000001",
    sessionGeneration: 1,
    turnId: "turn_synthTurn0001",
    action: "action.commit.succeeded",
    assurance: "A3",
    evidencePointers: ["ledger://actions/act_synthActionPrimary01"],
    idempotencyKey: "idem_synthActionPrimary01",
    outcome: "SUCCEEDED",
    ...overrides,
  });
}

/** Appends n events through `append` with distinct idempotency keys. */
export async function appendMany(
  n: number,
  append: (input: AuditEventInput) => Promise<unknown>,
  clock: Clock,
  overrides: Partial<AuditInputFields> = {},
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await append(sampleAuditInput(clock, { idempotencyKey: `idem_${newId("act").slice(4)}`, ...overrides }));
  }
}

export async function countRows(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.tx((tx) => tx.query<{ n: unknown }>(sql, params), { role: "owner" });
  return Number(r.rows[0]?.n ?? 0);
}
