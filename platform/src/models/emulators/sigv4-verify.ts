/**
 * SigV4 verification for the Bedrock protocol emulator (WP-08; FO-09-06 acceptance "SigV4"). The emulator refuses
 * a request whose signature, scope, date, signed headers or payload hash does not verify, exactly as Bedrock answers
 * 403 (InvalidSignatureException / UnrecognizedClientException), so an adapter test that passes has produced a
 * correctly signed request. Verified against signatures produced by the AWS SDK's own signer in the emulator tests.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalRequest, signingKey, stringToSign } from "../adapters/sigv4.js";

export interface VerifyInput {
  method: string;
  rawPath: string;
  rawQuery: string;
  /** Lower-case header names as received. */
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  now: Date;
  /** Access key id to secret (synthetic emulator credentials only). */
  secrets: ReadonlyMap<string, string>;
  region: string;
  service: string;
  maxSkewMs?: number;
}

export type VerifyResult = { valid: true; accessKeyId: string } | { valid: false; reason: "MISSING_AUTHORIZATION" | "MALFORMED_AUTHORIZATION" | "UNKNOWN_ACCESS_KEY" | "SCOPE_MISMATCH" | "DATE_SKEW" | "MISSING_SIGNED_HEADER" | "PAYLOAD_HASH_MISMATCH" | "SIGNATURE_MISMATCH" };

const AUTH = /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request,\s*SignedHeaders=([a-z0-9;-]+),\s*Signature=([0-9a-f]{64})$/;

export function verifySigV4(i: VerifyInput): VerifyResult {
  const auth = i.headers.authorization;
  if (!auth) return { valid: false, reason: "MISSING_AUTHORIZATION" };
  const m = AUTH.exec(auth);
  if (!m) return { valid: false, reason: "MALFORMED_AUTHORIZATION" };
  const [, akid, day, region, service, signedList, signature] = m as unknown as [string, string, string, string, string, string, string];
  const secret = i.secrets.get(akid);
  if (secret === undefined) return { valid: false, reason: "UNKNOWN_ACCESS_KEY" };
  if (region !== i.region || service !== i.service) return { valid: false, reason: "SCOPE_MISMATCH" };
  const amzDate = i.headers["x-amz-date"] ?? "";
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== day) return { valid: false, reason: "MALFORMED_AUTHORIZATION" };
  const at = Date.UTC(Number(amzDate.slice(0, 4)), Number(amzDate.slice(4, 6)) - 1, Number(amzDate.slice(6, 8)), Number(amzDate.slice(9, 11)), Number(amzDate.slice(11, 13)), Number(amzDate.slice(13, 15)));
  if (Math.abs(i.now.getTime() - at) > (i.maxSkewMs ?? 300_000)) return { valid: false, reason: "DATE_SKEW" };
  const signed = signedList.split(";");
  if (!signed.includes("host") || !signed.includes("x-amz-date")) return { valid: false, reason: "MISSING_SIGNED_HEADER" };
  for (const h of signed) if (i.headers[h] === undefined) return { valid: false, reason: "MISSING_SIGNED_HEADER" };
  const bodyHash = createHash("sha256").update(i.body).digest("hex");
  const declared = i.headers["x-amz-content-sha256"];
  if (declared !== undefined && declared !== "UNSIGNED-PAYLOAD" && declared !== bodyHash) return { valid: false, reason: "PAYLOAD_HASH_MISMATCH" };
  const canonical = canonicalRequest({ method: i.method, rawPath: i.rawPath, rawQuery: i.rawQuery, headers: i.headers, signedHeaders: signed, payloadHash: declared ?? bodyHash });
  const expected = createHmac("sha256", signingKey(secret, day, region, service)).update(stringToSign(amzDate, `${day}/${region}/${service}/aws4_request`, canonical), "utf8").digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { valid: false, reason: "SIGNATURE_MISMATCH" };
  return { valid: true, accessKeyId: akid };
}
