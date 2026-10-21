/**
 * Layer-2 support for the identity suite (WP-05). Production adapters only; the pieces below are test
 * plumbing, not fakes of anything under test:
 *
 *   - IdpTlsProxy: a TLS-terminating TCP-level HTTP proxy in the test process that serves the shared
 *     Keycloak under the dotted name `idp.vsp-identity.test` with a certificate from a per-run test CA.
 *     The egress-classified transport refuses `localhost` and IP literals (WP-06 rule), so the production
 *     OIDC adapters reach Keycloak by a real-looking host name over verified TLS. Stopping the proxy is the
 *     IDP_UNAVAILABLE injection: the shared Keycloak container is never stopped or reconfigured.
 *   - Realms are created per run through the admin API with uniqueName()-style names and a realm
 *     `frontendUrl` of https://idp.vsp-identity.test, so the issuer and every discovered endpoint carry
 *     that host (backchannel endpoints follow the forwarded Host header, --hostname-backchannel-dynamic).
 *     The random suffix is letters only: the production EgressGuard refuses a URL path with a long digit run
 *     or a Luhn-valid number (PHI heuristic), and a hex suffix trips it for about 2 % of names (the identity
 *     suite's former intermittent OIDC_PROVIDER_UNAVAILABLE, root-caused in WP-05 round 2). `realmName`
 *     asserts the resulting discovery URL passes that check.
 *   - Browser: the user agent of the test. It follows the authorization URL the BACKEND produced, fills the
 *     hosted login pages (password, OTP from a pre-provisioned TOTP credential, RFC 6238 computed locally)
 *     and stops at the redirect, handing code and state back to the backend, which exchanges the code.
 *   - Account directory and notification capture for the caller secure-link flow: labelled `local_fixture`
 *     stand-ins; the system of record and the delivery channel are not under test (the IdP, the verifier and
 *     the session store are).
 * SYNTHETIC users, generated passwords and TOTP secrets; nothing secret is committed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { AccountCandidate, AdapterHealth, IdentityDirectory, NotificationSender, RegisteredChannel } from "../../../src/adapters/ports.js";
import { OidcRelyingPartyClient } from "../../../src/adapters/live/oidc-client.js";
import { OidcDiscovery } from "../../../src/adapters/live/oidc-discovery.js";
import { OidcHttp } from "../../../src/adapters/live/oidc-http.js";
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import { EgressGuard, urlCarriesSensitivePattern } from "../../../src/privacy/egress.js";
import { PlatformError } from "../../../src/shared/errors.js";
import type { Role } from "../../../src/protocol/index.js";
import type { Clock } from "../../../src/shared/clock.js";
import { uniqueName } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { totp } from "../_harness/keycloak.js";

export const IDP_HOST = "idp.vsp-identity.test";
export const IDP_ORIGIN = `https://${IDP_HOST}`;
export const CONSOLE_REDIRECT = "https://console.vsp-identity.test/auth/callback";
export const PORTAL_REDIRECT = "https://portal.vsp-identity.test/verify/callback";

/* ------------------------------------------------------------------------ */
/* Test PKI and the TLS proxy in front of the shared Keycloak                 */
/* ------------------------------------------------------------------------ */

export interface TestPki {
  caPem: string;
  certPem: string;
  keyPem: string;
  dispose(): void;
}

export function createIdentityPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "vsp-identity-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=VSP Layer-2 identity test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem"]);
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
  run(["req", "-new", "-key", "leaf.key", "-subj", `/CN=${IDP_HOST}`, "-out", "leaf.csr"]);
  writeFileSync(join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${IDP_HOST}\n`);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { caPem: read("ca.pem"), certPem: read("leaf.pem"), keyPem: read("leaf.key"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Serves the shared Keycloak (HTTPS, local CA) as https://idp.vsp-identity.test on a loopback port. */
export class IdpTlsProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  forwarded = 0;

  constructor(
    private readonly pki: TestPki,
    private readonly keycloakPort: number,
  ) {}

  async start(): Promise<number> {
    if (this.server) return this.port;
    const upstreamCa = readFileSync(localEnv().caFile, "utf8");
    const server = createHttpsServer({ cert: this.pki.certPem, key: this.pki.keyPem }, (req: IncomingMessage, res: ServerResponse) => {
      this.forwarded += 1;
      const up = httpsRequest(
        { host: "127.0.0.1", port: this.keycloakPort, method: req.method, path: req.url, headers: { ...req.headers, host: IDP_HOST }, servername: "localhost", ca: upstreamCa },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
    return this.port;
  }

  /** IDP_UNAVAILABLE injection: the IdP's address stops answering (the shared Keycloak keeps running). */
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

/* ------------------------------------------------------------------------ */
/* Production OIDC adapters over the egress-classified transport              */
/* ------------------------------------------------------------------------ */

/** The production EgressGuard with the IdP's synthetic destination (approved for PUBLIC and VERIFICATION_SECRET). */
export function idpEgress(): EgressGuard {
  return new EgressGuard(
    {
      policyVersion: "egress-identity-l2-1",
      destinations: [
        { destinationId: "egr_identity_idp", kind: "VERIFICATION_SERVICE", hosts: [IDP_HOST], allowedClasses: ["PUBLIC", "VERIFICATION_SECRET"], coverage: { baaRef: null, approvalId: "apr_synthIdentityL2Idp01" }, environments: ["local", "ci"], adapterKind: "live" },
      ],
    },
    { environment: "local" },
  );
}

export function idpTransport(pki: TestPki, proxyPort: number, egress: EgressGuard = idpEgress()): ConnectorHttpTransport {
  return new ConnectorHttpTransport({ environment: "local", egress, loopbackRoutes: new Map([[IDP_HOST, { port: proxyPort, tls: true }]]), tlsCa: [pki.caPem] });
}

export interface LiveOidc {
  http: OidcHttp;
  discovery: OidcDiscovery;
  client: OidcRelyingPartyClient;
}

export function liveOidc(o: { pki: TestPki; proxyPort: number; issuer: string; clientId: string; clientSecret: string; clock: Clock; groupsClaim?: string }): LiveOidc {
  // The shared Keycloak answers a realm's first requests slowly while other suites load it.
  const egress = idpEgress();
  const http = new OidcHttp({ transport: idpTransport(o.pki, o.proxyPort, egress), egress, destination: { allowedHosts: [IDP_HOST], addressClass: "PUBLIC_INTERNET" }, timeoutMs: 10_000 });
  const discovery = new OidcDiscovery({ issuer: o.issuer, http, clock: o.clock, ttlSeconds: 60, jwksTtlSeconds: 60 });
  const client = new OidcRelyingPartyClient({ clientId: o.clientId, discovery, http, auth: { method: "client_secret_basic", clientSecret: async () => o.clientSecret }, clock: o.clock, algorithms: ["RS256", "ES256", "PS256"], groupsClaim: o.groupsClaim });
  return { http, discovery, client };
}

/**
 * Waits until the realm's discovery document answers through the proxy (realm caches warm). Only a retryable
 * failure (the shared Keycloak still warming the realm, a connection reset) is retried; a deterministic refusal
 * (an egress-policy refusal, a non-retryable dependency answer) fails at once with its reason code instead of
 * after the whole timeout.
 */
export async function waitForRealm(o: LiveOidc, issuer: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await o.http.getJson(new URL(`${issuer}/.well-known/openid-configuration`), "discovery");
      return;
    } catch (err) {
      const reason = err instanceof PlatformError ? `${err.reasonCode}${"violations" in err ? ` ${String((err as { violations: string[] }).violations)}` : ""}` : String(err);
      if (err instanceof PlatformError && !err.retryable) throw new Error(`REALM_DISCOVERY_REFUSED (not retryable): ${reason}`, { cause: err });
      if (Date.now() > deadline) throw new Error(`REALM_DISCOVERY_TIMEOUT after ${timeoutMs} ms: ${reason}`, { cause: err });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Realms                                                                     */
/* ------------------------------------------------------------------------ */

export interface SyntheticUser {
  username: string;
  password: string;
  /** Raw TOTP secret value (HMAC key = its UTF-8 bytes, Keycloak's representation). */
  totpSecret: string | null;
  groups: string[];
  /** Keycloak user id (the OIDC `sub`), filled after realm creation. */
  id?: string;
  lastCode?: string;
}

export const newUser = (label: string, groups: string[], withOtp = true): SyntheticUser => ({
  username: `synthetic-${label}`,
  password: randomBytes(18).toString("base64url"),
  totpSecret: withOtp ? randomBytes(15).toString("hex") : null,
  groups,
});

/** Letters only (a..p for each hex digit): a realm path never carries a digit run the egress PHI heuristic refuses. */
const lettersOnly = (hex: string): string => hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));

export function realmName(kind: string): string {
  if (!/^[a-z][a-z-]{1,24}$/.test(kind)) throw new Error(`REALM_KIND_INVALID: ${kind}`);
  const suffix = lettersOnly(uniqueName("x").slice(2));
  const name = `vsp-it-${kind}-${suffix}`;
  // The same check the production transport applies before any socket opens.
  if (urlCarriesSensitivePattern(new URL(`${IDP_ORIGIN}/realms/${name}/.well-known/openid-configuration`))) throw new Error(`REALM_NAME_EGRESS_REFUSED: ${name}`);
  return name;
}

function userRep(u: SyntheticUser): Record<string, unknown> {
  const credentials: Record<string, unknown>[] = [{ type: "password", value: u.password, temporary: false }];
  if (u.totpSecret) {
    credentials.push({
      type: "otp",
      userLabel: "layer2",
      secretData: JSON.stringify({ value: u.totpSecret }),
      credentialData: JSON.stringify({ subType: "totp", digits: 6, counter: 0, period: 30, algorithm: "HmacSHA1" }),
    });
  }
  return { username: u.username, enabled: true, email: `${u.username}@layer2.example.test`, emailVerified: true, firstName: "Synthetic", lastName: "Layer2", credentials, groups: u.groups };
}

const AMR_MAPPER = { name: "amr", protocol: "openid-connect", protocolMapper: "oidc-amr-mapper", config: { "id.token.claim": "true", "access.token.claim": "true", "introspection.token.claim": "true" } };
/** Claim carrying the console client's own roles (the workforce membership source the console maps, CLIENT_ROLES). */
export const CLIENT_ROLES_CLAIM = "vsp_roles";
const clientRolesMapper = (clientId: string) => ({
  name: "vsp-roles",
  protocol: "openid-connect",
  protocolMapper: "oidc-usermodel-client-role-mapper",
  config: {
    "usermodel.clientRoleMapping.clientId": clientId,
    "claim.name": CLIENT_ROLES_CLAIM,
    multivalued: "true",
    "jsonType.label": "String",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "introspection.token.claim": "true",
    "userinfo.token.claim": "true",
  },
});
const GROUPS_MAPPER = {
  name: "groups",
  protocol: "openid-connect",
  protocolMapper: "oidc-group-membership-mapper",
  config: { "full.path": "true", "claim.name": "groups", "id.token.claim": "true", "access.token.claim": "true", "introspection.token.claim": "true", "userinfo.token.claim": "true" },
};

/**
 * Realm representation. Group paths like /vsp/supervisor become a "vsp" parent with sub-groups. `groupClientRoles`
 * maps a group path to a role of the realm's client that the group grants (client roles are defined on the client;
 * the `vsp_roles` claim carries the user's effective roles of that client, the console's CLIENT_ROLES source).
 */
export function realmRep(o: { realm: string; client: { clientId: string; secret: string; redirectUri: string }; users: SyntheticUser[]; groups: string[]; groupClientRoles?: Record<string, string> }): Record<string, unknown> {
  const parents = new Map<string, Set<string>>();
  for (const g of o.groups) {
    const [, parent, child] = g.split("/");
    if (!parent) continue;
    const set = parents.get(parent) ?? new Set<string>();
    if (child) set.add(child);
    parents.set(parent, set);
  }
  const grants = o.groupClientRoles ?? {};
  const roleOf = (path: string) => (Object.hasOwn(grants, path) ? { clientRoles: { [o.client.clientId]: [grants[path]] } } : {});
  const clientRoles = [...new Set(Object.values(grants))].sort().map((name) => ({ name }));
  return {
    realm: o.realm,
    enabled: true,
    attributes: { frontendUrl: IDP_ORIGIN },
    // Refresh-token rotation with reuse detection (OAuth 2.0 BCP for public-facing refresh).
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    accessTokenLifespan: 300,
    ...(clientRoles.length > 0 ? { roles: { client: { [o.client.clientId]: clientRoles } } } : {}),
    groups: [...parents.entries()].map(([name, subs]) => ({ name, ...roleOf(`/${name}`), subGroups: [...subs].map((s) => ({ name: s, ...roleOf(`/${name}/${s}`) })) })),
    clients: [
      {
        clientId: o.client.clientId,
        protocol: "openid-connect",
        publicClient: false,
        secret: o.client.secret,
        redirectUris: [o.client.redirectUri],
        webOrigins: [],
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        attributes: { "pkce.code.challenge.method": "S256", "use.refresh.tokens": "true" },
        protocolMappers: [AMR_MAPPER, GROUPS_MAPPER, clientRolesMapper(o.client.clientId)],
      },
    ],
    users: o.users.map(userRep),
  };
}

/* ------------------------------------------------------------------------ */
/* The test's user agent                                                      */
/* ------------------------------------------------------------------------ */

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const decodeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x3D;/g, "=").replace(/&#61;/g, "=").replace(/&quot;/g, '"');

/** Follows authorization URLs on idp.vsp-identity.test through the proxy, as a browser would. */
export class Browser {
  private readonly cookies = new Map<string, string>();
  /** Login forms (password, OTP) this agent submitted during its last `signIn`: 0 when the IdP's SSO session answered. */
  formsSubmitted = 0;

  constructor(
    private readonly pki: TestPki,
    private readonly proxy: IdpTlsProxy,
  ) {}

  private send(url: URL, method: "GET" | "POST", body?: string): Promise<RawResponse> {
    if (url.hostname !== IDP_HOST) throw new Error(`BROWSER_UNEXPECTED_HOST: ${url.hostname}`);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port: this.proxy.port,
          servername: IDP_HOST,
          ca: this.pki.caPem,
          method,
          path: `${url.pathname}${url.search}`,
          headers: {
            host: IDP_HOST,
            cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const set = res.headers["set-cookie"] ?? [];
            for (const c of set) {
              const pair = c.split(";")[0] ?? "";
              const eq = pair.indexOf("=");
              if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /**
   * Signs `user` in at the IdP for an authorization URL and returns what the IdP redirects back to
   * `redirectUri` (code and state), or the IdP's refusal when it renders an error page instead.
   */
  async signIn(authorizationUrl: string, user: SyntheticUser, redirectUri: string): Promise<{ code: string; state: string } | { refused: string }> {
    this.formsSubmitted = 0;
    let res = await this.send(new URL(authorizationUrl), "GET");
    for (let step = 0; step < 8; step++) {
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      if (res.status === 302 || res.status === 303) {
        if (location?.startsWith(redirectUri)) {
          const back = new URL(location);
          const code = back.searchParams.get("code");
          const state = back.searchParams.get("state") ?? "";
          return code ? { code, state } : { refused: back.searchParams.get("error") ?? "NO_CODE" };
        }
        if (!location) return { refused: `REDIRECT_WITHOUT_LOCATION_${res.status}` };
        res = await this.send(new URL(location, IDP_ORIGIN), "GET");
        continue;
      }
      const page = res.body;
      const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
      if (!action) return { refused: /<title>([^<]*)/.exec(page)?.[1]?.trim() || `PAGE_${res.status}` };
      const form = new URLSearchParams();
      if (/name="password"/.test(page)) {
        // A re-authentication page (max_age, prompt=login) shows the known user and asks for the password only.
        if (/name="username"/.test(page)) form.set("username", user.username);
        form.set("password", user.password);
        form.set("credentialId", "");
      } else if (/name="otp"/.test(page)) {
        if (!user.totpSecret) return { refused: "OTP_REQUESTED_WITHOUT_CREDENTIAL" };
        const key = Buffer.from(user.totpSecret, "utf8");
        // Keycloak refuses a code reused within its 30 s step: wait for the next one.
        while (totp(key) === user.lastCode) await new Promise((r) => setTimeout(r, 1_000));
        user.lastCode = totp(key);
        form.set("otp", user.lastCode);
      } else {
        // Account disabled, invalid user, invalid redirect...: the IdP refused the login.
        const message = /id="input-error"[^>]*>([^<]*)/.exec(page)?.[1] ?? /class="[^"]*alert[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]*)/.exec(page)?.[1] ?? "LOGIN_PAGE_UNEXPECTED";
        return { refused: message.trim() };
      }
      this.formsSubmitted += 1;
      res = await this.send(new URL(decodeHtml(action), IDP_ORIGIN), "POST", form.toString());
    }
    return { refused: "LOGIN_DID_NOT_COMPLETE" };
  }
}

/* ------------------------------------------------------------------------ */
/* Caller secure-link stand-ins (system of record and delivery channel)       */
/* ------------------------------------------------------------------------ */

export interface StandInAccount {
  accountId: string;
  actorId: string;
  subjectId: string;
  role: Role;
  portalUsernameHint: string;
  channelRef: string;
  idpIssuer: string;
  idpSubject: string;
  state: "ACTIVE" | "LOCKED" | "RECOVERY_IN_PROGRESS" | "CLOSED";
}

/**
 * Layer-2 stand-in for the account system of record (not under test here): the IdP subject mapping comes
 * from the Keycloak user ids created for this run. A test stand-in, so it is labelled `local_fixture` (no live
 * IdentityDirectory adapter exists yet); it holds SYNTHETIC rows only and is never composed outside this suite.
 */
export class StandInAccountDirectory implements IdentityDirectory {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "identity-directory-l2";
  constructor(readonly accounts: StandInAccount[]) {}
  async health(): Promise<AdapterHealth> {
    return { healthy: true, reasonCode: null };
  }
  async findCandidates(locator: { fullName: string; dateOfBirth: string } | { portalUsernameHint: string }): Promise<AccountCandidate[]> {
    if (!("portalUsernameHint" in locator)) return [];
    return this.accounts.filter((a) => a.portalUsernameHint === locator.portalUsernameHint).map((a) => ({ accountId: a.accountId, actorId: a.actorId, roles: [a.role] }));
  }
  async registeredChannels(accountId: string): Promise<RegisteredChannel[]> {
    return this.accounts.filter((a) => a.accountId === accountId).map((a) => ({ channelRef: a.channelRef, kind: "portal_push" as const, verified: true, changedAt: null }));
  }
  async accountState(accountId: string): Promise<"ACTIVE" | "LOCKED" | "RECOVERY_IN_PROGRESS" | "CLOSED"> {
    return this.accounts.find((a) => a.accountId === accountId)?.state ?? "CLOSED";
  }
  async actorForIdpSubject(issuer: string, sub: string): Promise<string | null> {
    return this.accounts.find((a) => a.idpIssuer === issuer && a.idpSubject === sub)?.actorId ?? null;
  }
  async selfSubjectId(actorId: string): Promise<string | null> {
    return this.accounts.find((a) => a.actorId === actorId)?.subjectId ?? null;
  }
  async organizationFor(): Promise<string | null> {
    return null;
  }
}

/** Captures the secure link the verification service sends (delivery is not under test here; a test stand-in). */
export class CapturedLinks implements NotificationSender {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "notifications-l2";
  readonly sent: { channelRef: string; templateId: string; slots: Record<string, string> }[] = [];
  async health(): Promise<AdapterHealth> {
    return { healthy: true, reasonCode: null };
  }
  async send(input: { channelRef: string; templateId: string; slots: Record<string, string>; idempotencyKey: string }): Promise<{ messageId: string }> {
    this.sent.push({ channelRef: input.channelRef, templateId: input.templateId, slots: { ...input.slots } });
    return { messageId: `msg_${randomBytes(12).toString("base64url")}` };
  }
  lastLink(channelRef: string): { transactionId: string; nonce: string } | null {
    const msg = [...this.sent].reverse().find((m) => m.channelRef === channelRef);
    const m = msg?.slots.linkPath ? /\/(vtx_[A-Za-z0-9_-]+)#n=([A-Za-z0-9_-]{43})$/.exec(msg.slots.linkPath) : null;
    return m?.[1] && m[2] ? { transactionId: m[1], nonce: m[2] } : null;
  }
}

/* ------------------------------------------------------------------------ */
/* DynamoDB Local session table and a clock that can move ahead               */
/* ------------------------------------------------------------------------ */

export async function createSessionTable(client: DynamoDBClient): Promise<string> {
  const name = uniqueName("vsp-it-identity-kv");
  await client.send(new CreateTableCommand({ TableName: name, AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" }));
  return name;
}

/** System time plus an offset the test moves forward (provider tokens keep using real time). */
export class AheadClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advanceSeconds(s: number): void {
    this.offsetMs += s * 1000;
  }
}
