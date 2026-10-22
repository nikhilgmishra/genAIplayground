/**
 * AWS Signature Version 4 (header form) for the Bedrock control-plane catalogue request of the discovery command
 * (WP-08; FO-09-11). The runtime adapter signs through the AWS SDK itself; this signer exists because the pinned
 * dependency set has the Bedrock RUNTIME client only (the `ListFoundationModels` call lives in the control-plane
 * client). The Bedrock emulator verifies SigV4 with the same canonicalization (`canonicalRequest`), and its
 * verifier is itself checked against signatures made by the AWS SDK's own signer, so this implementation is
 * cross-checked with AWS's.
 *
 * Canonical request (AWS documentation, "Create a canonical request"): method, the URI path with every segment
 * URI-encoded again (non-S3 services), the sorted canonical query, the lowercase sorted canonical headers, the signed
 * header list and the hex SHA-256 of the payload.
 */
import { createHash, createHmac } from "node:crypto";

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding as SigV4 requires (unreserved characters kept, everything else %XX upper-case). */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The canonical URI of a raw (already encoded) request path: each segment encoded once more. */
export function canonicalUri(rawPath: string): string {
  if (rawPath === "" || rawPath === "/") return "/";
  return rawPath
    .split("/")
    .map((seg) => uriEncode(seg))
    .join("/");
}

export function canonicalQuery(rawQuery: string): string {
  if (rawQuery === "") return "";
  const pairs = rawQuery.split("&").map((p) => {
    const i = p.indexOf("=");
    const k = decodeURIComponent((i === -1 ? p : p.slice(0, i)).replace(/\+/g, "%20"));
    const v = i === -1 ? "" : decodeURIComponent(p.slice(i + 1).replace(/\+/g, "%20"));
    return [uriEncode(k), uriEncode(v)] as const;
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export interface CanonicalInput {
  method: string;
  /** Path exactly as sent on the wire (already percent-encoded). */
  rawPath: string;
  /** Query string without the leading `?`. */
  rawQuery: string;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string>>;
  signedHeaders: readonly string[];
  payloadHash: string;
}

export function canonicalRequest(c: CanonicalInput): string {
  const names = [...c.signedHeaders].map((h) => h.toLowerCase()).sort();
  const headerLines = names.map((n) => `${n}:${(c.headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  return [c.method.toUpperCase(), canonicalUri(c.rawPath), canonicalQuery(c.rawQuery), headerLines, names.join(";"), c.payloadHash].join("\n");
}

export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), "aws4_request");
}

export function stringToSign(amzDate: string, scope: string, canonical: string): string {
  return ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
}

/** `20261021T205247Z` for a Date. */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface SignInput {
  method: "GET" | "POST";
  url: URL;
  headers: Record<string, string>;
  body: string | Buffer | null;
  region: string;
  service: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  now: Date;
}

/** Signed headers for one request (host, x-amz-date, x-amz-content-sha256, the session token, authorization). */
export function signRequest(i: SignInput): Record<string, string> {
  const date = amzDate(i.now);
  const payloadHash = sha256Hex(i.body ?? "");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v;
  headers.host = i.url.host;
  headers["x-amz-date"] = date;
  headers["x-amz-content-sha256"] = payloadHash;
  if (i.credentials.sessionToken) headers["x-amz-security-token"] = i.credentials.sessionToken;
  const signed = Object.keys(headers).sort();
  const scope = `${date.slice(0, 8)}/${i.region}/${i.service}/aws4_request`;
  const canonical = canonicalRequest({ method: i.method, rawPath: i.url.pathname, rawQuery: i.url.search.replace(/^\?/, ""), headers, signedHeaders: signed, payloadHash });
  const signature = createHmac("sha256", signingKey(i.credentials.secretAccessKey, date.slice(0, 8), i.region, i.service)).update(stringToSign(date, scope, canonical), "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
  // The transport sets host itself (same value the signature covers).
  delete headers.host;
  return headers;
}
