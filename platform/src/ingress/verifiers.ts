/**
 * Per-source authentication of inbound events (follow-on FO-07-16, FO-06-98, FO-15-50; SPEC-8 webhook auth).
 *
 * Every mechanism verifies BEFORE anything is persisted, against every credential version the resolver
 * reports as active (rotation overlap), in constant time where a secret is compared, and reports which
 * version verified the event. Failures are reason codes only (never the presented value, never a secret).
 *
 *  - hmac_header: HMAC-SHA256 / HMAC-SHA1 over the raw request bytes, or over `<timestamp>.<raw bytes>`
 *    with a bounded timestamp window; hex or base64, optional literal prefix ("sha256="). The signature
 *    binds the bytes, so a captured request can only be replayed byte for byte: such a replay (or a
 *    vendor's redelivery after a lost acknowledgement, which looks the same — GitHub and Shopify sign the
 *    body only) is AUTHENTIC and reaches the durable inbox, which records it as a duplicate of the event
 *    and applies nothing (FO-07-18). Freshness comes from the timestamp window where the vendor signs one.
 *  - jwt_bearer: a JWT in the configured header ("Bearer <jwt>" or bare): HS256 with the shared secret
 *    versions, or RS256/ES256 from the source's JWKS; issuer, audience and maximum token age enforced;
 *    when the source binds the body (bodyHashClaim, e.g. LiveKit's "sha256" claim) the claim must equal
 *    base64(SHA-256(raw body)). A token that does not bind the body must carry a jti; its replay key
 *    (SHA-256 of source and jti, never the token) goes to the inbox's DURABLE replay cache
 *    (inbound_replay_keys, shared by every replica, migration 2043): the same token over the same bytes is
 *    a redelivery (recorded duplicate), the same token over other bytes is refused (INGRESS_REPLAYED).
 *  - mtls: the client certificate (verified chain at the gateway socket, or the leaf an AWS ALB in mTLS
 *    verify mode passes in X-Amzn-Mtls-Clientcert) must have a pinned SHA-256 fingerprint.
 *  - reconcile_by_lookup: no signed feed exists; the delivering gateway is authenticated (shared bearer
 *    versions) and the router then replaces the delivered body with the authoritative record from a
 *    trusted server-side lookup (the delivered body is never trusted).
 *  - stream_iam: records are pulled by the platform's own consumer with its IAM identity.
 */
import { X509Certificate, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Clock } from "../shared/clock.js";
import type { CredentialResolver } from "./credentials.js";
import { authMechanismOf } from "./profile.js";
import type { AuthMechanism, SourceProfile } from "./profile.js";

export interface PeerCertificateInfo {
  /** The TLS layer verified the chain against the configured client CA. */
  authorized: boolean;
  /** Leaf SHA-256 fingerprint, lower-case hex without separators; null when no certificate was presented. */
  fingerprint256: string | null;
}

export interface InboundRequest {
  sourceId: string;
  /** Lower-cased single-value header lookup (null when absent or duplicated). */
  header(name: string): string | null;
  rawBody: Buffer;
  peer: PeerCertificateInfo | null;
}

/**
 * Replay key of a token-authenticated delivery (JWT jti): the inbox records it durably with the payload
 * digest, so a reuse of the token over OTHER bytes is refused on every replica (PgInbox, migration 2043).
 */
export interface ReplayKey {
  /** SHA-256 hex of `${sourceId}|jti|${jti}` (never the token or the jti itself). */
  keyDigest: string;
  /** When the token expires (the key is kept until then). */
  expiresAt: Date;
}

export type VerifyResult =
  | { ok: true; mechanism: AuthMechanism; credentialVersion: string | null; replay: ReplayKey | null }
  | { ok: false; mechanism: AuthMechanism; reasonCode: string };

const fail = (mechanism: AuthMechanism, reasonCode: string): VerifyResult => ({ ok: false, mechanism, reasonCode });

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Compare against itself to keep timing independent of where the lengths differ.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Normalizes "AB:CD:..." or "abcd..." SHA-256 fingerprints to lower-case hex. */
export function normalizeFingerprint(f: string): string | null {
  const hex = f.replace(/:/g, "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(hex) ? hex : null;
}

/** Leaf fingerprint of the URL-encoded PEM an AWS ALB passes in X-Amzn-Mtls-Clientcert. */
export function albClientCertFingerprint(headerValue: string): string | null {
  try {
    const pem = decodeURIComponent(headerValue.replace(/\+/g, "%20"));
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) return null;
    return normalizeFingerprint(new X509Certificate(pem).fingerprint256);
  } catch {
    return null;
  }
}

export interface InboundVerifierDeps {
  credentials: CredentialResolver;
  clock: Clock;
}

export class InboundVerifier {
  private readonly jwks = new Map<string, JWTVerifyGetKey>();

  constructor(private readonly deps: InboundVerifierDeps) {}

  async verify(req: InboundRequest, profile: SourceProfile): Promise<VerifyResult> {
    const v = profile.verifier;
    const mechanism = authMechanismOf(v);
    const now = this.deps.clock.now();
    const policy = { overlapSeconds: profile.rotationOverlapSeconds, acceptPending: profile.acceptPendingCredential };
    try {
      switch (v.kind) {
        case "hmac_header": {
          const presented = req.header(v.signatureHeader);
          if (!presented || !presented.startsWith(v.prefix)) return fail(mechanism, "INGRESS_SIGNATURE_MISSING");
          const raw = presented.slice(v.prefix.length);
          const sig = v.encoding === "hex" ? (/^[a-f0-9]+$/i.test(raw) ? Buffer.from(raw, "hex") : null) : /^[A-Za-z0-9+/=]+$/.test(raw) ? Buffer.from(raw, "base64") : null;
          if (!sig || sig.length === 0) return fail(mechanism, "INGRESS_SIGNATURE_MALFORMED");
          let signed: Buffer = req.rawBody;
          if (v.signedPayload === "timestamp.body") {
            const tsRaw = v.timestampHeader ? req.header(v.timestampHeader) : null;
            const ts = tsRaw !== null && /^\d{9,11}$/.test(tsRaw) ? Number(tsRaw) : NaN;
            if (!Number.isInteger(ts) || Math.abs(now.getTime() / 1000 - ts) > v.toleranceSeconds) return fail(mechanism, "INGRESS_TIMESTAMP_INVALID");
            signed = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), req.rawBody]);
          }
          const versions = await this.deps.credentials.activeVersions(v.credentials, policy, now);
          let matched: string | null = null;
          for (const cv of versions) {
            const expected = createHmac(v.algorithm, cv.material).update(signed).digest();
            if (constantTimeEqual(expected, sig) && matched === null) matched = cv.version;
          }
          if (matched === null) return fail(mechanism, "INGRESS_SIGNATURE_INVALID");
          // The signature binds the bytes: a byte-identical replay is a redelivery, deduplicated by the inbox.
          return { ok: true, mechanism, credentialVersion: matched, replay: null };
        }
        case "jwt_bearer": {
          const h = req.header(v.header);
          const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : h?.trim();
          if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) return fail(mechanism, "INGRESS_TOKEN_MISSING");
          // exp is required; the token's remaining lifetime and (when present) its age are bounded below,
          // because some vendors (LiveKit) issue tokens without iat.
          const opts = {
            algorithms: v.algorithms,
            requiredClaims: ["exp"],
            currentDate: now,
            clockTolerance: 30,
            ...(v.issuer ? { issuer: v.issuer } : {}),
            ...(v.audience ? { audience: v.audience } : {}),
          };
          let claims: Record<string, unknown> | null = null;
          let version: string | null = null;
          if (v.credentials) {
            for (const cv of await this.deps.credentials.activeVersions(v.credentials, policy, now)) {
              try {
                claims = (await jwtVerify(token, new Uint8Array(cv.material), opts)).payload as Record<string, unknown>;
                version = cv.version;
                break;
              } catch {
                // try the next active version
              }
            }
          } else if (v.jwksUrl) {
            let getKey = this.jwks.get(v.jwksUrl);
            if (!getKey) {
              getKey = createRemoteJWKSet(new URL(v.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
              this.jwks.set(v.jwksUrl, getKey);
            }
            try {
              claims = (await jwtVerify(token, getKey, opts)).payload as Record<string, unknown>;
              const kid = decodeProtectedHeader(token).kid;
              version = typeof kid === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(kid) ? kid : null;
            } catch {
              claims = null;
            }
          }
          if (!claims) return fail(mechanism, "INGRESS_TOKEN_INVALID");
          const nowS = now.getTime() / 1000;
          const expS = typeof claims.exp === "number" ? claims.exp : 0;
          const iatS = typeof claims.iat === "number" ? claims.iat : typeof claims.nbf === "number" ? claims.nbf : null;
          if (expS - nowS > v.maxTokenAgeSeconds + 30 || (iatS !== null && nowS - iatS > v.maxTokenAgeSeconds + 30)) return fail(mechanism, "INGRESS_TOKEN_LIFETIME_EXCEEDED");
          if (v.bodyHashClaim) {
            const want = createHash("sha256").update(req.rawBody).digest("base64");
            const got = claims[v.bodyHashClaim];
            if (typeof got !== "string" || !constantTimeEqual(Buffer.from(got.replace(/=+$/, "")), Buffer.from(want.replace(/=+$/, "")))) return fail(mechanism, "INGRESS_BODY_HASH_MISMATCH");
          }
          const jti = typeof claims.jti === "string" && claims.jti.length >= 1 && claims.jti.length <= 256 ? claims.jti : null;
          // A token that binds neither the body nor a unique id could be replayed over any bytes until it expires.
          if (!v.bodyHashClaim && !jti) return fail(mechanism, "INGRESS_TOKEN_JTI_REQUIRED");
          const replay = jti ? { keyDigest: createHash("sha256").update(`${profile.sourceId}|jti|${jti}`).digest("hex"), expiresAt: new Date(expS * 1000) } : null;
          return { ok: true, mechanism, credentialVersion: version, replay };
        }
        case "mtls": {
          let fingerprint: string | null = null;
          if (v.mode === "socket") {
            if (!req.peer?.authorized) return fail(mechanism, "INGRESS_CLIENT_CERT_UNVERIFIED");
            fingerprint = req.peer.fingerprint256;
          } else {
            const hv = req.header("x-amzn-mtls-clientcert");
            fingerprint = hv ? albClientCertFingerprint(hv) : null;
          }
          if (!fingerprint) return fail(mechanism, "INGRESS_CLIENT_CERT_MISSING");
          const fp = Buffer.from(fingerprint, "utf8");
          let matched: string | null = null;
          for (const cv of await this.deps.credentials.activeVersions(v.credentials, policy, now)) {
            const pinned = normalizeFingerprint(cv.material.toString("utf8"));
            if (pinned && constantTimeEqual(Buffer.from(pinned, "utf8"), fp) && matched === null) matched = cv.version;
          }
          return matched === null ? fail(mechanism, "INGRESS_CLIENT_CERT_NOT_PINNED") : { ok: true, mechanism, credentialVersion: matched, replay: null };
        }
        case "reconcile_by_lookup": {
          if (!v.gatewayCredentials) return { ok: true, mechanism, credentialVersion: null, replay: null };
          const h = req.header(v.gatewayHeader);
          const presented = h?.startsWith("Bearer ") ? h.slice(7) : h;
          if (!presented) return fail(mechanism, "INGRESS_GATEWAY_AUTH_MISSING");
          let matched: string | null = null;
          for (const cv of await this.deps.credentials.activeVersions(v.gatewayCredentials, policy, now)) {
            const want = createHash("sha256").update(cv.material).digest();
            const got = createHash("sha256").update(presented, "utf8").digest();
            if (constantTimeEqual(want, got) && matched === null) matched = cv.version;
          }
          return matched === null ? fail(mechanism, "INGRESS_GATEWAY_AUTH_INVALID") : { ok: true, mechanism, credentialVersion: matched, replay: null };
        }
        case "stream_iam":
          return fail(mechanism, "INGRESS_STREAM_SOURCE_NOT_PUSH");
      }
    } catch {
      return fail(mechanism, "INGRESS_CREDENTIALS_UNAVAILABLE");
    }
  }
}
