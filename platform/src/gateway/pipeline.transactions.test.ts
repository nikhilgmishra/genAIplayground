/**
 * ToolPipeline transaction-safety regressions (ACT-F2, VSP-GW-04). Real policy bundle, PGlite,
 * PgAuditWriter and identity session service; LOCAL FIXTURE tools; SYNTHETIC data.
 *
 * ACT-F2: an ambiguous timeout of a tool that writes durable records (an intake) is UNKNOWN_OUTCOME,
 * its idempotency reservation is kept, and the real result settles it: a same-key retry never runs
 * the intake a second time (ACT-02, ACT-03).
 * VSP-GW-04: one idempotency-key grammar for the transport and the audit record; tool.invoke audit is
 * never silently dropped and a schema rejection is not reported as an audit outage (OPS-01, AUTH-02).
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditEventInvalidError, AuditWriterInput } from "../audit/schema.js";
import type { AuditEventInput } from "../protocol/index.js";
import type { ToolModule } from "./ports.js";
import { createGatewayHarness, ManualTimersFixture } from "./fixtures/harness.fixture.js";
import type { GatewayHarness } from "./fixtures/harness.fixture.js";
import { isAcceptedIdempotencyKey, writesDurableRecords } from "./pipeline.js";

let h: GatewayHarness;
afterEach(async () => {
  // Pure tests reuse no harness; a harness closed by an earlier test must not fail this hook.
  await h?.close().catch(() => undefined);
});

const header = (sessionRef: string) => ({ sessionRefHeader: sessionRef });

/** LOCAL TEST FIXTURE intake whose execution is held open by the test, then completes (creates one SYNTHETIC record). */
class SlowIntakeFixture {
  started = 0;
  effects: string[] = [];
  private releases: (() => void)[] = [];
  release(): void {
    for (const r of this.releases.splice(0)) r();
  }
  tool(): ToolModule {
    const input = z.strictObject({ category: z.enum(["general_question"]) });
    const output = z.strictObject({ supportReference: z.string().regex(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/), status: z.literal("ACCEPTED") });
    const module: ToolModule<z.infer<typeof input>, z.infer<typeof output>> = {
      definition: {
        name: "fixture_slow_intake",
        version: "1.0.0",
        description: "LOCAL TEST FIXTURE: intake whose execution outlives the gateway timeout (synthetic).",
        safetyClass: "INTAKE",
        dataClassification: "INTERNAL",
        minAssurance: "A0",
        permissions: ["support_request:create"],
        timeoutMs: 1_000,
        retryPolicy: { maxAttempts: 1, backoffMs: 0, jitter: false, retryOn: [] },
        idempotency: "IDEMPOTENCY_KEY_REQUIRED",
        consequential: false,
        maxInputBytes: 128,
        contracts: [],
      },
      maskTarget: { collectionKey: null, envelopeKeys: [] },
      input,
      output,
      purpose: () => "caller_self_service",
      resolveResource: async (auth) => ({ type: "support_request", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "INTERNAL", actionDigest: null }),
      execute: async () => {
        this.started += 1;
        await new Promise<void>((r) => this.releases.push(r));
        this.effects.push(`slow_intake_${this.effects.length + 1}`);
        return { status: "SUCCESS", data: { supportReference: "SR-ABCD-EFGH", status: "ACCEPTED" }, speech: null };
      },
    };
    return module as unknown as ToolModule;
  }
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
}

describe("[ACT-F2] ambiguous timeout of a tool that writes durable records", () => {
  it("[ACT-02][ACT-03][ACT-F2] intake timeout -> UNKNOWN_OUTCOME, reservation kept, same-key retry never re-executes; the real result settles it", async () => {
    const timers = new ManualTimersFixture();
    const slow = new SlowIntakeFixture();
    h = await createGatewayHarness({ timers, extraTools: () => [slow.tool()] });
    const { sessionRef } = await h.startCall();
    const key = "idem_slowIntakeKey000001";
    const args = { category: "general_question" };

    const first = h.call({ name: "fixture_slow_intake", arguments: args, idempotencyKey: key }, header(sessionRef));
    await until(() => slow.started === 1 && timers.pending.size > 0);
    timers.fireAll(); // the gateway timeout fires; the execution keeps running (it is not cancellable)
    const r1 = await first;
    expect(r1.status).toBe("UNKNOWN_OUTCOME");
    if (r1.status === "UNKNOWN_OUTCOME") {
      expect(r1.reasonCode).toBe("TIMEOUT");
      expect(r1.reconciliationRef).toBe(r1.requestId);
    }

    // The caller retries with the same key while the first execution is still in flight: not a second intake.
    const r2 = await h.call({ name: "fixture_slow_intake", arguments: args, idempotencyKey: key }, header(sessionRef));
    expect(r2.status === "RETRYABLE_FAILURE" && r2.reasonCode).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(slow.started).toBe(1);

    // The orphaned execution completes: its REAL result completes the reservation (audited as a late settlement).
    slow.release();
    await until(() => slow.effects.length === 1);
    let replay = await h.call({ name: "fixture_slow_intake", arguments: args, idempotencyKey: key }, header(sessionRef));
    for (let i = 0; i < 50 && replay.status !== "SUCCESS"; i++) {
      await tick();
      replay = await h.call({ name: "fixture_slow_intake", arguments: args, idempotencyKey: key }, header(sessionRef));
    }
    expect(replay.status).toBe("SUCCESS");
    if (replay.status === "SUCCESS") expect(replay.data.supportReference).toBe("SR-ABCD-EFGH");
    expect(slow.started).toBe(1);
    expect(slow.effects).toHaveLength(1);
    const invokes = (await h.auditRows()).filter((r) => r.action === "tool.invoke" && (r.event.evidencePointers as string[]).includes("db://tool_catalog/fixture_slow_intake/1.0.0"));
    expect(invokes.map((r) => [r.outcome, r.reason_code])).toEqual(
      expect.arrayContaining([
        ["UNKNOWN", "TIMEOUT"],
        ["SUCCEEDED", "LATE_SETTLEMENT"],
        ["SUCCEEDED", "IDEMPOTENT_REPLAY"],
      ]),
    );
  });

  it("[ACT-03][ACT-F2] an ambiguous dependency failure inside an executed intake is UNKNOWN_OUTCOME (not RETRYABLE); a provably-not-started one stays retryable", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.startCall();
    h.faults.mode = "unknown";
    const unknown = await h.call({ name: "fixture_create_request", arguments: { category: "general_question", urgency: "normal" }, idempotencyKey: "idem_intakeUnknown00001" }, header(sessionRef));
    expect(unknown.status).toBe("UNKNOWN_OUTCOME");
    // The reservation was not released: the same key does not run the intake again.
    h.faults.mode = "none";
    const again = await h.call({ name: "fixture_create_request", arguments: { category: "general_question", urgency: "normal" }, idempotencyKey: "idem_intakeUnknown00001" }, header(sessionRef));
    expect(again.status === "RETRYABLE_FAILURE" && again.reasonCode).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(h.faults.effects.filter((e) => e.startsWith("intake_"))).toHaveLength(0);
    h.faults.mode = "not_started";
    const notStarted = await h.call({ name: "fixture_create_request", arguments: { category: "general_question", urgency: "normal" }, idempotencyKey: "idem_intakeNotStarted01" }, header(sessionRef));
    expect(notStarted.status === "RETRYABLE_FAILURE" && notStarted.reasonCode).toBe("CONNECTION_REFUSED");
  });

  it("[ACT-03][ACT-F2] an unexpected output field after an executed intake is UNKNOWN_OUTCOME (the record may exist)", async () => {
    h = await createGatewayHarness({ extraTools: () => [createIntakeWithExtraField()] });
    const { sessionRef } = await h.startCall();
    const r = await h.call({ name: "fixture_intake_extra_field", arguments: { category: "general_question" }, idempotencyKey: "idem_intakeExtraField001" }, header(sessionRef));
    expect(r.status === "UNKNOWN_OUTCOME" && r.reasonCode).toBe("OUTPUT_SCHEMA_VIOLATION");
  });

  it("[ACT-F2] classification: commits, prepares, intakes and key-required tools write durable records; reads and the safety route do not", () => {
    expect(writesDurableRecords({ consequential: false, idempotency: "IDEMPOTENCY_KEY_REQUIRED", safetyClass: "INTAKE" })).toBe(true);
    expect(writesDurableRecords({ consequential: false, idempotency: "IDEMPOTENCY_KEY_REQUIRED", safetyClass: "PREPARE_MUTATION" })).toBe(true);
    expect(writesDurableRecords({ consequential: true, idempotency: "PREPARED_ACTION_DIGEST", safetyClass: "COMMIT_MUTATION" })).toBe(true);
    expect(writesDurableRecords({ consequential: false, idempotency: "NATURALLY_IDEMPOTENT", safetyClass: "PROTECTED_READ" })).toBe(false);
    expect(writesDurableRecords({ consequential: false, idempotency: "NATURALLY_IDEMPOTENT", safetyClass: "PUBLIC_READ" })).toBe(false);
    expect(writesDurableRecords({ consequential: false, idempotency: "NATURALLY_IDEMPOTENT", safetyClass: "SAFETY_AND_HUMAN_ROUTE" })).toBe(false);
  });
});

function createIntakeWithExtraField(): ToolModule {
  const input = z.strictObject({ category: z.enum(["general_question"]) });
  const output = z.strictObject({ status: z.literal("ACCEPTED") });
  const module: ToolModule<z.infer<typeof input>, z.infer<typeof output>> = {
    definition: {
      name: "fixture_intake_extra_field",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: intake whose dependency returns an unexpected field (synthetic).",
      safetyClass: "INTAKE",
      dataClassification: "INTERNAL",
      minAssurance: "A0",
      permissions: ["support_request:create"],
      timeoutMs: 1_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, jitter: false, retryOn: [] },
      idempotency: "IDEMPOTENCY_KEY_REQUIRED",
      consequential: false,
      maxInputBytes: 128,
      contracts: [],
    },
    maskTarget: { collectionKey: null, envelopeKeys: [] },
    input,
    output,
    purpose: () => "caller_self_service",
    resolveResource: async (auth) => ({ type: "support_request", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "INTERNAL", actionDigest: null }),
    execute: async () => ({ status: "SUCCESS", data: { status: "ACCEPTED", providerNote: "unexpected" } as unknown as { status: "ACCEPTED" }, speech: null }),
  };
  return module as unknown as ToolModule;
}

describe("[VSP-GW-04] one idempotency-key grammar; tool.invoke audit never silently dropped", () => {
  const PHI_SHAPED = ["2026-10-18-turn-0007-read", "turn-555-123-4567-call01", "idem-123-45-6789-abcdef", "key_10/18/2026_turn_01x"];

  it("[OPS-01][VSP-GW-04] the gateway accepts a key exactly when the audit writer would store it", () => {
    const auditKey = AuditWriterInput.shape.idempotencyKey;
    const corpus = [
      ...PHI_SHAPED,
      "_leadingUnderscoreKey01",
      "-leadingHyphenKey00001",
      "8f14e45f-ceea-467a-9575-1d1a2b3c4d5e",
      "idem_synthJourney001primary01",
      "short",
      "x".repeat(129),
      "has space in the key 0001",
      "a".repeat(128),
    ];
    for (const k of corpus) {
      const gateway = isAcceptedIdempotencyKey(k);
      if (gateway) expect(auditKey.safeParse(k).success, k).toBe(true);
      // Inside the published transport alphabet, the two rules agree.
      if (/^[A-Za-z0-9_-]{16,128}$/.test(k)) expect(gateway, k).toBe(auditKey.safeParse(k).success);
    }
    expect(PHI_SHAPED.filter((k) => /^[A-Za-z0-9_-]{16,128}$/.test(k)).every((k) => !isAcceptedIdempotencyKey(k))).toBe(true);
    expect(isAcceptedIdempotencyKey("8f14e45f-ceea-467a-9575-1d1a2b3c4d5e")).toBe(true);
  });

  it("[AUTH-02][OPS-01][VSP-GW-04] a PHI-shaped key on a protected read or an intake is refused with IDEMPOTENCY_KEY_INVALID (not AUDIT_UNAVAILABLE), and the refusal is audited", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.verifiedAveryCall();
    for (const key of ["2026-10-18-turn-0007-read", "turn-555-123-4567-call01"]) {
      const read = await h.call({ name: "fixture_get_appointments", idempotencyKey: key }, header(sessionRef));
      expect(read.status === "PERMANENT_FAILURE" && read.reasonCode).toBe("IDEMPOTENCY_KEY_INVALID");
      expect(read.auditEventId).not.toBeNull();
      const intake = await h.call({ name: "fixture_create_request", arguments: { category: "general_question", urgency: "normal" }, idempotencyKey: key }, header(sessionRef));
      expect(intake.status === "PERMANENT_FAILURE" && intake.reasonCode).toBe("IDEMPOTENCY_KEY_INVALID");
      expect(intake.auditEventId).not.toBeNull();
    }
    expect(h.faults.executions).toBe(0);
    // A conforming key works as before.
    const ok = await h.call({ name: "fixture_get_appointments", idempotencyKey: "8f14e45f-ceea-467a-9575-1d1a2b3c4d5e" }, header(sessionRef));
    expect(ok.status).toBe("SUCCESS");
    const rows = (await h.auditRows()).filter((r) => r.action === "tool.invoke");
    expect(rows.filter((r) => r.reason_code === "IDEMPOTENCY_KEY_INVALID")).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toContain("2026-10-18-turn");
    expect(JSON.stringify(rows)).not.toContain("555-123-4567");
  });

  it("[SAFE-02][OPS-01][VSP-GW-04] a safety route with a PHI-shaped key is never blocked and is still audited (without the key)", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.startCall();
    const r = await h.call({ name: "fixture_request_human", arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en" }, idempotencyKey: "2026-10-18-turn-0002-saf" }, header(sessionRef));
    expect(r.status).not.toBe("PERMANENT_FAILURE");
    expect(r.auditEventId).not.toBeNull();
    const row = (await h.auditRows()).find((x) => x.action === "tool.invoke" && x.event.idempotencyKey === null && (x.event.evidencePointers as string[]).includes("db://tool_catalog/fixture_request_human/1.0.0"));
    expect(row).toBeDefined();
  });

  it("[OPS-01][VSP-GW-04] a writer schema rejection is retried minimized (still recorded), counted and logged; an AUDIT_READ disclosure it cannot record is AUDIT_EVENT_INVALID, not a retryable outage", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.verifiedAveryCall();
    // LOCAL FIXTURE: a writer whose rules are stricter than the gateway's (rejects any idempotency key).
    const realAppend = h.audit.appendStandalone.bind(h.audit);
    h.audit.appendStandalone = async (input: AuditEventInput, stream?: string) => {
      if (input.idempotencyKey !== null) throw new AuditEventInvalidError([{ path: "idempotencyKey", code: "custom" }]);
      return realAppend(input, stream);
    };
    const r = await h.call({ name: "fixture_create_request", arguments: { category: "general_question", urgency: "normal" }, idempotencyKey: "idem_strictWriterKey0001" }, header(sessionRef));
    expect(r.status).toBe("SUCCESS");
    expect(r.auditEventId).not.toBeNull();
    expect(h.metrics.counterValue("vsp_audit_events_rejected_total", { source_component: "mcp_adapter" })).toBe(1);
    expect(h.records.some((x) => x.event === "gateway.audit.event_invalid" && x.level === "error")).toBe(true);

    // Both attempts rejected: an AUDIT_READ read returns no data and says why (not "retry in 5 s").
    h.audit.appendStandalone = async () => {
      throw new AuditEventInvalidError([{ path: "evidencePointers", code: "custom" }]);
    };
    const read = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(read.status === "PERMANENT_FAILURE" && read.reasonCode).toBe("AUDIT_EVENT_INVALID");
    expect(read.status === "SUCCESS").toBe(false);
    // A real outage is still reported as AUDIT_UNAVAILABLE (retryable).
    h.audit.appendStandalone = realAppend;
    h.audit.setOutage(true);
    const outage = await h.call({ name: "fixture_get_appointments" }, header(sessionRef));
    expect(outage.status === "RETRYABLE_FAILURE" && outage.reasonCode).toBe("AUDIT_UNAVAILABLE");
    h.audit.setOutage(false);
  });
});
