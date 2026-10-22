/**
 * SigV4 signer of the discovery command and the emulator's verifier (WP-08; FO-09-06, FO-09-11). The verifier is
 * cross-checked against the AWS SDK's own signer in bedrock-converse.test.ts (`sigv4: "VERIFIED"` for SDK-signed
 * ConverseStream requests); here the platform signer is verified by it, and tampering is refused. Synthetic keys.
 */
import { describe, expect, it } from "vitest";
import { verifySigV4 } from "../emulators/sigv4-verify.js";
import { canonicalQuery, canonicalUri, signRequest } from "./sigv4.js";

const creds = { accessKeyId: "akid_synthSigner", secretAccessKey: "sk_synthSignerSecret0001" };
const now = new Date("2026-10-21T12:00:00Z");
const url = new URL("https://bedrock.us-east-1.models.test/foundation-models?byOutputModality=TEXT&b=a%20b");

function verify(headers: Record<string, string>, over: Partial<Parameters<typeof verifySigV4>[0]> = {}) {
  return verifySigV4({ method: "GET", rawPath: url.pathname, rawQuery: url.search.slice(1), headers: { ...headers, host: url.host }, body: Buffer.alloc(0), now, secrets: new Map([[creds.accessKeyId, creds.secretAccessKey]]), region: "us-east-1", service: "bedrock", ...over });
}

describe("SigV4 signer and verifier [FO-09-06][FO-09-11]", () => {
  it("[FO-09-11] a request signed by the platform signer verifies", () => {
    const h = signRequest({ method: "GET", url, headers: { accept: "application/json" }, body: null, region: "us-east-1", service: "bedrock", credentials: creds, now });
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=akid_synthSigner\/20261021\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(verify(h)).toEqual({ valid: true, accessKeyId: "akid_synthSigner" });
  });

  it("[FO-09-06] adversarial: tampered headers, body, scope, date or key are refused with the reason", () => {
    const h = signRequest({ method: "GET", url, headers: { accept: "application/json" }, body: null, region: "us-east-1", service: "bedrock", credentials: creds, now });
    expect(verify({ ...h, accept: "text/plain" })).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
    expect(verify(h, { body: Buffer.from("x") })).toEqual({ valid: false, reason: "PAYLOAD_HASH_MISMATCH" });
    expect(verify(h, { region: "us-west-2" })).toEqual({ valid: false, reason: "SCOPE_MISMATCH" });
    expect(verify(h, { now: new Date(now.getTime() + 600_000) })).toEqual({ valid: false, reason: "DATE_SKEW" });
    expect(verify(h, { secrets: new Map([[creds.accessKeyId, "sk_synthOtherSecret0002"]]) })).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
    expect(verify(h, { secrets: new Map() })).toEqual({ valid: false, reason: "UNKNOWN_ACCESS_KEY" });
    expect(verify({ ...h, authorization: "Bearer x" })).toEqual({ valid: false, reason: "MALFORMED_AUTHORIZATION" });
    const { authorization: _a, ...unsigned } = h;
    expect(verify(unsigned)).toEqual({ valid: false, reason: "MISSING_AUTHORIZATION" });
  });

  it("[FO-09-06] canonical forms: path segments encoded again, query sorted and RFC 3986 encoded", () => {
    expect(canonicalUri("/model/emulated%3Atext/converse-stream")).toBe("/model/emulated%253Atext/converse-stream");
    expect(canonicalUri("/")).toBe("/");
    expect(canonicalQuery("b=2&a=x%20y&a=1")).toBe("a=1&a=x%20y&b=2");
  });
});
