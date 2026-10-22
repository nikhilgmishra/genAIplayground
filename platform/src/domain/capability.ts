/**
 * Operator capability test of a domain connector (WP-23; FO-06-11, FO-06-74, FO-16-17, FO-00-13).
 *
 * The WP-06 connector test wizard (`probeConnector`) qualifies the transport, authentication, metadata and the
 * approved synthetic record. A DOMAIN capability needs two more facts before an operator may mark it ready:
 *   - the system's own documented visibility window (its `consistency` operation) is not longer than the window
 *     the binding's reconciliation relies on: otherwise "not found after the window" could be wrong, and an
 *     unknown write could be retried into a duplicate (ACT-03). Recorded as the FRESHNESS_TEST step;
 *   - the system reports the guarantees the binding relies on: a binding that treats absence after the dispatch
 *     deadline as definitive needs the system to enforce that deadline (REQUEST_NOT_AFTER), and a binding that binds
 *     reconciliation to a request digest needs the system to document that digest scheme
 *     (DISPATCH_DEADLINE_NOT_ENFORCED / REQUEST_DIGEST_NOT_OFFERED, same step);
 *   - a binding that proves absence by the system's FENCE needs the system to offer it (FENCE_AFTER_DEADLINE:
 *     FENCE_NOT_OFFERED), and a binding with a dispatch reservation needs the system to offer that marker
 *     (RESERVE_BEFORE_CREATE: DISPATCH_RESERVATION_NOT_OFFERED); with an authorized `fenceProbe`, a fence of a fresh
 *     synthetic request id (or reference) whose deadline has passed must come back FENCED, twice (FENCE_NOT_ENFORCED);
 *   - the synthetic record maps into the canonical contract (not only into the connector's mapping), so the
 *     domain adapter can serve it. Folded into the same step's detail code when it fails.
 * A failure of either sets every capability of the profile NOT_READY with the reason code; the evidence record
 * comes from `capabilityEvidenceFrom` (content-free, digest-bound; vendor levels must be signed by an operator).
 * Write capabilities stay UNKNOWN unless an authorized sandbox write followed by its reconcile lookup passed.
 */
import type { ConnectorRuntime } from "../connectors/runtime/connector.js";
import { capabilityEvidenceFrom } from "../connectors/runtime/evidence.js";
import { probeConnector } from "../connectors/runtime/health.js";
import type { ProbeReport, ProbeStepResult, SandboxWriteProbe } from "../connectors/runtime/health.js";
import type { CapabilityEvidence, EvidenceLevel } from "../protocol/connector.js";
import { randomBytes } from "node:crypto";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { ChangeRequests, isFenced } from "./changes.js";
import type { DomainConnector } from "./runner.js";
import { int, optStr, single, str } from "./runner.js";

export interface DomainCapabilityTestResult {
  readonly report: ProbeReport;
  /** One evidence record per capability of the profile. */
  readonly evidence: readonly CapabilityEvidence[];
  readonly reportedVisibilityWindowMs: number | null;
}

export interface DomainCapabilityTestInput {
  runtime: ConnectorRuntime;
  connector: DomainConnector;
  now: () => Date;
  level: EvidenceLevel;
  /** Evidence pointer root, e.g. `evidence://domain/capability/<run>`. */
  evidenceRef: string;
  evidenceTtlMs: number;
  /** Canonical read of the approved synthetic record through the domain adapter (null: no synthetic record). */
  canonicalSynthetic: (() => Promise<unknown>) | null;
  sandboxWrite?: SandboxWriteProbe;
  /**
   * An authorized sandbox fence (a write): a fresh synthetic request id (keyed contracts: of `operation`) or
   * reference (legacy) whose deadline passed an hour ago is fenced twice; both answers must be FENCED.
   */
  fenceProbe?: { operation: string };
  signal?: AbortSignal;
}

const reason = (e: unknown): string => (e instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(e.reasonCode) ? e.reasonCode : "DOMAIN_PROBE_FAILED");

export async function runDomainCapabilityTest(input: DomainCapabilityTestInput): Promise<DomainCapabilityTestResult> {
  const rt = input.runtime;
  if (rt.profile.profileId !== input.connector.binding.binding.connectorProfileId) throw new ValidationError("DOMAIN_RUNNER_PROFILE_MISMATCH");
  const report = await probeConnector(rt, { now: input.now, signal: input.signal, sandboxWrite: input.sandboxWrite });
  let step: ProbeStepResult;
  let reported: number | null = null;
  try {
    const consistency = single(await input.connector.run("consistency", { signal: input.signal }));
    reported = int(consistency, "visibilityWindowMs");
    const rec = input.connector.binding.binding.reconciliation;
    const declared = rec?.visibilityWindowMs ?? null;
    if (declared !== null && reported > declared) {
      step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "VISIBILITY_WINDOW_EXCEEDS_BINDING" };
    } else if (rec && rec.dispatchDeadline === "REQUEST_NOT_AFTER" && optStr(consistency, "dispatchDeadline") !== "REQUEST_NOT_AFTER") {
      step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "DISPATCH_DEADLINE_NOT_ENFORCED" };
    } else if (rec && rec.requestDigest !== null && optStr(consistency, "requestDigestScheme") !== rec.requestDigest) {
      step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "REQUEST_DIGEST_NOT_OFFERED" };
    } else if (rec && rec.fenceOperationId !== null && optStr(consistency, "absenceProof") !== "FENCE_AFTER_DEADLINE") {
      step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "FENCE_NOT_OFFERED" };
    } else if (rec && rec.dispatchReservation !== null && optStr(consistency, "dispatchReservation") !== "RESERVE_BEFORE_CREATE") {
      step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "DISPATCH_RESERVATION_NOT_OFFERED" };
    } else if (rec && rec.fenceOperationId !== null && input.fenceProbe !== undefined && !(await fenceEnforced(input.connector, input.fenceProbe.operation, input.now, input.signal))) {
      step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "FENCE_NOT_ENFORCED" };
    } else if (input.canonicalSynthetic !== null) {
      const v = await input.canonicalSynthetic();
      step = v === null ? { step: "FRESHNESS_TEST", result: "FAIL", detailCode: "SYNTHETIC_RECORD_NOT_CANONICAL" } : { step: "FRESHNESS_TEST", result: "PASS", detailCode: "VISIBILITY_WINDOW_WITHIN_BINDING" };
    } else {
      step = { step: "FRESHNESS_TEST", result: "PASS", detailCode: "VISIBILITY_WINDOW_WITHIN_BINDING" };
    }
  } catch (e) {
    step = { step: "FRESHNESS_TEST", result: "FAIL", detailCode: reason(e) };
  }
  if (step.result === "FAIL") for (const c of rt.readiness()) rt.setReadiness(c.capability, "NOT_READY", step.detailCode);
  const full: ProbeReport = { ...report, steps: [...report.steps.filter((s) => s.step !== "FRESHNESS_TEST"), step], capabilities: rt.readiness() };
  const occurredAt = input.now();
  const expiresAt = new Date(occurredAt.getTime() + input.evidenceTtlMs);
  const evidence = full.capabilities.map((c) =>
    capabilityEvidenceFrom(full, { tenantId: rt.profile.tenantId, capability: c.capability, level: input.level, evidenceRef: `${input.evidenceRef}/${c.capability}`, occurredAt, expiresAt }),
  );
  return { report: full, evidence, reportedVisibilityWindowMs: reported };
}

/** A fence of a fresh synthetic id whose deadline passed an hour ago answers FENCED, and again FENCED (idempotent). */
async function fenceEnforced(conn: DomainConnector, operation: string, now: () => Date, signal: AbortSignal | undefined): Promise<boolean> {
  const notAfter = new Date(now().getTime() - 3_600_000).toISOString();
  const token = randomBytes(18).toString("base64url");
  if (conn.binding.binding.contract === "scheduling.legacy.v1") {
    const externalRef = `vsp_${token}`;
    for (let i = 0; i < 2; i++) {
      const r = single(await conn.run("fenceReference", { params: { externalRef }, body: { notAfter }, idempotencyKey: externalRef, signal }));
      if (str(r, "referenceState") !== "FENCED") return false;
    }
    return true;
  }
  const changes = new ChangeRequests(conn);
  const requestId = `idk_${token}`;
  for (let i = 0; i < 2; i++) {
    const c = await changes.fence(requestId, operation, notAfter, signal);
    if (c === null || !isFenced(c)) return false;
  }
  return true;
}
