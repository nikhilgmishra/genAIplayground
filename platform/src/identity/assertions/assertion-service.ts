import { randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { VerificationAssertionClaims, meetsAssurance } from "../../protocol/index.js";
import type { AuthContext, VerificationAssertionClaims as Claims } from "../../protocol/index.js";
import { sha256Hex } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { AccessDeniedError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { Logger } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import type { AssertionService, KvStore } from "../ports.js";
import { isSessionBindingRef, kvKeys, sessionBindingRefFor } from "../keys.js";
import type { AssertionKeyRing } from "./key-ring.js";

/**
 * Signed short-lived assertions (spec section 7), minted and validated only by
 * trusted components: ES256 compact JWS with issuer, audience, iat/nbf/exp, jti,
 * nonce and key id (rotation through AssertionKeyRing).
 *
 * Purposes:
 *  - transfer_receiver: a verification result carried to the authorised receiver of
 *    a transfer for the SAME call. Single use (jti replay protection).
 *  - portal_binding: binds a portal step to a call session. Single use.
 *  - durable_action_grant: narrowly authorised authority for an asynchronous
 *    workflow; only the listed actions (1..8), bounded lifetime, never the call's
 *    session token reused as unlimited authority.
 *
 * `sid` is always the NON-BEARER session binding reference (`ses_bnd_...`), so a
 * receiver holding an assertion can never present it as a session reference.
 */
export type AssertionPurpose = Claims["purpose"];

export const ASSERTION_TYP = "vsp-assertion+jwt";

export const DEFAULT_MAX_TTL_SECONDS: Record<AssertionPurpose, number> = {
  transfer_receiver: 300,
  portal_binding: 300,
  durable_action_grant: 7 * 86_400,
};

const SINGLE_USE: ReadonlySet<AssertionPurpose> = new Set(["transfer_receiver", "portal_binding"]);
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ACTION = /^[a-z_.]+$/;

export interface AssertionServiceDeps {
  keyRing: AssertionKeyRing;
  /** Replay store for single-use purposes (jti). */
  kv: KvStore;
  clock: Clock;
  /** Issuer identifier, e.g. "vsp-identity/local". */
  issuer: string;
  maxTtlSeconds?: Partial<Record<AssertionPurpose, number>>;
  clockToleranceSeconds?: number;
  logger?: Logger;
}

export interface VerifyExpectation {
  audience: string;
  purpose: AssertionPurpose;
  /** When given, the assertion nonce must equal it (constant time). */
  nonce?: string;
  /** When given, the assertion must be for this call. */
  callId?: string;
  /** durable_action_grant: the action being performed must be listed. */
  action?: string;
}

const b64 = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");

function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256Hex(a), "hex"), Buffer.from(sha256Hex(b), "hex"));
}

function mapVerifyError(err: unknown): PlatformError {
  if (err instanceof PlatformError) return err;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const claim = typeof err === "object" && err !== null ? (err as { claim?: unknown }).claim : undefined;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return new AccessDeniedError("ASSERTION_EXPIRED");
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (claim === "aud") return new AccessDeniedError("ASSERTION_AUDIENCE_MISMATCH");
      if (claim === "iss") return new AccessDeniedError("ASSERTION_ISSUER_MISMATCH");
      if (claim === "nbf") return new AccessDeniedError("ASSERTION_NOT_YET_VALID");
      if (claim === "typ") return new AccessDeniedError("ASSERTION_TYPE_INVALID");
      return new AccessDeniedError("ASSERTION_CLAIMS_INVALID");
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return new AccessDeniedError("ASSERTION_SIGNATURE_INVALID");
    case "ERR_JWKS_NO_MATCHING_KEY":
      return new AccessDeniedError("ASSERTION_KEY_UNKNOWN");
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return new AccessDeniedError("ASSERTION_ALG_NOT_ALLOWED");
    default:
      return new AccessDeniedError("ASSERTION_INVALID");
  }
}

export class SignedAssertionService implements AssertionService {
  private readonly maxTtl: Record<AssertionPurpose, number>;
  private readonly tolerance: number;
  private readonly logger: Logger;

  constructor(private readonly deps: AssertionServiceDeps) {
    if (!/^[A-Za-z0-9:/._-]{3,128}$/.test(deps.issuer)) throw new ValidationError("ASSERTION_ISSUER_INVALID");
    this.maxTtl = { ...DEFAULT_MAX_TTL_SECONDS, ...deps.maxTtlSeconds };
    for (const v of Object.values(this.maxTtl)) if (!Number.isInteger(v) || v < 1 || v > 30 * 86_400) throw new ValidationError("ASSERTION_TTL_CONFIG_INVALID");
    this.tolerance = deps.clockToleranceSeconds ?? 5;
    if (!Number.isInteger(this.tolerance) || this.tolerance < 0 || this.tolerance > 60) throw new ValidationError("ASSERTION_TOLERANCE_INVALID");
    this.logger = (deps.logger ?? silentLogger).child({ component: "identity.assertions" });
  }

  get kind(): "local_fixture" | "live" {
    return this.deps.keyRing.kind;
  }

  async mint(claims: Omit<Claims, "iss" | "iat" | "nbf" | "exp" | "jti">, ttlSeconds: number): Promise<string> {
    const purpose = claims?.purpose;
    if (!purpose || !(purpose in this.maxTtl)) throw new ValidationError("ASSERTION_CLAIMS_INVALID");
    const max = this.maxTtl[purpose];
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > max) throw new ValidationError("ASSERTION_TTL_INVALID");
    if (!Array.isArray(claims.actions)) throw new ValidationError("ASSERTION_CLAIMS_INVALID");
    if (purpose === "durable_action_grant") {
      if (claims.actions.length < 1 || claims.actions.length > 8 || new Set(claims.actions).size !== claims.actions.length) {
        throw new ValidationError("ASSERTION_GRANT_ACTIONS_INVALID");
      }
    } else if (claims.actions.length !== 0) {
      // Only durable grants carry action authority; other purposes are verification results, never authority to act.
      throw new ValidationError("ASSERTION_ACTIONS_NOT_ALLOWED");
    }
    if (typeof claims.sid !== "string" || !isSessionBindingRef(claims.sid)) throw new ValidationError("ASSERTION_SID_MUST_BE_BINDING_REF");

    const iat = Math.floor(this.deps.clock.now().getTime() / 1000);
    const full = VerificationAssertionClaims.safeParse({ ...claims, iss: this.deps.issuer, iat, nbf: iat, exp: iat + ttlSeconds, jti: newId("jti") });
    if (!full.success) throw new ValidationError("ASSERTION_CLAIMS_INVALID");

    const signer = this.deps.keyRing.active;
    const header = b64(JSON.stringify({ alg: "ES256", kid: signer.kid, typ: ASSERTION_TYP }));
    const payload = b64(JSON.stringify(full.data));
    const signingInput = `${header}.${payload}`;
    const signature = await signer.sign(new TextEncoder().encode(signingInput));
    if (signature.length !== 64) throw new DependencyError("ASSERTION_SIGNATURE_LENGTH_INVALID", "FAILED");
    this.logger.info("identity.assertion.minted", { purpose, sessionGeneration: full.data.gen, callId: full.data.call });
    return `${signingInput}.${b64(signature)}`;
  }

  async verify(token: string, expected: VerifyExpectation): Promise<Claims> {
    try {
      const claims = await this.verifyInner(token, expected);
      this.logger.info("identity.assertion.verified", { purpose: claims.purpose, callId: claims.call });
      return claims;
    } catch (err) {
      const mapped = mapVerifyError(err);
      this.logger.warn("identity.assertion.rejected", { reasonCode: mapped.reasonCode, purpose: expected?.purpose ?? null });
      throw mapped;
    }
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const { keys } = await this.deps.keyRing.jwks();
    return { keys: keys.map((k) => ({ ...k })) };
  }

  // ---------------- purpose-specific helpers ----------------

  /**
   * Signed verification result for the authorised receiver of a transfer on the same
   * call. `ctx` must come from SessionService.resolve (server state), never from a tool argument.
   */
  async mintTransferResult(ctx: AuthContext, opts: { receiverAudience: string; nonce?: string; ttlSeconds?: number }): Promise<string> {
    if (!ctx.actorId || !ctx.selectedRole || !meetsAssurance(ctx.assurance, "A1")) throw new AccessDeniedError("NO_VERIFICATION_RESULT");
    return this.mint(
      {
        aud: opts.receiverAudience,
        sub: ctx.actorId,
        nonce: opts.nonce ?? randomBytes(32).toString("base64url"),
        sid: sessionBindingRefFor(ctx.sessionRef),
        gen: ctx.sessionGeneration,
        call: ctx.callId,
        asr: ctx.assurance === "A3" ? "A2" : ctx.assurance,
        role: ctx.selectedRole,
        purpose: "transfer_receiver",
        actions: [],
      },
      opts.ttlSeconds ?? 120,
    );
  }

  async verifyTransferResult(token: string, opts: { receiverAudience: string; callId: string; nonce?: string }): Promise<Claims> {
    return this.verify(token, { audience: opts.receiverAudience, purpose: "transfer_receiver", callId: opts.callId, ...(opts.nonce ? { nonce: opts.nonce } : {}) });
  }

  /** Narrow durable grant for asynchronous follow-up: listed actions only, bounded lifetime. Requires A2. */
  async mintDurableActionGrant(ctx: AuthContext, opts: { audience: string; actions: string[]; ttlSeconds: number }): Promise<string> {
    if (!ctx.actorId || !ctx.selectedRole || !meetsAssurance(ctx.assurance, "A2")) throw new AccessDeniedError("GRANT_REQUIRES_A2");
    return this.mint(
      {
        aud: opts.audience,
        sub: ctx.actorId,
        nonce: randomBytes(32).toString("base64url"),
        sid: sessionBindingRefFor(ctx.sessionRef),
        gen: ctx.sessionGeneration,
        call: ctx.callId,
        asr: ctx.assurance === "A3" ? "A2" : ctx.assurance,
        role: ctx.selectedRole,
        purpose: "durable_action_grant",
        actions: [...opts.actions],
      },
      opts.ttlSeconds,
    );
  }

  async authorizeDurableAction(token: string, opts: { audience: string; action: string }): Promise<Claims> {
    return this.verify(token, { audience: opts.audience, purpose: "durable_action_grant", action: opts.action });
  }

  // ---------------------------------------------------------------------------

  private async verifyInner(token: string, expected: VerifyExpectation): Promise<Claims> {
    if (!expected || typeof expected.audience !== "string" || !(expected.purpose in this.maxTtl)) throw new ValidationError("ASSERTION_EXPECTATION_INVALID");
    if (typeof token !== "string" || token.length > 8192 || !COMPACT_JWS.test(token)) throw new AccessDeniedError("ASSERTION_MALFORMED");
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new AccessDeniedError("ASSERTION_MALFORMED");
    }
    if (header.alg !== "ES256") throw new AccessDeniedError("ASSERTION_ALG_NOT_ALLOWED");
    if (header.typ !== ASSERTION_TYP) throw new AccessDeniedError("ASSERTION_TYPE_INVALID");
    if (typeof header.kid !== "string" || !this.deps.keyRing.knows(header.kid)) throw new AccessDeniedError("ASSERTION_KEY_UNKNOWN");

    const now = this.deps.clock.now();
    const jwks = await this.deps.keyRing.jwks();
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: this.deps.issuer,
      audience: expected.audience,
      algorithms: ["ES256"],
      typ: ASSERTION_TYP,
      currentDate: now,
      clockTolerance: this.tolerance,
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nbf", "jti", "nonce", "sid", "gen", "call", "asr", "role", "purpose", "actions"],
    });
    const parsed = VerificationAssertionClaims.safeParse(payload);
    if (!parsed.success) throw new AccessDeniedError("ASSERTION_CLAIMS_INVALID");
    const c = parsed.data;
    if (c.purpose !== expected.purpose) throw new AccessDeniedError("ASSERTION_PURPOSE_MISMATCH");
    if (c.exp - c.iat > this.maxTtl[c.purpose] || c.nbf < c.iat || c.iat > Math.floor(now.getTime() / 1000) + this.tolerance) {
      throw new AccessDeniedError("ASSERTION_LIFETIME_INVALID");
    }
    if (!isSessionBindingRef(c.sid)) throw new AccessDeniedError("ASSERTION_CLAIMS_INVALID");
    if (c.purpose === "durable_action_grant") {
      if (c.actions.length === 0) throw new AccessDeniedError("ASSERTION_CLAIMS_INVALID");
      if (expected.action !== undefined && !(ACTION.test(expected.action) && c.actions.includes(expected.action))) {
        throw new AccessDeniedError("ASSERTION_ACTION_NOT_GRANTED");
      }
    } else if (c.actions.length !== 0) {
      throw new AccessDeniedError("ASSERTION_CLAIMS_INVALID");
    }
    if (expected.nonce !== undefined && !equalSecret(c.nonce, expected.nonce)) throw new AccessDeniedError("ASSERTION_NONCE_MISMATCH");
    if (expected.callId !== undefined && c.call !== expected.callId) throw new AccessDeniedError("ASSERTION_CALL_MISMATCH");

    if (SINGLE_USE.has(c.purpose)) {
      const fresh = await this.deps.kv.putIfAbsent({
        pk: kvKeys.assertionJti(c.iss, c.jti),
        version: 1,
        ttlEpochSeconds: c.exp + this.tolerance + 3600,
        data: { schema: "vsp.assertion-jti.v1", purpose: c.purpose, usedAt: now.toISOString() },
      });
      if (!fresh) throw new AccessDeniedError("ASSERTION_REPLAYED");
    }
    return c;
  }
}
