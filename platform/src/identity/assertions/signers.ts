import { createPublicKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import type { JWK } from "jose";
import { sha256Hex } from "../../shared/canonical.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import { derToJose } from "./der.js";

/** Produces ES256 JWS signatures (JOSE r || s encoding) for assertions minted by trusted components. */
export interface AssertionSigner {
  readonly kind: "local_fixture" | "live";
  readonly kid: string;
  readonly alg: "ES256";
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
  /** Public verification key only. */
  publicJwk(): Promise<JWK>;
}

/**
 * LOCAL DEVELOPMENT signing key (kind "local_fixture"): an in-memory P-256 key
 * generated per process. Labelled LOCAL in its kid; production configuration
 * rejects it (`signing.localDevKey` must be false, OPS-04).
 */
export class LocalEs256Signer implements AssertionSigner {
  readonly kind = "local_fixture" as const;
  readonly alg = "ES256" as const;
  readonly label = "LOCAL DEVELOPMENT ASSERTION KEY — NOT FOR PRODUCTION";
  readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.kid = `local-dev-${newId("kid").slice(4, 24)}`;
  }

  async sign(signingInput: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(nodeSign("sha256", signingInput, { key: this.privateKey, dsaEncoding: "ieee-p1363" }));
  }

  async publicJwk(): Promise<JWK> {
    const { kty, crv, x, y } = this.publicKey.export({ format: "jwk" });
    return { kty, crv, x, y, kid: this.kid, alg: "ES256", use: "sig" } as JWK;
  }
}

/** AWS KMS maximum message size for MessageType RAW. */
export const KMS_RAW_MESSAGE_LIMIT = 4096;

export interface KmsSender {
  send(command: SignCommand | GetPublicKeyCommand): Promise<unknown>;
}

/**
 * AWS KMS asymmetric signer (kind "live"): `Sign` with `SigningAlgorithm:
 * ECDSA_SHA_256` and `MessageType: RAW` over the JWS signing input (KMS hashes it
 * with SHA-256; RAW messages are limited to 4096 bytes, larger inputs are refused),
 * DER signature converted to JOSE r || s. `GetPublicKey` (SPKI DER) supplies the
 * public JWK; the key must be `ECC_NIST_P256` with `SIGN_VERIFY` usage. Both are
 * documented KMS APIs (@aws-sdk/client-kms v3).
 *
 * STATUS: contract-tested with a stub client. Live use is BLOCKED on a provisioned
 * KMS key (infra), IAM grant for the gateway role and security approval.
 */
export class KmsAssertionSigner implements AssertionSigner {
  readonly kind = "live" as const;
  readonly alg = "ES256" as const;
  readonly kid: string;
  private cachedJwk: JWK | null = null;

  constructor(
    private readonly client: KmsSender,
    private readonly keyId: string,
    kid?: string,
  ) {
    if (!/^(arn:aws:kms:[a-z0-9-]{4,32}:\d{12}:(key|alias)\/[A-Za-z0-9/_-]{1,256}|alias\/[A-Za-z0-9/_-]{1,256}|[0-9a-f-]{36})$/.test(keyId)) {
      throw new ValidationError("KMS_KEY_ID_INVALID");
    }
    this.kid = kid ?? `kms-${sha256Hex(keyId).slice(0, 24)}`;
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(this.kid)) throw new ValidationError("KMS_KID_INVALID");
  }

  async sign(signingInput: Uint8Array): Promise<Uint8Array> {
    // RAW: KMS computes SHA-256 itself. KMS limits RAW messages to 4096 bytes; larger inputs fail closed.
    if (!(signingInput instanceof Uint8Array) || signingInput.length === 0 || signingInput.length > KMS_RAW_MESSAGE_LIMIT) {
      throw new ValidationError("ASSERTION_TOO_LARGE_FOR_KMS");
    }
    let out: unknown;
    try {
      out = await this.client.send(
        new SignCommand({ KeyId: this.keyId, Message: new Uint8Array(signingInput), MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" }),
      );
    } catch {
      throw new DependencyError("ASSERTION_SIGNER_UNAVAILABLE", "NOT_STARTED");
    }
    const r = out as { Signature?: unknown; SigningAlgorithm?: unknown } | undefined;
    if (!(r?.Signature instanceof Uint8Array) || r.SigningAlgorithm !== "ECDSA_SHA_256") throw new DependencyError("ASSERTION_SIGNER_RESPONSE_INVALID", "FAILED");
    return derToJose(r.Signature, 32);
  }

  async publicJwk(): Promise<JWK> {
    if (this.cachedJwk) return { ...this.cachedJwk };
    let out: unknown;
    try {
      out = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    } catch {
      throw new DependencyError("ASSERTION_SIGNER_UNAVAILABLE", "NOT_STARTED");
    }
    const r = out as { PublicKey?: unknown; KeySpec?: unknown; KeyUsage?: unknown; SigningAlgorithms?: unknown } | undefined;
    if (
      !(r?.PublicKey instanceof Uint8Array) ||
      r.KeySpec !== "ECC_NIST_P256" ||
      r.KeyUsage !== "SIGN_VERIFY" ||
      !Array.isArray(r.SigningAlgorithms) ||
      !r.SigningAlgorithms.includes("ECDSA_SHA_256")
    ) {
      throw new DependencyError("ASSERTION_SIGNER_KEY_INVALID", "FAILED");
    }
    let jwk: JWK;
    try {
      const { kty, crv, x, y } = createPublicKey({ key: Buffer.from(r.PublicKey), format: "der", type: "spki" }).export({ format: "jwk" });
      jwk = { kty, crv, x, y, kid: this.kid, alg: "ES256", use: "sig" } as JWK;
    } catch {
      throw new DependencyError("ASSERTION_SIGNER_KEY_INVALID", "FAILED");
    }
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new DependencyError("ASSERTION_SIGNER_KEY_INVALID", "FAILED");
    this.cachedJwk = jwk;
    return { ...jwk };
  }
}
