/**
 * LOCAL FIXTURE — OIDC identity provider and verifier for the SYNTHETIC world.
 *
 * `LocalOidcProviderFixture` plays the client and provider IdPs of
 * platform/src/fixtures/synthetic-world.ts: it generates LOCAL ES256 keys per
 * issuer, issues ID tokens (iss, sub, aud, iat, exp, nonce, auth_time, amr, acr)
 * for synthetic people and publishes each issuer's public JWKS. Keys are
 * generated in memory per process and labelled LOCAL; they are never real IdP keys.
 *
 * `LocalOidcVerifierFixture` (kind "local_fixture") runs the SAME verification
 * core as the live `JwksOidcVerifier`, with keys resolved from this provider in
 * memory instead of over the network. Production configuration rejects it (OPS-04).
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey, JSONWebKeySet, JWK } from "jose";
import { IDP } from "../../fixtures/synthetic-world.js";
import type { Clock } from "../../shared/clock.js";
import { ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { AdapterHealth, OidcClaims, OidcVerifier } from "../ports.js";
import { DEFAULT_OIDC_POLICY, verifyIdTokenCore } from "../live/oidc-verifier.js";
import type { OidcVerificationPolicy, TrustedIssuer } from "../live/oidc-verifier.js";

interface IssuerKeys {
  active: { kid: string; privateKey: CryptoKey; publicJwk: JWK };
  retired: { kid: string; publicJwk: JWK }[];
}

export interface IssueIdTokenInput {
  issuer: string;
  sub: string;
  nonce: string;
  audience?: string | string[];
  azp?: string;
  /** Epoch seconds; defaults to now. */
  authTime?: number | null;
  amr?: string[] | null;
  acr?: string | null;
  ttlSeconds?: number;
  /** Epoch seconds; defaults to now. */
  issuedAt?: number;
  /** TEST: sign with a key the verifier does not trust (same kid), to prove signature checks. */
  signWithUntrustedKey?: boolean;
  /** TEST: override `iss` in the payload while signing with `issuer`'s key. */
  payloadIssuerOverride?: string;
}

export class LocalOidcProviderFixture {
  readonly label = "LOCAL FIXTURE OIDC PROVIDER — SYNTHETIC IDENTITIES ONLY";
  private readonly keys = new Map<string, IssuerKeys>();

  private constructor(
    private readonly clock: Clock,
    readonly defaultAudience: string,
  ) {}

  static async create(opts: { clock: Clock; issuers?: string[]; audience?: string }): Promise<LocalOidcProviderFixture> {
    const p = new LocalOidcProviderFixture(opts.clock, opts.audience ?? IDP.portalAudience);
    for (const issuer of opts.issuers ?? [IDP.clientIssuer, IDP.providerIssuer]) {
      p.keys.set(issuer, { active: await newLocalKey(), retired: [] });
    }
    return p;
  }

  get issuers(): string[] {
    return [...this.keys.keys()];
  }

  trustedIssuers(audience = this.defaultAudience): TrustedIssuer[] {
    return this.issuers.map((issuer) => ({ issuer, audience, jwksUri: `${issuer}/.well-known/jwks.json` }));
  }

  /** Public JWKS (active + retired keys); never contains private key material. */
  jwks(issuer: string): JSONWebKeySet {
    const k = this.keys.get(issuer);
    if (!k) return { keys: [] };
    return { keys: [k.active.publicJwk, ...k.retired.map((r) => r.publicJwk)].map((j) => ({ ...j })) };
  }

  /**
   * Rotates the issuer's signing key. By default previous public keys stay published
   * (tokens they signed keep verifying); `dropOld` unpublishes every previous key.
   */
  async rotate(issuer: string, dropOld = false): Promise<void> {
    const k = this.mustKeys(issuer);
    const next = await newLocalKey();
    if (dropOld) k.retired = [];
    else k.retired.push({ kid: k.active.kid, publicJwk: k.active.publicJwk });
    k.active = next;
  }

  async issueIdToken(input: IssueIdTokenInput): Promise<string> {
    const k = this.mustKeys(input.issuer);
    const nowS = Math.floor(this.clock.now().getTime() / 1000);
    const iat = input.issuedAt ?? nowS;
    const payload: Record<string, unknown> = { nonce: input.nonce };
    if (input.authTime !== null) payload.auth_time = input.authTime ?? nowS;
    if (input.amr !== null) payload.amr = input.amr ?? ["pwd", "mfa"];
    if (input.acr !== null && input.acr !== undefined) payload.acr = input.acr;
    if (input.azp) payload.azp = input.azp;
    const signingKey = input.signWithUntrustedKey ? (await newLocalKey()).privateKey : k.active.privateKey;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: k.active.kid, typ: "JWT" })
      .setIssuer(input.payloadIssuerOverride ?? input.issuer)
      .setSubject(input.sub)
      .setAudience(input.audience ?? this.defaultAudience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (input.ttlSeconds ?? 300))
      .setJti(newId("idt"))
      .sign(signingKey);
  }

  /** Convenience: ID token for a SYNTHETIC person record (idpIssuer / idpSubject). */
  async issueFor(person: { idpIssuer: string; idpSubject: string }, opts: Omit<IssueIdTokenInput, "issuer" | "sub">): Promise<string> {
    return this.issueIdToken({ ...opts, issuer: person.idpIssuer, sub: person.idpSubject });
  }

  private mustKeys(issuer: string): IssuerKeys {
    const k = this.keys.get(issuer);
    if (!k) throw new ValidationError("FIXTURE_ISSUER_UNKNOWN");
    return k;
  }
}

async function newLocalKey(): Promise<IssuerKeys["active"]> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = `local-idp-${newId("kid").slice(4, 20)}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return { kid, privateKey, publicJwk };
}

export class LocalOidcVerifierFixture implements OidcVerifier {
  readonly kind = "local_fixture" as const;
  readonly integrationId: string;
  private readonly policy: OidcVerificationPolicy;

  constructor(
    private readonly provider: LocalOidcProviderFixture,
    private readonly opts: { clock: Clock; audience?: string; integrationId?: string; policy?: Partial<OidcVerificationPolicy> },
  ) {
    this.integrationId = opts.integrationId ?? "oidc-client-idp";
    this.policy = { ...DEFAULT_OIDC_POLICY, ...opts.policy };
  }

  async health(): Promise<AdapterHealth> {
    return { healthy: true, reasonCode: null };
  }

  async verifyIdToken(idToken: string, expected: { nonce: string; maxAuthAgeSeconds: number }): Promise<OidcClaims> {
    return verifyIdTokenCore(idToken, expected, {
      issuers: this.provider.trustedIssuers(this.opts.audience ?? this.provider.defaultAudience),
      // Resolved per call so key rotation in the fixture is visible immediately.
      resolverFor: (issuer) => (header, token) => createLocalJWKSet(this.provider.jwks(issuer.issuer))(header, token),
      clock: this.opts.clock,
      policy: this.policy,
    });
  }
}
