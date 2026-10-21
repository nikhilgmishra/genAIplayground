/**
 * ConnectorProfile admission, loading, credential separation rules, derived retention / egress / release
 * pins and reviewed changes (WP-06; FO-06-12..18, FO-05-56, FO-05-39). See README.md.
 */
export { ProfileRejectedError, admitConnectorProfile } from "./validate.js";
export type { AdmittedProfile } from "./validate.js";
export { loadConnectorProfile, loadConnectorProfilesFromDir } from "./load.js";
export { committedConfigCredentialRefs, credentialReuseViolations } from "./credentials.js";
export type { CredentialViolation, EnvironmentCredentialSet } from "./credentials.js";
export { egressDestinationFor, profileDigestEntries, retentionRulesFor } from "./derive.js";
export type { ConnectorRetentionRule, EgressCoverage, ProfileDigestEntry } from "./derive.js";
export { ConnectorProfileRegistry } from "./changes.js";
export type { ConnectorAuditPort, ConnectorProfileAuditEvent, ProfileChangeReview } from "./changes.js";
