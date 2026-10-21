/**
 * Adapter from the SecretResolver to the `credentials()` callback of the existing Salesforce REST
 * adapter (platform/src/adapters/live/salesforce-rest-support-records.ts, SalesforceRestDeps): the
 * live composition (WP-07) binds that callback to Secrets Manager through this function instead of any
 * other source. The secret format is the connector runtime's client-credentials format
 * `{"clientId": "...", "clientSecret": "..."}`.
 */
import { z } from "zod";
import { DependencyError } from "../../shared/errors.js";
import type { SecretResolver } from "./resolver.js";

export interface ClientCredentialPair {
  clientId: string;
  clientSecret: string;
}

const Pair = z.strictObject({ clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(512) });

/** Returns a callback that resolves the current client id and secret on every call (rotation without restart). */
export function secretResolverCredentials(resolver: SecretResolver, ref: string): () => Promise<ClientCredentialPair> {
  return async () => {
    const s = await resolver.resolve(ref);
    const parsed = Pair.safeParse(s.value.json());
    if (!parsed.success) throw new DependencyError("SECRET_MALFORMED", "FAILED", false);
    return parsed.data;
  };
}
