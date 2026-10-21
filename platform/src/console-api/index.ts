/**
 * Console API backend (spec sections 7, 12, 13, 16). See README.md.
 * Fixtures (fixtures/*.fixture.ts) are test-only and not re-exported.
 */
export * from "./contract.js";
export {
  registerConsoleApi,
  assertConsoleDeps,
  consoleRuntimeComponents,
  CONSOLE_LOCAL_SIGN_IN_COMPONENT,
  WORKFORCE_IDP_COMPONENT,
  RETRY_RECONCILIATION_MAX_AGE_MS,
  BREAK_GLASS_MAX_DURATION_SECONDS,
} from "./plugin.js";
export type { ConsoleApiDeps, ReconciledRetryPort, CallOwnershipSource } from "./deps.js";
export { LedgerReconciledRetry } from "./reconciled-retry.js";
export {
  WorkforceTokenVerifier,
  WorkforceTokenPolicy,
  LocalStaffDirectoryFixture,
  LocalWorkforceSignInFixture,
  AMR_FACTOR_CLASS,
  amrSatisfiesMfa,
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
export { WorkforceSsoService, isConsoleSessionHeader } from "./sso.js";
export type { WorkforceOidcPort, WorkforceIdTokenFacts, WorkforceTokenSet, WorkforceIdTokenPolicyCheck, WorkforceSsoDeps, SsoIdentity } from "./sso.js";
export { DEFAULT_WORKFORCE_SESSION, WorkforceSsoConfigSchema, WorkforceSessionPolicySchema, parseWorkforceSsoConfig, workforceSsoGuardViolations, redirectUriProblem, rolesForGroups } from "./sso-config.js";
export type { WorkforceSsoConfig, WorkforceSessionPolicy } from "./sso-config.js";
export { PgConsoleSessionStore, CONSOLE_SESSION_TOKEN, sessionVerdict } from "./sessions.js";
export { AesGcmTokenSealer } from "./token-sealer.js";
export type { TokenSealer, SealedToken } from "./token-sealer.js";
export { OidcGroupStaffDirectory, workforceDisplayLabel } from "./oidc-staff-directory.js";
export { PgBreakGlassIssuance, BREAK_GLASS_DECISION_WINDOW_SECONDS, ACCESS_REVIEW_DUE_SECONDS } from "./break-glass-issuance.js";
export { PgRecoveryService, DEFAULT_RECOVERY_POLICY, RECOVERY_AUDIENCE, RECOVERY_SIGNATURE_TYP, signRecoveryChallenge, recoveryKeyThumbprint } from "./recovery.js";
export type { RecoveryPolicy } from "./recovery.js";
export type { ConsoleSsoDeps } from "./routes/auth/workforce-auth.js";
