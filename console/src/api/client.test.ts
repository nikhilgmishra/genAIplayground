import { describe, expect, it, vi } from "vitest";
import { ConsoleApiClient, ConsoleApiError } from "./client";
import { buildApiPath, InvalidReferenceError } from "./paths";
import { createMemoryTokenStore } from "./token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(fetchImpl: typeof fetch, token: string | null = "synthetic-token.stf_synthSupervisor01") {
  const tokens = createMemoryTokenStore();
  if (token) tokens.set(token, "2099-01-01T00:00:00.000Z");
  const client = new ConsoleApiClient({ tokenStore: tokens, fetchImpl });
  return { tokens, client };
}

async function caught(p: Promise<unknown>): Promise<ConsoleApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConsoleApiError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

describe("console API client", () => {
  it("[SPEC-16.console-token] the bearer token is kept in memory only: no localStorage, sessionStorage or cookie", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { loggedOut: true }));
    const { tokens, client } = setup(fetchImpl);
    await client.request("auth.logout", {});
    expect(tokens.get()).toBe("synthetic-token.stf_synthSupervisor01");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token.stf_synthSupervisor01");
    expect(init?.credentials).toBe("omit");
    expect(init?.cache).toBe("no-store");
  });

  it("[SPEC-16.console-token] an expired token is dropped and no request is sent", async () => {
    let now = Date.parse("2026-10-17T15:00:00.000Z");
    const tokens = createMemoryTokenStore(() => now);
    tokens.set("synthetic-token.stf_synthSupervisor01", "2026-10-17T15:05:00.000Z");
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new ConsoleApiClient({ tokenStore: tokens, fetchImpl });
    const onUnauth = vi.fn();
    client.onUnauthenticated(onUnauth);
    now = Date.parse("2026-10-17T15:05:00.000Z");
    const err = await caught(client.request("me", {}));
    expect(err.reasonCode).toBe("SESSION_EXPIRED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onUnauth).toHaveBeenCalledWith("SESSION_EXPIRED");
    expect(tokens.get()).toBeNull();
  });

  it("[SPEC-16.console-errors] failures surface as reason codes only; server text is discarded", async () => {
    const leaky = { error: { reasonCode: "STATE_CONFLICT", correlationId: "cor_synthCorrelation0001", retryable: false }, message: "select * from secrets", stack: "at db.ts:1" };
    const { client } = setup(async () => jsonResponse(409, leaky));
    const err = await caught(client.request("overview", {}));
    expect(err.reasonCode).toBe("STATE_CONFLICT");
    expect(err.correlationId).toBe("cor_synthCorrelation0001");
    expect(err.message).toBe("STATE_CONFLICT");
    expect(JSON.stringify(err)).not.toContain("secrets");
  });

  it("[SPEC-16.console-errors] malformed reason codes, non-JSON bodies and network failures map to fixed codes", async () => {
    expect((await caught(setup(async () => jsonResponse(403, { error: { reasonCode: "drop table; --", correlationId: "Avery" } })).client.request("overview", {}))).reasonCode).toBe(
      "STAFF_ROLE_NOT_PERMITTED",
    );
    const bad = await caught(setup(async () => jsonResponse(403, { error: { reasonCode: "drop table; --", correlationId: "Avery" } })).client.request("overview", {}));
    expect(bad.correlationId).toBeNull();
    expect((await caught(setup(async () => new Response("<html>oops</html>", { status: 500, headers: { "content-type": "text/html" } })).client.request("overview", {}))).reasonCode).toBe(
      "SERVER_ERROR",
    );
    const net = await caught(
      setup(async () => {
        throw new TypeError("network down");
      }).client.request("overview", {}),
    );
    expect(net.reasonCode).toBe("NETWORK_UNAVAILABLE");
    expect(net.retryable).toBe(true);
  });

  it("[SPEC-16.console-token] a 401 clears the in-memory token and notifies the session", async () => {
    const { client, tokens } = setup(async () => jsonResponse(401, { error: { reasonCode: "SESSION_EXPIRED", correlationId: null, retryable: false } }));
    const onUnauth = vi.fn();
    client.onUnauthenticated(onUnauth);
    expect((await caught(client.request("me", {}))).reasonCode).toBe("SESSION_EXPIRED");
    expect(tokens.get()).toBeNull();
    expect(onUnauth).toHaveBeenCalledWith("SESSION_EXPIRED");
  });

  it("[SPEC-13.console] mutations send JSON with an Idempotency-Key; reads do not", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const { client } = setup(fetchImpl);
    await client.request("outbox.requeue", { params: { messageId: "msg_synthDeadLetter00001" }, body: { reason: "ROOT_CAUSE_FIXED" }, idempotencyKey: "idem_synthetic_key_0001" });
    await client.request("overview", {});
    const post = fetchImpl.mock.calls[0];
    expect(post?.[0]).toBe("/console/api/v1/outbox/msg_synthDeadLetter00001/requeue");
    expect(post?.[1]?.method).toBe("POST");
    expect(new Headers(post?.[1]?.headers).get("Idempotency-Key")).toBe("idem_synthetic_key_0001");
    expect(post?.[1]?.body).toBe(JSON.stringify({ reason: "ROOT_CAUSE_FIXED" }));
    const get = fetchImpl.mock.calls[1];
    expect(get?.[1]?.method).toBe("GET");
    expect(new Headers(get?.[1]?.headers).get("Idempotency-Key")).toBeNull();
    expect(get?.[1]?.body).toBeUndefined();
  });

  it("[SPEC-6.no-phi-url] path parameters must be opaque references; invalid values are refused without echo or request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client } = setup(fetchImpl);
    for (const value of ["+15555550101", "Avery Synthetic-Client", "1990-01-01", "cal_short", "../../me"]) {
      const err = await caught(client.request("calls.get", { params: { callId: value } }));
      expect(err.reasonCode).toBe("INVALID_REFERENCE");
      expect(err.message).not.toContain(value);
      expect(() => buildApiPath("calls.get", { callId: value })).toThrow(InvalidReferenceError);
    }
    expect(() => buildApiPath("supportRequests.trace", { ref: "SR-1111-0000" })).toThrow(InvalidReferenceError);
    expect(buildApiPath("supportRequests.trace", { ref: "SR-7KQM-W4XP" })).toBe("/console/api/v1/support-requests/SR-7KQM-W4XP/trace");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[SPEC-13.console] audit search sends metadata filters as query parameters only", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { events: [], searchAuditEventId: "aud_synthAuditSearch0001", limit: 20 }));
    const { client } = setup(fetchImpl);
    await client.request("audit.search", { query: { callId: "cal_synthCallPrimary0001", action: "killswitch.set", limit: 20 } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/console/api/v1/audit/search?callId=cal_synthCallPrimary0001&action=killswitch.set&limit=20");
  });
});
