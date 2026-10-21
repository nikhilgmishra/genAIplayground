/**
 * Encryption of inbound payloads at rest (follow-on FO-07-17, FO-07-22; DATA-01, DATA-02).
 *
 * KmsEnvelopeCipher (kind "live"): a fresh 256-bit data key per event from KMS GenerateDataKey (AES_256)
 * with EncryptionContext { purpose, tenantId, sourceId } (a KMS grant can be scoped to the context);
 * AES-256-GCM with a 96-bit random IV and additional authenticated data binding the ciphertext to the
 * inbox row identity (tenant, source, event id, payload digest), so a ciphertext copied to another row
 * does not decrypt. Only the KMS-encrypted data key is stored; the plaintext key is wiped after use.
 * Decrypt calls KMS Decrypt with the same context.
 *
 * LocalAesCipherFixture (kind "local_fixture"): the same AES-256-GCM construction with an in-process key,
 * for unit tests and the offline composition only.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { DependencyError, ValidationError } from "../shared/errors.js";

export interface PayloadContext {
  tenantId: string;
  sourceId: string;
  eventId: string;
  payloadDigest: string;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  encryptedDataKey: Buffer;
  keyRef: string;
  iv: Buffer;
  tag: Buffer;
}

export interface PayloadCipher {
  readonly kind: "live" | "local_fixture";
  encrypt(plaintext: Buffer, ctx: PayloadContext): Promise<EncryptedPayload>;
  decrypt(p: EncryptedPayload, ctx: PayloadContext): Promise<Buffer>;
}

export interface KmsDataKeySender {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<unknown>;
}

const PURPOSE = "vsp.inbox.payload.v1";
const aadOf = (ctx: PayloadContext): Buffer => Buffer.from(`${PURPOSE}\n${ctx.tenantId}\n${ctx.sourceId}\n${ctx.eventId}\n${ctx.payloadDigest}`, "utf8");

function seal(key: Buffer, plaintext: Buffer, ctx: PayloadContext): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aadOf(ctx));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

function open(key: Buffer, p: EncryptedPayload, ctx: PayloadContext): Buffer {
  try {
    const d = createDecipheriv("aes-256-gcm", key, p.iv);
    d.setAAD(aadOf(ctx));
    d.setAuthTag(p.tag);
    return Buffer.concat([d.update(p.ciphertext), d.final()]);
  } catch {
    throw new DependencyError("INBOX_PAYLOAD_DECRYPT_FAILED", "FAILED", false);
  }
}

export class KmsEnvelopeCipher implements PayloadCipher {
  readonly kind = "live" as const;

  constructor(
    private readonly client: KmsDataKeySender,
    private readonly keyId: string,
  ) {
    if (!/^(arn:aws:kms:[a-z0-9-]{4,32}:\d{12}:(key|alias)\/[A-Za-z0-9/_-]{1,256}|alias\/[A-Za-z0-9/_-]{1,256}|[0-9a-f-]{36})$/.test(keyId)) throw new ValidationError("INBOX_KMS_KEY_ID_INVALID");
  }

  private context(ctx: PayloadContext): Record<string, string> {
    return { purpose: PURPOSE, tenantId: ctx.tenantId, sourceId: ctx.sourceId };
  }

  async encrypt(plaintext: Buffer, ctx: PayloadContext): Promise<EncryptedPayload> {
    let out: unknown;
    try {
      out = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256", EncryptionContext: this.context(ctx) }));
    } catch {
      throw new DependencyError("INBOX_KMS_UNAVAILABLE", "NOT_STARTED");
    }
    const r = out as { Plaintext?: unknown; CiphertextBlob?: unknown; KeyId?: unknown } | undefined;
    if (!(r?.Plaintext instanceof Uint8Array) || r.Plaintext.length !== 32 || !(r.CiphertextBlob instanceof Uint8Array) || typeof r.KeyId !== "string") {
      throw new DependencyError("INBOX_KMS_RESPONSE_INVALID", "FAILED", false);
    }
    const key = Buffer.from(r.Plaintext);
    try {
      const sealed = seal(key, plaintext, ctx);
      return { ...sealed, encryptedDataKey: Buffer.from(r.CiphertextBlob), keyRef: r.KeyId };
    } finally {
      key.fill(0);
      r.Plaintext.fill(0);
    }
  }

  async decrypt(p: EncryptedPayload, ctx: PayloadContext): Promise<Buffer> {
    let out: unknown;
    try {
      out = await this.client.send(new DecryptCommand({ CiphertextBlob: new Uint8Array(p.encryptedDataKey), KeyId: p.keyRef, EncryptionContext: this.context(ctx) }));
    } catch {
      throw new DependencyError("INBOX_KMS_UNAVAILABLE", "NOT_STARTED");
    }
    const r = out as { Plaintext?: unknown } | undefined;
    if (!(r?.Plaintext instanceof Uint8Array) || r.Plaintext.length !== 32) throw new DependencyError("INBOX_KMS_RESPONSE_INVALID", "FAILED", false);
    const key = Buffer.from(r.Plaintext);
    try {
      return open(key, p, ctx);
    } finally {
      key.fill(0);
      r.Plaintext.fill(0);
    }
  }
}

/** LOCAL FIXTURE payload cipher: AES-256-GCM with an in-process key (never in production, OPS-04). */
export class LocalAesCipherFixture implements PayloadCipher {
  readonly kind = "local_fixture" as const;
  readonly label = "LOCAL FIXTURE INBOX KEY — in-process, not KMS";
  private readonly key = randomBytes(32);

  async encrypt(plaintext: Buffer, ctx: PayloadContext): Promise<EncryptedPayload> {
    return { ...seal(this.key, plaintext, ctx), encryptedDataKey: Buffer.from("local-fixture-data-key"), keyRef: "local-fixture:inbox-key" };
  }

  async decrypt(p: EncryptedPayload, ctx: PayloadContext): Promise<Buffer> {
    return open(this.key, p, ctx);
  }
}
