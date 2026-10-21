/**
 * Capability evidence and its signature (WP-06; FO-06-18, FO-06-11; OPS-03, OPS-06). Layer 1: the
 * production evidence builder and verifier with a LOCAL FIXTURE signer (an in-process P-256 key); the
 * production KmsEvidenceSigner signs with LocalStack KMS in the Layer-2 suite.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CapabilityEvidence } from "../../protocol/connector.js";
import { FakeClock } from "../../shared/clock.js";
import { capabilityEvidenceFrom, evidenceContentDigest, signCapabilityEvidence, verifyEvidenceSignature } from "./evidence.js";
import type { EvidenceSigner } from "./evidence.js";
import type { ProbeReport } from "./health.js";

const report = (status: "READY" | "NOT_READY" | "UNKNOWN", write: "PASS" | "NOT_RUN" = "NOT_RUN"): ProbeReport => ({
  profileId: "cnp_synthEmulatedVendor01",
  configDigest: "a".repeat(64),
  probedAt: "2026-10-19T12:00:00.000Z",
  steps: [
    { step: "VALIDATE_CONFIGURATION", result: "PASS", detailCode: "CONFIG_ADMITTED" },
    { step: "AUTHENTICATE", result: "PASS", detailCode: "TOKEN_ISSUED" },
    { step: "INSPECT_METADATA", result: "PASS", detailCode: "MAPPING_MATCHES_METADATA" },
    { step: "INSPECT_SYNTHETIC_RECORD", result: "PASS", detailCode: "SYNTHETIC_RECORD_MAPPED" },
    { step: "WRITE_RECONCILE_TEST", result: write, detailCode: write === "PASS" ? "WRITE_RECONCILED" : "SANDBOX_WRITE_NOT_AUTHORIZED" },
    { step: "COMPARE_MAPPING", result: "PASS", detailCode: "MAPPING_DIGEST_PINNED" },
  ],
  mappingDigests: { Appointment: "b".repeat(64) },
  capabilities: [{ capability: "scheduling.appointments_read", status, reasonCode: status === "READY" ? "PROBES_PASSED" : "CONNECTOR_SCHEMA_DRIFT", checkedAt: "2026-10-19T12:00:00.000Z" }],
});

const opts = { tenantId: "tnt_synthTenantConnector01", capability: "scheduling.appointments_read", level: "EMULATOR_PASS" as const, evidenceRef: "evidence/connectors/emulated-run-1", occurredAt: new Date("2026-10-19T12:00:00Z"), expiresAt: new Date("2026-11-19T12:00:00Z") };

/** LOCAL FIXTURE signer: an in-process P-256 key standing in for the operator's KMS key in Layer 1. */
function fixtureSigner(): { signer: EvidenceSigner; publicKeyDer: Buffer } {
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    signer: {
      keyRef: "arn:aws:kms:us-east-1:111122223333:key/0000-synthetic-fixture",
      signerRole: "integration_owner",
      algorithm: "ECDSA_P256_SHA256",
      signDigest: async (d) => cryptoSign("sha256", d, { key: kp.privateKey, dsaEncoding: "der" }).toString("base64url"),
    },
    publicKeyDer: kp.publicKey.export({ type: "spki", format: "der" }),
  };
}

describe("capability evidence [FO-06-18][FO-06-11][OPS-03]", () => {
  it("[FO-06-18] evidence from a READY probe is schema-valid, digested and records NOT_RUN for the steps a read probe cannot perform", () => {
    const e = capabilityEvidenceFrom(report("READY"), opts);
    expect(CapabilityEvidence.safeParse(e).success).toBe(true);
    expect(e.result).toBe("PASS");
    expect(e.steps.find((s) => s.step === "FRESHNESS_TEST")?.result).toBe("NOT_RUN");
    expect(e.evidenceDigest).toBe(evidenceContentDigest(e));
    expect(e.profileConfigDigest).toBe("a".repeat(64));
  });

  it("[OPS-03] a capability that is not READY is never evidenced as passing", () => {
    expect(capabilityEvidenceFrom(report("UNKNOWN"), opts).result).toBe("INCONCLUSIVE");
    expect(capabilityEvidenceFrom(report("NOT_READY"), opts).result).toBe("FAIL");
    expect(() => capabilityEvidenceFrom(report("READY"), { ...opts, capability: "billing.invoices_read" })).toThrow("EVIDENCE_CAPABILITY_NOT_PROBED");
  });

  it("[FO-06-18] evidence refs are signed: the signature verifies, and any change to the content breaks it", async () => {
    const { signer, publicKeyDer } = fixtureSigner();
    const signed = await signCapabilityEvidence(capabilityEvidenceFrom(report("READY"), opts), signer, new FakeClock(new Date("2026-10-19T12:01:00Z")));
    expect(signed.signature).toMatchObject({ signerRole: "integration_owner", algorithm: "ECDSA_P256_SHA256" });
    expect(verifyEvidenceSignature(signed, publicKeyDer)).toBe(true);
    const tampered = { ...signed, result: "FAIL" as const };
    expect(verifyEvidenceSignature(tampered, publicKeyDer)).toBe(false);
    const redigested = { ...tampered, evidenceDigest: evidenceContentDigest(tampered) };
    expect(verifyEvidenceSignature(redigested, publicKeyDer)).toBe(false);
    expect(verifyEvidenceSignature(signed, fixtureSigner().publicKeyDer)).toBe(false);
    await expect(signCapabilityEvidence({ ...signed, result: "FAIL" }, signer, new FakeClock(new Date()))).rejects.toThrow("EVIDENCE_DIGEST_MISMATCH");
  });

  it("[FO-06-18][OPS-03] vendor-level evidence needs a signature and never a fixture key (contract rules hold for built evidence)", () => {
    const e = capabilityEvidenceFrom(report("READY"), opts);
    expect(CapabilityEvidence.safeParse({ ...e, level: "VENDOR_SANDBOX_PASS" }).success).toBe(false);
    expect(
      CapabilityEvidence.safeParse({ ...e, level: "VENDOR_SANDBOX_PASS", signature: { signerRole: "deployment_operator", keyRef: "local-fixture:keys/evidence", algorithm: "ECDSA_P256_SHA256", value: "A".repeat(64), signedAt: "2026-10-19T12:01:00.000Z" } }).success,
    ).toBe(false);
  });
});
