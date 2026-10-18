/**
 * Database outage at the gateway (spec section 12: "A database outage must block protected
 * reads and writes, while the telephone route remains usable"). LOCAL FIXTURE gateway harness:
 * PGlite with the real PgAuditWriter and tool-request idempotency store, real policy bundle,
 * LOCAL FIXTURE tools; SYNTHETIC data. The outage is simulated by making every database call
 * on the harness connection reject.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayHarness } from "./fixtures/harness.fixture.js";
import type { GatewayHarness } from "./fixtures/harness.fixture.js";

let h: GatewayHarness;
let restore: (() => void) | null = null;

beforeEach(async () => {
  h = await createGatewayHarness();
});
afterEach(async () => {
  restore?.();
  restore = null;
  await h?.close();
});

const header = (sessionRef: string) => ({ sessionRefHeader: sessionRef });

/** LOCAL FIXTURE outage: query, exec and tx on the harness database all reject until restored. */
function databaseOutage(): void {
  const db = h.db as unknown as Record<string, unknown>;
  const down = async () => {
    throw new Error("LOCAL_FIXTURE_DATABASE_OUTAGE");
  };
  for (const m of ["query", "exec", "tx"]) db[m] = down;
  restore = () => {
    for (const m of ["query", "exec", "tx"]) delete db[m];
  };
}

describe("ToolPipeline — database outage", () => {
  it("[SPEC-12.db-outage] a protected read and a durable-record write are refused: no protected data, no execution", async () => {
    const { sessionRef } = await h.verifiedAveryCall();
    const baseline = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(baseline.status).toBe("SUCCESS");
    expect(JSON.stringify(baseline)).toContain("Dr. Morgan");
    const effects = h.faults.effects.length;

    databaseOutage();
    const read = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(read.status).not.toBe("SUCCESS");
    expect(JSON.stringify(read)).not.toContain("Dr. Morgan");
    expect(read.speech).toBeNull();
    const executions = h.faults.executions;

    // A write whose request record lives in the database (IDEMPOTENCY_KEY_REQUIRED) never executes.
    // A consequential commit over the real business modules is covered in src/business/db-outage.test.ts.
    const intake = await h.call({ name: "fixture_create_request", arguments: { category: "general_question", urgency: "normal" }, idempotencyKey: "idem_fixtureKey_000099" }, header(sessionRef));
    expect(intake.status).not.toBe("SUCCESS");
    expect(h.faults.effects.length).toBe(effects);
    expect(h.faults.executions).toBe(executions);
  });

  it("[SPEC-12.db-outage][SAFE-02] the human route still answers during the outage, with and without a session", async () => {
    const { sessionRef } = await h.startCall();
    databaseOutage();
    for (const transport of [header(sessionRef), {}]) {
      const r = await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" } }, transport);
      expect(r.status).toBe("PENDING");
    }
  });
});
