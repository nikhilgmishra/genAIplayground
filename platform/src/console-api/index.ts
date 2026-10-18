/**
 * Console API backend (spec sections 7, 12, 13, 16). See README.md.
 * Fixtures (fixtures/*.fixture.ts) are test-only and not re-exported.
 */
export * from "./contract.js";
export { registerConsoleApi, assertConsoleDeps, consoleRuntimeComponents, CONSOLE_LOCAL_SIGN_IN_COMPONENT, WORKFORCE_IDP_COMPONENT, RETRY_RECONCILIATION_MAX_AGE_MS } from "./plugin.js";
export type { ConsoleApiDeps, ReconciledRetryPort, CallOwnershipSource } from "./deps.js";
export {
  WorkforceTokenVerifier,
  WorkforceTokenPolicy,
  LocalStaffDirectoryFixture,
  LocalWorkforceSignInFixture,
  BlockedWorkforceStaffDirectory,
  DEFAULT_MFA_AMR_VALUES,
  LOCAL_FIXTURE_AMR,
  isOfflineEnvironment,
} from "./auth.js";
export type { StaffDirectory, StaffRecord, LocalWorkforceSignIn, VerifiedWorkforceToken } from "./auth.js";
export { PgBreakGlassGrantSource, activeGrant } from "./break-glass.js";
export type { BreakGlassGrantSource } from "./break-glass.js";
export { ENDPOINT_POLICY_ACTIONS, ENDPOINT_RESOURCE_TYPES, authorize, consoleReasonFor, defaultChecks, hasEndpointRole } from "./authorize.js";
export type { ConsoleIdentity, ConsolePolicyEngine, PolicyCheck } from "./authorize.js";
export { ReleaseSubmissionRegistryPg, ReleaseSubmissionInput, auditActionFor } from "./stores.js";
export { ENDPOINT_SCHEMAS } from "./schemas.js";
