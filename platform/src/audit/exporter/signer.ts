/**
 * Audit manifest signatures (follow-on FO-15-38; prompt section 15 "immutable manifests/signatures").
 *
 * The exporter signs every manifest it ships with an asymmetric KMS key held in the audit account; the
 * separate verifier checks the signature with the public key only (kms:GetPublicKey or a pinned SPKI),
 * never with signing authority. The signed content is
 *   "vsp.audit.manifest.sig.v1\n" + canonical JSON of the manifest without `signature`
 * so `signedAt` and `signerRole` are covered too, and every field that describes the batch (stream,
 * sequence range, first/last hash, batch digest, object key) is bound to the signature.
 *
 *  - KmsManifestSigner (kind "live"): KMS Sign, SigningAlgorithm ECDSA_SHA_256, MessageType RAW over the
 *    signing input (KMS hashes it with SHA-256; at most 4096 bytes); the DER signature is stored base64url. The key must be ECC_NIST_P256
 *    with SIGN_VERIFY usage (checked through GetPublicKey before the first signature).
 *  - LocalManifestSignerFixture (kind "local_fixture"): in-process P-256 key, keyRef "local-fixture:...",
 *    for unit tests and the offline composition only (production configuration rejects it, OPS-04).
 *  - ManifestSignatureVerifier: trusted public keys by keyRef; an unsigned, partially signed, unknown-key
 *    or invalid manifest is a finding, never a pass.
 */
import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { AuditManifest, manifestSignaturePresent } from "../../protocol/index.js";
import type { AuditManifest as AuditManifestT, AuditManifestSignature } from "../../protocol/index.js";
import { canonicalJson } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { iso } from "../../shared/clock.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";

export const MANIFEST_SIGNATURE_CONTEXT = "vsp.audit.manifest.sig.v1";
const KMS_RAW_LIMIT = 4096;

/** Bytes that are signed for a manifest (signature removed, signedAt / signerRole kept). */
export function manifestSigningInput(m: AuditManifestT): Buffer {
  const { signature: _omit, ...rest } = m;
  return Buffer.from(`${MANIFEST_SIGNATURE_CONTEXT}\n${canonicalJson(rest)}`, "utf8");
}

export interface ManifestSigner {
  readonly kind: "local_fixture" | "live";
  /** Returns the manifest with signature, signedAt and signerRole set. */
  sign(manifest: AuditManifestT): Promise<AuditManifestT>;
}

export interface KmsSignSender {
  send(command: SignCommand | GetPublicKeyCommand): Promise<unknown>;
}

const KMS_KEY_ID = /^(arn:aws:kms:[a-z0-9-]{4,32}:\d{12}:(key|alias)\/[A-Za-z0-9/_-]{1,256}|alias\/[A-Za-z0-9/_-]{1,256}|[0-9a-f-]{36})$/;
const KMS_KEY_ARN = /^arn:aws:kms:[A-Za-z0-9-]{1,32}:[0-9]{12}:key\/[A-Za-z0-9-]{1,128}$/;

interface PublicKeyInfo {
  keyRef: string;
  key: KeyObject;
}

async function kmsPublicKey(client: KmsSignSender, keyId: string): Promise<PublicKeyInfo> {
  let out: unknown;
  try {
    out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  } catch {
    throw new DependencyError("AUDIT_SIGNER_UNAVAILABLE", "NOT_STARTED");
  }
  const r = out as { KeyId?: unknown; PublicKey?: unknown; KeySpec?: unknown; KeyUsage?: unknown; SigningAlgorithms?: unknown } | undefined;
  if (
    typeof r?.KeyId !== "string" ||
    !KMS_KEY_ARN.test(r.KeyId) ||
    !(r.PublicKey instanceof Uint8Array) ||
    r.KeySpec !== "ECC_NIST_P256" ||
    r.KeyUsage !== "SIGN_VERIFY" ||
    !Array.isArray(r.SigningAlgorithms) ||
    !r.SigningAlgorithms.includes("ECDSA_SHA_256")
  ) {
    throw new DependencyError("AUDIT_SIGNER_KEY_INVALID", "FAILED", false);
  }
  try {
    return { keyRef: r.KeyId, key: createPublicKey({ key: Buffer.from(r.PublicKey), format: "der", type: "spki" }) };
  } catch {
    throw new DependencyError("AUDIT_SIGNER_KEY_INVALID", "FAILED", false);
  }
}

/** AWS KMS manifest signer (audit account asymmetric key; the exporter role holds kms:Sign on it only). */
export class KmsManifestSigner implements ManifestSigner {
  readonly kind = "live" as const;
  private keyRef: string | null = null;

  constructor(
    private readonly client: KmsSignSender,
    private readonly keyId: string,
    private readonly clock: Clock,
  ) {
    if (!KMS_KEY_ID.test(keyId)) throw new ValidationError("AUDIT_SIGNER_KEY_ID_INVALID");
  }

  /** Key ARN used as keyRef (resolved and checked once through GetPublicKey). */
  async resolveKeyRef(): Promise<string> {
    this.keyRef ??= (await kmsPublicKey(this.client, this.keyId)).keyRef;
    return this.keyRef;
  }

  async sign(manifest: AuditManifestT): Promise<AuditManifestT> {
    const keyRef = await this.resolveKeyRef();
    const unsigned: AuditManifestT = { ...stripSignature(manifest), signedAt: iso(this.clock.now()), signerRole: "audit_exporter" };
    const message = manifestSigningInput(unsigned);
    // RAW: KMS computes SHA-256 itself; RAW messages are limited to 4096 bytes (a manifest is far smaller).
    if (message.length > KMS_RAW_LIMIT) throw new ValidationError("AUDIT_MANIFEST_TOO_LARGE_TO_SIGN");
    let out: unknown;
    try {
      out = await this.client.send(new SignCommand({ KeyId: keyRef, Message: new Uint8Array(message), MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" }));
    } catch {
      throw new DependencyError("AUDIT_SIGNER_UNAVAILABLE", "NOT_STARTED");
    }
    const r = out as { Signature?: unknown; SigningAlgorithm?: unknown } | undefined;
    if (!(r?.Signature instanceof Uint8Array) || r.SigningAlgorithm !== "ECDSA_SHA_256") throw new DependencyError("AUDIT_SIGNER_RESPONSE_INVALID", "FAILED", false);
    const signature: AuditManifestSignature = { algorithm: "ECDSA_P256_SHA256", keyRef, value: Buffer.from(r.Signature).toString("base64url") };
    return AuditManifest.parse({ ...unsigned, signature });
  }
}

/** LOCAL FIXTURE manifest signer: an in-process P-256 key (unit tests, offline composition). */
export class LocalManifestSignerFixture implements ManifestSigner {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL FIXTURE AUDIT MANIFEST KEY — NOT FOR PRODUCTION";
  readonly keyRef: string;
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(private readonly clock: Clock) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.keyRef = `local-fixture:audit-manifest/${newId("kid").slice(4, 20).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
  }

  async sign(manifest: AuditManifestT): Promise<AuditManifestT> {
    const unsigned: AuditManifestT = { ...stripSignature(manifest), signedAt: iso(this.clock.now()), signerRole: "audit_exporter" };
    const value = nodeSign("sha256", manifestSigningInput(unsigned), { key: this.privateKey, dsaEncoding: "der" }).toString("base64url");
    return AuditManifest.parse({ ...unsigned, signature: { algorithm: "ECDSA_P256_SHA256", keyRef: this.keyRef, value } });
  }
}

function stripSignature(m: AuditManifestT): AuditManifestT {
  const { signature: _s, signedAt: _a, signerRole: _r, ...rest } = m;
  return rest;
}

export type ManifestSignatureCheck = "VALID" | "UNSIGNED" | "PARTIAL" | "UNTRUSTED_KEY" | "INVALID" | "WRONG_SIGNER_ROLE";

/** Verifies manifest signatures with trusted PUBLIC keys only. */
export class ManifestSignatureVerifier {
  private readonly keys = new Map<string, KeyObject>();

  /** Trusts a public key (SPKI PEM/DER or KeyObject) for a keyRef. */
  trust(keyRef: string, publicKey: KeyObject | string | Buffer): this {
    const key = typeof publicKey === "string" || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey;
    if (key.type !== "public" || key.asymmetricKeyType !== "ec") throw new ValidationError("AUDIT_VERIFY_KEY_INVALID");
    this.keys.set(keyRef, key);
    return this;
  }

  /** Trusts a KMS key's public key (the verifier identity needs kms:GetPublicKey only). Returns the keyRef (ARN). */
  async trustKms(client: KmsSignSender, keyId: string): Promise<string> {
    if (!KMS_KEY_ID.test(keyId)) throw new ValidationError("AUDIT_SIGNER_KEY_ID_INVALID");
    const info = await kmsPublicKey(client, keyId);
    this.keys.set(info.keyRef, info.key);
    return info.keyRef;
  }

  get trustedKeyRefs(): string[] {
    return [...this.keys.keys()];
  }

  check(m: AuditManifestT): ManifestSignatureCheck {
    if (m.signature === undefined && m.signedAt === undefined && m.signerRole === undefined) return "UNSIGNED";
    if (!manifestSignaturePresent(m) || !m.signature) return "PARTIAL";
    if (m.signerRole !== "audit_exporter") return "WRONG_SIGNER_ROLE";
    const key = this.keys.get(m.signature.keyRef);
    if (!key) return "UNTRUSTED_KEY";
    if (m.signature.algorithm !== "ECDSA_P256_SHA256") return "INVALID";
    try {
      return nodeVerify("sha256", manifestSigningInput(m), { key, dsaEncoding: "der" }, Buffer.from(m.signature.value, "base64url")) ? "VALID" : "INVALID";
    } catch {
      return "INVALID";
    }
  }
}
