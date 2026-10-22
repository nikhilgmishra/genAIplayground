/**
 * Layer 2, model providers (WP-08; FO-09-06, FO-09-07, FO-09-08, FO-09-09, FO-09-45, FO-09-46, FO-16-18, FO-09-36):
 * the production adapters over TLS (server name verified against the file's test CA) to the `model-emulator` compose
 * service, with the per-request model egress check, the resilience wrapper and the emulator's fault injection seams
 * (MODEL_REFUSAL, MODEL_HANG, MODEL_OVERLOAD) driven through its admin API exactly as the later fault runs drive it
 * (WP-15 MODEL_HANG, WP-17 MODEL_REFUSAL and MODEL_OVERLOAD). Synthetic data only; no real provider is contacted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { invocationEgressCheck } from "../../../src/models/adapters/factory.js";
import { decideModelFallback, speakableText } from "../../../src/models/port/fallback.js";
import { modelInvocationRecord } from "../../../src/models/port/invocation.js";
import type { InvocationAuditContext } from "../../../src/models/port/invocation.js";
import { ModelRequest } from "../../../src/models/port/types.js";
import type { ModelProvider, ModelStreamEvent } from "../../../src/models/port/types.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import { VALID_CATALOG_ARGUMENTS, catalogTools } from "../../emulators/models/catalog-tools.js";
import { layer2 } from "../_harness/layer2.js";
import { scratchDir } from "../_harness/scratch.js";
import { LOOKUP_TOOL, REGION, createModelPki, egressPolicyFor, liveRig, request, syntheticAws, syntheticKey, waitForLog } from "./support.js";
import type { TestPki } from "./support.js";

const PROVIDERS: readonly ModelProvider[] = ["openai_responses", "bedrock_converse", "vllm_openai_compatible"];
const TRANSFER = { name: "transfer_funds", description: "Synthetic transfer tool.", parameters: { type: "object", properties: { amountCents: { type: "integer", maximum: 1000 } }, required: ["amountCents"], additionalProperties: false } };

const it = layer2(["model-emulator"]);
let pki: TestPki;
beforeAll(() => {
  pki = createModelPki();
});
afterAll(() => pki.dispose());

describe("model adapters against the compose emulator over TLS [FO-16-18]", () => {
  it("[FO-09-07][FO-16-18][DATA-01] OpenAI Responses: streamed text and a tool-call round trip over TLS, store:false on every request", async ({ l2 }) => {
    const r = await liveRig(l2, pki, "openai_responses", { endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    const events: ModelStreamEvent[] = [];
    const first = await r.port.invoke(request({ tools: [LOOKUP_TOOL] }), { onEvent: (e) => events.push(e) });
    expect(first).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "lookup_status", arguments: { reference: "synthetic" } }] });
    expect(events.some((e) => e.type === "tool_call_arguments_delta")).toBe(true);
    if (first.outcome !== "COMPLETED") return;
    const call = first.toolCalls[0]!;
    const second = await r.port.invoke(request({ tools: [LOOKUP_TOOL], messages: [{ role: "user", content: "Synthetic caller turn." }, { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", callId: call.callId, name: call.name, content: "{}" }] }));
    expect(second).toMatchObject({ outcome: "COMPLETED", text: "The synthetic tool result was received." });
    const log = await r.admin.requests(r.host);
    expect(log.map((l) => [l.api, l.authorized, l.store, l.stream, l.completed])).toEqual([
      ["openai_responses", true, false, true, true],
      ["openai_responses", true, false, true, true],
    ]);
  });

  it("[FO-09-06][FO-16-18] Bedrock ConverseStream: every request SigV4-verified by the emulator, event stream decoded by the AWS SDK, tool use round trip", async ({ l2 }) => {
    const r = await liveRig(l2, pki, "bedrock_converse", { endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    const first = await r.port.invoke(request({ tools: [LOOKUP_TOOL] }));
    expect(first).toMatchObject({ outcome: "COMPLETED", detail: { stopReason: "tool_use", latencyMs: 25 } });
    if (first.outcome !== "COMPLETED") return;
    const call = first.toolCalls[0]!;
    const second = await r.port.invoke(request({ tools: [LOOKUP_TOOL], messages: [{ role: "user", content: "Synthetic caller turn." }, { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", callId: call.callId, name: call.name, content: "{}" }] }));
    expect(second).toMatchObject({ outcome: "COMPLETED", text: "The synthetic tool result was received.", detail: { stopReason: "end_turn" } });
    expect((await r.admin.requests(r.host)).map((l) => l.sigv4)).toEqual(["VERIFIED", "VERIFIED"]);
  });

  it("[FO-09-06][AUTH-06] adversarial: a request signed with another key pair is refused by SigV4 verification at the emulator", async ({ l2 }) => {
    const wrong = syntheticAws();
    const r = await liveRig(l2, pki, "bedrock_converse", { credential: { kind: "aws", credentials: async () => wrong } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED" });
    expect((await r.admin.requests(r.host))[0]).toMatchObject({ sigv4: "REFUSED", authFailure: "UNKNOWN_ACCESS_KEY", status: 403 });
  });

  it("[FO-09-08][FO-16-18] vLLM: chunks to [DONE] with the pinned served name; leaked parser markup is MALFORMED, never text", async ({ l2 }) => {
    const r = await liveRig(l2, pki, "vllm_openai_compatible");
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", detail: { finishReason: "stop", servedModel: "emulated-text", toolParser: "hermes" } });
    await r.admin.scripts(r.host, { kind: "malformed", variant: "tool_markup_leak" }, { kind: "malformed", variant: "served_name_mismatch" });
    const leak = await r.port.invoke(request());
    expect(leak).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_MARKUP_LEAKED" });
    expect(speakableText(leak)).toBeNull();
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_SERVED_NAME_MISMATCH" });
  });

  it("[FO-09-46][FAULT:MODEL_REFUSAL seam] the admin-injected refusal, rendered as each provider really refuses, is REFUSED and answered by the approved fallback", async ({ l2 }) => {
    // OpenAI: the refusal content part. vLLM: plain content with finish_reason stop (vLLM has no refusal field), typed by
    // the port's refusal classifier. Bedrock: guardrail_intervened only for a request carrying the endpoint's guardrail;
    // without one the model declines in text with end_turn (classified).
    const cases = [
      { provider: "openai_responses" as const, endpoint: {}, refusal: { source: "MODEL_REFUSAL" }, detail: { status: "completed" }, guardrail: false },
      { provider: "vllm_openai_compatible" as const, endpoint: {}, refusal: { source: "CLASSIFIED_REFUSAL" }, detail: { finishReason: "stop", servedModel: "emulated-text" }, guardrail: false },
      { provider: "bedrock_converse" as const, endpoint: { bedrock: { guardrail: { identifier: "gr1synth", version: "1" } } }, refusal: { source: "GUARDRAIL_INTERVENED" }, detail: { stopReason: "guardrail_intervened" }, guardrail: true },
      { provider: "bedrock_converse" as const, endpoint: {}, refusal: { source: "CLASSIFIED_REFUSAL" }, detail: { stopReason: "end_turn" }, guardrail: false },
    ];
    for (const c of cases) {
      const r = await liveRig(l2, pki, c.provider, { endpoint: c.endpoint });
      await r.admin.fault(r.host, "MODEL_REFUSAL");
      const result = await r.port.invoke(request());
      expect(result, `${c.provider} guardrail=${c.guardrail}`).toMatchObject({ outcome: "REFUSED", refusal: c.refusal, detail: c.detail });
      expect(speakableText(result)).toBeNull();
      expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_REFUSED", decisions: [{ templateId: "fallback.safe_explanation" }, { reason: "AI_UNAVAILABLE" }] });
      expect(decideModelFallback(result, { safetySignalActive: true })).toMatchObject({ kind: "APPROVED_FALLBACK", safetyRoute: true, decisions: [{ templateId: "safety.acknowledgment" }, { reason: "SAFETY_PRIORITY" }] });
      const log = await r.admin.requests(r.host);
      expect(log[0]).toMatchObject({ script: "refusal", ...(c.provider === "bedrock_converse" ? { guardrail: c.guardrail, sigv4: "VERIFIED" } : {}) });
    }
  });

  it("[FO-09-45][FAULT:MODEL_HANG seam] a stalled stream ends at the attempt deadline, the emulator sees the connection closed, the fallback is the approved template", async ({ l2 }) => {
    const budget = { deadlineMs: 4_000, attemptTimeoutMs: 600, firstEventTimeoutMs: 600, idleTimeoutMs: 600, maxOutputTokens: 64, maxInputBytes: 65_536 };
    for (const provider of ["openai_responses", "bedrock_converse", "vllm_openai_compatible"] as const) {
      const r = await liveRig(l2, pki, provider, { endpoint: { budget } });
      await r.admin.fault(r.host, "MODEL_HANG");
      const started = Date.now();
      const result = await r.port.invoke(request({ budget }));
      expect(result.outcome, provider).toBe("TIMED_OUT");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(decideModelFallback(result, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK", reason: "MODEL_HANG" });
      const log = await waitForLog(r.admin, r.host, (l) => l[0]?.clientClosedEarly === true);
      expect(log[0], provider).toMatchObject({ script: "hang", clientClosedEarly: true, completed: false });
      expect(log[0]?.framesWritten).toBeGreaterThan(0);
    }
  });

  it("[FO-09-45][FAULT:MODEL_OVERLOAD seam] 429 with Retry-After: the bounded retry waits the provider's delay and then succeeds; without budget it is OVERLOADED", async ({ l2 }) => {
    const r = await liveRig(l2, pki, "openai_responses", { endpoint: { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 5_000 } } });
    await r.admin.fault(r.host, "MODEL_OVERLOAD");
    const started = Date.now();
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect((await r.admin.requests(r.host)).map((l) => l.status)).toEqual([429, 200]);
    const b = await liveRig(l2, pki, "bedrock_converse");
    await b.admin.fault(b.host, "MODEL_OVERLOAD", 1);
    const over = await b.port.invoke(request());
    expect(over).toMatchObject({ outcome: "OVERLOADED", detail: { exception: "ThrottlingException" } });
    expect(decideModelFallback(over, { safetySignalActive: true })).toMatchObject({ kind: "APPROVED_FALLBACK", safetyRoute: true });
  });

  it("[FO-09-45] cancellation over TLS closes the provider stream; the breaker opens on repeated server errors and then fails fast", async ({ l2 }) => {
    const r = await liveRig(l2, pki, "vllm_openai_compatible", { endpoint: { breaker: { windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 } } });
    await r.admin.scripts(r.host, { kind: "hang", afterEvents: 2 }, { kind: "server_error" }, { kind: "server_error" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect(await r.port.invoke(request(), { signal: ac.signal })).toMatchObject({ outcome: "CANCELLED" });
    expect((await waitForLog(r.admin, r.host, (l) => l[0]?.clientClosedEarly === true))[0]?.clientClosedEarly).toBe(true);
    expect((await r.port.invoke(request())).outcome).toBe("FAILED");
    expect((await r.port.invoke(request())).outcome).toBe("FAILED");
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 });
    expect(await r.admin.requests(r.host)).toHaveLength(3);
  });

  it("[DATA-01] adversarial: PHI above the endpoint ceiling, a class the destination does not approve and an untrusted certificate never reach the emulator's API", async ({ l2 }) => {
    // Endpoint ceiling INTERNAL, destination approved for PHI: refused by the port before any exchange.
    const r = await liveRig(l2, pki, "openai_responses", { egressAllowsPhi: true });
    expect(await r.port.invoke(request({ dataClass: "PHI" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(await r.port.invoke(request({ dataClass: "VERIFICATION_SECRET" }))).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_DATA_CLASS_EXCEEDS_ENDPOINT", attempts: 0 });
    expect(await r.admin.requests(r.host)).toEqual([]);
    // Endpoint ceiling PHI, destination PUBLIC/INTERNAL/PHI: FINANCIAL passes the ceiling but the transport's per-request
    // model egress check refuses it before any byte; the PHI request itself is sent (synthetic content only).
    for (const provider of PROVIDERS) {
      const p = await liveRig(l2, pki, provider, { endpoint: { maxDataClass: "PHI" }, egressAllowsPhi: true });
      expect(await p.port.invoke(request({ dataClass: "FINANCIAL" })), provider).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION" });
      expect(await p.admin.requests(p.host), provider).toEqual([]);
      expect((await p.port.invoke(request({ dataClass: "PHI" }))).outcome, provider).toBe("COMPLETED");
      expect(await p.admin.requests(p.host), provider).toHaveLength(1);
    }
    // A transport that trusts another CA refuses the emulator's certificate before any request byte is sent.
    const other = createModelPki();
    try {
      const t = await liveRig(l2, pki, "openai_responses", { tlsCa: [other.caPem] });
      expect(await t.port.invoke(request())).toMatchObject({ outcome: "FAILED", reasonCode: "CONNECTOR_TLS_FAILED", errorClass: "PERMANENT" });
      expect(await t.admin.requests(t.host)).toEqual([]);
    } finally {
      other.dispose();
    }
  });

  for (const provider of PROVIDERS) {
    it(`[FO-04-19][FO-09-09] ${provider}: tool-call proposals the request did not allow are MALFORMED over TLS (un-offered tool, toolChoice none, no tools, schema-violating arguments)`, async ({ l2 }) => {
      const r = await liveRig(l2, pki, provider);
      await r.admin.scripts(
        r.host,
        { kind: "tool_call", name: "transfer_funds", arguments: { amountCents: 999_999 } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: 12_345, extra: "x" } },
        { kind: "tool_call", name: "transfer_funds", arguments: { amountCents: 999_999 } },
        { kind: "tool_call", name: "lookup_status", arguments: { reference: "synthetic" } },
      );
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_NOT_OFFERED" });
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL], toolChoice: "none" }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CHOICE_VIOLATED" });
      expect(await r.port.invoke(request({ tools: [] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_NOT_OFFERED" });
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL, TRANSFER] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      // Positive control: the allowed call is COMPLETED with the parsed proposal.
      expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "lookup_status", arguments: { reference: "synthetic" } }] });
      expect(await r.admin.requests(r.host)).toHaveLength(6);
    });
  }

  for (const provider of PROVIDERS) {
    it(`[FO-04-19][FO-09-09] ${provider}: the gateway's pinned catalogue (18 tools, JSON Schema 2020-12) is offered over TLS; a valid catalogue call is COMPLETED, a schema-breaking one MALFORMED`, async ({ l2 }) => {
      const r = await liveRig(l2, pki, provider);
      const tools = catalogTools();
      const claim = VALID_CATALOG_ARGUMENTS.get_claim_status as Record<string, unknown>;
      await r.admin.scripts(r.host, { kind: "tool_call", name: "get_claim_status", arguments: claim }, { kind: "tool_call", name: "get_claim_status", arguments: { ...claim, injected: "synthetic" } });
      expect(await r.port.invoke(request({ tools }))).toMatchObject({ outcome: "COMPLETED", toolCalls: [{ name: "get_claim_status", arguments: claim }] });
      expect(await r.port.invoke(request({ tools }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_SCHEMA_INVALID" });
      const log = await r.admin.requests(r.host);
      expect(log.map((l) => [l.status, l.toolCount])).toEqual([
        [200, 18],
        [200, 18],
      ]);
    });
  }

  it("[OPS-06][DATA-01] invocation records over TLS: a wrong key per provider (request sent, refused 401 / SigV4 403) is a FAILED record MODEL_AUTH_REJECTED; an egress-refused class has sentAttempts 0 and no record", async ({ l2 }) => {
    const ctx = (endpointRef: string, egressAllowed: InvocationAuditContext["egressAllowed"]): InvocationAuditContext => ({
      tenantId: "ten_synthTenant00000000001",
      requestId: "req_synthRequest0000000001",
      interactionId: null,
      turnId: null,
      caseId: null,
      causationId: null,
      registryRef: "router.primary@1",
      revision: "emulated.1",
      endpointRef,
      region: REGION,
      retentionPolicyRef: "retention.emulator_none",
      pins: { promptTemplate: "router.v1", harness: "harness.v1", policyVersion: "policy.v1", toolSchemaDigest: null },
      contextSnapshotRef: null,
      purposes: ["support_administration"],
      maxInputTokens: 8_000,
      cost: null,
      startedAt: new Date("2026-10-22T05:00:00.000Z"),
      completedAt: new Date("2026-10-22T05:00:01.000Z"),
      digestKey: Buffer.alloc(32, 5),
      egressAllowed,
    });
    for (const provider of PROVIDERS) {
      const wrong = provider === "bedrock_converse" ? { kind: "aws" as const, credentials: async () => syntheticAws() } : { kind: "bearer" as const, token: async () => syntheticKey() };
      const r = await liveRig(l2, pki, provider, { credential: wrong });
      const egressAllowed = invocationEgressCheck(r.endpoint, new EgressGuard(egressPolicyFor([r.endpoint]), { environment: "local" }));
      const req = ModelRequest.parse(request());
      const result = await r.port.invoke(req);
      expect(result, provider).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED", attempts: 1, sentAttempts: 1 });
      const log = await r.admin.requests(r.host);
      expect(log, provider).toHaveLength(1);
      expect([401, 403], provider).toContain(log[0]?.status);
      expect(modelInvocationRecord(req, result, ctx(r.endpoint.endpointRef, egressAllowed)), provider).toMatchObject({ status: "FAILED", errorCode: "MODEL_AUTH_REJECTED", egress: { endpointAllowlisted: true }, contentRecorded: false });
      // Refused by the transport's per-request egress check before any byte: no request at the emulator, no record.
      const p = await liveRig(l2, pki, provider, { endpoint: { maxDataClass: "PHI" }, egressAllowsPhi: true });
      const fin = ModelRequest.parse(request({ dataClass: "FINANCIAL" }));
      const refused = await p.port.invoke(fin);
      expect(refused, provider).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION", attempts: 1, sentAttempts: 0 });
      expect(await p.admin.requests(p.host), provider).toEqual([]);
      expect(modelInvocationRecord(fin, refused, ctx(p.endpoint.endpointRef, () => true)), provider).toBeNull();
    }
  });

  it("[OPS-06][DATA-01] invocation records over TLS: a call the caller cancels (barge-in) after its request reached the provider is CANCELLED with a CANCELLED record, per provider, every time", async ({ l2 }) => {
    const ctx = (endpointRef: string, egressAllowed: InvocationAuditContext["egressAllowed"]): InvocationAuditContext => ({
      tenantId: "ten_synthTenant00000000001",
      requestId: "req_synthRequest0000000001",
      interactionId: null,
      turnId: null,
      caseId: null,
      causationId: null,
      registryRef: "router.primary@1",
      revision: "emulated.1",
      endpointRef,
      region: REGION,
      retentionPolicyRef: "retention.emulator_none",
      pins: { promptTemplate: "router.v1", harness: "harness.v1", policyVersion: "policy.v1", toolSchemaDigest: null },
      contextSnapshotRef: null,
      purposes: ["support_administration"],
      maxInputTokens: 8_000,
      cost: null,
      startedAt: new Date("2026-10-22T09:00:00.000Z"),
      completedAt: new Date("2026-10-22T09:00:01.000Z"),
      digestKey: Buffer.alloc(32, 6),
      egressAllowed,
    });
    for (const provider of PROVIDERS) {
      for (let i = 0; i < 3; i += 1) {
        const r = await liveRig(l2, pki, provider);
        const egressAllowed = invocationEgressCheck(r.endpoint, new EgressGuard(egressPolicyFor([r.endpoint]), { environment: "local" }));
        await r.admin.scripts(r.host, { kind: "hang", afterEvents: 1 });
        const req = ModelRequest.parse(request());
        const ac = new AbortController();
        const pending = r.port.invoke(req, { signal: ac.signal });
        // Cancel only once the emulator has logged the request: the prompt has left the platform.
        await waitForLog(r.admin, r.host, (l) => l.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        ac.abort();
        const result = await pending;
        expect(result, `${provider} #${i}`).toMatchObject({ outcome: "CANCELLED", attempts: 1, sentAttempts: 1 });
        expect(modelInvocationRecord(req, result, ctx(r.endpoint.endpointRef, egressAllowed)), `${provider} #${i}`).toMatchObject({ status: "CANCELLED", errorCode: "MODEL_CALL_CANCELLED", egress: { endpointAllowlisted: true }, contentRecorded: false });
        expect((await waitForLog(r.admin, r.host, (l) => l[0]?.clientClosedEarly === true))[0]?.clientClosedEarly, provider).toBe(true);
      }
    }
  });

  it("[FO-09-09][FO-09-08][FO-04-19] structured output over TLS: schema-valid JSON is COMPLETED, schema-breaking or free text is MALFORMED; an unsupported endpoint, an uncompilable schema and duplicate tool names are refused with no request", async ({ l2 }) => {
    const decision = { name: "decision", schema: { type: "object", properties: { decision: { type: "string", enum: ["synthetic_a", "synthetic_b"] } }, required: ["decision"], additionalProperties: false } };
    for (const provider of ["openai_responses", "vllm_openai_compatible"] as const) {
      const r = await liveRig(l2, pki, provider);
      await r.admin.scripts(r.host, { kind: "text", text: JSON.stringify({ decision: "synthetic_a" }) }, { kind: "text", text: JSON.stringify({ decision: "synthetic_c", extra: 1 }) }, { kind: "text", text: "synthetic-free-text-marker-06" });
      expect(await r.port.invoke(request({ responseSchema: decision })), provider).toMatchObject({ outcome: "COMPLETED", text: JSON.stringify({ decision: "synthetic_a" }) });
      for (let i = 0; i < 2; i += 1) {
        const bad = await r.port.invoke(request({ responseSchema: decision }));
        expect(bad, `${provider} #${i}`).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STRUCTURED_OUTPUT_INVALID" });
        expect(speakableText(bad)).toBeNull();
      }
      expect(await r.admin.requests(r.host), provider).toHaveLength(3);
    }
    const none = await liveRig(l2, pki, "vllm_openai_compatible", { endpoint: { vllm: { toolParser: "hermes", structuredOutput: "none" } } });
    expect(await none.port.invoke(request({ responseSchema: decision }))).toMatchObject({ outcome: "FAILED", reasonCode: "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED", attempts: 0, sentAttempts: 0 });
    expect(await none.admin.requests(none.host)).toEqual([]);
    const duplicate = [LOOKUP_TOOL, { ...LOOKUP_TOOL, description: "Synthetic permissive duplicate.", parameters: { type: "object" } }];
    for (const provider of PROVIDERS) {
      const r = await liveRig(l2, pki, provider);
      expect(await r.port.invoke(request({ responseSchema: { name: "decision", schema: { type: "object", syntheticUnknownKeyword: true } } })), provider).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", attempts: 0 });
      expect(await r.port.invoke(request({ tools: duplicate })), provider).toMatchObject({ outcome: "FAILED", reasonCode: "MODEL_TOOL_NAME_DUPLICATE", attempts: 0 });
      expect(await r.admin.requests(r.host), provider).toEqual([]);
    }
  });

  it("[FO-09-06][AUTH-06] adversarial: with ambient bearer settings (AWS_BEARER_TOKEN_BEDROCK; AWS_AUTH_SCHEME_PREFERENCE=httpBearerAuth with an SSO session) Bedrock still signs SigV4 with the handle, and nothing leaves outside the transport", async ({ l2 }) => {
    // A side listener stands in for the SSO-OIDC token endpoint: a request reaching it would have left the transport.
    const side: string[] = [];
    const sideServer = createServer((req, res) => {
      side.push(`${req.method} ${req.url}`);
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
    });
    await new Promise<void>((resolve) => sideServer.listen(0, "127.0.0.1", () => resolve()));
    const sidePort = (sideServer.address() as { port: number }).port;
    const home = scratchDir("vsp-models-bedrock-ambient-");
    mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
    writeFileSync(join(home, ".aws", "config"), "[default]\nsso_session = synth\nauth_scheme_preference = httpBearerAuth\n\n[sso-session synth]\nsso_region = us-east-1\nsso_start_url = https://synth.awsapps.invalid/start\n");
    writeFileSync(
      join(home, ".aws", "sso", "cache", `${createHash("sha1").update("synth").digest("hex")}.json`),
      JSON.stringify({ accessToken: "tok_synthssoaccess", expiresAt: new Date(Date.now() + 120_000).toISOString(), refreshToken: "tok_synthrefresh", clientId: "cid_synth", clientSecret: "cs_synth", registrationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), region: REGION, startUrl: "https://synth.awsapps.invalid/start" }),
    );
    const saved = { ...process.env };
    const variants: Record<string, string>[] = [
      { AWS_BEARER_TOKEN_BEDROCK: "amb_synthambientbearer01" },
      { AWS_AUTH_SCHEME_PREFERENCE: "httpBearerAuth", HOME: home, AWS_CONFIG_FILE: join(home, ".aws", "config"), AWS_ENDPOINT_URL_SSO_OIDC: `http://127.0.0.1:${sidePort}` },
    ];
    try {
      for (const env of variants) {
        Object.assign(process.env, env);
        const aws = syntheticAws();
        let handleCalls = 0;
        const r = await liveRig(l2, pki, "bedrock_converse", { credential: { kind: "aws", credentials: async () => ((handleCalls += 1), aws) }, hostCredentials: () => ({ aws: [aws], region: REGION, models: ["emulated-text"] }) });
        const connect = vi.spyOn(net.Socket.prototype, "connect");
        let result;
        let calls: unknown[][] = [];
        try {
          result = await r.port.invoke(request());
        } finally {
          // Read the calls before restoring: restoring a spy also clears its recorded calls.
          calls = connect.mock.calls.map((c) => [...c]);
          connect.mockRestore();
        }
        // net normalizes the arguments into an array whose first item holds the options; unwrap either form.
        const ports = calls.map((c) => {
          const a = Array.isArray(c[0]) ? (c[0] as unknown[])[0] : c[0];
          return typeof a === "object" && a !== null ? Number((a as { port?: unknown }).port) : Number(a);
        });
        expect(result, JSON.stringify(Object.keys(env))).toMatchObject({ outcome: "COMPLETED" });
        expect(handleCalls).toBe(1);
        expect(ports.length).toBeGreaterThanOrEqual(1);
        expect(ports.every((p) => p === r.emulatorPort), JSON.stringify(ports)).toBe(true);
        const log = await r.admin.requests(r.host);
        expect(log).toMatchObject([{ sigv4: "VERIFIED", authorized: true }]);
        expect(log[0]?.headerNames).toEqual(expect.arrayContaining(["authorization", "x-amz-date", "x-amz-content-sha256"]));
        for (const k of Object.keys(env)) delete process.env[k];
        Object.assign(process.env, saved);
      }
      expect(side).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      await new Promise<void>((resolve) => sideServer.close(() => resolve()));
    }
  });

  for (const provider of PROVIDERS) {
    it(`[FO-09-45][FAULT:MODEL_HANG seam] ${provider}: hangs ended by the overall deadline (attempt timeout == deadline) open the breaker over TLS; later calls fail fast with no request`, async ({ l2 }) => {
      const budget = { deadlineMs: 600, attemptTimeoutMs: 600, firstEventTimeoutMs: 500, idleTimeoutMs: 500, maxOutputTokens: 64, maxInputBytes: 65_536 };
      const breaker = { windowMs: 60_000, minimumRequests: 2, failureRateThreshold: 0.5, cooldownMs: 60_000, halfOpenMaxProbes: 1, halfOpenSuccessesToClose: 1 };
      const r = await liveRig(l2, pki, provider, { endpoint: { budget, breaker } });
      await r.admin.fault(r.host, "MODEL_HANG", 4);
      const results = [];
      for (let i = 0; i < 4; i += 1) results.push(await r.port.invoke(request({ budget })));
      expect(results.slice(0, 2), provider).toMatchObject([{ outcome: "TIMED_OUT" }, { outcome: "TIMED_OUT" }]);
      expect(results.slice(2), provider).toMatchObject([
        { outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 },
        { outcome: "UNAVAILABLE", reasonCode: "MODEL_CIRCUIT_OPEN", attempts: 0 },
      ]);
      for (const res of results) expect(decideModelFallback(res, { safetySignalActive: false })).toMatchObject({ kind: "APPROVED_FALLBACK" });
      const log = await waitForLog(r.admin, r.host, (l) => l.length === 2 && l.every((e) => e.clientClosedEarly === true));
      expect(log, provider).toHaveLength(2);
      expect(log.every((e) => e.clientClosedEarly === true && e.script === "hang"), provider).toBe(true);
    });
  }

  it("[FO-09-45][FAULT:MODEL_OVERLOAD seam] vLLM: 503 with Retry-After from the gateway in front of the server: the bounded retry waits the delay, then succeeds", async ({ l2 }) => {
    const r = await liveRig(l2, pki, "vllm_openai_compatible", { endpoint: { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 5_000 } } });
    await r.admin.fault(r.host, "MODEL_OVERLOAD", 1, { status: 503, retryAfterSeconds: 1 });
    const started = Date.now();
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect((await r.admin.requests(r.host)).map((l) => l.status)).toEqual([503, 200]);
    const o = await liveRig(l2, pki, "vllm_openai_compatible");
    await o.admin.fault(o.host, "MODEL_OVERLOAD", 1, { status: 503, retryAfterSeconds: 2 });
    expect(await o.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", retryAfterMs: 2_000 });
  });

  it("[FO-09-09] error classes over TLS: PERMANENT is never retried, RETRYABLE is retried within the budget, an unrecognised provider error is UNKNOWN", async ({ l2 }) => {
    const retry = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 };
    const o = await liveRig(l2, pki, "openai_responses", { endpoint: { retry } });
    await o.admin.scripts(o.host, { kind: "request_rejected" }, { kind: "stream_error", code: "synthetic_unrecognised_code" }, { kind: "server_error" }, { kind: "text", text: "Recovered.", chunks: 1 });
    expect(await o.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_REQUEST_REJECTED", attempts: 1 });
    expect(await o.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "UNKNOWN", reasonCode: "MODEL_RESPONSE_FAILED", attempts: 1 });
    expect(await o.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    const b = await liveRig(l2, pki, "bedrock_converse", { endpoint: { retry } });
    await b.admin.scripts(b.host, { kind: "request_rejected" }, { kind: "quota_exhausted" }, { kind: "context_window" }, { kind: "server_error" }, { kind: "text", text: "Recovered.", chunks: 1 });
    expect(await b.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", detail: { exception: "ValidationException" }, attempts: 1 });
    expect(await b.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", reasonCode: "MODEL_QUOTA_EXHAUSTED", detail: { exception: "ServiceQuotaExceededException" }, attempts: 1 });
    expect(await b.port.invoke(request())).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_CONTEXT_WINDOW_EXCEEDED" });
    expect(await b.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
    expect((await b.admin.requests(b.host)).every((l) => l.sigv4 === "VERIFIED")).toBe(true);
    const v = await liveRig(l2, pki, "vllm_openai_compatible", { endpoint: { retry } });
    await v.admin.scripts(v.host, { kind: "request_rejected", status: 422 }, { kind: "engine_abort" }, { kind: "text", text: "Recovered.", chunks: 1 });
    expect(await v.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "PERMANENT", httpStatus: 422, attempts: 1 });
    expect(await v.port.invoke(request())).toMatchObject({ outcome: "COMPLETED", attempts: 2 });
  });

  it("[FO-09-07][FO-09-09] OpenAI: a long well-formed stream (3,200 deltas, a body above twice the per-event bound, text well within the output budget) is COMPLETED over TLS on the buffered production exchange", async ({ l2 }) => {
    // Each Responses delta event carries about 200 bytes of envelope, so 3,200 of them make a buffered body of more
    // than 512 KiB (2 x maxEventBytes) while the text itself is about 16 KB, inside maxOutputTokens.
    const budget = { deadlineMs: 60_000, attemptTimeoutMs: 60_000, firstEventTimeoutMs: 30_000, idleTimeoutMs: 30_000, maxOutputTokens: 8_192, maxInputBytes: 65_536 };
    const r = await liveRig(l2, pki, "openai_responses", { endpoint: { budget } });
    const text = "word ".repeat(3_200);
    await r.admin.scripts(r.host, { kind: "text", text, chunks: 3_200 });
    let deltas = 0;
    const result = await r.port.invoke(request({ budget }), { onEvent: (e) => void (e.type === "text_delta" && (deltas += 1)) });
    expect(result).toMatchObject({ outcome: "COMPLETED" });
    if (result.outcome === "COMPLETED") expect(result.text).toBe(text);
    expect(deltas).toBe(3_200);
    expect((await r.admin.requests(r.host))[0]?.framesWritten).toBeGreaterThan(3_200);
  }, 90_000);
});
