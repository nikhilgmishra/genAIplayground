/**
 * Minimized invocation audit metadata (WP-08; FO-09-45, OPS-06, DATA-01): the ModelInvocation record validates
 * against the contract, carries a KEYED digest and never the prompt or completion text, and exists only for a call
 * that reached the allowlisted endpoint. Synthetic values only (the date of birth below is synthetic).
 */
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelInvocation } from "../../protocol/models.js";
import { canonicalJson } from "../../shared/canonical.js";
import { EgressGuard } from "../../privacy/egress.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { egressPolicyFor, request, rig, syntheticAws, syntheticKey, testMetrics } from "../../../test/emulators/models/harness.js";
import { invocationEgressCheck } from "../adapters/factory.js";
import { MODEL_DIGEST_KEY_MIN_BYTES, modelInputDigest, modelInvocationRecord, reachedProvider } from "./invocation.js";
import type { InvocationAuditContext } from "./invocation.js";
import { ModelRequest } from "./types.js";
import type { ModelResult } from "./types.js";

const KEY = Buffer.alloc(32, 7); // synthetic digest key (the composition root supplies the audit or tenant key)

const ctx: InvocationAuditContext = {
  tenantId: "ten_synthTenant00000000001",
  requestId: "req_synthRequest0000000001",
  interactionId: null,
  turnId: null,
  caseId: null,
  causationId: null,
  registryRef: "router.primary@1",
  revision: "emulated.1",
  endpointRef: "ep.openai.synth",
  region: "us-east-1",
  retentionPolicyRef: "retention.zero_retention",
  pins: { promptTemplate: "router.v1", harness: "harness.v1", policyVersion: "policy.v1", toolSchemaDigest: null },
  contextSnapshotRef: null,
  purposes: ["support_administration"],
  maxInputTokens: 8_000,
  cost: { costVersion: "cost.synth.1", inputMicroUsdPerMTok: 1_000_000, outputMicroUsdPerMTok: 2_000_000 },
  startedAt: new Date("2026-10-21T12:00:00.000Z"),
  completedAt: new Date("2026-10-21T12:00:01.000Z"),
  digestKey: KEY,
  egressAllowed: () => true,
};

const detail = { provider: "openai_responses" as const, responseId: null, status: "completed" as const, incompleteReason: null, errorCode: null };
const completed = (req: ModelRequest): ModelResult => ({ provider: "openai_responses", invocationId: req.invocationId, latencyMs: 420, attempts: 1, sentAttempts: 1, usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: null, reasoningTokens: null }, outcome: "COMPLETED", text: "Synthetic reply", toolCalls: [], detail });

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

describe("ModelInvocation audit record [OPS-06][DATA-01]", () => {
  it("[OPS-06] a completed call yields a valid record with the pinned entry, keyed digest, usage and cost, and no content", () => {
    const req = ModelRequest.parse(request({ messages: [{ role: "user", content: "Synthetic caller 555-0100 asks a question." }] }));
    const rec = modelInvocationRecord(req, completed(req), ctx);
    expect(rec).not.toBeNull();
    expect(ModelInvocation.safeParse(rec).success).toBe(true);
    expect(rec).toMatchObject({ status: "COMPLETED", contentRecorded: false, errorCode: null, egress: { endpointAllowlisted: true }, usage: { inputTokens: 1_000, outputTokens: 200, costMicroUsd: 1_400, latencyMs: 420 } });
    expect(rec?.input.digest).toBe(modelInputDigest(req, KEY));
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain("555-0100");
    expect(dump).not.toContain("Synthetic reply");
  });

  it("[DATA-01] adversarial: the digest is keyed; a dictionary of guesses cannot confirm a low-entropy prompt without the key", () => {
    const dob = (d: Date) => d.toISOString().slice(0, 10);
    const prompt = (x: string) => ModelRequest.parse(request({ invocationId: "minv_synthDigest0000000001", messages: [{ role: "user", content: `Synthetic date of birth ${x}` }] }));
    const secret = "1987-03-14"; // synthetic
    const recorded = modelInputDigest(prompt(secret), KEY);
    const canonical = (r: ModelRequest) => canonicalJson({ i: r.instructions, m: r.messages, t: r.tools, c: r.toolChoice, s: r.responseSchema });
    let unkeyedHits = 0;
    let wrongKeyHits = 0;
    let keyedHits = 0;
    const wrongKey = Buffer.alloc(32, 9);
    const start = Date.UTC(1940, 0, 1);
    for (let day = 0; day < 365 * 70; day += 1) {
      const guess = canonical(prompt(dob(new Date(start + day * 86_400_000))));
      if (createHash("sha256").update(guess).digest("hex") === recorded) unkeyedHits += 1;
      if (createHmac("sha256", wrongKey).update(guess).digest("hex") === recorded) wrongKeyHits += 1;
      if (createHmac("sha256", KEY).update(guess).digest("hex") === recorded) keyedHits += 1;
    }
    expect({ unkeyedHits, wrongKeyHits }).toEqual({ unkeyedHits: 0, wrongKeyHits: 0 });
    // Positive control: the same enumeration finds it with the key, so the dictionary did contain the value.
    expect(keyedHits).toBe(1);
    expect(() => modelInputDigest(prompt(secret), Buffer.alloc(MODEL_DIGEST_KEY_MIN_BYTES - 1))).toThrow("MODEL_DIGEST_KEY_TOO_SHORT");
    expect(modelInputDigest(prompt(secret), KEY)).not.toBe(modelInputDigest(prompt("1987-03-15"), KEY));
  });

  it("[DATA-01][OPS-06] adversarial: no record claims allowlisting for a call that never reached the endpoint (egress refused, data class, circuit, attempts 0, egress check refuses)", () => {
    const req = ModelRequest.parse(request());
    const base = { provider: "openai_responses" as const, invocationId: req.invocationId, latencyMs: 3, usage: null };
    const refusedEgress: ModelResult = { ...base, attempts: 1, sentAttempts: 0, outcome: "UNAVAILABLE", reasonCode: "EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION", detail: null };
    const ceiling: ModelResult = { ...base, attempts: 0, sentAttempts: 0, outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", detail: null };
    const circuit: ModelResult = { ...base, attempts: 0, sentAttempts: 0, outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", detail: null };
    const preCancelled: ModelResult = { ...base, attempts: 0, sentAttempts: 0, outcome: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED", detail: null };
    for (const r of [refusedEgress, ceiling, circuit, preCancelled]) {
      expect(reachedProvider(r)).toBe(false);
      expect(modelInvocationRecord(req, r, ctx)).toBeNull();
    }
    expect(modelInvocationRecord(req, completed(req), { ...ctx, egressAllowed: () => false })).toBeNull();
  });

  it("[DATA-01] end to end: a PHI request refused by egress has no record; an allowed call's record uses the endpoint's own egress check", async () => {
    const r = await rig("openai_responses", { emulator });
    const policy = egressPolicyFor([r.endpoint]);
    const guardMetrics = testMetrics();
    const egressAllowed = invocationEgressCheck(r.endpoint, new EgressGuard(policy, { environment: "local", metrics: guardMetrics }));
    const phi = ModelRequest.parse(request({ dataClass: "PHI" }));
    // The endpoint ceiling is INTERNAL: refused before any exchange, and the destination would refuse PHI as well.
    const refused = await r.port.invoke(phi);
    expect(refused).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(egressAllowed("PHI")).toBe(false);
    // The audit decision is a peek: it never counts a second denial for a payload (the transport counted it once).
    expect(guardMetrics.counterValue("vsp_egress_denied_total")).toBe(0);
    expect(modelInvocationRecord(phi, refused, { ...ctx, egressAllowed })).toBeNull();
    const ok = ModelRequest.parse(request());
    const done = await r.port.invoke(ok);
    expect(done.outcome).toBe("COMPLETED");
    expect(modelInvocationRecord(ok, done, { ...ctx, egressAllowed })).toMatchObject({ status: "COMPLETED", egress: { endpointAllowlisted: true } });
    expect(emulator.requests(r.host)).toHaveLength(1);
  });

  it("[OPS-06][DATA-01] a request whose bytes reached the provider is recorded whatever the outcome: a wrong key (401/403 after send) is a FAILED record MODEL_AUTH_REJECTED, per provider", async () => {
    for (const provider of ["openai_responses", "vllm_openai_compatible", "bedrock_converse"] as const) {
      const wrong = provider === "bedrock_converse" ? { kind: "aws" as const, credentials: async () => syntheticAws() } : { kind: "bearer" as const, token: async () => syntheticKey() };
      const r = await rig(provider, { emulator, credential: wrong });
      const egressAllowed = invocationEgressCheck(r.endpoint, new EgressGuard(egressPolicyFor([r.endpoint]), { environment: "local" }));
      const req = ModelRequest.parse(request());
      const result = await r.port.invoke(req);
      expect(result, provider).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", attempts: 1, sentAttempts: 1 });
      // The emulator received the request (the prompt left the platform) and refused it.
      const log = emulator.requests(r.host);
      expect(log).toHaveLength(1);
      expect([401, 403]).toContain(log[0]?.status);
      expect(reachedProvider(result)).toBe(true);
      expect(modelInvocationRecord(req, result, { ...ctx, endpointRef: r.endpoint.endpointRef, egressAllowed }), provider).toMatchObject({ status: "FAILED", errorCode: "MODEL_AUTH_REJECTED", egress: { endpointAllowlisted: true }, contentRecorded: false, usage: null });
    }
  });

  it("[OPS-06][DATA-01] adversarial: a call the caller cancels (barge-in) after its request reached the provider is CANCELLED with a CANCELLED record, per provider, every time", async () => {
    for (const provider of ["openai_responses", "vllm_openai_compatible", "bedrock_converse"] as const) {
      for (let i = 0; i < 5; i += 1) {
        const r = await rig(provider, { emulator });
        const egressAllowed = invocationEgressCheck(r.endpoint, new EgressGuard(egressPolicyFor([r.endpoint]), { environment: "local" }));
        r.emulator.queue(r.host, { kind: "hang", afterEvents: 1 });
        const req = ModelRequest.parse(request());
        const ac = new AbortController();
        const pending = r.port.invoke(req, { signal: ac.signal });
        // Cancel only once the emulator has logged the request (the prompt left the platform), mid-stream.
        await expect.poll(() => r.emulator.requests(r.host).length, { timeout: 3_000, interval: 5 }).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        ac.abort();
        const result = await pending;
        expect(result, `${provider} #${i}`).toMatchObject({ outcome: "CANCELLED", attempts: 1, sentAttempts: 1 });
        expect(reachedProvider(result)).toBe(true);
        expect(modelInvocationRecord(req, result, { ...ctx, endpointRef: r.endpoint.endpointRef, egressAllowed }), `${provider} #${i}`).toMatchObject({ status: "CANCELLED", errorCode: "MODEL_CALL_CANCELLED", egress: { endpointAllowlisted: true }, contentRecorded: false });
      }
    }
  });

  it("[OPS-06][DATA-01] adversarial: attempts refused before any byte was sent (egress, credential, connection refused) carry sentAttempts 0 and no record", async () => {
    // Egress: the destination approves PUBLIC/INTERNAL/PHI; FINANCIAL is under the PHI ceiling but refused by the
    // transport's per-request check before any byte is sent.
    const both = await rig("openai_responses", { emulator, endpoint: { maxDataClass: "PHI" }, egressAllowsPhi: true });
    const fin = ModelRequest.parse(request({ dataClass: "FINANCIAL" }));
    const refused = await both.port.invoke(fin);
    expect(refused).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION", attempts: 1, sentAttempts: 0 });
    expect(modelInvocationRecord(fin, refused, ctx)).toBeNull();
    expect(emulator.requests(both.host)).toEqual([]);
    // Credential: the composition root cannot resolve the key.
    const noKey = await rig("openai_responses", { emulator, credential: { kind: "bearer", token: async () => { throw new Error("synthetic secret store outage"); } } });
    const req = ModelRequest.parse(request());
    const unavailable = await noKey.port.invoke(req);
    expect(unavailable).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_UNAVAILABLE", attempts: 1, sentAttempts: 0 });
    expect(modelInvocationRecord(req, unavailable, ctx)).toBeNull();
    // Connection refused: the endpoint host is routed to a loopback port nobody listens on.
    const closed = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
    await closed.stop();
    const refusedConn = await rig("openai_responses", { emulator: closed });
    const conn = await refusedConn.port.invoke(req);
    expect(conn).toMatchObject({ outcome: "FAILED", reasonCode: "CONNECTION_REFUSED", sentAttempts: 0 });
    expect(modelInvocationRecord(req, conn, ctx)).toBeNull();
  });

  it("[OPS-06] the record states the budget the call ran with: the request budget capped at the endpoint ceiling", () => {
    const req = ModelRequest.parse(request({ budget: { deadlineMs: 9_000, attemptTimeoutMs: 8_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 4_096, maxInputBytes: 65_536 } }));
    const ceiling = { deadlineMs: 5_000, attemptTimeoutMs: 4_000, firstEventTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxOutputTokens: 256, maxInputBytes: 65_536 };
    expect(modelInvocationRecord(req, completed(req), { ...ctx, budgetCeiling: ceiling })?.budget).toMatchObject({ maxOutputTokens: 256, deadlineMs: 5_000 });
    // A request below the ceiling keeps its own (smaller) budget; without a ceiling the request budget is recorded.
    const small = ModelRequest.parse(request({ budget: { deadlineMs: 3_000, attemptTimeoutMs: 2_000, firstEventTimeoutMs: 1_000, idleTimeoutMs: 1_000, maxOutputTokens: 64, maxInputBytes: 65_536 } }));
    expect(modelInvocationRecord(small, { ...completed(small), usage: null }, { ...ctx, budgetCeiling: ceiling })?.budget).toMatchObject({ maxOutputTokens: 64, deadlineMs: 3_000 });
    expect(modelInvocationRecord(req, completed(req), ctx)?.budget).toMatchObject({ maxOutputTokens: 4_096, deadlineMs: 9_000 });
  });

  it("[DATA-01] failures carry their reason code", () => {
    const a = ModelRequest.parse(request());
    const timed: ModelResult = { provider: "bedrock_converse", invocationId: a.invocationId, latencyMs: 9, attempts: 1, sentAttempts: 1, usage: null, outcome: "TIMED_OUT", phase: "STREAM_IDLE", reasonCode: "MODEL_READ_TIMEOUT", detail: null };
    expect(modelInvocationRecord(a, timed, ctx)).toMatchObject({ status: "TIMED_OUT", errorCode: "MODEL_READ_TIMEOUT", usage: null });
    const refused: ModelResult = { provider: "bedrock_converse", invocationId: a.invocationId, latencyMs: 9, attempts: 1, sentAttempts: 1, usage: null, outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED", reasonCode: "MODEL_GUARDRAIL_INTERVENED" }, detail: { provider: "bedrock_converse", requestId: null, stopReason: "guardrail_intervened", exception: null, latencyMs: null } };
    expect(modelInvocationRecord(a, refused, ctx)).toMatchObject({ status: "REFUSED", errorCode: "MODEL_GUARDRAIL_INTERVENED" });
  });
});
