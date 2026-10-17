import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { CALLS, PEOPLE } from "../../fixtures/synthetic-world.js";
import type { AuthContext, VerificationAssertionClaims } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { DependencyError, ValidationError } from "../../shared/errors.js";
import { newId, newSessionRef } from "../../shared/ids.js";
import { createMemoryLogger } from "../../observability/logger.js";
import { MemoryKvStoreFixture } from "../kv/memory-kv-store.js";
import { sessionBindingRefFor } from "../keys.js";
import { createIdentityHarness, mcp } from "../identity-harness.fixture.js";
import { ASSERTION_TYP, SignedAssertionService } from "./assertion-service.js";
import { derToJose, joseToDer } from "./der.js";
import { AssertionKeyRing } from "./key-ring.js";
import { KmsAssertionSigner, LocalEs256Signer } from "./signers.js";
import type { KmsSender } from "./signers.js";

const ISSUER = "vsp-identity/local";
const RECEIVER = "talkdesk-receiver-local";

function setup(opts: { kvShared?: MemoryKvStoreFixture } = {}) {
  const clock = new FakeClock();
  const kv = opts.kvShared ?? new MemoryKvStoreFixture();
  const ring = new AssertionKeyRing(new LocalEs256Signer());
  const { logger, records } = createMemoryLogger();
  const svc = new SignedAssertionService({ keyRing: ring, kv, clock, issuer: ISSUER, logger });
  return { clock, kv, ring, svc, records };
}

function claims(overrides: Partial<VerificationAssertionClaims> = {}): Omit<VerificationAssertionClaims, "iss" | "iat" | "nbf" | "exp" | "jti"> {
  return {
    aud: RECEIVER,
    sub: PEOPLE.avery.actorId,
    nonce: "n".repeat(32),
    sid: sessionBindingRefFor(newSessionRef()),
    gen: 1,
    call: CALLS.primary.callId,
    asr: "A2",
    role: "client",
    purpose: "transfer_receiver",
    actions: [],
    ...overrides,
  };
}

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { reasonCode?: string }).reasonCode ?? "UNTYPED_ERROR";
  }
};

describe("SignedAssertionService", () => {
  it("[SPEC-7.ASSERTION] mints ES256 assertions with iss, aud, iat, nbf, exp, jti, nonce and kid; verify returns the strict claims", async () => {
    const { svc, ring, clock } = setup();
    const token = await svc.mint(claims(), 120);
    const [h] = token.split(".");
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({ alg: "ES256", kid: ring.active.kid, typ: ASSERTION_TYP });
    const c = await svc.verify(token, { audience: RECEIVER, purpose: "transfer_receiver" });
    const now = Math.floor(clock.now().getTime() / 1000);
    expect(c).toMatchObject({ iss: ISSUER, aud: RECEIVER, iat: now, nbf: now, exp: now + 120, sub: PEOPLE.avery.actorId, purpose: "transfer_receiver" });
    expect(c.jti).toMatch(/^jti_/);
    // Independently verifiable with the published JWKS by a standard JOSE library.
    const { payload } = await jwtVerify(token, createLocalJWKSet((await svc.jwks()) as never), { issuer: ISSUER, audience: RECEIVER, currentDate: clock.now() });
    expect(payload.jti).toBe(c.jti);
  });

  it("[SPEC-7.ASSERTION] wrong audience, wrong purpose, expired, not yet valid and tampered tokens are rejected", async () => {
    const { svc, clock } = setup();
    const t = await svc.mint(claims(), 60);
    expect(await reason(svc.verify(t, { audience: "another-receiver", purpose: "transfer_receiver" }))).toBe("ASSERTION_AUDIENCE_MISMATCH");
    expect(await reason(svc.verify(t, { audience: RECEIVER, purpose: "portal_binding" }))).toBe("ASSERTION_PURPOSE_MISMATCH");
    const [hh, p, s] = t.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p ?? "", "base64url").toString()), asr: "A3" })).toString("base64url");
    expect(await reason(svc.verify(`${hh}.${forgedPayload}.${s}`, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_SIGNATURE_INVALID");
    expect(await reason(svc.verify("not.a.jwt!", { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_MALFORMED");
    const fresh = await svc.mint(claims(), 60);
    clock.advanceSeconds(66);
    expect(await reason(svc.verify(fresh, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_EXPIRED");
    const future = await svc.mint(claims(), 60);
    clock.advanceSeconds(-30);
    expect(await reason(svc.verify(future, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_NOT_YET_VALID");
  });

  it("[SPEC-7.ASSERTION] unsigned (alg none), HMAC and foreign-issuer tokens are rejected", async () => {
    const { svc, ring, clock } = setup();
    const now = Math.floor(clock.now().getTime() / 1000);
    const body = { ...claims(), iss: ISSUER, iat: now, nbf: now, exp: now + 60, jti: newId("jti") };
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: ASSERTION_TYP, kid: ring.active.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.`;
    expect(await reason(svc.verify(none, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_MALFORMED");
    const noneWithSig = `${none}AAAA`;
    expect(await reason(svc.verify(noneWithSig, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_ALG_NOT_ALLOWED");
    const hs = await new SignJWT(body).setProtectedHeader({ alg: "HS256", typ: ASSERTION_TYP, kid: ring.active.kid }).sign(new TextEncoder().encode("k".repeat(32)));
    expect(await reason(svc.verify(hs, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_ALG_NOT_ALLOWED");
    const other = setup();
    const foreign = await other.svc.mint(claims(), 60);
    expect(await reason(svc.verify(foreign, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_KEY_UNKNOWN");
  });

  it("[SPEC-14.REPLAY] transfer_receiver and portal_binding assertions are single use (jti replay rejected)", async () => {
    const { svc } = setup();
    for (const purpose of ["transfer_receiver", "portal_binding"] as const) {
      const t = await svc.mint(claims({ purpose }), 60);
      await expect(svc.verify(t, { audience: RECEIVER, purpose })).resolves.toBeTruthy();
      expect(await reason(svc.verify(t, { audience: RECEIVER, purpose }))).toBe("ASSERTION_REPLAYED");
    }
  });

  it("[SPEC-14.REPLAY] replay protection holds across service instances sharing the KV store", async () => {
    const shared = new MemoryKvStoreFixture();
    const a = setup({ kvShared: shared });
    const b = new SignedAssertionService({ keyRing: a.ring, kv: shared, clock: a.clock, issuer: ISSUER });
    const t = await a.svc.mint(claims(), 60);
    await a.svc.verify(t, { audience: RECEIVER, purpose: "transfer_receiver" });
    expect(await reason(b.verify(t, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_REPLAYED");
  });

  it("[SPEC-7.ASSERTION] durable_action_grant is reusable but limited to its listed actions and bounded lifetime", async () => {
    const { svc } = setup();
    const t = await svc.mint(claims({ purpose: "durable_action_grant", aud: "vsp-workflows", actions: ["billing_review.follow_up"] }), 86_400);
    await expect(svc.verify(t, { audience: "vsp-workflows", purpose: "durable_action_grant", action: "billing_review.follow_up" })).resolves.toBeTruthy();
    await expect(svc.verify(t, { audience: "vsp-workflows", purpose: "durable_action_grant", action: "billing_review.follow_up" })).resolves.toBeTruthy();
    expect(await reason(svc.verify(t, { audience: "vsp-workflows", purpose: "durable_action_grant", action: "appointment.cancel" }))).toBe("ASSERTION_ACTION_NOT_GRANTED");
    await expect(svc.mint(claims({ purpose: "durable_action_grant", actions: [] }), 60)).rejects.toMatchObject({ reasonCode: "ASSERTION_GRANT_ACTIONS_INVALID" });
    await expect(svc.mint(claims({ purpose: "durable_action_grant", actions: ["a.b", "a.b"] }), 60)).rejects.toMatchObject({ reasonCode: "ASSERTION_GRANT_ACTIONS_INVALID" });
    await expect(svc.mint(claims({ purpose: "transfer_receiver", actions: ["billing_review.follow_up"] }), 60)).rejects.toMatchObject({ reasonCode: "ASSERTION_ACTIONS_NOT_ALLOWED" });
    await expect(svc.mint(claims({ purpose: "durable_action_grant", actions: ["x.y"] }), 8 * 86_400)).rejects.toMatchObject({ reasonCode: "ASSERTION_TTL_INVALID" });
    await expect(svc.mint(claims(), 301)).rejects.toMatchObject({ reasonCode: "ASSERTION_TTL_INVALID" });
    await expect(svc.mint(claims(), 0)).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-7.ASSERTION] a verifier with a shorter lifetime policy rejects over-long assertions", async () => {
    const { ring, kv, clock } = setup();
    const lenient = new SignedAssertionService({ keyRing: ring, kv, clock, issuer: ISSUER });
    const strict = new SignedAssertionService({ keyRing: ring, kv, clock, issuer: ISSUER, maxTtlSeconds: { transfer_receiver: 60 } });
    const t = await lenient.mint(claims(), 300);
    expect(await reason(strict.verify(t, { audience: RECEIVER, purpose: "transfer_receiver" }))).toBe("ASSERTION_LIFETIME_INVALID");
  });

  it("[SPEC-7.ASSERTION] sid must be the non-bearer binding ref; a bearer session ref is refused", async () => {
    const { svc } = setup();
    await expect(svc.mint(claims({ sid: newSessionRef() }), 60)).rejects.toMatchObject({ reasonCode: "ASSERTION_SID_MUST_BE_BINDING_REF" });
  });

  it("[SPEC-7.ASSERTION] nonce and call expectations are enforced", async () => {
    const { svc } = setup();
    const t1 = await svc.mint(claims(), 60);
    expect(await reason(svc.verify(t1, { audience: RECEIVER, purpose: "transfer_receiver", nonce: "x".repeat(32) }))).toBe("ASSERTION_NONCE_MISMATCH");
    const t2 = await svc.mint(claims(), 60);
    expect(await reason(svc.verify(t2, { audience: RECEIVER, purpose: "transfer_receiver", callId: CALLS.concurrent.callId }))).toBe("ASSERTION_CALL_MISMATCH");
  });

  it("[SPEC-7.ASSERTION] key rotation: tokens from the previous kid verify until it is retired; the JWKS has no private material", async () => {
    const { svc, ring } = setup();
    const oldKid = ring.active.kid;
    const before = await svc.mint(claims({ purpose: "durable_action_grant", aud: "vsp-workflows", actions: ["case.follow_up"] }), 3600);
    await ring.rotate(new LocalEs256Signer());
    expect(ring.active.kid).not.toBe(oldKid);
    const after = await svc.mint(claims({ purpose: "durable_action_grant", aud: "vsp-workflows", actions: ["case.follow_up"] }), 3600);
    expect(JSON.parse(Buffer.from(after.split(".")[0] ?? "", "base64url").toString()).kid).toBe(ring.active.kid);
    const expect1 = { audience: "vsp-workflows", purpose: "durable_action_grant" as const };
    await expect(svc.verify(before, expect1)).resolves.toBeTruthy();
    await expect(svc.verify(after, expect1)).resolves.toBeTruthy();
    const jwks = await svc.jwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([oldKid, ring.active.kid].sort());
    for (const k of jwks.keys) {
      expect(k).not.toHaveProperty("d");
      expect(k).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    }
    ring.retire(oldKid);
    expect(await reason(svc.verify(before, expect1))).toBe("ASSERTION_KEY_UNKNOWN");
    await expect(svc.verify(after, expect1)).resolves.toBeTruthy();
    expect(() => ring.retire(ring.active.kid)).toThrow(ValidationError);
    await expect(ring.rotate(ring.active)).rejects.toBeInstanceOf(ValidationError);
  });

  it("[SPEC-7.ASSERTION] local development keys are labelled LOCAL and report kind local_fixture", () => {
    const s = new LocalEs256Signer();
    expect(s.kind).toBe("local_fixture");
    expect(s.kid).toMatch(/^local-dev-/);
    expect(s.label).toContain("LOCAL");
    expect(setup().svc.kind).toBe("local_fixture");
  });

  it("[SPEC-7.TRANSFER] transfer result: same call and receiver only, from a server-resolved context, single use", async () => {
    const h = await createIdentityHarness();
    const { sessionRef } = await h.startCall();
    await h.verifyWithSecureLink(PEOPLE.avery, sessionRef);
    const ctx = await h.sessions.resolve(sessionRef, mcp());
    const ring = new AssertionKeyRing(new LocalEs256Signer());
    const svc = new SignedAssertionService({ keyRing: ring, kv: h.kv, clock: h.clock, issuer: ISSUER });
    const token = await svc.mintTransferResult(ctx, { receiverAudience: RECEIVER });
    expect(token).not.toContain(sessionRef);
    expect(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).not.toContain(sessionRef);
    expect(await reason(svc.verifyTransferResult(token, { receiverAudience: RECEIVER, callId: CALLS.concurrent.callId }))).toBe("ASSERTION_CALL_MISMATCH");
    const c = await svc.verifyTransferResult(token, { receiverAudience: RECEIVER, callId: CALLS.primary.callId });
    expect(c).toMatchObject({ sub: PEOPLE.avery.actorId, asr: "A2", role: "client", call: CALLS.primary.callId, sid: sessionBindingRefFor(sessionRef) });
    expect(await reason(svc.verifyTransferResult(token, { receiverAudience: RECEIVER, callId: CALLS.primary.callId }))).toBe("ASSERTION_REPLAYED");
    const a0 = await h.startCall(newId("cal"));
    expect(await reason(svc.mintTransferResult(a0.ctx, { receiverAudience: RECEIVER }))).toBe("NO_VERIFICATION_RESULT");
    const grant = await svc.mintDurableActionGrant(ctx, { audience: "vsp-workflows", actions: ["billing_review.follow_up"], ttlSeconds: 3600 });
    await expect(svc.authorizeDurableAction(grant, { audience: "vsp-workflows", action: "billing_review.follow_up" })).resolves.toBeTruthy();
    expect(await reason(svc.authorizeDurableAction(grant, { audience: "vsp-workflows", action: "appointment.cancel" }))).toBe("ASSERTION_ACTION_NOT_GRANTED");
    expect(await reason(svc.mintDurableActionGrant({ ...a0.ctx } as AuthContext, { audience: "vsp-workflows", actions: ["x.y"], ttlSeconds: 60 }))).toBe("GRANT_REQUIRES_A2");
  });

  it("[AUTH-06] assertion logs carry codes only (no tokens, nonces or bearer refs)", async () => {
    const { svc, records } = setup();
    const t = await svc.mint(claims(), 60);
    await svc.verify(t, { audience: RECEIVER, purpose: "transfer_receiver" });
    await svc.verify(t, { audience: RECEIVER, purpose: "transfer_receiver" }).catch(() => undefined);
    const text = JSON.stringify(records);
    expect(text).not.toContain(t);
    expect(text).not.toContain("n".repeat(32));
    expect(text).toContain("ASSERTION_REPLAYED");
  });
});

describe("DER <-> JOSE ECDSA signature conversion", () => {
  it("[SPEC-7.ASSERTION] property: derToJose(DER signature) equals the IEEE-P1363 signature semantics and round-trips", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (msg) => {
        const der = nodeSign("sha256", msg, { key: privateKey, dsaEncoding: "der" });
        const jose = derToJose(new Uint8Array(der));
        expect(jose).toHaveLength(64);
        expect(nodeVerify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, jose)).toBe(true);
        expect(Buffer.from(joseToDer(jose)).equals(der)).toBe(true);
      }),
      { seed: 42, numRuns: 150 },
    );
  });

  it("[SPEC-7.ASSERTION] malformed or malleated DER is rejected", () => {
    const bad = [
      [],
      [0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01],
      [0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01],
      [0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01], // negative r
      [0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01], // non-minimal r
      [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01], // zero r
      [0x30, 0x08, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00, 0x00], // trailing bytes
      [0x30, 0x26, 0x02, 0x21, 0x01, ...new Array(32).fill(1), 0x02, 0x01, 0x01], // r too long
    ];
    for (const b of bad) expect(() => derToJose(Uint8Array.from(b))).toThrow(ValidationError);
    expect(derToJose(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]))).toEqual(Uint8Array.from([...new Array(31).fill(0), 1, ...new Array(31).fill(0), 2]));
  });
});

describe("KmsAssertionSigner CONTRACT (stub KMS client; live KMS NOT RUN)", () => {
  const KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

  function stubKms() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sent: (SignCommand | GetPublicKeyCommand)[] = [];
    const client: KmsSender = {
      async send(cmd) {
        sent.push(cmd);
        if (cmd instanceof GetPublicKeyCommand) {
          return {
            KeyId: KEY_ARN,
            PublicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
            KeySpec: "ECC_NIST_P256",
            KeyUsage: "SIGN_VERIFY",
            SigningAlgorithms: ["ECDSA_SHA_256"],
          };
        }
        if (cmd instanceof SignCommand) {
          // RAW mode with ECDSA_SHA_256: KMS hashes the message with SHA-256 and returns a DER signature.
          const der = nodeSign("sha256", Buffer.from(cmd.input.Message as Uint8Array), { key: privateKey, dsaEncoding: "der" });
          return { KeyId: KEY_ARN, Signature: new Uint8Array(der), SigningAlgorithm: "ECDSA_SHA_256" };
        }
        throw new Error("UNEXPECTED_COMMAND");
      },
    };
    return { client, sent, publicKey };
  }

  it("[SPEC-7.ASSERTION] sends Sign(ECDSA_SHA_256, RAW) and GetPublicKey; DER signature converts to a verifiable ES256 JWS", async () => {
    const { client, sent } = stubKms();
    const signer = new KmsAssertionSigner(client, KEY_ARN);
    expect(signer.kind).toBe("live");
    const ring = new AssertionKeyRing(signer);
    const clock = new FakeClock();
    const svc = new SignedAssertionService({ keyRing: ring, kv: new MemoryKvStoreFixture(), clock, issuer: ISSUER });
    const token = await svc.mint(claims(), 60);
    const signCmd = sent.find((c): c is SignCommand => c instanceof SignCommand);
    expect(signCmd?.input).toMatchObject({ KeyId: KEY_ARN, MessageType: "RAW", SigningAlgorithm: "ECDSA_SHA_256" });
    expect(Buffer.from(signCmd?.input.Message as Uint8Array).toString()).toBe(token.split(".").slice(0, 2).join("."));
    await expect(svc.verify(token, { audience: RECEIVER, purpose: "transfer_receiver" })).resolves.toMatchObject({ aud: RECEIVER });
    expect(sent.some((c) => c instanceof GetPublicKeyCommand && c.input.KeyId === KEY_ARN)).toBe(true);
    const jwk = await signer.publicJwk();
    expect(createPublicKey({ key: jwk as never, format: "jwk" }).asymmetricKeyType).toBe("ec");
  });

  it("[SPEC-7.ASSERTION] KMS failures and wrong key specs fail closed with reason codes", async () => {
    const failing: KmsSender = {
      async send() {
        throw new Error("AccessDeniedException: User arn:aws:iam::111122223333:role/x is not authorized");
      },
    };
    const err = await new KmsAssertionSigner(failing, KEY_ARN).sign(new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).message).toBe("ASSERTION_SIGNER_UNAVAILABLE");
    const wrongSpec: KmsSender = { send: async () => ({ PublicKey: new Uint8Array([1, 2]), KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", SigningAlgorithms: ["RSASSA_PSS_SHA_256"] }) };
    await expect(new KmsAssertionSigner(wrongSpec, KEY_ARN).publicJwk()).rejects.toMatchObject({ reasonCode: "ASSERTION_SIGNER_KEY_INVALID" });
    const wrongAlg: KmsSender = { send: async () => ({ Signature: new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), SigningAlgorithm: "ECDSA_SHA_384" }) };
    await expect(new KmsAssertionSigner(wrongAlg, KEY_ARN).sign(new Uint8Array([1]))).rejects.toMatchObject({ reasonCode: "ASSERTION_SIGNER_RESPONSE_INVALID" });
    expect(() => new KmsAssertionSigner(failing, "not-a-key")).toThrow(ValidationError);
    await expect(new KmsAssertionSigner(failing, KEY_ARN).sign(new Uint8Array(4097))).rejects.toMatchObject({ reasonCode: "ASSERTION_TOO_LARGE_FOR_KMS" });
  });
});
