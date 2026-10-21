/**
 * Runtime secret resolution for connectors (WP-06; FO-06-04, FO-16-31, FO-15-26). See README.md.
 */
export { LocalFixtureSecretResolver, SecretValue, SecretsManagerSecretResolver, createSecretResolver, refuseUnresolvable } from "./resolver.js";
export type { ResolvedSecret, SecretResolver, SecretsManagerResolverOptions, SecretsManagerSender, VersionStage } from "./resolver.js";
export { secretResolverCredentials } from "./credentials.js";
export type { ClientCredentialPair } from "./credentials.js";
