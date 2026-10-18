/**
 * Operations and incident control console API contract, v1 (spec sections 6, 7, 12, 13, 16).
 *
 * TYPES AND ROUTE CONSTANTS ONLY. This file has no imports and no runtime
 * dependencies so that the React console (`console/`) can import it with a
 * relative path while the backend (`platform/src/console-api`) implements
 * matching strict zod schemas. Enumerations below mirror
 * `platform/src/protocol/*`; the backend MUST assert type equality between its
 * zod-inferred types and these (see README "Keeping the contract in sync").
 *
 * Binding rules for every endpoint (the console UI mirrors them, the server
 * ENFORCES them; hiding a button is never the control):
 *  - Workforce SSO with MFA; staff identity and roles are server-established
 *    from the verified token, never from a request body (AUTH-02, AUTH-03).
 *  - Least privilege per endpoint: `ENDPOINT_ROLES` below, plus per-scope /
 *    per-task / per-release rules (`KILL_SWITCH_SCOPE_ROLES`,
 *    `HumanTaskView.requiredStaffRoles`, `RELEASE_REVIEW_ROLES`).
 *  - Opaque identifiers only in paths and query strings; never PHI (spec section 6).
 *  - Content-free: no transcript text, audio, recording links, summaries of
 *    what a caller said, raw database queries, shared secrets or Step Functions
 *    task tokens are ever returned (spec section 16). The contract has no field
 *    that could carry them.
 *  - Every mutation is written as an audit event in the same transaction as the
 *    change; if the audit event cannot be written the change is refused with
 *    `AUDIT_UNAVAILABLE` (OPS-01).
 *  - Operator reasons are reason codes (optionally `CODE:<opaque incident id>`),
 *    never free text, so no PHI can be typed into an administrative record.
 *  - Errors are `ConsoleErrorBody` carrying reason codes only.
 *
 * Status: IMPLEMENTED_OFFLINE contract. Workforce SSO is BLOCKED on PRQ-036
 * (identity owner: OIDC client, MFA claims and role-group mapping, VQ-IDP-08).
 * Talkdesk join/transfer controls are UNKNOWN (TB-07); the backend reports
 * their availability per call in `CallDetailResponse.controls`.
 */

/* ------------------------------------------------------------------------ */
/* Versioning, base path, headers                                            */
/* ------------------------------------------------------------------------ */

export const CONSOLE_API_VERSION = "console-api.v1";
export const CONSOLE_API_BASE = "/console/api/v1";

/** Bearer token from the console token endpoints. Held in browser memory only (never localStorage/cookies). */
export const AUTHORIZATION_HEADER = "Authorization";
/** Client-generated key per confirmed mutation; the server returns the first result for a repeated key. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9_-]{16,128}$";

/* ------------------------------------------------------------------------ */
/* Identifier and value patterns (regex sources; mirror platform/src/protocol) */
/* ------------------------------------------------------------------------ */

/** platform/src/protocol/common.ts OpaqueId */
export const OPAQUE_ID_PATTERN = "^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$";
/** platform/src/protocol/support.ts SupportReference (never presented as a Salesforce Case number) */
export const SUPPORT_REFERENCE_PATTERN = "^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$";
/** platform/src/protocol/support.ts DestinationId (trusted configuration only, SAFE-05) */
export const DESTINATION_ID_PATTERN = "^dst_[a-z0-9_]{2,40}$";
/** platform/src/protocol/release.ts StaffActor.staffId */
export const STAFF_ID_PATTERN = "^stf_[A-Za-z0-9_-]{8,64}$";
/** platform/src/protocol/tools.ts ReasonCode */
export const REASON_CODE_PATTERN = "^[A-Z][A-Z0-9_]{2,63}$";
/**
 * Operator reason: a reason code, optionally followed by `:<opaque incident id>`.
 * Same shape as KILL_SWITCH_REASON in platform/src/ops/kill-switches.ts. The code
 * part must not contain a run of four or more digits.
 */
export const OPERATOR_REASON_PATTERN = "^[A-Z][A-Z0-9_]{2,63}(:[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64})?$";
/** platform/src/audit/schema.ts AuditAction (dotted action name) */
export const AUDIT_ACTION_PATTERN = "^[a-z][a-z0-9_.]{2,80}$";
export const MAX_AUDIT_SEARCH_LIMIT = 200;

/** Every path parameter and the pattern the server (and the console router) validates it against. */
export const PATH_PARAM_PATTERNS = {
  callId: OPAQUE_ID_PATTERN,
  ref: SUPPORT_REFERENCE_PATTERN,
  actionId: OPAQUE_ID_PATTERN,
  messageId: OPAQUE_ID_PATTERN,
  taskId: OPAQUE_ID_PATTERN,
  releaseId: OPAQUE_ID_PATTERN,
} as const;
export type PathParamName = keyof typeof PATH_PARAM_PATTERNS;

/** ISO-8601 UTC timestamp string (`...Z`). */
export type IsoDateTime = string;
/** Opaque identifier string matching OPAQUE_ID_PATTERN. */
export type OpaqueId = string;
/** Reason code string matching REASON_CODE_PATTERN. */
export type ReasonCode = string;
/** Operator reason string matching OPERATOR_REASON_PATTERN. */
export type OperatorReason = string;

/* ------------------------------------------------------------------------ */
/* Mirrored protocol enumerations                                            */
/* ------------------------------------------------------------------------ */

/** platform/src/protocol/common.ts StaffRole (spec section 7: separated workforce roles). */
export const STAFF_ROLES = [
  "support_agent",
  "supervisor",
  "safety_responder",
  "auditor",
  "knowledge_editor",
  "policy_approver",
  "deployment_operator",
  "security_admin",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type Environment = "local" | "ci" | "sandbox" | "staging" | "production";
export type Assurance = "A0" | "A1" | "A2" | "A3";
export type AdapterKind = "local_fixture" | "live";
export type DataClass = "TRANSIENT_CONVERSATION" | "BUSINESS_RECORD" | "RESTRICTED_QA_MEDIA" | "SECURITY_AUDIT";

export type Outcome =
  | "RESOLVED"
  | "REQUEST_ACCEPTED"
  | "TRANSFERRED"
  | "INFORMATION_PROVIDED"
  | "DECLINED_BY_POLICY"
  | "CALLER_DISCONNECTED"
  | "FAILED"
  | "OUTCOME_UNKNOWN";

export type IssueCategory =
  | "general_question"
  | "portal_login_help"
  | "appointment"
  | "billing_question"
  | "billing_dispute"
  | "claim_status"
  | "provider_onboarding"
  | "credentialing_documents"
  | "remittance"
  | "partner_intake"
  | "complaint"
  | "case_follow_up"
  | "privacy_concern"
  | "safety_concern"
  | "clinical_question_redirected"
  | "accessibility_request"
  | "language_support"
  | "other";

export type SyncState = "PENDING" | "SYNCING" | "SYNCED" | "RETRY_SCHEDULED" | "DEAD_LETTER";

export type TransferState =
  | "REQUESTED"
  | "QUEUED"
  | "RECEIVER_ACCEPTED"
  | "BRIDGED"
  | "CALLER_CONFIRMED_CONNECTED"
  | "COMPLETED"
  | "TIMED_OUT"
  | "RECEIVER_UNAVAILABLE"
  | "BRIDGE_DROPPED"
  | "CALLER_DISCONNECTED"
  | "FAILED";

/** platform/src/protocol/support.ts TransferReason */
export const TRANSFER_REASONS = [
  "CALLER_REQUESTED_HUMAN",
  "SAFETY_PRIORITY",
  "CLINICAL_QUESTION",
  "POLICY_REQUIRES_HUMAN",
  "VERIFICATION_RECOVERY",
  "UNSUPPORTED_LANGUAGE",
  "ACCESSIBILITY",
  "DEPENDENCY_FAILURE",
  "AI_UNAVAILABLE",
  "CONSENT_DECLINED_ALTERNATIVE",
] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];

export type DestinationPurpose =
  | "SAFETY_PRIORITY"
  | "STANDARD_SUPPORT"
  | "INTERPRETER"
  | "CLINICAL_ROUTE"
  | "PROVIDER_SUPPORT"
  | "PARTNER_SUPPORT"
  | "BILLING_SPECIALIST"
  | "OUTAGE_CONTINUITY";

export type ActionKind =
  | "appointment.reschedule"
  | "appointment.create"
  | "appointment.cancel"
  | "billing.review.submit"
  | "support_request.create"
  | "callback.schedule";

export type ActionState =
  | "PREPARED"
  | "CONFIRMED"
  | "COMMITTING"
  | "COMMITTED"
  | "FAILED"
  | "UNKNOWN"
  | "INVALIDATED"
  | "EXPIRED"
  | "CANCELLED";

export type CommitOutcome = "NOT_STARTED" | "COMMITTED" | "FAILED" | "UNKNOWN";
export type ActionTargetSystem = "scheduling" | "billing" | "claims" | "provider" | "support_records" | "internal";

export type ToolStatus = "SUCCESS" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "POLICY_DENIED" | "PENDING" | "UNKNOWN_OUTCOME";

export type WorkflowType =
  | "billing_dispute_review"
  | "provider_document_review"
  | "claim_investigation"
  | "partner_onboarding"
  | "support_request_sync"
  | "callback_request"
  | "complaint_review";

export type WorkflowStateName =
  | "ACCEPTED"
  | "VALIDATING"
  | "WAITING_FOR_SYSTEM"
  | "WAITING_FOR_HUMAN"
  | "WAITING_FOR_CALLER"
  | "READY_TO_COMMIT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** platform/src/protocol/contracts.ts KillSwitchScope (spec section 13: separate kill switches). */
export const KILL_SWITCH_SCOPES = [
  "AI_ADMISSION",
  "INTENT",
  "INTEGRATION",
  "WRITES",
  "MODEL_VERSION",
  "VOICE_VERSION",
  "OUTBOUND_NOTIFICATIONS",
] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];
/** Scopes whose only valid target is "*" (platform/src/ops/kill-switches.ts GLOBAL_SCOPES). */
export const GLOBAL_KILL_SWITCH_SCOPES = ["AI_ADMISSION", "WRITES", "OUTBOUND_NOTIFICATIONS"] as const satisfies readonly KillSwitchScope[];

export type AuditOutcome = "ALLOWED" | "DENIED" | "SUCCEEDED" | "FAILED" | "PENDING" | "UNKNOWN" | "INVALIDATED" | "RECONCILED";
export type AuditSourceComponent =
  | "gateway"
  | "mcp_adapter"
  | "telephony_control"
  | "identity"
  | "policy"
  | "actions"
  | "workflow"
  | "knowledge"
  | "safety"
  | "voice_gate"
  | "console"
  | "worker"
  | "retention"
  | "config";

/** FAIL_SAFE: the safety pipeline could not assess an utterance (rule-stage crash or a lexeme-bearing utterance it could not classify) and routed to safety. */
export type SafetySignalSource = "EXPLICIT_PHRASE" | "SEMANTIC_SIGNAL" | "ASR_UNCERTAIN" | "CALLER_REQUEST" | "HUMAN_INTERVENTION" | "FAIL_SAFE";
export type SafetyRouteOutcome = "IN_PROGRESS" | "TRANSFERRED" | "CALLER_DISCONNECTED" | "FAILED" | "OUTCOME_UNKNOWN";
export type OutboxTopic = "support_request.sync" | "workflow.start" | "workflow.signal" | "notification.send" | "audit.ship" | "action.committed";
export type ApprovalScope = "POLICY_RELEASE" | "KNOWLEDGE_RELEASE";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

/* ------------------------------------------------------------------------ */
/* Endpoints                                                                 */
/* ------------------------------------------------------------------------ */

export type HttpMethod = "GET" | "POST";

/**
 * Every console endpoint. Paths use `:name` placeholders validated against
 * PATH_PARAM_PATTERNS. Nothing outside this table is served under the base path.
 */
export const CONSOLE_ENDPOINTS = {
  // --- authentication (unauthenticated; see PUBLIC_ENDPOINTS) ---
  "auth.config": { method: "GET", path: "/console/api/v1/auth/config" },
  /** LOCAL FIXTURE ONLY: synthetic workforce staff for the dev sign-in picker. */
  "auth.localStaff": { method: "GET", path: "/console/api/v1/auth/local/staff" },
  /** LOCAL FIXTURE ONLY: token for one synthetic staff member from the local workforce IdP fixture. */
  "auth.localToken": { method: "POST", path: "/console/api/v1/auth/local/token" },
  /** OIDC authorization-code + PKCE exchange performed by the backend (BLOCKED: PRQ-036). */
  "auth.oidcExchange": { method: "POST", path: "/console/api/v1/auth/oidc/exchange" },
  // --- authenticated ---
  "auth.logout": { method: "POST", path: "/console/api/v1/auth/logout" },
  me: { method: "GET", path: "/console/api/v1/me" },
  overview: { method: "GET", path: "/console/api/v1/overview" },
  "calls.list": { method: "GET", path: "/console/api/v1/calls" },
  "calls.get": { method: "GET", path: "/console/api/v1/calls/:callId" },
  "calls.transfer": { method: "POST", path: "/console/api/v1/calls/:callId/transfer" },
  "supportRequests.trace": { method: "GET", path: "/console/api/v1/support-requests/:ref/trace" },
  /** Operator repair of a support request whose Salesforce sync was dead-lettered (spec section 8 "operator repair flow"). */
  "supportRequests.repair": { method: "POST", path: "/console/api/v1/support-requests/:ref/repair" },
  "actions.pending": { method: "GET", path: "/console/api/v1/actions/pending" },
  "actions.cancel": { method: "POST", path: "/console/api/v1/actions/:actionId/cancel" },
  "reconciliation.list": { method: "GET", path: "/console/api/v1/reconciliation" },
  "reconciliation.reconcile": { method: "POST", path: "/console/api/v1/reconciliation/:actionId/reconcile" },
  "reconciliation.retry": { method: "POST", path: "/console/api/v1/reconciliation/:actionId/retry" },
  "outbox.requeue": { method: "POST", path: "/console/api/v1/outbox/:messageId/requeue" },
  "workflows.tasks": { method: "GET", path: "/console/api/v1/workflows/tasks" },
  "workflows.decision": { method: "POST", path: "/console/api/v1/workflows/tasks/:taskId/decision" },
  "safetyEvents.list": { method: "GET", path: "/console/api/v1/safety-events" },
  "releases.list": { method: "GET", path: "/console/api/v1/releases" },
  "releases.review": { method: "POST", path: "/console/api/v1/releases/:releaseId/review" },
  "budgets.list": { method: "GET", path: "/console/api/v1/budgets" },
  "killSwitches.list": { method: "GET", path: "/console/api/v1/kill-switches" },
  "killSwitches.set": { method: "POST", path: "/console/api/v1/kill-switches" },
  "audit.search": { method: "GET", path: "/console/api/v1/audit/search" },
  "destinations.list": { method: "GET", path: "/console/api/v1/destinations" },
} as const satisfies Record<string, { method: HttpMethod; path: string }>;

export type EndpointKey = keyof typeof CONSOLE_ENDPOINTS;

/**
 * Endpoints served without a bearer token. The `auth.local*` endpoints are
 * registered ONLY when the environment is `local` or `ci` and the workforce IdP
 * adapter kind is `local_fixture`; the production configuration guard rejects
 * them (OPS-04). They respond 404 `LOCAL_FIXTURE_DISABLED` everywhere else.
 */
export const PUBLIC_ENDPOINTS = ["auth.config", "auth.localStaff", "auth.localToken", "auth.oidcExchange"] as const satisfies readonly EndpointKey[];
export type PublicEndpointKey = (typeof PUBLIC_ENDPOINTS)[number];
export type AuthenticatedEndpointKey = Exclude<EndpointKey, PublicEndpointKey>;

/** Extracts `:name` placeholders from a path template. */
type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
export type PathParams<K extends EndpointKey> = { [N in PathParamNames<(typeof CONSOLE_ENDPOINTS)[K]["path"]>]: string };

/* ------------------------------------------------------------------------ */
/* Least-privilege role requirements                                          */
/* ------------------------------------------------------------------------ */

const ALL_STAFF: readonly StaffRole[] = STAFF_ROLES;
const JOURNEY: readonly StaffRole[] = ["support_agent", "supervisor", "safety_responder"];

/**
 * Staff roles allowed to call each authenticated endpoint (any one role suffices).
 * The server additionally applies the finer rules noted per entry. Mirrors
 * docs/security/permission-matrix.md "Workforce (console) roles".
 */
export const ENDPOINT_ROLES: Readonly<Record<AuthenticatedEndpointKey, readonly StaffRole[]>> = {
  "auth.logout": ALL_STAFF,
  me: ALL_STAFF,
  /** Operational health; no record-level data. */
  overview: ["support_agent", "supervisor", "safety_responder", "deployment_operator", "security_admin"],
  "calls.list": JOURNEY,
  "calls.get": JOURNEY,
  /** Destination must be in the trusted allowlist (SAFE-05); success requires receiver acceptance (SAFE-04). */
  "calls.transfer": JOURNEY,
  "supportRequests.trace": JOURNEY,
  /**
   * Only a DEAD_LETTER sync (STATE_CONFLICT otherwise); restricted requests additionally need a valid
   * break-glass grant (restricted_record:view). Re-queues the idempotent upsert by external id (ACT-02).
   */
  "supportRequests.repair": ["supervisor"],
  "actions.pending": ["support_agent", "supervisor"],
  /** support_agent: only actions on calls they currently own (server-enforced); supervisor: any. Only uncommitted actions. */
  "actions.cancel": ["support_agent", "supervisor"],
  "reconciliation.list": ["supervisor"],
  "reconciliation.reconcile": ["supervisor"],
  /** Only after the latest reconciliation for the action returned NOT_FOUND (ACT-03). */
  "reconciliation.retry": ["supervisor"],
  "outbox.requeue": ["supervisor"],
  /** Union of staff roles mapped from workflow business roles (platform/src/workflows/types.ts); the list is filtered to tasks for the caller's roles. */
  "workflows.tasks": ["support_agent", "supervisor"],
  /** Additionally requires one of the task's `requiredStaffRoles`. */
  "workflows.decision": ["support_agent", "supervisor"],
  "safetyEvents.list": ["safety_responder", "supervisor"],
  /** auditor and security_admin read only. */
  "releases.list": ["policy_approver", "knowledge_editor", "security_admin", "auditor"],
  /** Additionally per release kind: RELEASE_REVIEW_ROLES. A reviewer can never review a release they submitted. */
  "releases.review": ["policy_approver", "knowledge_editor"],
  /** platform/src/ops/staff-authz.ts BUDGET_ROLES (read). */
  "budgets.list": ["supervisor", "security_admin", "deployment_operator"],
  "killSwitches.list": ["supervisor", "security_admin", "deployment_operator"],
  /** Additionally per scope: KILL_SWITCH_SCOPE_ROLES. */
  "killSwitches.set": ["supervisor", "security_admin", "deployment_operator"],
  /** Metadata only; every search is itself audited; auditors can never rewrite evidence. */
  "audit.search": ["auditor", "security_admin"],
  "destinations.list": ["support_agent", "supervisor", "safety_responder", "security_admin"],
};

/** Mirrors KILL_SWITCH_ROLES in platform/src/ops/staff-authz.ts (model/voice also deployment_operator). */
export const KILL_SWITCH_SCOPE_ROLES: Readonly<Record<KillSwitchScope, readonly StaffRole[]>> = {
  AI_ADMISSION: ["security_admin", "supervisor"],
  INTENT: ["security_admin", "supervisor"],
  INTEGRATION: ["security_admin", "supervisor"],
  WRITES: ["security_admin", "supervisor"],
  OUTBOUND_NOTIFICATIONS: ["security_admin", "supervisor"],
  MODEL_VERSION: ["security_admin", "supervisor", "deployment_operator"],
  VOICE_VERSION: ["security_admin", "supervisor", "deployment_operator"],
};

export type ReleaseKind = "POLICY_BUNDLE" | "KNOWLEDGE_SNAPSHOT";

/** Reviewer roles per release kind. Reviews are recorded opinions, never approval records. */
export const RELEASE_REVIEW_ROLES: Readonly<Record<ReleaseKind, readonly StaffRole[]>> = {
  POLICY_BUNDLE: ["policy_approver"],
  KNOWLEDGE_SNAPSHOT: ["knowledge_editor"],
};

/* ------------------------------------------------------------------------ */
/* Operator reason-code catalogue (PROPOSED; owner: support operations)        */
/* ------------------------------------------------------------------------ */

/**
 * Allowlisted reason codes per mutation. PROPOSED engineering catalogue pending
 * review by support operations and security (no approval exists). The server
 * rejects any code not listed for the endpoint with `REASON_NOT_ALLOWED`.
 */
export const OPERATOR_REASON_CODES = {
  "calls.transfer": TRANSFER_REASONS,
  "actions.cancel": ["CALLER_CHANGED_REQUEST", "SAFETY_ESCALATION", "SUSPECTED_FRAUD", "INCIDENT_CONTAINMENT", "DUPLICATE_REQUEST", "OPERATOR_ERROR_CORRECTION"],
  "reconciliation.retry": ["RECONCILED_NOT_FOUND_RETRY", "INCIDENT_RECOVERY"],
  "outbox.requeue": ["ROOT_CAUSE_FIXED", "TRANSIENT_DEPENDENCY_FAILURE", "INCIDENT_RECOVERY"],
  "supportRequests.repair": ["ROOT_CAUSE_FIXED", "TRANSIENT_DEPENDENCY_FAILURE", "INCIDENT_RECOVERY"],
  "workflows.decision.APPROVE": ["EVIDENCE_VERIFIED", "POLICY_CRITERIA_MET", "SPECIALIST_CONFIRMED"],
  "workflows.decision.REJECT": ["EVIDENCE_INSUFFICIENT", "OUT_OF_POLICY", "DUPLICATE_REQUEST", "NEEDS_SPECIALIST_REVIEW"],
  "releases.review": ["DIFF_REVIEWED", "TESTS_REVIEWED", "SCOPE_UNCLEAR", "MISSING_EVIDENCE", "POLICY_REGRESSION_SUSPECTED"],
  "killSwitches.set.engage": [
    "INCIDENT_CONTAINMENT",
    "PHI_EXPOSURE_SUSPECTED",
    "UNSAFE_OUTPUT",
    "FAILED_SAFETY_TRANSFER",
    "AUTH_BYPASS_SUSPECTED",
    "DEPENDENCY_OUTAGE",
    "UNEXPECTED_SPEND",
    "DUPLICATE_COMMIT",
    "VENDOR_BEHAVIOUR_CHANGE",
    "PLANNED_DRILL",
  ],
  "killSwitches.set.release": ["ROOT_CAUSE_FIXED", "INCIDENT_CLOSED", "PLANNED_DRILL_COMPLETE"],
} as const;

/* ------------------------------------------------------------------------ */
/* Errors                                                                    */
/* ------------------------------------------------------------------------ */

/** Known console reason codes; the server may return other ReasonCode values. */
export type ConsoleReasonCode =
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "STAFF_MFA_REQUIRED"
  | "STAFF_ROLE_NOT_PERMITTED"
  | "STAFF_BREAK_GLASS_EXPIRED"
  | "VALIDATION_FAILED"
  | "REASON_NOT_ALLOWED"
  | "NOT_FOUND"
  | "STATE_CONFLICT"
  | "ACTION_NOT_CANCELLABLE"
  | "RECONCILE_REQUIRED"
  | "RETRY_NOT_ELIGIBLE"
  | "DESTINATION_NOT_ALLOWLISTED"
  | "CONFIRMATION_MISMATCH"
  | "TASK_STALE"
  | "SELF_REVIEW_FORBIDDEN"
  | "TALKDESK_CONTROL_UNAVAILABLE"
  | "AUDIT_UNAVAILABLE"
  | "LOCAL_FIXTURE_DISABLED"
  | "OIDC_NOT_CONFIGURED"
  | "RATE_LIMITED";

/** Every non-2xx response body. No stack traces, SQL, record contents or free text. */
export interface ConsoleErrorBody {
  error: {
    reasonCode: ReasonCode;
    correlationId: OpaqueId | null;
    retryable: boolean;
  };
}

/* ------------------------------------------------------------------------ */
/* Authentication                                                            */
/* ------------------------------------------------------------------------ */

export interface OidcClientConfig {
  /** BLOCKED until the identity owner issues the workforce OIDC client (PRQ-036). */
  status: "CONFIGURED" | "BLOCKED";
  issuer: string | null;
  clientId: string | null;
  /** Resolved by the backend from the issuer's OpenID Connect discovery document. */
  authorizationEndpoint: string | null;
  /** Console route that receives the authorization response. */
  redirectPath: "/auth/callback";
  scopes: string[];
  /** PKCE is mandatory. */
  codeChallengeMethod: "S256";
  blockedReasonCode: ReasonCode | null;
}

export interface AuthConfigResponse {
  apiVersion: typeof CONSOLE_API_VERSION;
  environment: Environment;
  /** True when the backend runs against labelled local fixtures; the console shows a persistent badge. */
  localFixture: boolean;
  mode: "oidc_workforce" | "local_fixture";
  oidc: OidcClientConfig | null;
}

export interface LocalStaffOption {
  staffId: string;
  displayLabel: string;
  roles: StaffRole[];
}

/** GET auth/local/staff: synthetic staff from platform/src/fixtures/synthetic-world.ts STAFF. */
export interface LocalStaffResponse {
  label: "LOCAL DEV SIGN-IN (synthetic staff)";
  staff: LocalStaffOption[];
}

/**
 * POST auth/local/token. The local workforce IdP fixture authenticates the
 * synthetic staff member (amr `local_fixture`, mfa true) and the backend mints
 * a short-lived console token. Never available outside local/ci (OPS-04).
 */
export interface LocalTokenRequest {
  staffId: string;
}

/**
 * POST auth/oidc/exchange. The browser sends the authorization code with its
 * PKCE verifier and nonce; the backend exchanges the code at the IdP token
 * endpoint, validates the ID token (issuer, audience, nonce, expiry, MFA claim
 * per IdP configuration, BLOCKED VQ-IDP-08), maps workforce groups to StaffRole
 * and mints a console token. IdP tokens never reach the browser.
 */
export interface OidcExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: IsoDateTime;
  localFixture: boolean;
}

export interface BreakGlassView {
  /** Time-bound; expired break-glass fails closed (STAFF_BREAK_GLASS_EXPIRED). */
  expiresAt: IsoDateTime;
  /** staffId of the security_admin who granted it; never the holder (no self-grant). */
  approvedBy: string;
  justificationCode: ReasonCode;
}

export interface StaffView {
  staffId: string;
  displayLabel: string;
  roles: StaffRole[];
  mfa: boolean;
  authenticatedAt: IsoDateTime;
  /** Granted only through the separate audited access process; the console has no grant or request endpoint. */
  breakGlass: BreakGlassView | null;
}

export interface MeResponse {
  apiVersion: typeof CONSOLE_API_VERSION;
  staff: StaffView;
  tenantId: OpaqueId;
  environment: Environment;
  localFixture: boolean;
  sessionExpiresAt: IsoDateTime;
}

/* ------------------------------------------------------------------------ */
/* Overview                                                                  */
/* ------------------------------------------------------------------------ */

export interface QueueHealth {
  /** Owner queue id (`q_...`). */
  queueId: string;
  label: string;
  waiting: number | null;
  oldestWaitSeconds: number | null;
  availableAgents: number | null;
  status: HealthStatus;
  source: AdapterKind;
  reasonCode: ReasonCode | null;
}

export interface DependencyHealth {
  dependencyId: string;
  kind: AdapterKind;
  status: HealthStatus;
  circuit: "CLOSED" | "OPEN" | "HALF_OPEN" | "UNKNOWN";
  reasonCode: ReasonCode | null;
  checkedAt: IsoDateTime | null;
}

export interface OverviewResponse {
  generatedAt: IsoDateTime;
  liveSessions: { active: number; inTransfer: number; safetyActive: number };
  queues: QueueHealth[];
  aiAdmission: {
    state: "OPEN" | "CLOSED_BY_KILL_SWITCH" | "LIMITED_BY_BUDGET" | "LIMITED_BY_CAPACITY" | "UNKNOWN";
    reasonCode: ReasonCode | null;
  };
  dependencies: DependencyHealth[];
  audit: {
    backlogCount: number;
    oldestUnshippedAgeSeconds: number | null;
    sinkHealthy: boolean;
    canAcceptConsequential: boolean;
    reasonCode: ReasonCode | null;
  };
  killSwitchesEngaged: number;
  reconciliationBacklog: number;
  openSafetyEvents: number;
}

/* ------------------------------------------------------------------------ */
/* Calls                                                                     */
/* ------------------------------------------------------------------------ */

export interface CallsListQuery {
  state: "active";
}

export interface CallSummary {
  callId: OpaqueId;
  state: "ACTIVE" | "IN_TRANSFER" | "ENDED";
  assurance: Assurance;
  intentCategory: IssueCategory | null;
  safetyFlag: boolean;
  startedAt: IsoDateTime;
  transferState: TransferState | null;
  sessionGeneration: number;
  language: string;
  localFixture: boolean;
}

export interface CallsListResponse {
  calls: CallSummary[];
  generatedAt: IsoDateTime;
}

interface TimelineBase {
  eventId: OpaqueId;
  at: IsoDateTime;
  auditEventId: OpaqueId | null;
  turnId: string | null;
  sessionGeneration: number | null;
}

/** Content-free timeline entries. There is deliberately no event kind that carries caller words. */
export type CallTimelineEvent =
  | (TimelineBase & {
      kind: "session";
      change: "STARTED" | "ROLE_SELECTED" | "CONSENT_RECORDED" | "VERIFIED" | "GENERATION_CHANGED" | "REVOKED" | "ENDED";
      assurance: Assurance;
    })
  | (TimelineBase & {
      kind: "tool_invocation";
      tool: { name: string; version: string };
      status: ToolStatus;
      reasonCode: ReasonCode | null;
      policyDecisionId: OpaqueId | null;
      latencyMs: number | null;
    })
  | (TimelineBase & {
      kind: "policy_decision";
      decisionId: OpaqueId;
      policyAction: string;
      allow: boolean;
      reasonCodes: ReasonCode[];
      policyVersion: string;
      obligations: string[];
    })
  | (TimelineBase & {
      kind: "action";
      actionId: OpaqueId;
      actionKind: ActionKind;
      state: ActionState;
      receiptId: OpaqueId | null;
      commitOutcome: CommitOutcome | null;
    })
  | (TimelineBase & {
      kind: "transfer";
      transferId: OpaqueId;
      destinationId: string;
      transferState: TransferState;
      reason: TransferReason;
      receiverAcknowledgedPackage: boolean;
    })
  | (TimelineBase & {
      kind: "safety_event";
      incidentId: OpaqueId;
      phase: "SIGNAL_VALIDATED" | "ROUTE_INITIATED" | "OUTCOME";
      route: "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";
      latencyMs: number | null;
      withinTarget: boolean | null;
    })
  | (TimelineBase & {
      kind: "support_request";
      referenceNumber: string;
      syncState: SyncState;
    });

export interface ControlAvailability {
  available: boolean;
  /** Why not, e.g. TALKDESK_CONTROL_UNAVAILABLE while TB-07 is UNKNOWN. */
  reasonCode: ReasonCode | null;
}

export interface VersionSetView {
  agentConfig: string;
  model: string;
  voice: string;
  promptTemplates: string;
  policyBundle: string;
  toolCatalog: string;
  knowledgeSnapshot: string;
  schema: string;
}

export interface CallDetailResponse {
  call: CallSummary;
  versions: VersionSetView | null;
  controls: { transfer: ControlAvailability; join: ControlAvailability };
  timeline: CallTimelineEvent[];
  supportRequestRefs: string[];
  /** Always false: transcripts, audio and recording links are never served to the console. */
  contentAvailable: false;
}

export interface TransferRequest {
  /** Must be in GET destinations (trusted configuration). Never a phone number. */
  destinationId: string;
  reason: TransferReason;
}

export interface TransferResponse {
  transferId: OpaqueId;
  callId: OpaqueId;
  destinationId: string;
  /** REQUESTED or QUEUED: a transfer is complete only after receiver acceptance and verified connection (SAFE-04). */
  state: TransferState;
  auditEventId: OpaqueId;
}

/* ------------------------------------------------------------------------ */
/* Support request trace                                                     */
/* ------------------------------------------------------------------------ */

export interface SupportTraceResponse {
  supportRequest: {
    supportRequestId: OpaqueId;
    referenceNumber: string;
    issueCategory: IssueCategory;
    disposition: Outcome;
    ownerQueue: string;
    priority: "P1_SAFETY" | "P2_URGENT" | "P3_STANDARD" | "P4_LOW";
    restricted: boolean;
    sourceCallIds: OpaqueId[];
    createdAt: IsoDateTime;
    updatedAt: IsoDateTime;
  };
  sync: {
    state: SyncState;
    attempts: number;
    lastAttemptAt: IsoDateTime | null;
    lastReasonCode: ReasonCode | null;
    /** Null until Salesforce confirms the upsert; never invented. */
    salesforceCaseId: string | null;
    syncedAt: IsoDateTime | null;
    outboxMessageIds: OpaqueId[];
  };
  actions: {
    actionId: OpaqueId;
    kind: ActionKind;
    state: ActionState;
    receiptId: OpaqueId | null;
    commitOutcome: CommitOutcome | null;
    committedAt: IsoDateTime | null;
  }[];
  workflows: {
    workflowId: OpaqueId;
    type: WorkflowType;
    state: WorkflowStateName;
    definitionVersion: string;
    ownerQueue: string;
    deadline: IsoDateTime | null;
    openTaskIds: OpaqueId[];
  }[];
  auditEventIds: OpaqueId[];
}

/* ------------------------------------------------------------------------ */
/* Pending actions                                                           */
/* ------------------------------------------------------------------------ */

export interface PendingActionView {
  actionId: OpaqueId;
  kind: ActionKind;
  state: "PREPARED" | "CONFIRMED" | "COMMITTING";
  callId: OpaqueId | null;
  preparedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  requiresStepUp: boolean;
  target: { system: ActionTargetSystem; recordType: string };
  /** First 12 hex characters of the prepared-action digest, for correlation only. */
  digestPrefix: string;
  /** False once a commit has started (COMMITTING): uncommitted work only. */
  cancellable: boolean;
  notCancellableReason: ReasonCode | null;
}

export interface PendingActionsResponse {
  actions: PendingActionView[];
}

export interface CancelActionRequest {
  reason: OperatorReason;
  /** Optimistic check: the state the operator saw. */
  expectedState: "PREPARED" | "CONFIRMED";
}

export interface CancelActionResponse {
  actionId: OpaqueId;
  state: "CANCELLED";
  auditEventId: OpaqueId;
}

/* ------------------------------------------------------------------------ */
/* Reconciliation and dead letters                                           */
/* ------------------------------------------------------------------------ */

export interface ReconcileResultView {
  reconciliationId: OpaqueId;
  /** Provider lookup by idempotency key (platform/src/actions/ports.ts ProviderLookupResult). */
  result: "COMMITTED" | "NOT_FOUND" | "UNKNOWN";
  at: IsoDateTime;
  receiptId: OpaqueId | null;
}

export interface ReconciliationItem {
  actionId: OpaqueId;
  kind: ActionKind;
  state: "UNKNOWN" | "COMMITTING";
  providerSystem: ActionTargetSystem;
  since: IsoDateTime;
  attempts: number;
  lastReconcile: ReconcileResultView | null;
  /** True only when lastReconcile.result is NOT_FOUND and no newer attempt exists. */
  retryEligible: boolean;
}

export interface DeadLetterItem {
  messageId: OpaqueId;
  topic: OutboxTopic;
  /** Opaque aggregate key; payloads are never returned. */
  aggregateRef: string;
  attempts: number;
  lastReasonCode: ReasonCode | null;
  createdAt: IsoDateTime;
  deadAt: IsoDateTime;
}

export interface ReconciliationResponse {
  actions: ReconciliationItem[];
  deadLetters: DeadLetterItem[];
}

/** POST reconciliation/:actionId/reconcile has an empty body. */
export type ReconcileRequest = Record<string, never>;

export interface ReconcileResponse {
  actionId: OpaqueId;
  result: ReconcileResultView;
  state: ActionState;
  retryEligible: boolean;
  auditEventId: OpaqueId;
}

export interface RetryRequest {
  /** The NOT_FOUND reconciliation this retry is based on; stale ids are refused (RECONCILE_REQUIRED). */
  reconciliationId: OpaqueId;
  reason: OperatorReason;
}

export interface RetryResponse {
  actionId: OpaqueId;
  state: ActionState;
  outcome: CommitOutcome;
  receiptId: OpaqueId | null;
  auditEventId: OpaqueId;
}

export interface RequeueRequest {
  reason: OperatorReason;
}

export interface RequeueResponse {
  messageId: OpaqueId;
  /** Consumers deduplicate, so a requeue cannot create a duplicate effect (ACT-02). */
  requeued: boolean;
  auditEventId: OpaqueId;
}

export interface SupportRepairRequest {
  reason: OperatorReason;
}

export interface SupportRepairResponse {
  referenceNumber: string;
  /** The request is back in the sync queue; synchronization is asynchronous and never reported as done here. */
  syncState: SyncState;
  /** Salesforce upserts are idempotent by external id, so a repair cannot create a duplicate Case (ACT-02). */
  repaired: boolean;
  /** The business module's in-transaction `support_request.repair_requeued` event (else the console completion event). */
  auditEventId: OpaqueId;
}

/* ------------------------------------------------------------------------ */
/* Workflow human tasks                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Open human task. There is deliberately NO task token anywhere in this
 * contract: the backend holds the (hashed, single-task, expiring) token and
 * completes the task on the authenticated staff member's behalf after
 * re-validating their current authority (spec section 9).
 */
export interface HumanTaskView {
  taskId: OpaqueId;
  workflowId: OpaqueId;
  workflowType: WorkflowType;
  workflowState: WorkflowStateName;
  taskType: string;
  requiredStaffRoles: StaffRole[];
  status: "OPEN" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  ownerQueue: string;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  /** Opaque references (support request id, action id); no PHI. */
  sourceRecordRefs: string[];
}

export interface WorkflowTasksResponse {
  tasks: HumanTaskView[];
}

export interface WorkflowDecisionRequest {
  decision: "APPROVE" | "REJECT";
  /** Mandatory; from OPERATOR_REASON_CODES["workflows.decision.<DECISION>"]. */
  reason: OperatorReason;
}

export interface WorkflowDecisionResponse {
  taskId: OpaqueId;
  workflowId: OpaqueId;
  decision: "APPROVE" | "REJECT";
  workflowState: WorkflowStateName;
  auditEventId: OpaqueId;
}

/* ------------------------------------------------------------------------ */
/* Safety events                                                             */
/* ------------------------------------------------------------------------ */

/** Content-free safety evidence (platform/src/safety/safety-events.ts): rule ids, never the caller's words. */
export interface SafetyEventView {
  incidentId: OpaqueId;
  callId: OpaqueId;
  detectedAt: IsoDateTime;
  route: "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";
  signalSources: SafetySignalSource[];
  ruleIds: string[];
  strongestStrength: "CREDIBLE" | "UNRESOLVED" | null;
  destinationId: string;
  routeInitiatedAt: IsoDateTime | null;
  latencyMs: number | null;
  /** Engineering target for initiating the priority route (spec section 10: 2 s); not a staffed-connection commitment. */
  targetMs: number;
  withinTarget: boolean | null;
  outcome: SafetyRouteOutcome;
  auditStatus: "RECORDED" | "AUDIT_UNAVAILABLE";
  afterHours: boolean;
  locale: string;
  localeSupported: boolean;
}

export interface SafetyEventsResponse {
  events: SafetyEventView[];
}

/* ------------------------------------------------------------------------ */
/* Policy and knowledge release review                                       */
/* ------------------------------------------------------------------------ */

export type ReleaseReviewDecision = "NO_OBJECTION" | "CHANGES_REQUESTED";

export interface ReleaseReviewItem {
  releaseId: OpaqueId;
  kind: ReleaseKind;
  version: string;
  previousVersion: string | null;
  /** sha256 of the bundle / snapshot under review. */
  digest: string;
  submittedAt: IsoDateTime;
  submittedBy: string;
  diffSummary: {
    added: number;
    removed: number;
    changed: number;
    /** Rule ids / article ids with a change code; never document bodies. */
    entries: { ref: string; change: "ADDED" | "REMOVED" | "CHANGED"; summaryCode: ReasonCode }[];
  };
  reviews: {
    reviewId: OpaqueId;
    reviewerStaffId: string;
    reviewerRole: StaffRole;
    decision: ReleaseReviewDecision;
    reason: OperatorReason;
    at: IsoDateTime;
  }[];
  /** Release requires a signed human approval record of this scope (approvals/; the console cannot create one). */
  requiredApprovalScope: ApprovalScope;
  approvalStatus: "MISSING" | "PRESENT" | "EXPIRED" | "SIGNATURE_INVALID";
  approvalId: string | null;
  /**
   * KNOWLEDGE_SNAPSHOT only (optional; added compatibly by the backend): knowledge items held
   * out of the snapshot for human review, quarantined, or expired while in service. Item ids,
   * versions and reason codes only, never article bodies.
   */
  heldItems?: HeldKnowledgeItem[];
}

export interface HeldKnowledgeItem {
  ref: string;
  version: number;
  status: "HELD_FOR_REVIEW" | "QUARANTINED" | "EXPIRED_IN_SERVICE";
  reasonCodes: ReasonCode[];
}

export interface ReleasesResponse {
  releases: ReleaseReviewItem[];
}

export interface ReleaseReviewRequest {
  decision: ReleaseReviewDecision;
  reason: OperatorReason;
}

export interface ReleaseReviewResponse {
  reviewId: OpaqueId;
  releaseId: OpaqueId;
  recordedAt: IsoDateTime;
  auditEventId: OpaqueId;
  /** Always false: a review is NOT an approval record substitute. */
  approvalRecordCreated: false;
}

/* ------------------------------------------------------------------------ */
/* Budgets                                                                   */
/* ------------------------------------------------------------------------ */

/** Mirrors BudgetStatus in platform/src/ops/ports.ts. USD figures as numbers (protocol Budget). */
export interface BudgetView {
  budgetId: OpaqueId;
  scope: { environment: string; cohort: string; workflow: string; vendor: string };
  periodStart: IsoDateTime;
  periodEnd: IsoDateTime;
  limitUsd: number;
  safetyReserveUsd: number;
  spentUsd: number;
  safetySpentUsd: number;
  nonSafetySpentUsd: number;
  burnRateUsdPerMinute: number;
  /** spent + meteringDelayMinutes x burn rate: recorded spend understates actual spend. */
  projectedUsd: number;
  nonessentialHeadroomUsd: number;
  safetyReserveRemainingUsd: number;
  meteringDelayMinutes: number;
  /** New nonessential automation stops; active safety handoffs are never disconnected (SAFE-03). */
  exhausted: boolean;
  /** Alert the escalation owner; never a cap on safety work. */
  safetyReserveExceeded: boolean;
  /** Approval record reference for the financial authority; null = unapproved. */
  approvedBy: string | null;
  version: string;
}

export interface BudgetsResponse {
  budgets: BudgetView[];
  generatedAt: IsoDateTime;
  /** True for local fixture figures, which are illustrative and not approved budgets. */
  figuresIllustrative: boolean;
}

/* ------------------------------------------------------------------------ */
/* Kill switches                                                             */
/* ------------------------------------------------------------------------ */

export interface KillSwitchView {
  switchId: OpaqueId;
  scope: KillSwitchScope;
  /** Intent id, integration id or version label; "*" for global scopes. */
  target: string;
  engaged: boolean;
  reason: OperatorReason;
  changedBy: string;
  changedAt: IsoDateTime;
}

export interface KillSwitchesResponse {
  switches: KillSwitchView[];
  snapshot: {
    aiAdmission: boolean;
    writes: boolean;
    outboundNotifications: boolean;
    intents: string[];
    integrations: string[];
    modelVersions: string[];
    voiceVersions: string[];
  };
  /** Known targets from trusted configuration; the console offers only these (no free-typed targets). */
  targets: { INTENT: string[]; INTEGRATION: string[]; MODEL_VERSION: string[]; VOICE_VERSION: string[] };
  /** Always true: no switch gates the approved safety and human routes. */
  safetyRoutesPreserved: true;
}

/**
 * Typed confirmation the operator enters and the server re-checks:
 * `ENGAGE <scope> <target>` or `RELEASE <scope> <target>` (single spaces).
 */
export type KillSwitchConfirmationPhrase = `${"ENGAGE" | "RELEASE"} ${KillSwitchScope} ${string}`;

export interface SetKillSwitchRequest {
  scope: KillSwitchScope;
  target: string;
  engaged: boolean;
  /** From OPERATOR_REASON_CODES["killSwitches.set.engage" | "killSwitches.set.release"], optionally `:<incident id>`. */
  reason: OperatorReason;
  confirmationPhrase: KillSwitchConfirmationPhrase;
}

export interface SetKillSwitchResponse {
  switch: KillSwitchView;
  auditEventId: OpaqueId;
  safetyRoutesPreserved: true;
}

/* ------------------------------------------------------------------------ */
/* Audit search                                                              */
/* ------------------------------------------------------------------------ */

/** Metadata filters only (platform/src/audit/ports.ts AuditQuery). Free-text search does not exist. */
export interface AuditSearchQuery {
  correlationId?: OpaqueId;
  callId?: OpaqueId;
  action?: string;
  from?: IsoDateTime;
  to?: IsoDateTime;
  limit: number;
}

export interface AuditEventMetadata {
  eventId: OpaqueId;
  occurredAt: IsoDateTime;
  correlationId: OpaqueId;
  parentId: OpaqueId | null;
  actorRef: OpaqueId | null;
  subjectRef: OpaqueId | null;
  role: string | null;
  sourceComponent: AuditSourceComponent;
  callId: OpaqueId | null;
  sessionGeneration: number | null;
  action: string;
  outcome: AuditOutcome;
  reasonCode: ReasonCode | null;
  policyDecision: { decisionId: OpaqueId; allow: boolean; reasonCodes: ReasonCode[]; policyVersion: string } | null;
  assurance: Assurance | null;
  dataClass: DataClass;
  /** Count only: evidence pointers need their own permission check. */
  evidencePointerCount: number;
  sourceStream: string;
  sequence: number;
  hash: string;
}

export interface AuditSearchResponse {
  events: AuditEventMetadata[];
  /** The search itself is recorded as an audit event. */
  searchAuditEventId: OpaqueId;
  limit: number;
}

/* ------------------------------------------------------------------------ */
/* Destinations                                                              */
/* ------------------------------------------------------------------------ */

export interface DestinationView {
  destinationId: string;
  purpose: DestinationPurpose;
  fallbackDestinationIds: string[];
  languages: string[];
  /** False while the vendor queue reference is a placeholder pending Talkdesk exports. */
  vendorQueueConfigured: boolean;
}

export interface DestinationsResponse {
  destinations: DestinationView[];
  source: "trusted_configuration";
}

/* ------------------------------------------------------------------------ */
/* Endpoint type map                                                         */
/* ------------------------------------------------------------------------ */

type NoBody = undefined;
type NoQuery = undefined;

/** Request and response types for every endpoint. Path params: `PathParams<K>`. */
export interface ConsoleEndpointTypes {
  "auth.config": { query: NoQuery; body: NoBody; response: AuthConfigResponse };
  "auth.localStaff": { query: NoQuery; body: NoBody; response: LocalStaffResponse };
  "auth.localToken": { query: NoQuery; body: LocalTokenRequest; response: TokenResponse };
  "auth.oidcExchange": { query: NoQuery; body: OidcExchangeRequest; response: TokenResponse };
  "auth.logout": { query: NoQuery; body: NoBody; response: { loggedOut: true } };
  me: { query: NoQuery; body: NoBody; response: MeResponse };
  overview: { query: NoQuery; body: NoBody; response: OverviewResponse };
  "calls.list": { query: CallsListQuery; body: NoBody; response: CallsListResponse };
  "calls.get": { query: NoQuery; body: NoBody; response: CallDetailResponse };
  "calls.transfer": { query: NoQuery; body: TransferRequest; response: TransferResponse };
  "supportRequests.trace": { query: NoQuery; body: NoBody; response: SupportTraceResponse };
  "supportRequests.repair": { query: NoQuery; body: SupportRepairRequest; response: SupportRepairResponse };
  "actions.pending": { query: NoQuery; body: NoBody; response: PendingActionsResponse };
  "actions.cancel": { query: NoQuery; body: CancelActionRequest; response: CancelActionResponse };
  "reconciliation.list": { query: NoQuery; body: NoBody; response: ReconciliationResponse };
  "reconciliation.reconcile": { query: NoQuery; body: ReconcileRequest; response: ReconcileResponse };
  "reconciliation.retry": { query: NoQuery; body: RetryRequest; response: RetryResponse };
  "outbox.requeue": { query: NoQuery; body: RequeueRequest; response: RequeueResponse };
  "workflows.tasks": { query: NoQuery; body: NoBody; response: WorkflowTasksResponse };
  "workflows.decision": { query: NoQuery; body: WorkflowDecisionRequest; response: WorkflowDecisionResponse };
  "safetyEvents.list": { query: NoQuery; body: NoBody; response: SafetyEventsResponse };
  "releases.list": { query: NoQuery; body: NoBody; response: ReleasesResponse };
  "releases.review": { query: NoQuery; body: ReleaseReviewRequest; response: ReleaseReviewResponse };
  "budgets.list": { query: NoQuery; body: NoBody; response: BudgetsResponse };
  "killSwitches.list": { query: NoQuery; body: NoBody; response: KillSwitchesResponse };
  "killSwitches.set": { query: NoQuery; body: SetKillSwitchRequest; response: SetKillSwitchResponse };
  "audit.search": { query: AuditSearchQuery; body: NoBody; response: AuditSearchResponse };
  "destinations.list": { query: NoQuery; body: NoBody; response: DestinationsResponse };
}
