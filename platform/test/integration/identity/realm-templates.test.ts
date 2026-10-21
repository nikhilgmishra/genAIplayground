/**
 * Layer 2 (WP-05): the committed SYNTHETIC realm templates (deploy/local/keycloak/realms/*.json) import into
 * Keycloak 26 and behave as the platform needs: discovery through the production adapter, MFA logins that
 * carry `otp` in amr, workforce role groups in the `groups` claim and the console client role each managed group
 * grants in the `vsp_roles` claim (the console's CLIENT_ROLES membership source), a password-only user without `otp`.
 * Each template is imported under a uniqueName() realm with generated placeholder values and the test's
 * frontendUrl (the importer service does the same through kcadm.sh with the state values); realms are
 * deleted afterwards. The shared Keycloak is never reconfigured.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { s256Challenge } from "../../../src/adapters/live/oidc-client.js";
import { systemClock } from "../../../src/shared/clock.js";
import { REPO_ROOT } from "../_harness/env.js";
import { Keycloak } from "../_harness/keycloak.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { Browser, IDP_ORIGIN, IdpTlsProxy, createIdentityPki, liveOidc, realmName, waitForRealm } from "./support.js";
import type { SyntheticUser, TestPki } from "./support.js";

const SERVICES = ["keycloak"];
const it = layer2(SERVICES);
const TEMPLATE_DIR = join(REPO_ROOT, "deploy", "local", "keycloak", "realms");
const PLACEHOLDERS = { password: randomBytes(18).toString("base64url"), totp: randomBytes(15).toString("hex"), clientSecret: randomBytes(24).toString("base64url") };

interface Template {
  file: string;
  name: string;
  realm: string;
  rep: {
    realm: string;
    clients: { clientId: string; redirectUris: string[] }[];
    users: { username: string; groups?: string[]; credentials: { type: string }[] }[];
    groups?: { name: string; subGroups?: { name: string; clientRoles?: Record<string, string[]> }[] }[];
    attributes?: Record<string, string>;
  };
}

let kc: Keycloak;
let pki: TestPki;
let proxy: IdpTlsProxy;
const templates: Template[] = [];

function load(file: string): Template {
  const raw = readFileSync(join(TEMPLATE_DIR, file), "utf8");
  expect(raw, file).not.toMatch(/"value"\s*:\s*"(?!__VSP_SYNTH_)/); // no committed credential values
  const filled = raw.replaceAll("__VSP_SYNTH_PASSWORD__", PLACEHOLDERS.password).replaceAll("__VSP_SYNTH_TOTP_SECRET__", PLACEHOLDERS.totp).replaceAll("__VSP_SYNTH_CLIENT_SECRET__", PLACEHOLDERS.clientSecret);
  const rep = JSON.parse(filled) as Template["rep"];
  const realm = realmName(rep.realm.replace(/^vsp-/, ""));
  return { file, name: rep.realm, realm, rep: { ...rep, realm, attributes: { ...(rep.attributes ?? {}), frontendUrl: IDP_ORIGIN } } };
}

async function login(t: Template, username: string) {
  const client = t.rep.clients[0];
  if (!client) throw new Error("template without client");
  const issuer = `${IDP_ORIGIN}/realms/${t.realm}`;
  const o = liveOidc({ pki, proxyPort: proxy.port, issuer, clientId: client.clientId, clientSecret: PLACEHOLDERS.clientSecret, clock: systemClock });
  await waitForRealm(o, issuer);
  const redirectUri = client.redirectUris[0] ?? "";
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const { url } = await o.client.authorizationRequest({ redirectUri, state: randomBytes(32).toString("base64url"), nonce, codeChallenge: s256Challenge(verifier), scopes: ["openid"] });
  const hasOtp = t.rep.users.find((u) => u.username === username)?.credentials.some((c) => c.type === "otp") ?? false;
  const user: SyntheticUser = { username, password: PLACEHOLDERS.password, totpSecret: hasOtp ? PLACEHOLDERS.totp : null, groups: [] };
  const back = await new Browser(pki, proxy).signIn(url, user, redirectUri);
  if ("refused" in back) throw new Error(`IDP_REFUSED_LOGIN ${t.name}/${username}: ${back.refused}`);
  return o.client.exchangeCode({ code: back.code, codeVerifier: verifier, redirectUri, nonce, maxAuthAgeSeconds: 600 });
}

describe("SYNTHETIC Keycloak realm templates (deploy/local/keycloak)", () => {
  beforeAll(async () => {
    const l2 = layer2Context(SERVICES);
    kc = new Keycloak(`https://localhost:${l2.port("keycloak", 8443)}`);
    pki = createIdentityPki();
    proxy = new IdpTlsProxy(pki, l2.port("keycloak", 8443));
    await proxy.start();
    for (const file of readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".json")).sort()) {
      const t = load(file);
      await kc.createRealm(t.rep);
      await kc.setAuthenticatorReference(t.realm, "browser", "auth-username-password-form", "pwd");
      await kc.setAuthenticatorReference(t.realm, "browser", "auth-otp-form", "otp");
      templates.push(t);
    }
  }, 180_000);

  afterAll(async () => {
    for (const t of templates) await kc?.deleteRealm(t.realm);
    await proxy?.stop();
    pki?.dispose();
  });

  it("[FO-05-07][FO-03-28] client, provider, partner and workforce templates import and are discoverable through the production adapter", async () => {
    expect(templates.map((t) => t.name)).toEqual(["vsp-client", "vsp-partner", "vsp-provider", "vsp-workforce"]);
    for (const t of templates) {
      const issuer = `${IDP_ORIGIN}/realms/${t.realm}`;
      const o = liveOidc({ pki, proxyPort: proxy.port, issuer, clientId: t.rep.clients[0]?.clientId ?? "", clientSecret: PLACEHOLDERS.clientSecret, clock: systemClock });
      await waitForRealm(o, issuer);
      const p = await o.discovery.provider();
      expect(p.issuer, t.name).toBe(issuer);
      expect(p.codeChallengeMethods, t.name).toContain("S256");
    }
  });

  it("[FO-05-41][FO-05-04] a caller login and a workforce login carry otp in amr; workforce users carry their role group; the password-only user does not carry otp", async () => {
    const client = templates.find((t) => t.name === "vsp-client");
    const workforce = templates.find((t) => t.name === "vsp-workforce");
    if (!client || !workforce) throw new Error("templates missing");
    const caller = await login(client, "synthetic-avery");
    expect(caller.idToken.amr).toEqual(expect.arrayContaining(["pwd", "otp"]));
    const staff = await login(workforce, "synthetic-supervisor");
    expect(staff.idToken.amr).toContain("otp");
    expect(staff.idToken.groups).toEqual(["/vsp/supervisor"]);
    expect((decodeJwt(staff.idTokenJwt) as { groups?: string[] }).groups).toEqual(["/vsp/supervisor"]);
    // The console maps the console client's own roles, which only the managed groups grant (never a group name).
    expect((decodeJwt(staff.idTokenJwt) as { vsp_roles?: string[] }).vsp_roles).toEqual(["supervisor"]);
    const pwd = await login(workforce, "synthetic-password-only");
    expect(pwd.idToken.amr).not.toContain("otp");
    // One workforce user per staff role, each in exactly its managed group.
    const groups = workforce.rep.users.flatMap((u) => u.groups ?? []);
    const managed = workforce.rep.groups?.find((g) => g.name === "vsp")?.subGroups ?? [];
    for (const role of ["support-agent", "supervisor", "safety-responder", "auditor", "knowledge-editor", "policy-approver", "deployment-operator", "security-admin"]) {
      expect(groups).toContain(`/vsp/${role}`);
      expect(managed.find((g) => g.name === role)?.clientRoles).toEqual({ "vsp-console": [role] });
    }
  });
});
