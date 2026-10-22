/**
 * Amazon Bedrock ConverseStream adapter against the protocol-exact emulator (WP-08; FO-09-06, FO-09-09, FO-09-45,
 * FO-09-46, FO-16-18). The AWS SDK signs (SigV4) and decodes (AWS event stream); its network handler is the
 * egress-classified transport. The emulator VERIFIES every SigV4 signature with the registered synthetic key pair and
 * writes binary event-stream frames that the SDK's own decoder must accept. In-process test emulator, 127.0.0.1 only.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decideModelFallback, speakableText } from "../port/fallback.js";
import type { ModelStreamEvent } from "../port/types.js";
import { ModelEmulator } from "../../../test/emulators/models/server.js";
import { LOOKUP_TOOL, egressPolicyFor, endpointConfig, request, rig, syntheticAws } from "../../../test/emulators/models/harness.js";
import { modelEndpointGuardViolations } from "../port/config.js";
import { bedrockConverseInput } from "./bedrock-converse.js";
import { ModelRequest } from "../port/types.js";

let emulator: ModelEmulator;
beforeAll(async () => {
  emulator = await new ModelEmulator({ httpPort: 0, frameDelayMs: 1 }).start();
});
afterAll(async () => {
  await emulator.stop();
});

describe("Bedrock ConverseStream adapter over the emulator [FO-09-06][FO-09-09]", () => {
  it("[FO-09-06] a SigV4-signed ConverseStream: the emulator verifies the signature, the SDK decodes the event stream, usage and latency are reported", async () => {
    const r = await rig("bedrock_converse", { emulator });
    const events: ModelStreamEvent[] = [];
    const result = await r.port.invoke(request(), { onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ outcome: "COMPLETED", provider: "bedrock_converse", text: "This is a synthetic emulated reply.", toolCalls: [] });
    if (result.outcome === "COMPLETED") expect(result.detail).toMatchObject({ provider: "bedrock_converse", stopReason: "end_turn", latencyMs: 25, exception: null });
    expect(result.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: 6 });
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThanOrEqual(3);
    expect(r.emulator.requests(r.host)[0]).toMatchObject({ api: "bedrock_converse", sigv4: "VERIFIED", authorized: true, model: "emulated-text", completed: true });
    expect(r.emulator.requests(r.host)[0]?.headerNames).toEqual(expect.arrayContaining(["authorization", "x-amz-date", "x-amz-content-sha256"]));
  });

  it("[FO-09-06][AUTH-06] adversarial: a request signed with the wrong secret is refused by SigV4 verification (UNAVAILABLE), nothing is answered", async () => {
    const wrong = syntheticAws();
    const r = await rig("bedrock_converse", { emulator, credential: { kind: "aws", credentials: async () => wrong } });
    const result = await r.port.invoke(request());
    expect(result).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_AUTH_REJECTED" });
    expect(r.emulator.requests(r.host)[0]).toMatchObject({ sigv4: "REFUSED", authFailure: "UNKNOWN_ACCESS_KEY", status: 403 });
  });

  it("[FO-09-06][AUTH-06] failure injection: a credential provider that fails (task role unavailable) is UNAVAILABLE MODEL_CREDENTIAL_UNAVAILABLE, nothing is sent and nothing retried", async () => {
    let calls = 0;
    const r = await rig("bedrock_converse", {
      emulator,
      credential: {
        kind: "aws",
        credentials: async () => {
          calls += 1;
          throw new Error("synthetic credential provider failure");
        },
      },
    });
    const result = await r.port.invoke(request());
    expect(result).toMatchObject({ outcome: "UNAVAILABLE", reasonCode: "MODEL_CREDENTIAL_UNAVAILABLE", attempts: 1 });
    expect(calls).toBe(1);
    expect(r.emulator.requests(r.host)).toEqual([]);
  });

  it("[FO-09-06][FO-09-09] tool use round trip: toolUse content blocks become a parsed tool call; the toolResult turn is accepted", async () => {
    const r = await rig("bedrock_converse", { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    const first = await r.port.invoke(request({ tools: [LOOKUP_TOOL] }));
    expect(first).toMatchObject({ outcome: "COMPLETED", detail: { stopReason: "tool_use" } });
    if (first.outcome !== "COMPLETED") return;
    expect(first.toolCalls).toEqual([{ callId: expect.stringMatching(/^tooluse_/), name: "lookup_status", arguments: { reference: "synthetic" } }]);
    const call = first.toolCalls[0]!;
    const second = await r.port.invoke(
      request({
        tools: [LOOKUP_TOOL],
        messages: [
          { role: "user", content: "Synthetic caller turn." },
          { role: "assistant", content: "", toolCalls: [call] },
          { role: "tool", callId: call.callId, name: call.name, content: JSON.stringify({ status: "SYNTHETIC_OPEN" }) },
        ],
      }),
    );
    expect(second).toMatchObject({ outcome: "COMPLETED", text: "The synthetic tool result was received." });
    expect(r.emulator.requests(r.host).every((l) => l.sigv4 === "VERIFIED")).toBe(true);
  });

  it("[FO-09-06] the request keeps Bedrock's rules: alternating roles, tool results in the next user turn, guardrail configuration", () => {
    const req = ModelRequest.parse(
      request({
        tools: [LOOKUP_TOOL],
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "assistant", content: "c", toolCalls: [{ callId: "tooluse_synth1", name: "lookup_status", arguments: { reference: "x" } }] },
          { role: "tool", callId: "tooluse_synth1", name: "lookup_status", content: "{}" },
        ],
      }),
    );
    const input = bedrockConverseInput({ modelId: "emulated-text", guardrail: { identifier: "gr1synth", version: "1" } }, req);
    expect(input.messages?.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(input.messages?.[0]?.content).toHaveLength(2);
    expect(input.messages?.[2]?.content?.[0]).toMatchObject({ toolResult: { toolUseId: "tooluse_synth1" } });
    expect(input.guardrailConfig).toMatchObject({ guardrailIdentifier: "gr1synth", guardrailVersion: "1", streamProcessingMode: "sync" });
    expect(input.toolConfig?.toolChoice).toEqual({ auto: {} });
  });

  it("[FO-09-46][FAULT:MODEL_REFUSAL seam] with the endpoint's guardrail on the request, the refusal is guardrail_intervened: REFUSED, the guardrail text never speakable", async () => {
    const r = await rig("bedrock_converse", { emulator, endpoint: { bedrock: { guardrail: { identifier: "gr1synth", version: "1" } } } });
    r.emulator.injectFault(r.host, "MODEL_REFUSAL");
    const result = await r.port.invoke(request());
    expect(r.emulator.requests(r.host)[0]).toMatchObject({ guardrail: true, sigv4: "VERIFIED" });
    expect(result).toMatchObject({ outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED", reasonCode: "MODEL_GUARDRAIL_INTERVENED" }, detail: { stopReason: "guardrail_intervened" } });
    expect(speakableText(result)).toBeNull();
    expect(decideModelFallback(result, { safetySignalActive: true })).toMatchObject({ kind: "APPROVED_FALLBACK", safetyRoute: true, decisions: [{ kind: "SPEECH_REQUEST", templateId: "safety.acknowledgment" }, { kind: "HANDOFF_PROPOSAL", reason: "SAFETY_PRIORITY" }] });
  });

  it("[FO-09-09] stop reasons keep their provider meaning: content_filtered, max_tokens", async () => {
    const r = await rig("bedrock_converse", { emulator });
    r.emulator.queue(r.host, { kind: "content_filter" }, { kind: "max_tokens" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "REFUSED", refusal: { source: "CONTENT_FILTER" } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "INCOMPLETE", reasonCode: "MODEL_MAX_OUTPUT_TOKENS", detail: { stopReason: "max_tokens" } });
  });

  it("[FO-09-45][FAULT:MODEL_OVERLOAD seam] ThrottlingException over HTTP and inside the stream is OVERLOADED; ServiceUnavailable too", async () => {
    const r = await rig("bedrock_converse", { emulator });
    r.emulator.injectFault(r.host, "MODEL_OVERLOAD");
    r.emulator.queue(r.host, { kind: "overload", midStream: true }, { kind: "overload", status: 503 });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", reasonCode: "MODEL_OVERLOADED", detail: { exception: "ThrottlingException" } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", detail: { exception: "ThrottlingException" } });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "OVERLOADED", detail: { exception: "ServiceUnavailableException" } });
  });

  it("[FO-09-45][FAULT:MODEL_HANG seam] a stalled event stream ends at the attempt deadline and the connection is closed", async () => {
    const budget = { deadlineMs: 3_000, attemptTimeoutMs: 400, firstEventTimeoutMs: 400, idleTimeoutMs: 400, maxOutputTokens: 64, maxInputBytes: 65_536 };
    const r = await rig("bedrock_converse", { emulator, endpoint: { budget } });
    r.emulator.injectFault(r.host, "MODEL_HANG");
    const result = await r.port.invoke(request({ budget }));
    expect(result.outcome).toBe("TIMED_OUT");
    await expect.poll(() => r.emulator.requests(r.host)[0]?.clientClosedEarly, { timeout: 2_000 }).toBe(true);
  });

  it("[FO-09-09] errors: a modelled stream error is RETRYABLE, a corrupt frame (bad CRC) never becomes text, malformed tool input is MALFORMED", async () => {
    const r = await rig("bedrock_converse", { emulator });
    r.emulator.queue(r.host, { kind: "stream_error" }, { kind: "malformed", variant: "bad_crc" }, { kind: "malformed", variant: "bad_tool_args" }, { kind: "malformed", variant: "truncated" }, { kind: "server_error" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "RETRYABLE", reasonCode: "MODEL_STREAM_ERROR" });
    const crc = await r.port.invoke(request());
    expect(["FAILED", "MALFORMED"]).toContain(crc.outcome);
    expect(speakableText(crc)).toBeNull();
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_ARGUMENTS_INVALID" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_TRUNCATED" });
    expect(await r.port.invoke(request())).toMatchObject({ outcome: "FAILED", errorClass: "RETRYABLE", reasonCode: "MODEL_SERVER_ERROR", httpStatus: 500 });
  });

  it("[FO-09-06][FO-09-46] adversarial (emulator variants over the transport): a guardrail stop overridden by a later end_turn stays REFUSED; content after the stop, an unclosed toolUse block and a call replaced at its index are MALFORMED", async () => {
    const r = await rig("bedrock_converse", { emulator, endpoint: { model: { id: "emulated-tools", revision: "emulated.1" } } });
    r.emulator.queue(r.host, { kind: "malformed", variant: "refusal_overridden" }, { kind: "malformed", variant: "content_after_finish" }, { kind: "malformed", variant: "tool_call_unclosed" }, { kind: "malformed", variant: "tool_call_renamed" });
    const overridden = await r.port.invoke(request());
    expect(overridden).toMatchObject({ outcome: "REFUSED", refusal: { source: "GUARDRAIL_INTERVENED" }, detail: { stopReason: "guardrail_intervened" } });
    const after = await r.port.invoke(request());
    expect(after).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_STREAM_CONTENT_AFTER_STOP" });
    expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_UNCLOSED" });
    expect(await r.port.invoke(request({ tools: [LOOKUP_TOOL] }))).toMatchObject({ outcome: "MALFORMED", reasonCode: "MODEL_TOOL_CALL_INVALID" });
    for (const res of [overridden, after]) expect(speakableText(res)).toBeNull();
    expect(r.emulator.requests(r.host).map((q) => q.sigv4)).toEqual(["VERIFIED", "VERIFIED", "VERIFIED", "VERIFIED"]);
  });

  it("[FO-09-06][DATA-01] documented limitation (fail closed): a model id that is an account ARN (application inference profile, provisioned throughput) is refused by the egress URL scan, so the endpoint is NOT_CONFIGURED and never composed", () => {
    // The 12-digit account id in the ARN path segment is a sensitive digit run for the egress URL scan; such an
    // endpoint is refused at configuration (use a model id or a system-defined inference profile id; adapter header).
    const host = "bedrock-runtime.us-east-1.amazonaws.com";
    const arn = endpointConfig("bedrock_converse", host, { model: { id: "arn:aws:bedrock:us-east-1:000000000000:application-inference-profile/synthprofile01", revision: "emulated.1" } });
    const profileId = endpointConfig("bedrock_converse", host, { model: { id: "us.emulated-text-v1:0", revision: "emulated.1" } });
    const refused = modelEndpointGuardViolations([arn], { environment: "local", egress: egressPolicyFor([arn]) });
    expect(refused.violations).toEqual([]);
    expect(refused.status).toMatchObject([{ endpointRef: arn.endpointRef, status: "NOT_CONFIGURED", reasons: ["EGRESS_URL_CONTAINS_SENSITIVE_PATTERN"] }]);
    // Control: the same destination with a system-defined inference profile id is CONFIGURED.
    expect(modelEndpointGuardViolations([profileId], { environment: "local", egress: egressPolicyFor([profileId]) }).status).toMatchObject([{ status: "CONFIGURED" }]);
  });

  it("[FO-09-45] cancellation closes the Bedrock stream (CANCELLED)", async () => {
    const r = await rig("bedrock_converse", { emulator });
    r.emulator.queue(r.host, { kind: "hang", afterEvents: 2 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    expect(await r.port.invoke(request(), { signal: ac.signal })).toMatchObject({ outcome: "CANCELLED" });
    await expect.poll(() => r.emulator.requests(r.host)[0]?.clientClosedEarly, { timeout: 2_000 }).toBe(true);
  });

  it("[FO-09-06][AUTH-06] adversarial: ambient bearer auth (AWS_BEARER_TOKEN_BEDROCK; AWS_AUTH_SCHEME_PREFERENCE=httpBearerAuth with an expiring SSO session) is never used: SigV4 with the handle only, nothing outside the transport", async () => {
    // A side listener stands in for the SSO-OIDC token endpoint: any request reaching it left the egress transport.
    const side: string[] = [];
    const sideServer = createServer((req, res) => {
      side.push(`${req.method} ${req.url}`);
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
    });
    await new Promise<void>((resolve) => sideServer.listen(0, "127.0.0.1", () => resolve()));
    const sidePort = (sideServer.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), "vsp-bedrock-ambient-"));
    mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
    writeFileSync(join(home, ".aws", "config"), "[default]\nsso_session = synth\nauth_scheme_preference = httpBearerAuth\n\n[sso-session synth]\nsso_region = us-east-1\nsso_start_url = https://synth.awsapps.invalid/start\n");
    writeFileSync(
      join(home, ".aws", "sso", "cache", `${createHash("sha1").update("synth").digest("hex")}.json`),
      JSON.stringify({ accessToken: "tok_synthssoaccess", expiresAt: new Date(Date.now() + 120_000).toISOString(), refreshToken: "tok_synthrefresh", clientId: "cid_synth", clientSecret: "cs_synth", registrationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), region: "us-east-1", startUrl: "https://synth.awsapps.invalid/start" }),
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
        const r = await rig("bedrock_converse", { emulator, register: false, credential: { kind: "aws", credentials: async () => ((handleCalls += 1), aws) } });
        r.emulator.registerHost(r.host, { aws: [aws], region: "us-east-1", models: ["emulated-text"] });
        const connect = vi.spyOn(net.Socket.prototype, "connect");
        const result = await r.port.invoke(request());
        // net normalizes the arguments into an array whose first item holds the options; unwrap either form.
        const ports = connect.mock.calls.map((c) => {
          const a = Array.isArray(c[0]) ? (c[0] as unknown[])[0] : c[0];
          return typeof a === "object" && a !== null ? (a as { port?: unknown }).port : a;
        });
        connect.mockRestore();
        expect(result, JSON.stringify(env)).toMatchObject({ outcome: "COMPLETED" });
        expect(r.emulator.requests(r.host)).toMatchObject([{ sigv4: "VERIFIED", authorized: true }]);
        expect(handleCalls).toBe(1);
        // Every socket the call opened went to the emulator route of the egress transport.
        expect(ports.length).toBeGreaterThanOrEqual(1);
        expect(ports.every((p) => Number(p) === emulator.httpPort), JSON.stringify(ports)).toBe(true);
        for (const k of Object.keys(env)) delete process.env[k];
        Object.assign(process.env, saved);
      }
      expect(side).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      await new Promise<void>((resolve) => sideServer.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
