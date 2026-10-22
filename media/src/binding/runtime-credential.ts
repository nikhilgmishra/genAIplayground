/**
 * The conversation runtime's own access token (WP-11; AUTH-02, AUTH-03): OAuth 2.0 client credentials at the
 * workforce/integration IdP, through the egress-classified transport. The gateway verifies it for the
 * `conversation_runtime` channel (platform/src/calls/binding/runtime-auth.ts). The client secret is injected into
 * the worker's environment by the deployment from the secret store (the worker imports no secret-store client,
 * FO-06-04) and is never logged; the access token is cached in memory until shortly before it expires.
 */
import type { MediaTransport } from "./client.js";

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: () => string;
  scope: string;
  transport: MediaTransport;
  addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  now?: () => number;
  /** Refresh this long before expiry (default 60 s, never more than half the token's lifetime). */
  refreshMarginMs?: number;
  timeoutMs?: number;
}

export class RuntimeCredentialError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "RuntimeCredentialError";
  }
}

export class ClientCredentialsTokenSource {
  private readonly url: URL;
  private cached: { token: string; refreshAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ClientCredentialsOptions) {
    const url = new URL(o.tokenUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new RuntimeCredentialError("RUNTIME_TOKEN_URL_INVALID");
    if (!/^[A-Za-z0-9_.-]{3,128}$/.test(o.clientId)) throw new RuntimeCredentialError("RUNTIME_CLIENT_ID_INVALID");
    if (!/^[a-z][a-z0-9_.:-]{2,63}( [a-z][a-z0-9_.:-]{2,63}){0,7}$/.test(o.scope)) throw new RuntimeCredentialError("RUNTIME_SCOPE_INVALID");
    this.url = url;
    this.now = o.now ?? Date.now;
  }

  /** A current access token (cached; one request in flight at a time). */
  token(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAt) return Promise.resolve(this.cached.token);
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the cached token (after the gateway refused it). */
  invalidate(): void {
    this.cached = null;
  }

  private async fetch(): Promise<string> {
    const basic = Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(this.o.clientSecret())}`).toString("base64");
    let res;
    try {
      res = await this.o.transport.send({
        method: "POST",
        url: this.url,
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: this.o.scope }).toString(),
        policy: { allowedHosts: [this.url.hostname], addressClass: this.o.addressClass, dataClass: "VERIFICATION_SECRET" },
        sideEffect: false,
        timeoutMs: this.o.timeoutMs ?? 4_000,
        dependency: "idp",
      });
    } catch {
      throw new RuntimeCredentialError("RUNTIME_TOKEN_UNAVAILABLE");
    }
    if (res.status === 400 || res.status === 401) throw new RuntimeCredentialError("RUNTIME_CLIENT_REFUSED");
    if (res.status !== 200) throw new RuntimeCredentialError("RUNTIME_TOKEN_UNAVAILABLE");
    let body: { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    try {
      body = JSON.parse(res.body.toString("utf8")) as typeof body;
    } catch {
      throw new RuntimeCredentialError("RUNTIME_TOKEN_RESPONSE_INVALID");
    }
    if (typeof body.access_token !== "string" || body.access_token.length < 16 || String(body.token_type).toLowerCase() !== "bearer") throw new RuntimeCredentialError("RUNTIME_TOKEN_RESPONSE_INVALID");
    const lifetimeMs = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : 60_000;
    const margin = Math.min(this.o.refreshMarginMs ?? 60_000, lifetimeMs / 2);
    this.cached = { token: body.access_token, refreshAt: this.now() + lifetimeMs - margin };
    return body.access_token;
  }
}
