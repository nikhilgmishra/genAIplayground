/**
 * OAuth 2.0 client credentials (RFC 6749 section 4.4) for the reference business API (WP-23).
 *
 * Each client belongs to exactly one account (one tenant's system-of-record instance) and holds a scope set;
 * a token carries the account and the granted scopes, and the token response reports `account_id` and
 * `region` so the platform's connector runtime can verify the account binding (FO-06-13). Every API response
 * also carries `Refbiz-Account` and `Refbiz-Region`. Secrets and tokens are stored as SHA-256 digests only;
 * comparisons are constant-time.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "./db.js";
import { ApiError } from "./errors.js";
import { digestEquals, sha256Hex } from "./ids.js";

export const SCOPES = [
  "scheduling:read",
  "scheduling:write",
  "billing:read",
  "billing:write",
  "claims:read",
  "provider:read",
  "provider:write",
  "referrals:read",
  "legacy:read",
  "legacy:write",
] as const;
export type Scope = (typeof SCOPES)[number];

export interface Principal {
  accountId: string;
  clientId: string;
  scopes: readonly string[];
}

const TokenForm = z.object({
  grant_type: z.literal("client_credentials"),
  scope: z.string().max(1_024).optional(),
  client_id: z.string().min(1).max(128).optional(),
  client_secret: z.string().min(1).max(512).optional(),
});

/** OAuth error as RFC 6749 section 5.2 describes it (status 400 or 401, `error` code only). */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: "invalid_request" | "invalid_client" | "invalid_scope" | "unsupported_grant_type",
  ) {
    super(error);
  }
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  try {
    return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
  } catch {
    return null;
  }
}

export class Auth {
  constructor(
    private readonly store: Store,
    private readonly tokenTtlSeconds: number,
  ) {}

  /** Registers a client for an account (fault-control API only); returns the secret once. */
  async registerClient(accountId: string, scopes: readonly string[]): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = `cli_${randomBytes(12).toString("base64url")}`;
    const clientSecret = `cs_synth${randomBytes(24).toString("base64url")}`;
    await this.store.query("insert into refbiz.clients (client_id, account_id, secret_sha256, scopes) values ($1, $2, $3, $4)", [clientId, accountId, sha256Hex(clientSecret), [...scopes]]);
    return { clientId, clientSecret };
  }

  /** The token endpoint: client_secret_basic or client_secret_post. */
  async issue(form: unknown, authorization: string | undefined): Promise<Record<string, unknown>> {
    const raw = (typeof form === "object" && form !== null ? form : {}) as Record<string, unknown>;
    if (raw.grant_type !== undefined && raw.grant_type !== "client_credentials") throw new OAuthError(400, "unsupported_grant_type");
    const parsed = TokenForm.safeParse(raw);
    if (!parsed.success) throw new OAuthError(400, "invalid_request");
    const basic = basicCredentials(authorization);
    const post = parsed.data.client_id && parsed.data.client_secret ? { id: parsed.data.client_id, secret: parsed.data.client_secret } : null;
    if ((basic === null) === (post === null)) throw new OAuthError(basic && post ? 400 : 401, basic && post ? "invalid_request" : "invalid_client");
    const cred = (basic ?? post) as { id: string; secret: string };
    const rows = await this.store.query<{ account_id: string; secret_sha256: string; scopes: string[]; region: string }>(
      "select c.account_id, c.secret_sha256, c.scopes, a.region from refbiz.clients c join refbiz.accounts a using (account_id) where c.client_id = $1",
      [cred.id],
    );
    const client = rows[0];
    // Same answer for an unknown client and a wrong secret.
    if (!client || !digestEquals(client.secret_sha256, sha256Hex(cred.secret))) throw new OAuthError(401, "invalid_client");
    const requested = parsed.data.scope === undefined ? client.scopes : [...new Set(parsed.data.scope.split(/\s+/).filter((s) => s.length > 0))];
    if (requested.some((s) => !client.scopes.includes(s))) throw new OAuthError(400, "invalid_scope");
    const token = `rbt_${randomBytes(32).toString("base64url")}`;
    await this.store.query("insert into refbiz.tokens (token_sha256, client_id, account_id, scopes, expires_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))", [
      sha256Hex(token),
      cred.id,
      client.account_id,
      requested,
      this.tokenTtlSeconds,
    ]);
    // Expired tokens are purged (bounded batch): the table never grows with tokens nobody can use.
    await this.store.query("delete from refbiz.tokens where token_sha256 in (select token_sha256 from refbiz.tokens where expires_at < now() - interval '1 hour' limit 100)");
    return { access_token: token, token_type: "Bearer", expires_in: this.tokenTtlSeconds, scope: [...requested].sort().join(" "), account_id: client.account_id, region: client.region };
  }

  /** Resolves a bearer token; throws 401 UNAUTHENTICATED for anything else. */
  async authenticate(authorization: string | undefined): Promise<Principal> {
    if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "UNAUTHENTICATED");
    const token = authorization.slice(7).trim();
    if (!/^rbt_[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ApiError(401, "UNAUTHENTICATED");
    const rows = await this.store.query<{ account_id: string; client_id: string; scopes: string[] }>(
      "select account_id, client_id, scopes from refbiz.tokens where token_sha256 = $1 and expires_at > now()",
      [sha256Hex(token)],
    );
    const t = rows[0];
    if (!t) throw new ApiError(401, "UNAUTHENTICATED");
    return { accountId: t.account_id, clientId: t.client_id, scopes: t.scopes };
  }
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!p.scopes.includes(scope)) throw new ApiError(403, "SCOPE_MISSING");
}
