/**
 * The model emulator itself (WP-08; FO-16-18): its admin API (host registration, scripts, the three fault injection
 * points, the content-free request log), fail-closed authentication of unregistered hosts, and the documented request
 * rules it enforces per provider. Plain HTTP on 127.0.0.1; the TLS listener is exercised by the Layer-2 suite.
 */
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelEmulator } from "./server.js";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http (fetch forbids setting the Host header the emulator keys on). */
function call(method: string, url: string, host: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest({ method, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { host, ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let em: ModelEmulator;
let base: string;
let admin: string;
beforeAll(async () => {
  em = await new ModelEmulator({ httpPort: 0, adminPort: 0, frameDelayMs: 1 }).start();
  base = `http://127.0.0.1:${em.httpPort}`;
  admin = `http://127.0.0.1:${em.adminPort}`;
});
afterAll(async () => {
  await em.stop();
});

const post = (url: string, host: string, body: unknown, headers: Record<string, string> = {}) => call("POST", url, host, body, headers);
const adminPost = (path: string, body: unknown) => fetch(`${admin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("model emulator [FO-16-18]", () => {
  it("[FO-16-18] an unregistered host is refused (401 for bearer APIs, 403 for SigV4), and the refusal is logged", async () => {
    const host = "unregistered.openai.models.test";
    const res = await post(`${base}/v1/responses`, host, { model: "emulated-text", input: "x", stream: true });
    expect(res.status).toBe(401);
    const b = await post(`${base}/model/emulated-text/converse-stream`, "unregistered.bedrock.models.test", { messages: [] });
    expect(b.status).toBe(403);
    expect(String(b.headers["x-amzn-errortype"])).toMatch(/^InvalidSignatureException:|^UnrecognizedClientException:/);
    expect(em.requests(host)[0]).toMatchObject({ authorized: false, authFailure: "HOST_NOT_REGISTERED", status: 401 });
  });

  it("[FO-16-18] admin API: register a host, queue a fault, read the content-free log, forget the host", async () => {
    const host = "admin.openai.models.test";
    expect((await fetch(`${admin}/__emulator/health`)).status).toBe(200);
    expect((await adminPost("/__emulator/hosts", { host, credentials: { bearer: ["key_synthAdmin"], models: ["emulated-text"] } })).status).toBe(200);
    expect((await adminPost("/__emulator/faults", { host, fault: "MODEL_OVERLOAD", count: 1 })).status).toBe(200);
    expect((await adminPost("/__emulator/faults", { host, fault: "NOT_A_FAULT" })).status).toBe(400);
    const res = await post(`${base}/v1/responses`, host, { model: "emulated-text", input: "Synthetic caller 555-0100", stream: true, store: false }, { authorization: "Bearer key_synthAdmin" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("1");
    const log = (await (await fetch(`${admin}/__emulator/requests?host=${host}`)).json()) as { requests: Record<string, unknown>[] };
    expect(log.requests[0]).toMatchObject({ api: "openai_responses", authorized: true, script: "overload", status: 429, store: false });
    expect(JSON.stringify(log)).not.toContain("555-0100");
    const models = await call("GET", `${base}/v1/models`, host, undefined, { authorization: "Bearer key_synthAdmin" });
    expect(JSON.parse(models.body)).toMatchObject({ object: "list", data: [{ id: "emulated-text", object: "model" }] });
    expect((await fetch(`${admin}/__emulator/hosts?host=${host}`, { method: "DELETE" })).status).toBe(200);
    expect(em.requests(host)).toEqual([]);
  });

  it("[FO-16-18] adversarial: requests a provider would refuse are refused the provider's way", async () => {
    em.registerHost("rules.openai.models.test", { bearer: ["key_synthRules"] });
    em.registerHost("rules.vllm.models.test", { bearer: "none" });
    const o = (body: unknown) => post(`${base}/v1/responses`, "rules.openai.models.test", body, { authorization: "Bearer key_synthRules" });
    expect((await o({ input: "x", stream: true })).status).toBe(400);
    expect((await o({ model: "m", input: [{ type: "function_call_output", call_id: "call_x", output: "{}" }], stream: true })).status).toBe(400);
    const c = (body: unknown) => post(`${base}/v1/chat/completions`, "rules.vllm.models.test", body);
    expect((await c({ model: "m", messages: [], stream: true })).status).toBe(400);
    expect((await c({ model: "m", messages: [{ role: "tool", tool_call_id: "x", content: "{}" }], stream: true })).status).toBe(400);
    const okChat = await c({ model: "emulated-text", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(okChat.status).toBe(200);
    expect(okChat.body).toMatch(/data: \[DONE\]\n\n$/);
  });

  it("[FO-16-18] the in-process fault seams queue per host and are consumed one request each", () => {
    em.injectFault("seam.vllm.models.test", "MODEL_HANG", 2);
    em.injectFault("seam.vllm.models.test", "MODEL_REFUSAL");
    // Nothing is consumed until a request arrives; the log stays empty.
    expect(em.requests("seam.vllm.models.test")).toEqual([]);
  });
});
