import type { JWK } from "jose";
import { ValidationError } from "../../shared/errors.js";
import type { AssertionSigner } from "./signers.js";

/**
 * Assertion key ring with rotation. One ACTIVE signer mints; previously active
 * keys are RETAINED (public key only) so assertions they signed keep verifying
 * until they are retired. Retire a kid only after the longest assertion TTL
 * signed with it has elapsed. The JWKS never contains private key material.
 */
export class AssertionKeyRing {
  private activeSigner: AssertionSigner;
  private readonly retained = new Map<string, JWK>();

  constructor(active: AssertionSigner) {
    this.activeSigner = active;
  }

  get active(): AssertionSigner {
    return this.activeSigner;
  }

  get kind(): "local_fixture" | "live" {
    return this.activeSigner.kind;
  }

  /** Makes `next` the active signer; the previous active key is retained for verification. */
  async rotate(next: AssertionSigner): Promise<void> {
    if (next.kid === this.activeSigner.kid || this.retained.has(next.kid)) throw new ValidationError("ASSERTION_KID_REUSED");
    const previous = await this.activeSigner.publicJwk();
    await next.publicJwk(); // fail before switching if the new key is unusable
    this.retained.set(this.activeSigner.kid, previous);
    this.activeSigner = next;
  }

  /** Stops accepting a retained key. The active key cannot be retired. */
  retire(kid: string): void {
    if (kid === this.activeSigner.kid) throw new ValidationError("ASSERTION_ACTIVE_KEY_CANNOT_RETIRE");
    this.retained.delete(kid);
  }

  knows(kid: string): boolean {
    return kid === this.activeSigner.kid || this.retained.has(kid);
  }

  retainedKids(): string[] {
    return [...this.retained.keys()];
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const active = await this.activeSigner.publicJwk();
    return { keys: [active, ...this.retained.values()].map(publicOnly) };
  }
}

function publicOnly(jwk: JWK): JWK {
  const { kty, crv, x, y, kid, alg, use } = jwk;
  return { kty, crv, x, y, kid, alg, use } as JWK;
}
