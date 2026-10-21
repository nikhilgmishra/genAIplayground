/**
 * Capability evidence from probe runs, and its signature (WP-06; FO-06-18, FO-06-11; OPS-03, OPS-06).
 *
 * `capabilityEvidenceFrom` turns a ProbeReport into a CapabilityEvidence record (contract
 * platform/src/protocol/connector.ts) for one capability: the probe steps, the profile's configuration
 * digest, a digest over the evidence content, and the level the caller attests (CODE_PASS,
 * EMULATOR_PASS; the vendor levels need an operator signature). The write/reconcile and freshness steps
 * are NOT_RUN unless a separately authorized sandbox run performed them, so a read-only probe can never
 * produce a PASS that claims them.
 *
 * `KmsEvidenceSigner` signs the 32 evidence-digest bytes with an asymmetric KMS key (ECDSA P-256 with
 * SHA-256, MessageType RAW); `verifyEvidenceSignature` checks it against the public key. Software never signs vendor-level
 * evidence with a fixture key (the contract refuses it) and the signer role names the accountable human
 * role whose key it is.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { CapabilityEvidence } from "../../protocol/connector.js";
import type { CapabilityEvidence as CapabilityEvidenceT, EvidenceLevel } from "../../protocol/connector.js";
import type { QualificationResult } from "../../protocol/common.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import type { ProbeReport } from "./health.js";

export interface EvidenceOptions {
  tenantId: string;
  capability: string;
  level: EvidenceLevel;
  evidenceRef: string;
  occurredAt: Date;
  expiresAt: Date;
  causationId?: string | null;
}

function overall(steps: { result: QualificationResult }[]): QualificationResult {
  if (steps.some((s) => s.result === "FAIL")) return "FAIL";
  if (steps.some((s) => s.result === "INCONCLUSIVE")) return "INCONCLUSIVE";
  const ran = steps.filter((s) => s.result !== "NOT_RUN");
  return ran.length > 1 && ran.every((s) => s.result === "PASS") ? "PASS" : "INCONCLUSIVE";
}

/** The digest the signature covers: everything the evidence asserts. */
export function evidenceContentDigest(e: Pick<CapabilityEvidenceT, "tenantId" | "profileId" | "profileConfigDigest" | "capability" | "level" | "result" | "steps" | "evidenceRef" | "occurredAt" | "expiresAt">): string {
  return sha256Hex(
    canonicalJson({ v: "capability-evidence-content.v1", tenantId: e.tenantId, profileId: e.profileId, profileConfigDigest: e.profileConfigDigest, capability: e.capability, level: e.level, result: e.result, steps: e.steps, evidenceRef: e.evidenceRef, occurredAt: e.occurredAt, expiresAt: e.expiresAt }),
  );
}

/** Unsigned evidence of one capability from a probe report (schema-validated). */
export function capabilityEvidenceFrom(report: ProbeReport, opts: EvidenceOptions): CapabilityEvidenceT {
  const readiness = report.capabilities.find((c) => c.capability === opts.capability);
  if (!readiness) throw new ValidationError("EVIDENCE_CAPABILITY_NOT_PROBED");
  const steps = [...report.steps];
  if (!steps.some((s) => s.step === "FRESHNESS_TEST")) steps.push({ step: "FRESHNESS_TEST", result: "NOT_RUN", detailCode: "FRESHNESS_TEST_NOT_RUN" });
  if (!steps.some((s) => s.step === "WRITE_RECONCILE_TEST")) steps.push({ step: "WRITE_RECONCILE_TEST", result: "NOT_RUN", detailCode: "SANDBOX_WRITE_NOT_AUTHORIZED" });
  // A capability that is not READY cannot be evidenced as passing, whatever the shared steps say.
  const result = readiness.status === "READY" ? overall(steps) : readiness.status === "NOT_READY" ? "FAIL" : "INCONCLUSIVE";
  const base = {
    schemaVersion: "capability-evidence.v1" as const,
    tenantId: opts.tenantId,
    occurredAt: opts.occurredAt.toISOString(),
    expiresAt: opts.expiresAt.toISOString(),
    causationId: opts.causationId ?? null,
    evidenceId: newId("cpe"),
    profileId: report.profileId,
    profileConfigDigest: report.configDigest,
    capability: opts.capability,
    level: opts.level,
    result,
    steps,
    evidenceRef: opts.evidenceRef,
    signature: null,
  };
  const evidence = { ...base, evidenceDigest: evidenceContentDigest(base) };
  return CapabilityEvidence.parse(evidence);
}

export interface EvidenceSigner {
  readonly keyRef: string;
  readonly signerRole: "deployment_operator" | "security_admin" | "integration_owner";
  readonly algorithm: "ECDSA_P256_SHA256";
  /** Signs the 32 bytes of the evidence digest (ECDSA P-256 over SHA-256 of them); returns the DER signature, base64url. */
  signDigest(digest: Buffer): Promise<string>;
}

export interface KmsSender {
  send(command: SignCommand | GetPublicKeyCommand): Promise<unknown>;
}

/** Signs with an asymmetric KMS key (ECC_NIST_P256, SIGN_VERIFY). The private key never leaves KMS. */
export class KmsEvidenceSigner implements EvidenceSigner {
  readonly algorithm = "ECDSA_P256_SHA256" as const;
  constructor(
    private readonly client: KmsSender,
    readonly keyRef: string,
    readonly signerRole: EvidenceSigner["signerRole"],
  ) {
    if (!/^arn:aws:kms:[A-Za-z0-9-]{1,32}:[A-Za-z0-9]{1,32}:key\/[A-Za-z0-9-]{1,128}$/.test(keyRef)) throw new ValidationError("EVIDENCE_SIGNING_KEY_INVALID");
  }

  async signDigest(digest: Buffer): Promise<string> {
    let out: unknown;
    try {
      out = await this.client.send(new SignCommand({ KeyId: this.keyRef, Message: digest, MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" }));
    } catch {
      throw new DependencyError("EVIDENCE_SIGNING_UNAVAILABLE", "NOT_STARTED", true);
    }
    const sig = (out as { Signature?: unknown } | undefined)?.Signature;
    if (!(sig instanceof Uint8Array) || sig.length < 8) throw new DependencyError("EVIDENCE_SIGNATURE_INVALID", "FAILED", false);
    return Buffer.from(sig).toString("base64url");
  }

  /** SubjectPublicKeyInfo of the signing key (DER), for verifiers that hold no KMS permission to sign. */
  async publicKeyDer(): Promise<Buffer> {
    const out = (await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyRef }))) as { PublicKey?: unknown };
    if (!(out.PublicKey instanceof Uint8Array)) throw new DependencyError("EVIDENCE_PUBLIC_KEY_UNAVAILABLE", "FAILED", false);
    return Buffer.from(out.PublicKey);
  }
}

/** Adds the signature to evidence; refuses evidence whose digest does not match its content. */
export async function signCapabilityEvidence(e: CapabilityEvidenceT, signer: EvidenceSigner, clock: Clock): Promise<CapabilityEvidenceT> {
  if (evidenceContentDigest(e) !== e.evidenceDigest) throw new ValidationError("EVIDENCE_DIGEST_MISMATCH");
  const value = await signer.signDigest(Buffer.from(e.evidenceDigest, "hex"));
  return CapabilityEvidence.parse({ ...e, signature: { signerRole: signer.signerRole, keyRef: signer.keyRef, algorithm: signer.algorithm, value, signedAt: clock.now().toISOString() } });
}

/** True when the evidence content matches its digest and the signature verifies under the public key. */
export function verifyEvidenceSignature(e: CapabilityEvidenceT, publicKeyDer: Buffer): boolean {
  if (e.signature === null || evidenceContentDigest(e) !== e.evidenceDigest) return false;
  try {
    const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return cryptoVerify("sha256", Buffer.from(e.evidenceDigest, "hex"), { key, dsaEncoding: "der" }, Buffer.from(e.signature.value, "base64url"));
  } catch {
    return false;
  }
}
