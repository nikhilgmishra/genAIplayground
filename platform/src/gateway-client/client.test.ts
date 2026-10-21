/**
 * Gateway client (WP-07; FO-03-11 rule 1, AUTH-02, DATA-01). The HTTP port here is a UNIT FAKE that records the
 * requests the client hands it and answers with a canned status; the real port in the untrusted group is the
 * egress-classified transport. The drift of the generated table against the committed OpenAPI document is the
 * openapi:check gate (openapi.test.ts).
 */
import { describe, expect, it } from "vitest";
import { GATEWAY_OPERATIONS, GatewayClient, GatewayClientError } from "./index.js";
import type { GatewayHttp, GatewayHttpRequest } from "./index.js";
import { OPENAPI_FILE } from "../gateway/openapi.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { GATEWAY_CONTRACT_SHA256 } from "./operations.generated.js";

class RecordingHttpFixture implements GatewayHttp {
  readonly sent: GatewayHttpRequest[] = [];
  constructor(private readonly answer: { status: number; body: string } = { status: 200, body: '{"ok":true}' }) {}
  async send(req: GatewayHttpRequest) {
    this.sent.push(req);
    return this.answer;
  }
}

const TOKEN = "tok_synthGatewayClientToken0001";
const client = (http: GatewayHttp, baseUrl = "https://gateway.vsp-unit.example.com") => new GatewayClient({ baseUrl, http, credential: async () => TOKEN });
const reason = (p: Promise<unknown>) => p.then(() => "NO_ERROR", (e: unknown) => (e instanceof GatewayClientError ? e.reasonCode : String(e)));

describe("generated gateway client [FO-03-11]", () => {
  it("[FO-03-11] positive: the table is generated from the committed OpenAPI document (digest) and lists every operation", () => {
    expect(GATEWAY_CONTRACT_SHA256).toBe(createHash("sha256").update(readFileSync(OPENAPI_FILE, "utf8"), "utf8").digest("hex"));
    expect(Object.keys(GATEWAY_OPERATIONS)).toEqual(expect.arrayContaining(["health.ready", "tools.invoke", "mcp.post", "telephony.selectRole"]));
    expect(GATEWAY_OPERATIONS["tools.invoke"]).toMatchObject({ method: "POST", path: "/v1/tools/{name}/{version}", pathParams: ["name", "version"], body: "required", channel: "mcp_tools" });
  });

  it("[FO-03-11][AUTH-02] positive: a declared call carries its path parameters, its declared headers, the bearer and the JSON body", async () => {
    const http = new RecordingHttpFixture();
    const r = await client(http).call("telephony.selectRole", { headers: { "x-vsp-session-ref": "ses_synthGatewayClientSession01" }, body: { role: "client" } });
    expect(r.status).toBe(200);
    const sent = http.sent[0]!;
    expect([sent.method, sent.url.href, sent.body]).toEqual(["POST", "https://gateway.vsp-unit.example.com/telephony/v1/session/role", '{"role":"client"}']);
    expect(sent.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-vsp-session-ref": "ses_synthGatewayClientSession01" });
    await client(http).call("tools.invoke", { pathParams: { name: "request_human_transfer", version: "1.0.0" }, body: { arguments: {} } });
    expect(http.sent[1]?.url.pathname).toBe("/v1/tools/request_human_transfer/1.0.0");
  });

  it("[FO-03-11][DATA-01] adversarial: undeclared operations, headers, path parameters and bodies are refused before anything is sent", async () => {
    const http = new RecordingHttpFixture();
    const c = client(http);
    expect(await reason(c.call("admin.dropEverything" as never))).toBe("GATEWAY_OPERATION_UNKNOWN");
    expect(await reason(c.call("telephony.selectRole", { body: { role: "client" } }))).toBe("GATEWAY_HEADER_MISSING");
    expect(await reason(c.call("health.ready", { headers: { "x-forwarded-for": "198.51.100.7" } }))).toBe("GATEWAY_HEADER_UNDECLARED");
    expect(await reason(c.call("health.ready", { body: {} as never }))).toBe("GATEWAY_BODY_NOT_ACCEPTED");
    expect(await reason(c.call("tools.invoke", { pathParams: { name: "../admin", version: "1" }, body: { arguments: {} } }))).toBe("GATEWAY_PATH_PARAM_INVALID");
    expect(await reason(c.call("tools.invoke", { pathParams: { name: "x", version: "1", extra: "y" }, body: { arguments: {} } }))).toBe("GATEWAY_PATH_PARAM_UNDECLARED");
    expect(await reason(c.call("tools.invoke", { pathParams: { name: "x", version: "1" } }))).toBe("GATEWAY_BODY_MISSING");
    expect(http.sent).toEqual([]);
    expect(() => client(http, "http://gateway.vsp-unit.example.com")).toThrow(GatewayClientError);
    expect(() => client(http, "https://gateway.vsp-unit.example.com/base?x=1")).toThrow(GatewayClientError);
    expect(() => client(http, "http://127.0.0.1:8080")).not.toThrow();
  });

  it("[FO-03-11][OPS-01] failure: an undeclared status or a malformed body is refused with a reason code (no body or credential in the error)", async () => {
    expect(await reason(client(new RecordingHttpFixture({ status: 418, body: "{}" })).call("health.ready"))).toBe("GATEWAY_RESPONSE_UNDECLARED");
    const malformed = await client(new RecordingHttpFixture({ status: 200, body: `<html>${TOKEN}</html>` })).call("health.ready").then(() => null, (e: unknown) => e);
    expect(malformed).toBeInstanceOf(GatewayClientError);
    expect(String((malformed as Error).message)).not.toContain(TOKEN);
    const bad = new GatewayClient({ baseUrl: "https://gateway.vsp-unit.example.com", http: new RecordingHttpFixture(), credential: async () => "short" });
    expect(await reason(bad.call("health.ready"))).toBe("GATEWAY_CREDENTIAL_INVALID");
  });
});
