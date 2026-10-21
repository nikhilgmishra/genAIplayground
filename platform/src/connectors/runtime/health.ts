/**
 * Active health probes and per-capability readiness (WP-06; FO-06-11; OPS-02, OPS-03).
 *
 * A connector is never "healthy" because nothing failed yet: until a probe ran, every capability is
 * UNKNOWN (CONNECTOR_NEVER_PROBED) and `health()` is unhealthy. A probe runs the steps of the connector
 * test wizard that need no write: authenticate every capability credential, fetch metadata and compare it
 * with the compiled mappings, read the approved synthetic record through the production mapping. It
 * never throws; every failure becomes a step result and a readiness row:
 *   READY      authentication passed and every declared active probe passed (at least one declared);
 *   NOT_READY  authentication or a probe request failed (reason code of the failure);
 *   UNKNOWN    never probed, no active probe declared, or the mapping drifted (requalify first).
 * A WRITE capability is never READY from read probes alone: it stays UNKNOWN
 * (WRITE_RECONCILE_TEST_NOT_RUN) unless the caller passes an authorized sandbox write, which runs only
 * on a SANDBOX_WRITE profile: the write with a server-derived idempotency key, then its reconcile lookup.
 * A sandbox write passed for a READ_ONLY or PRODUCTION_WRITE profile is never sent; the step reports
 * NOT_RUN WRITE_TEST_REQUIRES_SANDBOX_PROFILE. `verifyPendingCredentials` is the rotation test: it
 * authenticates each credential's AWSPENDING version without changing readiness or the traffic credential.
 */
import type { QualificationResult } from "../../protocol/common.js";
import type { WizardStep } from "../../protocol/connector.js";
import { PlatformError } from "../../shared/errors.js";
import { ConnectorSchemaDriftError } from "../dsl/errors.js";
import type { CapabilityReadiness, ConnectorRuntime } from "./connector.js";

export interface ProbeStepResult {
  step: WizardStep;
  result: QualificationResult;
  detailCode: string;
}

export interface ProbeReport {
  profileId: string;
  configDigest: string;
  probedAt: string;
  steps: ProbeStepResult[];
  /** Mapping digest per source object checked by the probe. */
  mappingDigests: Record<string, string>;
  capabilities: CapabilityReadiness[];
}

const reason = (e: unknown): string => (e instanceof PlatformError ? e.reasonCode : "PROBE_FAILED");

export interface SandboxWriteProbe {
  operationId: string;
  input: { params: Record<string, string | number>; body: Record<string, unknown>; idempotencyKey: string };
}

export async function probeConnector(rt: ConnectorRuntime, opts: { signal?: AbortSignal; now: () => Date; sandboxWrite?: SandboxWriteProbe }): Promise<ProbeReport> {
  const p = rt.profile;
  const steps: ProbeStepResult[] = [{ step: "VALIDATE_CONFIGURATION", result: "PASS", detailCode: "CONFIG_ADMITTED" }];
  const enabled = p.operations.filter((o) => o.enabled && o.capability);
  const capabilities = [...new Set(enabled.map((o) => o.capability as string))].sort();
  const authFail = new Map<string, string>();
  for (const cap of capabilities) {
    for (const access of ["READ", "WRITE"] as const) {
      if (!enabled.some((o) => o.capability === cap && (o.kind === "WRITE") === (access === "WRITE"))) continue;
      const cred = (p.capabilityCredentials ?? []).find((c) => c.capability === cap && c.access === access);
      if (!cred) {
        authFail.set(cap, "CAPABILITY_CREDENTIAL_MISSING");
        continue;
      }
      try {
        await rt.tokens.grant(cred, "probe.authenticate");
      } catch (e) {
        authFail.set(cap, reason(e));
      }
    }
  }
  steps.push(authFail.size === 0 ? { step: "AUTHENTICATE", result: "PASS", detailCode: "TOKEN_ISSUED" } : { step: "AUTHENTICATE", result: "FAIL", detailCode: [...authFail.values()][0] ?? "AUTH_FAILED" });

  const drifted = new Set<string>();
  const failed = new Map<string, string>();
  const mappingDigests: Record<string, string> = {};
  const capsOf = (obj: string | null | undefined) => enabled.filter((o) => o.responseObject === obj).map((o) => o.capability as string);
  const h = p.health;
  let metadataDeclared = false;
  if (h?.metadataOperationId) {
    metadataDeclared = true;
    try {
      const issues = await rt.validateMappings(opts.signal);
      const driftObjects = Object.entries(issues).filter(([, list]) => list.length > 0).map(([obj]) => obj);
      for (const obj of Object.keys(issues)) {
        const m = rt.mappingFor(obj);
        if (m) mappingDigests[obj] = m.digest;
      }
      for (const obj of driftObjects) for (const c of capsOf(obj)) drifted.add(c);
      steps.push(driftObjects.length === 0 ? { step: "INSPECT_METADATA", result: "PASS", detailCode: "MAPPING_MATCHES_METADATA" } : { step: "INSPECT_METADATA", result: "FAIL", detailCode: "CONNECTOR_SCHEMA_DRIFT" });
    } catch (e) {
      for (const c of capabilities) failed.set(c, reason(e));
      steps.push({ step: "INSPECT_METADATA", result: "FAIL", detailCode: reason(e) });
    }
  } else {
    steps.push({ step: "INSPECT_METADATA", result: "NOT_RUN", detailCode: "METADATA_PROBE_NOT_DECLARED" });
  }

  let syntheticDeclared = false;
  if (h?.syntheticRecord) {
    syntheticDeclared = true;
    const op = p.operations.find((o) => o.operationId === h.syntheticRecord?.operationId);
    const caps = op?.capability ? [op.capability] : [];
    try {
      const params = Object.fromEntries(h.syntheticRecord.params.map((x) => [x.name, x.value]));
      const r = await rt.execute(h.syntheticRecord.operationId, { params, signal: opts.signal });
      if (r.mappingDigest && op?.responseObject) mappingDigests[op.responseObject] = r.mappingDigest;
      if (r.records.length === 0) {
        for (const c of caps) failed.set(c, "SYNTHETIC_RECORD_ABSENT");
        steps.push({ step: "INSPECT_SYNTHETIC_RECORD", result: "FAIL", detailCode: "SYNTHETIC_RECORD_ABSENT" });
      } else {
        steps.push({ step: "INSPECT_SYNTHETIC_RECORD", result: "PASS", detailCode: "SYNTHETIC_RECORD_MAPPED" });
      }
    } catch (e) {
      if (e instanceof ConnectorSchemaDriftError) for (const c of caps) drifted.add(c);
      else for (const c of caps) failed.set(c, reason(e));
      steps.push({ step: "INSPECT_SYNTHETIC_RECORD", result: "FAIL", detailCode: reason(e) });
    }
  } else {
    steps.push({ step: "INSPECT_SYNTHETIC_RECORD", result: "NOT_RUN", detailCode: "SYNTHETIC_PROBE_NOT_DECLARED" });
  }
  // Write capabilities: only an authorized sandbox write followed by its reconcile lookup can qualify them.
  const writeCaps = new Set(enabled.filter((o) => o.kind === "WRITE").map((o) => o.capability as string));
  const writeResult = new Map<string, { ok: boolean; code: string }>();
  const w = opts.sandboxWrite;
  if (w && p.writeMode !== "SANDBOX_WRITE") {
    // A requested test write never runs against a READ_ONLY or PRODUCTION_WRITE profile (OPS-04, ACT-03).
    steps.push({ step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "WRITE_TEST_REQUIRES_SANDBOX_PROFILE" });
  } else if (writeCaps.size > 0) {
    const wop = w ? enabled.find((o) => o.operationId === w.operationId && o.kind === "WRITE") : undefined;
    if (!w || !wop) {
      steps.push({ step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "SANDBOX_WRITE_NOT_AUTHORIZED" });
    } else {
      try {
        await rt.execute(w.operationId, { ...w.input, signal: opts.signal });
        const rec = await rt.reconcile(w.operationId, { params: w.input.params, signal: opts.signal });
        writeResult.set(wop.capability as string, rec.found ? { ok: true, code: "WRITE_RECONCILED" } : { ok: false, code: "WRITE_NOT_FOUND_BY_RECONCILE" });
      } catch (e) {
        writeResult.set(wop.capability as string, { ok: false, code: reason(e) });
      }
      const r = writeResult.get(wop.capability as string);
      steps.push({ step: "WRITE_RECONCILE_TEST", result: r?.ok ? "PASS" : "FAIL", detailCode: r?.code ?? "WRITE_TEST_FAILED" });
    }
  }
  const mapStepsPassed = steps.filter((s) => s.step === "INSPECT_METADATA" || s.step === "INSPECT_SYNTHETIC_RECORD");
  steps.push(
    drifted.size > 0
      ? { step: "COMPARE_MAPPING", result: "FAIL", detailCode: "CONNECTOR_SCHEMA_DRIFT" }
      : mapStepsPassed.some((s) => s.result === "PASS") && !mapStepsPassed.some((s) => s.result === "FAIL")
        ? { step: "COMPARE_MAPPING", result: "PASS", detailCode: "MAPPING_DIGEST_PINNED" }
        : { step: "COMPARE_MAPPING", result: "INCONCLUSIVE", detailCode: "MAPPING_NOT_COMPARED" },
  );

  for (const cap of capabilities) {
    if (authFail.has(cap)) rt.setReadiness(cap, "NOT_READY", authFail.get(cap) ?? "AUTH_FAILED");
    else if (drifted.has(cap)) rt.setReadiness(cap, "UNKNOWN", "CONNECTOR_SCHEMA_DRIFT");
    else if (failed.has(cap)) rt.setReadiness(cap, "NOT_READY", failed.get(cap) ?? "PROBE_FAILED");
    else if (!metadataDeclared && !syntheticDeclared) rt.setReadiness(cap, "UNKNOWN", "NO_ACTIVE_PROBE");
    else if (writeCaps.has(cap) && !writeResult.has(cap)) rt.setReadiness(cap, "UNKNOWN", "WRITE_RECONCILE_TEST_NOT_RUN");
    else if (writeCaps.has(cap) && writeResult.get(cap)?.ok !== true) rt.setReadiness(cap, "NOT_READY", writeResult.get(cap)?.code ?? "WRITE_TEST_FAILED");
    else rt.setReadiness(cap, "READY", "PROBES_PASSED");
  }
  return { profileId: p.profileId, configDigest: p.configDigest, probedAt: opts.now().toISOString(), steps, mappingDigests, capabilities: rt.readiness() };
}

export interface PendingCredentialCheck {
  capability: string;
  access: "READ" | "WRITE";
  result: QualificationResult;
  detailCode: string;
  /** Secrets Manager version id of the pending secret that authenticated (content-free; null when none did). */
  secretVersionId: string | null;
}

/**
 * Rotation test (docs/RUNBOOKS/secret-rotation.md, step 1; FO-06-04, FO-15-26): before AWSCURRENT moves,
 * every enabled capability credential's AWSPENDING version must authenticate at the vendor:
 *   OAuth schemes          a token request with the pending secret (the vendor accepting the client);
 *   the read credential    of the declared synthetic-record probe: the synthetic read with the pending
 *                          credential (the only test for API-key and self-signed JWT schemes);
 *   otherwise              NOT_RUN PENDING_CREDENTIAL_NOT_TESTABLE (a write is never sent to test one).
 * Traffic keeps using AWSCURRENT and readiness is not changed: a pending value the vendor refuses says
 * nothing about the credential in use. Never throws; each credential gets a row.
 */
export async function verifyPendingCredentials(rt: ConnectorRuntime, opts: { signal?: AbortSignal } = {}): Promise<PendingCredentialCheck[]> {
  const p = rt.profile;
  const enabled = p.operations.filter((o) => o.enabled && o.capability);
  const oauth = p.auth?.scheme === "OAUTH2_CLIENT_CREDENTIALS" || p.auth?.scheme === "OAUTH2_JWT_BEARER";
  const synthetic = p.health?.syntheticRecord ?? null;
  const syntheticCapability = synthetic ? (p.operations.find((o) => o.operationId === synthetic.operationId)?.capability ?? null) : null;
  const out: PendingCredentialCheck[] = [];
  for (const cred of p.capabilityCredentials ?? []) {
    if (!enabled.some((o) => o.capability === cred.capability && (o.kind === "WRITE") === (cred.access === "WRITE"))) continue;
    const row = (result: QualificationResult, detailCode: string, secretVersionId: string | null) => out.push({ capability: cred.capability, access: cred.access, result, detailCode, secretVersionId });
    // A fresh read of the pending version: never a token cached from an earlier test.
    rt.tokens.invalidate(cred, "AWSPENDING");
    try {
      let version: string | null = null;
      if (oauth) version = (await rt.tokens.grant(cred, "probe.pending_credential", "AWSPENDING")).secretVersionId;
      if (cred.access === "READ" && synthetic && syntheticCapability === cred.capability) {
        const params = Object.fromEntries(synthetic.params.map((x) => [x.name, x.value]));
        const r = await rt.execute(synthetic.operationId, { params, signal: opts.signal, credentialStage: "AWSPENDING" });
        version = r.receipt.secretVersionId;
        if (r.records.length > 0) row("PASS", "PENDING_CREDENTIAL_READ_SYNTHETIC", version);
        else row("FAIL", "SYNTHETIC_RECORD_ABSENT", version);
      } else if (oauth) {
        row("PASS", "PENDING_TOKEN_ISSUED", version);
      } else {
        row("NOT_RUN", "PENDING_CREDENTIAL_NOT_TESTABLE", null);
      }
    } catch (e) {
      row("FAIL", reason(e), null);
    }
  }
  return out;
}
