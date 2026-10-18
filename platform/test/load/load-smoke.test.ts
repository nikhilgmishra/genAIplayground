/**
 * LOCAL LOOPBACK load SMOKE (a few seconds; the long run is scripts/load/run-local-load.mts).
 *
 * LOCAL LOOPBACK, PGlite single connection, NOT the vendor/telephone path, NOT capacity
 * evidence. This test proves the load path works end to end and that the system stays
 * correct under concurrent traffic: every response is a SUCCESS ToolResult, nothing is
 * refused, and every successful call left a durable audit row. Throughput numbers are
 * recorded, never asserted against the 400 req/s target (that is the script's job).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOAD_LABEL, LOCAL_FIXTURE_BADGE } from "../../src/evaluation/driver/labels.js";
import { LoadTarget, phaseClean, runLoadCampaign, runPhase, writeLoadEvidence } from "./harness.js";
import type { FinalState, LoadEvidence, PhaseRecord } from "./harness.js";

/**
 * Each smoke phase sends a fixed number of requests over 8 concurrent connections, so the
 * assertions are about correctness under concurrency, not about how fast this machine is
 * (a wall-clock throughput floor failed under CPU contention from parallel test files).
 */
const SMOKE_REQUESTS = 120;

describe("LOCAL LOOPBACK load smoke (autocannon, 127.0.0.1)", () => {
  let target: LoadTarget;
  const phases: PhaseRecord[] = [];
  let final: FinalState;

  beforeAll(async () => {
    target = await LoadTarget.start({ shipIntervalMs: 500 });
    await target.shipAll();
    const before = await target.auditRows();
    target.startAuditShipping();
    phases.push(await runPhase(target, { name: "smoke.public_read", endpoint: "publicRead", connections: 8, durationS: 2, amount: SMOKE_REQUESTS }));
    phases.push(await runPhase(target, { name: "smoke.protected_read", endpoint: "protectedRead", connections: 8, durationS: 2, amount: SMOKE_REQUESTS }));
    const successes = phases.reduce((n, p) => n + p.result.status2xx - p.result.bodyNotSuccess, 0);
    final = await target.finalState(before, successes);
  }, 90_000);

  afterAll(async () => {
    await target?.close();
  });

  it("[SPEC-12.load-test] the target listens on loopback only and the two sessions sit at A0 (PUBLIC_READ) and A2+ (PROTECTED_READ)", () => {
    expect(target.endpoints.publicRead.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(target.endpoints.publicRead.safetyClass).toBe("PUBLIC_READ");
    expect(target.endpoints.publicRead.sessionAssurance).toBe("A0");
    expect(target.endpoints.protectedRead.safetyClass).toBe("PROTECTED_READ");
    expect(["A2", "A3"]).toContain(target.endpoints.protectedRead.sessionAssurance);
  });

  it("[SPEC-12.load-test][AUTH-02] PUBLIC_READ search_approved_runbook under concurrent load: every response is HTTP 200 with a SUCCESS ToolResult, no errors or timeouts", () => {
    const p = phases[0]!;
    expect(p.config.amount).toBe(SMOKE_REQUESTS);
    expect(p.result.responses).toBe(SMOKE_REQUESTS);
    expect(p.result.errors).toBe(0);
    expect(p.result.timeouts).toBe(0);
    expect(p.result.non2xx).toBe(0);
    expect(p.result.bodyNotSuccess).toBe(0);
    expect(p.result.bodyChecked).toBe(p.result.responses);
    expect(phaseClean(p)).toBe(true);
    expect(p.result.latencyMs.p50).not.toBeNull();
    expect(p.result.latencyMs.p99!).toBeGreaterThanOrEqual(p.result.latencyMs.p95!);
    expect(p.result.latencyMs.p95!).toBeGreaterThanOrEqual(p.result.latencyMs.p50!);
  });

  it("[SPEC-12.load-test][AUTH-04] PROTECTED_READ get_invoice_status on a verified synthetic session under concurrent load: every response is a SUCCESS ToolResult", () => {
    const p = phases[1]!;
    expect(p.result.responses).toBe(SMOKE_REQUESTS);
    expect(phaseClean(p)).toBe(true);
    expect(p.result.reasonCodes).toEqual({});
  });

  it("[SPEC-12.load-test][OPS-01] final state: every successful response under load left a durable audit row, and the hash chain recomputed in numeric sequence order is intact", () => {
    expect(final.successfulResponses).toBe(phases[0]!.result.responses + phases[1]!.result.responses);
    expect(final.auditRowsDelta).toBeGreaterThanOrEqual(final.successfulResponses);
    expect(final.everySuccessAudited).toBe(true);
    expect(final.auditShipFailures).toBe(0);
    expect(final.integrity.streams).toBeGreaterThan(0);
    expect(final.integrity.numericOrderChainOk).toBe(true);
  });

  // FORMERLY KNOWN FAILING, now fixed: platform/src/audit/verifier.ts ordered a stream by the
  // TEXT alias of `sequence` ("10" < "9"), so verifyStream reported SEQUENCE_GAP /
  // PREV_HASH_MISMATCH on any stream with >= 10 events. It now orders by the numeric column.
  it("[SPEC-12.load-test][OPS-01] the platform IntegrityVerifier verifies every local audit stream after load", () => {
    expect(final.integrity.localOk).toBe(true);
  });

  // FORMERLY KNOWN FAILING, now fixed: platform/src/audit/shipper.ts nextBatch selects
  // `sequence::text as sequence ... order by sequence limit $2` (line 199-200) and the previous
  // manifest with `last_sequence::text as last_sequence ... order by last_sequence desc` (line
  // 190-191), so ORDER BY binds to the TEXT alias. As soon as a stream has >= 10 unshipped events
  // the first row is not the expected sequence and every later run stops with AUDIT_CHAIN_GAP:
  // shipping stalls permanently and the backlog only grows (in deployment this ends in
  // AUDIT_BACKLOG_EXCEEDED, which fences consequential actions). Fix: order by the column
  // (`order by audit_outbox.sequence`, `order by audit_manifests.last_sequence desc`) or alias the
  // text projections differently (same fix at shipper.ts:260-261 and :333-335, verifier.ts:281-283, :415).
  it("[SPEC-12.load-test][OPS-01] audit shipping keeps up under load: no stream blocked and no unshipped backlog after the final ship pass", () => {
    expect(final.auditShipBlockedRuns).toBe(0);
    expect(final.auditShipBlockedReasons).toEqual({});
    expect(final.auditBacklogAfterShip).toBe(0);
  });

  it("[SPEC-12.load-test] the evidence record is labelled LOCAL LOOPBACK / NOT capacity evidence and is written exclusively", async () => {
    const root = mkdtempSync(join(tmpdir(), "vsp-load-smoke-"));
    try {
      const ev = await runLoadCampaign({ command: "vitest load-smoke (embedded mini campaign)", phases: [{ name: "sustained.smoke_public_read", endpoint: "publicRead", connections: 4, durationS: 1, overallRate: 50 }] });
      const path = writeLoadEvidence(ev, root);
      const back = JSON.parse(readFileSync(path, "utf8")) as LoadEvidence;
      expect(back.label).toBe(LOAD_LABEL);
      expect(back.label).toBe("LOCAL LOOPBACK, PGlite single connection, NOT the vendor/telephone path, NOT capacity evidence");
      expect(back.badge).toBe(LOCAL_FIXTURE_BADGE);
      expect(back.notCapacityEvidence).toBe(true);
      expect(back.executionMode).toBe("local_fixture");
      expect(back.phases[0]!.config.overallRate).toBe(50);
      expect(back.phases[0]!.sustainedTargetMet).toBe(false); // 50 req/s is below the 400 req/s target by construction
      expect(back.verdict.sustainedTargetMet).toBe(false);
      expect(() => writeLoadEvidence(ev, root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
