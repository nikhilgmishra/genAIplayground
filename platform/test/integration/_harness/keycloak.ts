/**
 * Keycloak test realm provisioning and an OIDC relying-party client for Layer 2 (FO-16-13).
 *
 * Realms are created through the Keycloak admin REST API with synthetic users whose passwords are
 * generated per run (nothing secret is committed). Logins use the real authorization-code flow with
 * PKCE (S256), state and nonce: the client fetches the hosted login page, posts the form, completes
 * TOTP enrolment / OTP when the realm asks for it (RFC 6238, computed locally), and exchanges the
 * code at the token endpoint. Everything is HTTPS with the checkout's local CA.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { localEnv } from "./env.js";

export interface RealmUser {
  username: string;
  password: string;
  /** Raw TOTP secret once the user enrolled (CONFIGURE_TOTP). */
  totpSecret?: string;
  /** Last code submitted: Keycloak refuses a code reused within its time step. */
  lastCode?: string;
}

export interface TokenSet {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  scope?: string;
}

const b64url = (b: Buffer) => b.toString("base64url");
const random = (n = 24) => b64url(randomBytes(n));

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s), Keycloak's default OTP policy. */
export function totp(secret: Buffer, at = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / stepSeconds)));
  const h = createHmac("sha1", secret).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0x0f;
  const code = (((h[offset] ?? 0) & 0x7f) << 24) | ((h[offset + 1] ?? 0) << 16) | ((h[offset + 2] ?? 0) << 8) | (h[offset + 3] ?? 0);
  return String(code % 10 ** digits).padStart(digits, "0");
}

const decodeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x3D;/g, "=").replace(/&#61;/g, "=").replace(/&quot;/g, '"');

class CookieJar {
  private readonly cookies = new Map<string, string>();
  store(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export class Keycloak {
  constructor(readonly baseUrl: string) {}

  issuer(realm: string): string {
    return `${this.baseUrl}/realms/${realm}`;
  }

  private async adminToken(): Promise<string> {
    const env = localEnv();
    const res = await fetch(`${this.baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: env.keycloakAdminUser, password: env.keycloakAdminPassword }),
    });
    if (!res.ok) throw new Error(`KEYCLOAK_ADMIN_LOGIN_FAILED: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async admin(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.adminToken()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 400) throw new Error(`KEYCLOAK_ADMIN_${method}_${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async adminJson<T>(path: string): Promise<T> {
    return (await (await this.admin("GET", path)).json()) as T;
  }

  async createRealm(rep: Record<string, unknown>): Promise<void> {
    await this.admin("POST", "/realms", rep);
  }

  async deleteRealm(realm: string): Promise<void> {
    await this.admin("DELETE", `/realms/${realm}`).catch(() => undefined);
  }

  async clientUuid(realm: string, clientId: string): Promise<string> {
    const list = await this.adminJson<{ id: string }[]>(`/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`);
    const id = list[0]?.id;
    if (!id) throw new Error(`KEYCLOAK_CLIENT_NOT_FOUND: ${clientId}`);
    return id;
  }

  /** Creates a client scope and attaches it to the client as a default scope. */
  async addDefaultScope(realm: string, clientId: string, scope: string): Promise<void> {
    const res = await this.admin("POST", `/realms/${realm}/client-scopes`, { name: scope, protocol: "openid-connect", attributes: { "include.in.token.scope": "true" } });
    const scopeId = res.headers.get("location")?.split("/").pop() ?? "";
    await this.admin("PUT", `/realms/${realm}/clients/${await this.clientUuid(realm, clientId)}/default-client-scopes/${scopeId}`);
  }

  /**
   * Sets the AMR reference value an authenticator execution contributes (Keycloak "Authenticator
   * Reference"). The max age bounds how long after that authentication step the value is still
   * reported; "0" drops it as soon as a token is issued in a later second than the step completed.
   */
  async setAuthenticatorReference(realm: string, flowAlias: string, providerId: string, reference: string, maxAgeSeconds = 3600): Promise<void> {
    const executions = await this.adminJson<{ id: string; providerId?: string; authenticationConfig?: string }[]>(`/realms/${realm}/authentication/flows/${encodeURIComponent(flowAlias)}/executions`);
    const exec = executions.find((e) => e.providerId === providerId);
    if (!exec) throw new Error(`KEYCLOAK_EXECUTION_NOT_FOUND: ${providerId}`);
    await this.admin("POST", `/realms/${realm}/authentication/executions/${exec.id}/config`, {
      alias: `${providerId}-amr-${random(4)}`,
      config: { "default.reference.value": reference, "default.reference.maxAge": String(maxAgeSeconds) },
    });
  }

  async clientCredentials(realm: string, clientId: string, clientSecret: string): Promise<{ access_token: string; scope?: string }> {
    const res = await fetch(`${this.issuer(realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new Error(`KEYCLOAK_CLIENT_CREDENTIALS_FAILED: ${res.status}`);
    return (await res.json()) as { access_token: string; scope?: string };
  }

  /**
   * Authorization-code login with PKCE through the hosted login pages. Completes TOTP enrolment
   * (CONFIGURE_TOTP) and the OTP step when the realm asks for them; records the user's TOTP secret.
   */
  async login(realm: string, client: { clientId: string; clientSecret: string; redirectUri: string }, user: RealmUser, nonce: string): Promise<TokenSet> {
    const jar = new CookieJar();
    const verifier = random(32);
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = random(16);
    const authUrl = new URL(`${this.issuer(realm)}/protocol/openid-connect/auth`);
    for (const [k, v] of Object.entries({ client_id: client.clientId, redirect_uri: client.redirectUri, response_type: "code", scope: "openid", state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) {
      authUrl.searchParams.set(k, v);
    }
    let res = await fetch(authUrl, { redirect: "manual" });
    jar.store(res);
    let page = await res.text();
    for (let step = 0; step < 6; step++) {
      const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
      if (!action) throw new Error(`KEYCLOAK_LOGIN_FORM_NOT_FOUND (step ${step}, status ${res.status})`);
      const form = new URLSearchParams();
      if (/name="username"/.test(page) && /name="password"/.test(page)) {
        form.set("username", user.username);
        form.set("password", user.password);
        form.set("credentialId", "");
      } else if (/name="totpSecret"/.test(page)) {
        const secret = decodeHtml(/name="totpSecret"[^>]*value="([^"]+)"/.exec(page)?.[1] ?? "");
        if (!secret) throw new Error("KEYCLOAK_TOTP_SECRET_NOT_FOUND");
        user.totpSecret = secret;
        form.set("totpSecret", secret);
        user.lastCode = totp(Buffer.from(secret, "utf8"));
        form.set("totp", user.lastCode);
        form.set("userLabel", "layer2");
        form.set("mode", "manual");
      } else if (/name="otp"/.test(page)) {
        if (!user.totpSecret) throw new Error("KEYCLOAK_OTP_REQUESTED_WITHOUT_ENROLMENT");
        const key = Buffer.from(user.totpSecret, "utf8");
        // A code already used in this 30 s step is refused as a replay: wait for the next step.
        while (totp(key) === user.lastCode) await new Promise((r) => setTimeout(r, 1_000));
        user.lastCode = totp(key);
        form.set("otp", user.lastCode);
      } else {
        throw new Error(`KEYCLOAK_UNEXPECTED_PAGE (step ${step}): ${/<title>([^<]*)/.exec(page)?.[1] ?? "untitled"}`);
      }
      res = await fetch(decodeHtml(action), { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() }, body: form });
      jar.store(res);
      const location = res.headers.get("location");
      if (res.status === 302 && location?.startsWith(client.redirectUri)) {
        const back = new URL(location);
        if (back.searchParams.get("state") !== state) throw new Error("KEYCLOAK_STATE_MISMATCH");
        const code = back.searchParams.get("code");
        if (!code) throw new Error(`KEYCLOAK_NO_CODE: ${back.searchParams.get("error") ?? ""}`);
        const tok = await fetch(`${this.issuer(realm)}/protocol/openid-connect/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: client.redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier }),
        });
        if (!tok.ok) throw new Error(`KEYCLOAK_CODE_EXCHANGE_FAILED: ${tok.status}`);
        return (await tok.json()) as TokenSet;
      }
      if (res.status === 302 && location) {
        res = await fetch(location, { redirect: "manual", headers: { cookie: jar.header() } });
        jar.store(res);
      }
      page = await res.text();
    }
    throw new Error("KEYCLOAK_LOGIN_DID_NOT_COMPLETE");
  }
}

export const secret = (n = 24): string => random(n);
