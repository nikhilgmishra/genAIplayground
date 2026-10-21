/**
 * Operations and incident control console API, v1 (spec sections 7, 12, 13, 16).
 *
 * `registerConsoleApi(app, deps)` registers every endpoint of contract.ts under
 * CONSOLE_API_BASE. Per request, in order:
 *   1. workforce authentication: an opaque console session (live SSO or dual-controlled recovery:
 *      revocation, rotation replay, absolute AND idle expiry, IdP active-state check; sso.ts) or,
 *      in local/ci only, a LOCAL FIXTURE bearer JWT (MFA amr, staff directory, revocation)
 *   2. ENDPOINT_ROLES (contract)                                   -> 403
 *   3. strict path / query / body validation (zod)                 -> 400
 *   4. console policy decision(s), deny by default (OPA)           -> 403
 *   5. Idempotency-Key for confirmed mutations (first result wins)
 *   6. the handler, with finer per-scope / per-task / per-release rules
 *   7. strict response validation: nothing outside the contract is ever sent
 * Every mutation writes a console audit event in the same transaction as its
 * effect where the effect is console-owned PostgreSQL state; effects owned by
 * other modules are audited in-transaction by that module (kill switches,
 * ledger cancel/reconcile, outbox requeue, human tasks) and the console adds a
 * write-ahead intent event that must succeed before anything is attempted
 * (fail closed, OPS-01). Sensitive reads are audited before data is returned.
 * Denials are audited best-effort; the denial stands either way.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditEventInput, CommitReceipt, StaffActor, StaffRole } from "../protocol/index.js";
import { PgAuditQuery } from "../audit/query.js";
import { CONSOLE_LOCAL_SIGN_IN_COMPONENT, WORKFORCE_IDP_ADAPTER_KEY } from "../config/guard.js";
import { killSwitchBlock } from "../ops/kill-switches.js";
import { humanInterventionSignal } from "../safety/detector.js";
import { AccessDeniedError, ConfigurationRejectedError, ConflictError, PlatformError } from "../shared/errors.js";
import { digestOf } from "../shared/canonical.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { WorkflowRecheckDeniedError } from "../workflows/engine.js";
import {
  CONSOLE_API_BASE,
  CONSOLE_API_VERSION,
  CONSOLE_ENDPOINTS,
  GLOBAL_KILL_SWITCH_SCOPES,
  IDEMPOTENCY_HEADER,
  KILL_SWITCH_SCOPE_ROLES,
  OPERATOR_REASON_CODES,
  PUBLIC_ENDPOINTS,
  RELEASE_REVIEW_ROLES,
  STAFF_ROLES,
} from "./contract.js";
import type * as C from "./contract.js";
import type { AuthenticatedEndpointKey, EndpointKey, PathParamName } from "./contract.js";
import { isOfflineEnvironment, normalizeRoles } from "./auth.js";
import type { ConsoleIdentity, PolicyCheck } from "./authorize.js";
import { authorize, defaultChecks, hasEndpointRole } from "./authorize.js";
import { activeGrant } from "./break-glass.js";
import { PgBreakGlassIssuance } from "./break-glass-issuance.js";
import type { ConsoleApiDeps } from "./deps.js";
import { ConsoleHttpError, badRequest, conflict, errorBody, forbidden, notFound, toHttpError, unauthenticated, unavailable } from "./errors.js";
import {
  ACTIVE_CALL_WINDOW_HOURS,
  ConsoleAuditReader,
  QUEUE_AGE_ELEVATED_SECONDS,
  buildTimeline,
  latestVersions,
  pendingActionRow,
  pendingActionRows,
  queueIdFor,
  recentSafetyRows,
  safetyEventViews,
  safetyRowsForCalls,
  summarizeCall,
} from "./read-models.js";
import { workforceDisplayLabel } from "./oidc-staff-directory.js";
import { exchangeCode, oidcClientView, recoveryActivate, recoveryChallenge, refreshSession, sessionPolicyView, startSignIn } from "./routes/auth/workforce-auth.js";
import { BREAK_GLASS_MAX_DURATION_SECONDS, ENDPOINT_SCHEMAS, IdempotencyKeyS, PATH_PARAM_SCHEMAS } from "./schemas.js";
import { isConsoleSessionHeader } from "./sso.js";
import type { SsoIdentity } from "./sso.js";
import {
  ConsoleIdempotencyStore,
  ConsoleReconciliationStore,
  ConsoleSessionRevocations,
  ReleaseSubmissionRegistryPg,
  auditActionFor,
  consoleAuditInput,
  consoleTx,
  requestDigest,
} from "./stores.js";
import type { IdempotencyScope } from "./stores.js";

/** Runtime component keys reported to the configuration guard (GuardContext.adapterKinds). */
export { CONSOLE_LOCAL_SIGN_IN_COMPONENT, WORKFORCE_IDP_ADAPTER_KEY as WORKFORCE_IDP_COMPONENT } from "../config/guard.js";

const PUBLIC: ReadonlySet<string> = new Set(PUBLIC_ENDPOINTS);
const SENSITIVE_READ_REASON = "SENSITIVE_VIEW_READ";
/** A NOT_FOUND reconciliation older than this must be repeated before a retry. */
export const RETRY_RECONCILIATION_MAX_AGE_MS = 10 * 60_000;
const SAFETY_EVENTS_WINDOW_MS = 7 * 24 * 3_600_000;
const BODY_LIMIT_BYTES = 8 * 1024;
/** Maximum of a break-glass grant: defined once in schemas.ts and pinned to policy data and migration 2051 by a test. */
export { BREAK_GLASS_MAX_DURATION_SECONDS };

/** Kinds of the components the console instantiated, for the configuration guard. */
export function consoleRuntimeComponents(deps: Pick<ConsoleApiDeps, "auth">): Record<string, "local_fixture" | "live"> {
  const sso = deps.auth.sso ?? null;
  const idp = sso ? (sso.service.kind === "live" && deps.auth.verifier.kind === "live" ? "live" : "local_fixture") : deps.auth.verifier.kind;
  const out: Record<string, "local_fixture" | "live"> = { [WORKFORCE_IDP_ADAPTER_KEY]: idp };
  if (deps.auth.localSignIn) out[CONSOLE_LOCAL_SIGN_IN_COMPONENT] = "local_fixture";
  return out;
}

/** Fails closed at startup: local fixture identity components never run outside local/ci (OPS-04). */
export function assertConsoleDeps(deps: ConsoleApiDeps): void {
  const violations: string[] = [];
  const offline = isOfflineEnvironment(deps.environment);
  if (deps.auth.localSignIn && !offline) violations.push("CONSOLE_LOCAL_SIGN_IN_OUTSIDE_OFFLINE@console.localSignIn");
  if (deps.auth.verifier.kind === "local_fixture" && !offline) violations.push("WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE@console.auth.verifier");
  if (deps.auth.staffDirectory.kind === "local_fixture" && !offline) violations.push("WORKFORCE_DIRECTORY_LOCAL_FIXTURE_OUTSIDE_OFFLINE@console.auth.staffDirectory");
  if (deps.auth.verifier.policy.allowLocalFixtureAmr && !offline) violations.push("WORKFORCE_FIXTURE_AMR_OUTSIDE_OFFLINE@console.auth.verifier");
  const sso = deps.auth.sso ?? null;
  // Outside local/ci the console only accepts server-side SSO sessions (idle + absolute expiry, FO-05-18).
  if (!sso && !offline) violations.push("WORKFORCE_SSO_NOT_CONFIGURED@console.auth.sso");
  if (sso && sso.service.kind === "local_fixture" && !offline) violations.push("WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE@console.auth.sso");
  if (sso && sso.config !== sso.service.config) violations.push("WORKFORCE_SSO_CONFIG_MISMATCH@console.auth.sso");
  if (deps.auth.recovery && !sso) violations.push("RECOVERY_WITHOUT_SSO@console.auth.recovery");
  if (violations.length > 0) throw new ConfigurationRejectedError(violations);
}

/* ------------------------------------------------------------------------ */
/* Request context                                                           */
/* ------------------------------------------------------------------------ */

interface Ctx {
  key: EndpointKey;
  correlationId: string;
  now: Date;
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  identity: ConsoleIdentity | null;
  role: StaffRole | null;
  idempotencyKey: string | null;
}

interface AuthedCtx extends Ctx {
  identity: ConsoleIdentity;
  role: StaffRole;
  /** Decision of the endpoint-level policy check. */
  decision: { decisionId: string; allow: boolean; reasonCodes: string[]; policyVersion: string };
}

interface RouteDef {
  /** Policy checks (any one allowing suffices); default: ENDPOINT_POLICY_ACTIONS. */
  checks?: (ctx: AuthedCtx) => Promise<PolicyCheck[]> | PolicyCheck[];
  handle: (ctx: AuthedCtx) => Promise<unknown>;
  /** Mutations are idempotent per Idempotency-Key (default: every authenticated POST except logout). */
  idempotent?: boolean;
}

interface PublicRouteDef {
  handle: (ctx: Ctx, req: FastifyRequest) => Promise<unknown>;
}

const relativePath = (path: string): string => path.slice(CONSOLE_API_BASE.length);
const pathParamNames = (path: string): PathParamName[] => [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as PathParamName);
const reasonCodeOf = (reason: string): string => reason.split(":")[0] ?? reason;

function requireAllowedReason(reason: string, allowed: readonly string[]): string {
  const code = reasonCodeOf(reason);
  if (!allowed.includes(code)) throw badRequest("REASON_NOT_ALLOWED");
  return code;
}

function staffActorOf(identity: ConsoleIdentity, now: Date): StaffActor {
  const grant = activeGrant(identity.breakGlass, identity.staffId, now);
  return {
    staffId: identity.staffId,
    roles: [...identity.roles],
    mfa: true,
    authenticatedAt: identity.authenticatedAt,
    breakGlass: grant ? { reason: grant.justificationCode, expiresAt: grant.expiresAt, approvedBy: grant.approvedBy } : null,
  };
}

/* ------------------------------------------------------------------------ */
/* Plugin                                                                    */
/* ------------------------------------------------------------------------ */

export async function registerConsoleApi(app: FastifyInstance, deps: ConsoleApiDeps): Promise<void> {
  assertConsoleDeps(deps);
  await app.register(async (scope) => consoleRoutes(scope, deps), { prefix: CONSOLE_API_BASE });
}

async function consoleRoutes(scope: FastifyInstance, deps: ConsoleApiDeps): Promise<void> {
  const log = deps.logger.child({ component: "console_api" });
  const reader = new ConsoleAuditReader(deps.db);
  const idempotency = new ConsoleIdempotencyStore(deps.db);
  const revocations = new ConsoleSessionRevocations(deps.db);
  const releases = new ReleaseSubmissionRegistryPg(deps.db);
  const reconciliations = new ConsoleReconciliationStore(deps.db);
  const auditorQuery = new PgAuditQuery(deps.db, "app_auditor");
  const sso = deps.auth.sso ?? null;
  const recovery = deps.auth.recovery ?? null;
  const issuance = deps.auth.breakGlassIssuance ?? new PgBreakGlassIssuance(deps.db, deps.audit, BREAK_GLASS_MAX_DURATION_SECONDS);
  const offline = isOfflineEnvironment(deps.environment);

  const sendError = (reply: FastifyReply, err: ConsoleHttpError, correlationId: string | null): FastifyReply =>
    reply.code(err.status).type("application/json; charset=utf-8").send(errorBody(err, correlationId));

  scope.addHook("onSend", async (_req, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  scope.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    const mapped =
      err instanceof ConsoleHttpError || err instanceof PlatformError
        ? toHttpError(err)
        : status === 413
          ? new ConsoleHttpError(413, "PAYLOAD_TOO_LARGE")
          : status === 415
            ? new ConsoleHttpError(415, "UNSUPPORTED_MEDIA_TYPE")
            : status >= 400 && status < 500
              ? new ConsoleHttpError(400, "VALIDATION_FAILED")
              : new ConsoleHttpError(500, "INTERNAL_ERROR");
    if (mapped.status >= 500) log.error("console.request.failed", { reasonCode: mapped.reasonCode });
    return sendError(reply, mapped, null);
  });

  scope.setNotFoundHandler((req, reply) => {
    // Local fixture sign-in routes are not registered outside local/ci (OPS-04).
    const local = /^\/console\/api\/v1\/auth\/local(\/|$)/.test(req.url.split("?")[0] ?? "");
    return sendError(reply, notFound(local ? "LOCAL_FIXTURE_DISABLED" : "NOT_FOUND"), null);
  });

  /* ---------------- helpers bound to deps ---------------- */

  /** Console session (SSO or recovery) -> identity; roles come from the session (refreshed by the IdP active-state check). */
  const identityFromSession = async (s: SsoIdentity, now: Date): Promise<ConsoleIdentity> => {
    const roles = normalizeRoles(s.roles);
    if (roles.length === 0) throw unauthenticated("STAFF_NOT_PROVISIONED");
    const breakGlass = await deps.auth.breakGlass.grantFor(s.tenantId, s.staffId, now);
    if (breakGlass && breakGlass.approvedBy === s.staffId) log.warn("console.break_glass.self_granted_record", { staffId: s.staffId, grantId: breakGlass.grantId, reasonCode: "BREAK_GLASS_SELF_GRANTED" });
    return {
      staffId: s.staffId,
      tenantId: s.tenantId,
      displayLabel: workforceDisplayLabel(s.staffId, roles),
      roles,
      mfa: true,
      authenticatedAt: iso(s.authenticatedAt),
      sessionExpiresAt: iso(s.sessionExpiresAt),
      jtiHash: s.sessionHash,
      localFixture: false,
      breakGlass,
      session: { kind: s.kind, familyId: s.familyId, sessionHash: s.sessionHash, idleTimeoutSeconds: s.idleTimeoutSeconds },
    };
  };

  const authenticate = async (req: FastifyRequest, now: Date): Promise<ConsoleIdentity> => {
    const header = req.headers.authorization;
    if (sso && isConsoleSessionHeader(header)) return identityFromSession(await sso.service.authenticate(header), now);
    // Outside local/ci only console sessions are accepted: a raw IdP token has no server-side idle expiry.
    if (!offline) throw unauthenticated("UNAUTHENTICATED");
    const token = await deps.auth.verifier.verifyAuthorizationHeader(header);
    const staff = await deps.auth.staffDirectory.resolve({ issuer: token.issuer, subject: token.subject });
    if (!staff || !staff.active) throw unauthenticated("STAFF_NOT_PROVISIONED");
    const roles = normalizeRoles(staff.roles);
    if (roles.length === 0) throw unauthenticated("STAFF_NOT_PROVISIONED");
    if (await revocations.isRevoked(staff.tenantId, staff.staffId, token.jtiHash)) throw unauthenticated("SESSION_REVOKED");
    const breakGlass = await deps.auth.breakGlass.grantFor(staff.tenantId, staff.staffId, now);
    if (breakGlass && breakGlass.approvedBy === staff.staffId) log.warn("console.break_glass.self_granted_record", { staffId: staff.staffId, grantId: breakGlass.grantId, reasonCode: "BREAK_GLASS_SELF_GRANTED" });
    return {
      staffId: staff.staffId,
      tenantId: staff.tenantId,
      displayLabel: staff.displayLabel,
      roles,
      mfa: true,
      authenticatedAt: token.authenticatedAt.toISOString(),
      sessionExpiresAt: token.expiresAt.toISOString(),
      jtiHash: token.jtiHash,
      localFixture: token.localFixture,
      breakGlass,
      session: { kind: token.localFixture ? "LOCAL_FIXTURE" : "OIDC_SSO", familyId: null, sessionHash: null, idleTimeoutSeconds: null },
    };
  };

  const auditInput = (ctx: Ctx, f: Partial<Parameters<typeof consoleAuditInput>[0]> & { outcome: AuditEventInput["outcome"]; reasonCode: string | null }): AuditEventInput =>
    consoleAuditInput({
      tenantId: ctx.identity?.tenantId ?? "",
      correlationId: ctx.correlationId,
      staffId: ctx.identity?.staffId ?? null,
      role: ctx.role,
      action: auditActionFor(ctx.key),
      occurredAt: ctx.now,
      ...f,
    });

  /** Standalone console audit event that MUST be written (fail closed: AUDIT_UNAVAILABLE). */
  const auditRequired = async (ctx: AuthedCtx, f: Parameters<typeof auditInput>[1]): Promise<string> => {
    try {
      const ev = await deps.audit.appendStandalone(auditInput(ctx, { policyDecision: ctx.decision, ...f }));
      return ev.eventId;
    } catch (err) {
      log.error("console.audit.unavailable", { action: auditActionFor(ctx.key), reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE", correlationId: ctx.correlationId });
      throw new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
    }
  };

  /** Best-effort audit (denials, completion records): never changes the outcome. */
  const auditBestEffort = async (ctx: Ctx, f: Parameters<typeof auditInput>[1]): Promise<string | null> => {
    if (!ctx.identity) return null;
    try {
      return (await deps.audit.appendStandalone(auditInput(ctx, f))).eventId;
    } catch (err) {
      log.warn("console.audit.best_effort_failed", { action: auditActionFor(ctx.key), reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE", correlationId: ctx.correlationId });
      return null;
    }
  };

  const deny = async (ctx: Ctx, err: ConsoleHttpError, decision?: AuthedCtx["decision"] | null): Promise<never> => {
    await auditBestEffort(ctx, { outcome: "DENIED", reasonCode: err.reasonCode, policyDecision: decision ?? null });
    throw err;
  };

  const authorizeOrDeny = async (ctx: AuthedCtx, checks: PolicyCheck[]): Promise<AuthedCtx["decision"]> => {
    const out = await authorize(deps.policy, ctx.identity, checks, { environment: deps.environment, now: ctx.now });
    const d = { decisionId: out.decision.decisionId, allow: out.decision.allow, reasonCodes: [...out.decision.reasonCodes], policyVersion: out.decision.policyVersion };
    if (!out.allowed) return deny(ctx, forbidden(out.reasonCode ?? "STAFF_ROLE_NOT_PERMITTED"), d);
    // BREAK_GLASS_REVIEW obligation: the use of the grant opens its post-use access review (fail closed).
    if (out.decision.obligations.includes("BREAK_GLASS_REVIEW")) {
      const grant = activeGrant(ctx.identity.breakGlass, ctx.identity.staffId, ctx.now);
      if (!grant) return deny(ctx, forbidden("STAFF_BREAK_GLASS_REQUIRED"), d);
      await recordEmergencyUse(ctx, d, { subjectKind: "BREAK_GLASS_GRANT", subjectRef: grant.grantId, approverId: grant.approvedBy });
    }
    return d;
  };

  /**
   * Post-use access review of emergency access (FO-05-45): the first use of a break-glass grant opens the
   * review in the same transaction as the use's audit event (idempotent per grant). When that cannot be
   * recorded the access is refused (fail closed, OPS-01).
   */
  const recordEmergencyUse = async (
    ctx: AuthedCtx,
    decision: AuthedCtx["decision"],
    subject: { subjectKind: C.AccessReviewSubject; subjectRef: string; approverId: string | null },
  ): Promise<void> => {
    const grantUse = subject.subjectKind === "BREAK_GLASS_GRANT";
    try {
      await issuance.recordUse({
        tenantId: ctx.identity.tenantId,
        holderId: ctx.identity.staffId,
        approverId: subject.approverId,
        subjectKind: subject.subjectKind,
        subjectRef: subject.subjectRef,
        now: ctx.now,
        audit: auditInput(ctx, {
          action: grantUse ? "console.break_glass.first_use" : "console.recovery.first_use",
          outcome: "SUCCEEDED",
          reasonCode: grantUse ? "BREAK_GLASS_USED" : "RECOVERY_SESSION_USED",
          policyDecision: decision,
          evidencePointers: [`${grantUse ? "break_glass_grant" : "recovery_session"}:${subject.subjectRef}`],
        }),
      });
    } catch (err) {
      log.error("console.access_review.unavailable", { action: auditActionFor(ctx.key), reasonCode: err instanceof PlatformError ? err.reasonCode : "ACCESS_REVIEW_UNAVAILABLE", correlationId: ctx.correlationId });
      throw new ConsoleHttpError(503, "ACCESS_REVIEW_UNAVAILABLE", true);
    }
  };

  const parseInputs = (key: EndpointKey, req: FastifyRequest): { params: Record<string, string>; query: unknown; body: unknown } => {
    const spec = CONSOLE_ENDPOINTS[key];
    const schemas = ENDPOINT_SCHEMAS[key];
    const params: Record<string, string> = {};
    const rawParams = (req.params ?? {}) as Record<string, unknown>;
    for (const name of pathParamNames(spec.path)) {
      const p = PATH_PARAM_SCHEMAS[name].safeParse(rawParams[name]);
      if (!p.success) throw badRequest("VALIDATION_FAILED");
      params[name] = p.data;
    }
    const rawQuery = (req.query ?? {}) as Record<string, unknown>;
    let query: unknown = undefined;
    if (schemas.query) {
      const q = schemas.query.safeParse(rawQuery);
      if (!q.success) throw badRequest("VALIDATION_FAILED");
      query = q.data;
    } else if (Object.keys(rawQuery).length > 0) throw badRequest("VALIDATION_FAILED");
    let body: unknown = undefined;
    if (spec.method === "POST") {
      const raw = req.body === undefined || req.body === null ? {} : req.body;
      if (schemas.body) {
        const b = schemas.body.safeParse(raw);
        if (!b.success) {
          const reasonIssue = b.error.issues.some((i) => i.path[0] === "reason");
          throw badRequest(reasonIssue ? "REASON_NOT_ALLOWED" : "VALIDATION_FAILED");
        }
        body = b.data;
      } else if (!z.strictObject({}).safeParse(raw).success) throw badRequest("VALIDATION_FAILED");
    }
    return { params, query, body };
  };

  const respond = (key: EndpointKey, payload: unknown): unknown => {
    const parsed = ENDPOINT_SCHEMAS[key].response.safeParse(payload);
    if (!parsed.success) {
      // Never send anything outside the contract (content-free guarantee).
      log.error("console.response.schema_violation", { action: auditActionFor(key), reasonCode: "RESPONSE_SCHEMA_VIOLATION" });
      throw new ConsoleHttpError(500, "RESPONSE_SCHEMA_VIOLATION");
    }
    return parsed.data;
  };

  const publicRoute = (key: EndpointKey, def: PublicRouteDef): void => mount(key, def);
  const register = (key: AuthenticatedEndpointKey, def: RouteDef): void => mount(key, def);

  const mount = (key: EndpointKey, def: RouteDef | PublicRouteDef): void => {
    const spec = CONSOLE_ENDPOINTS[key];
    const isPublic = PUBLIC.has(key);
    scope.route({
      method: spec.method,
      url: relativePath(spec.path),
      bodyLimit: BODY_LIMIT_BYTES,
      handler: async (req, reply) => {
        const ctx: Ctx = { key, correlationId: newId("cor"), now: deps.clock.now(), params: {}, query: undefined, body: undefined, identity: null, role: null, idempotencyKey: null };
        let idemScope: IdempotencyScope | null = null;
        try {
          if (isPublic) {
            Object.assign(ctx, parseInputs(key, req));
            const out = respond(key, await (def as PublicRouteDef).handle(ctx, req));
            return reply.code(200).type("application/json; charset=utf-8").send(out);
          }
          const route = def as RouteDef;
          ctx.identity = await authenticate(req, ctx.now);
          const role = hasEndpointRole(key as AuthenticatedEndpointKey, ctx.identity.roles);
          if (!role) await deny(ctx, forbidden("STAFF_ROLE_NOT_PERMITTED"));
          ctx.role = role;
          Object.assign(ctx, parseInputs(key, req));
          const authed = ctx as AuthedCtx;
          const checks = route.checks ? await route.checks(authed) : defaultChecks(key as AuthenticatedEndpointKey, authed.identity.tenantId);
          // A recovery session's access review is opened at activation (recovery.ts), before any use.
          authed.decision = await authorizeOrDeny(authed, checks);

          const idempotent = route.idempotent ?? (spec.method === "POST" && key !== "auth.logout");
          if (idempotent) {
            const header = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
            const parsedKey = IdempotencyKeyS.safeParse(header);
            if (!parsedKey.success) throw badRequest(header === undefined ? "IDEMPOTENCY_KEY_REQUIRED" : "IDEMPOTENCY_KEY_INVALID");
            authed.idempotencyKey = parsedKey.data;
            const s: IdempotencyScope = {
              tenantId: authed.identity.tenantId,
              staffId: authed.identity.staffId,
              endpoint: key,
              key: parsedKey.data,
              requestDigest: requestDigest(key, authed.params, authed.body),
            };
            const prior = await idempotency.begin(s, authed.now);
            if (prior.kind === "replay") return reply.code(prior.status).type("application/json; charset=utf-8").send(respond(key, prior.body));
            if (prior.kind === "in_progress") throw conflict("IDEMPOTENCY_IN_PROGRESS", true);
            if (prior.kind === "mismatch") throw conflict("IDEMPOTENCY_KEY_REUSED");
            idemScope = s;
          }
          const out = respond(key, await route.handle(authed));
          if (idemScope) {
            try {
              await idempotency.complete(idemScope, 200, out);
            } catch {
              log.warn("console.idempotency.complete_failed", { action: auditActionFor(key), correlationId: ctx.correlationId, reasonCode: "IDEMPOTENCY_RECORD_FAILED" });
            }
            idemScope = null;
          }
          log.info("console.request.completed", { action: auditActionFor(key), status: 200, staffId: ctx.identity.staffId, correlationId: ctx.correlationId });
          return reply.code(200).type("application/json; charset=utf-8").send(out);
        } catch (err) {
          if (idemScope) await idempotency.release(idemScope).catch(() => undefined);
          const e = toHttpError(err);
          if (e.status >= 500) log.error("console.request.failed", { action: auditActionFor(key), status: e.status, reasonCode: e.reasonCode, correlationId: ctx.correlationId });
          else log.info("console.request.refused", { action: auditActionFor(key), status: e.status, reasonCode: e.reasonCode, correlationId: ctx.correlationId });
          return sendError(reply, e, ctx.correlationId);
        }
      },
    });
  };

  /* ---------------- authentication ---------------- */

  publicRoute("auth.config", {
    handle: async (): Promise<C.AuthConfigResponse> => {
      // Availability only; a failed lookup reports "not available" (the activation path re-checks).
      const recoveryAvailable = recovery ? await recovery.anyActive().catch(() => false) : false;
      return {
        apiVersion: CONSOLE_API_VERSION,
        environment: deps.environment,
        localFixture: deps.localFixture,
        mode: deps.auth.localSignIn && !sso ? "local_fixture" : "oidc_workforce",
        oidc: await oidcClientView(sso, deps.auth.oidc),
        sessionPolicy: sessionPolicyView(sso),
        recoveryAvailable,
      };
    },
  });

  if (deps.auth.localSignIn && isOfflineEnvironment(deps.environment)) {
    const local = deps.auth.localSignIn;
    publicRoute("auth.localStaff", {
      handle: async (): Promise<C.LocalStaffResponse> => ({ label: "LOCAL DEV SIGN-IN (synthetic staff)", staff: local.staff() }),
    });
    publicRoute("auth.localToken", {
      handle: async (ctx): Promise<C.TokenResponse> => {
        const { staffId } = ctx.body as C.LocalTokenRequest;
        const issued = await local.issueToken(staffId);
        if (!issued) throw notFound("NOT_FOUND");
        // The issued token goes through the same verification as every request.
        const verified = await deps.auth.verifier.verify(issued.accessToken);
        const staff = await deps.auth.staffDirectory.resolve({ issuer: verified.issuer, subject: verified.subject });
        if (!staff) throw notFound("NOT_FOUND");
        try {
          await deps.audit.appendStandalone(
            consoleAuditInput({
              tenantId: staff.tenantId,
              correlationId: ctx.correlationId,
              staffId: staff.staffId,
              role: normalizeRoles(staff.roles)[0] ?? null,
              action: auditActionFor("auth.localToken"),
              outcome: "SUCCEEDED",
              reasonCode: "LOCAL_FIXTURE_SIGN_IN",
              occurredAt: ctx.now,
            }),
          );
        } catch {
          throw new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
        }
        return { accessToken: issued.accessToken, tokenType: "Bearer", expiresAt: issued.expiresAt.toISOString(), localFixture: true, sessionKind: "LOCAL_FIXTURE", idleTimeoutSeconds: null };
      },
    });
  }

  /* Workforce SSO (routes/auth/workforce-auth.ts); 503 OIDC_NOT_CONFIGURED without a live SSO client. */
  publicRoute("auth.oidcStart", { handle: async (ctx) => startSignIn(sso, ctx.body as C.OidcStartRequest) });
  publicRoute("auth.oidcExchange", { handle: async (ctx) => exchangeCode(sso, ctx.body as C.OidcExchangeRequest, ctx.correlationId) });
  publicRoute("auth.refresh", { handle: async (ctx, req) => refreshSession(sso, req.headers.authorization, ctx.correlationId) });
  /* Dual-controlled SSO-outage recovery (recovery.ts); 503 RECOVERY_NOT_CONFIGURED when not set up. */
  publicRoute("auth.recoveryChallenge", { handle: async (ctx) => recoveryChallenge(recovery, ctx.body as C.RecoveryChallengeRequest, ctx.correlationId) });
  publicRoute("auth.recoveryActivate", { handle: async (ctx) => recoveryActivate(recovery, ctx.body as C.RecoveryActivateRequest, ctx.correlationId) });

  register("auth.logout", {
    handle: async (ctx) => {
      const session = ctx.identity.session;
      if (sso && session.familyId && session.sessionHash) {
        // Console session: the whole family is revoked; the IdP refresh token is revoked (best effort).
        await auditRequired(ctx, { outcome: "SUCCEEDED", reasonCode: "STAFF_LOGOUT" });
        await sso.service.logout({ tenantId: ctx.identity.tenantId, familyId: session.familyId, sessionHash: session.sessionHash }, ctx.now);
        return { loggedOut: true };
      }
      await revocations.revoke(deps.audit, {
        tenantId: ctx.identity.tenantId,
        staffId: ctx.identity.staffId,
        jtiHash: ctx.identity.jtiHash,
        tokenExpiresAt: ctx.identity.sessionExpiresAt,
        now: ctx.now,
        audit: auditInput(ctx, { outcome: "SUCCEEDED", reasonCode: "STAFF_LOGOUT", policyDecision: ctx.decision }),
      });
      return { loggedOut: true };
    },
  });

  register("me", {
    handle: async (ctx): Promise<C.MeResponse> => {
      const grant = activeGrant(ctx.identity.breakGlass, ctx.identity.staffId, ctx.now);
      return {
        apiVersion: CONSOLE_API_VERSION,
        staff: {
          staffId: ctx.identity.staffId,
          displayLabel: ctx.identity.displayLabel,
          roles: [...ctx.identity.roles],
          mfa: true,
          authenticatedAt: ctx.identity.authenticatedAt,
          breakGlass: grant ? { expiresAt: grant.expiresAt, approvedBy: grant.approvedBy, justificationCode: grant.justificationCode } : null,
        },
        tenantId: ctx.identity.tenantId,
        environment: deps.environment,
        localFixture: deps.localFixture || ctx.identity.localFixture,
        sessionExpiresAt: ctx.identity.sessionExpiresAt,
        sessionKind: ctx.identity.session.kind,
        idleTimeoutSeconds: ctx.identity.session.idleTimeoutSeconds,
      };
    },
  });

  /* ---------------- break-glass issuance and access reviews (break-glass-issuance.ts) ---------------- */

  register("breakGlass.list", {
    handle: async (ctx): Promise<C.BreakGlassRequestsResponse> => ({
      requests: await issuance.list(ctx.identity.tenantId, ctx.identity.staffId, ctx.now, ctx.identity.roles.includes("security_admin")),
    }),
  });

  register("breakGlass.request", {
    handle: async (ctx): Promise<C.BreakGlassDecisionResponse> => {
      const body = ctx.body as C.BreakGlassRequestCreate;
      requireAllowedReason(body.reason, OPERATOR_REASON_CODES["breakGlass.request"]);
      const request = await issuance.request({
        tenantId: ctx.identity.tenantId,
        staffId: ctx.identity.staffId,
        body,
        now: ctx.now,
        audit: auditInput(ctx, { outcome: "PENDING", reasonCode: body.justificationCode, policyDecision: ctx.decision, idempotencyKey: ctx.idempotencyKey }),
      });
      return { request };
    },
  });

  register("breakGlass.decide", {
    // Never self-approved: the policy refuses a decision by the requester (forbidSelfInitiated), and so do
    // the service and the database (CHECK + RLS).
    checks: async (ctx) => {
      // A never-self action needs the record's initiator: an unknown record is refused like an unauthorized
      // one (INITIATOR_REQUIRED), so the endpoint is no existence oracle.
      const request = await issuance.get(ctx.identity.tenantId, ctx.identity.staffId, ctx.params.requestId as string, ctx.now);
      return [{ action: "break_glass:approve", resource: { type: "break_glass_request", tenantId: ctx.identity.tenantId, initiatorStaffId: request?.requestedBy ?? null } }];
    },
    handle: async (ctx): Promise<C.BreakGlassDecisionResponse> => {
      const body = ctx.body as C.BreakGlassDecisionRequest;
      requireAllowedReason(body.reason, OPERATOR_REASON_CODES["breakGlass.decide"]);
      const request = await issuance.decide({
        tenantId: ctx.identity.tenantId,
        deciderId: ctx.identity.staffId,
        requestId: ctx.params.requestId as string,
        body,
        now: ctx.now,
        audit: auditInput(ctx, {
          outcome: "SUCCEEDED",
          reasonCode: body.decision === "APPROVE" ? "BREAK_GLASS_APPROVED" : "BREAK_GLASS_REJECTED",
          policyDecision: ctx.decision,
          idempotencyKey: ctx.idempotencyKey,
          evidencePointers: [`break_glass_request:${ctx.params.requestId as string}`],
        }),
      });
      return { request };
    },
  });

  register("accessReviews.list", {
    handle: async (ctx): Promise<C.AccessReviewsResponse> => ({ reviews: await issuance.listReviews(ctx.identity.tenantId, ctx.identity.staffId) }),
  });

  register("accessReviews.complete", {
    checks: async (ctx) => {
      const review = await issuance.getReview(ctx.identity.tenantId, ctx.identity.staffId, ctx.params.reviewId as string);
      return [{ action: "access_review:perform", resource: { type: "access_review", tenantId: ctx.identity.tenantId, initiatorStaffId: review?.holderStaffId ?? null } }];
    },
    handle: async (ctx): Promise<C.AccessReviewCompleteResponse> => {
      const body = ctx.body as C.AccessReviewCompleteRequest;
      requireAllowedReason(body.reason, OPERATOR_REASON_CODES["accessReviews.complete"]);
      const review = await issuance.completeReview({
        tenantId: ctx.identity.tenantId,
        reviewerId: ctx.identity.staffId,
        reviewId: ctx.params.reviewId as string,
        body,
        now: ctx.now,
        audit: auditInput(ctx, {
          outcome: "SUCCEEDED",
          reasonCode: `ACCESS_REVIEW_${body.outcome}`,
          policyDecision: ctx.decision,
          idempotencyKey: ctx.idempotencyKey,
          evidencePointers: [`access_review:${ctx.params.reviewId as string}`],
        }),
      });
      return { review };
    },
  });

  /* ---------------- dual-controlled recovery identities (recovery.ts) ---------------- */

  const requireRecovery = () => {
    if (!recovery) throw unavailable("RECOVERY_NOT_CONFIGURED", false);
    return recovery;
  };

  register("recoveryIdentities.list", {
    handle: async (ctx): Promise<C.RecoveryIdentitiesResponse> => ({ identities: await requireRecovery().list(ctx.identity.staffId) }),
  });

  register("recoveryIdentities.propose", {
    handle: async (ctx): Promise<C.RecoveryIdentityProposeResponse> => {
      const body = ctx.body as C.RecoveryIdentityProposeRequest;
      return requireRecovery().propose({
        proposerId: ctx.identity.staffId,
        body,
        now: ctx.now,
        audit: auditInput(ctx, { outcome: "PENDING", reasonCode: "RECOVERY_IDENTITY_PROPOSED", policyDecision: ctx.decision, idempotencyKey: ctx.idempotencyKey }),
      });
    },
  });

  register("recoveryIdentities.confirm", {
    // Only the holder the identity names (policy assignedStaffId), and only in an SSO session (recovery.ts).
    checks: async (ctx) => {
      const identity = recovery ? await recovery.get(ctx.identity.staffId, ctx.params.identityId as string) : null;
      return [{ action: "recovery_identity:confirm", resource: { type: "recovery_identity", tenantId: ctx.identity.tenantId, assignedStaffId: identity?.staffId ?? null } }];
    },
    handle: async (ctx): Promise<C.RecoveryIdentityResponse> => {
      const body = ctx.body as C.RecoveryIdentityConfirmRequest;
      const session = ctx.identity.session;
      const identity = await requireRecovery().confirm({
        holder: { staffId: ctx.identity.staffId, sessionKind: session.kind, sessionHash: session.sessionHash, roles: ctx.identity.roles },
        identityId: ctx.params.identityId as string,
        signature: body.signature,
        now: ctx.now,
        audit: auditInput(ctx, {
          outcome: "SUCCEEDED",
          reasonCode: "RECOVERY_IDENTITY_HOLDER_CONFIRMED",
          policyDecision: ctx.decision,
          idempotencyKey: ctx.idempotencyKey,
          evidencePointers: [`recovery_identity:${ctx.params.identityId as string}`],
        }),
      });
      return { identity };
    },
  });

  register("recoveryIdentities.approve", {
    // Dual control: never approved by the proposer (policy forbidSelfInitiated, service and database checks).
    checks: async (ctx) => {
      const identity = recovery ? await recovery.get(ctx.identity.staffId, ctx.params.identityId as string) : null;
      return [{ action: "recovery_identity:approve", resource: { type: "recovery_identity", tenantId: ctx.identity.tenantId, initiatorStaffId: identity?.proposedBy ?? null } }];
    },
    handle: async (ctx): Promise<C.RecoveryIdentityResponse> => {
      const identity = await requireRecovery().approve({
        approverId: ctx.identity.staffId,
        identityId: ctx.params.identityId as string,
        now: ctx.now,
        audit: auditInput(ctx, {
          outcome: "SUCCEEDED",
          reasonCode: "RECOVERY_IDENTITY_APPROVED",
          policyDecision: ctx.decision,
          idempotencyKey: ctx.idempotencyKey,
          evidencePointers: [`recovery_identity:${ctx.params.identityId as string}`],
        }),
      });
      return { identity };
    },
  });

  register("recoveryIdentities.revoke", {
    handle: async (ctx): Promise<C.RecoveryIdentityResponse> => {
      const body = ctx.body as C.RecoveryIdentityRevokeRequest;
      const reason = requireAllowedReason(body.reason, OPERATOR_REASON_CODES["recoveryIdentities.revoke"]);
      const identity = await requireRecovery().revoke({
        adminId: ctx.identity.staffId,
        identityId: ctx.params.identityId as string,
        reason: body.reason,
        now: ctx.now,
        audit: auditInput(ctx, {
          outcome: "SUCCEEDED",
          reasonCode: reason,
          policyDecision: ctx.decision,
          idempotencyKey: ctx.idempotencyKey,
          evidencePointers: [`recovery_identity:${ctx.params.identityId as string}`],
        }),
      });
      return { identity };
    },
  });

  /* ---------------- calls ---------------- */

  const activeSummaries = async (ctx: AuthedCtx): Promise<C.CallSummary[]> => {
    const { tenantId, staffId } = ctx.identity;
    const since = new Date(ctx.now.getTime() - ACTIVE_CALL_WINDOW_HOURS * 3_600_000);
    const callIds = await reader.activeCallIds(tenantId, staffId, since);
    if (callIds.length === 0) return [];
    const [events, safety, journeys] = await Promise.all([
      reader.eventsForCalls(tenantId, staffId, callIds, 20_000),
      safetyRowsForCalls(deps.db, tenantId, staffId, callIds),
      deps.transfers.listActive(),
    ]);
    const mine = journeys.filter((j) => j.tenantId === tenantId);
    return callIds.map((id) => summarizeCall(id, events, safety, mine, deps.localFixture)).filter((c): c is C.CallSummary => c !== null && c.state !== "ENDED");
  };

  register("overview", {
    handle: async (ctx): Promise<C.OverviewResponse> => {
      const tenantId = ctx.identity.tenantId;
      const calls = await activeSummaries(ctx);
      const journeys = (await deps.transfers.listActive()).filter((j) => j.tenantId === tenantId);
      const queues: C.QueueHealth[] = deps.destinations.map((d) => {
        const waitingJourneys = journeys.filter((j) => j.status === "ROUTING" && j.connectedAt === null && j.attempts.at(-1)?.destinationId === d.destinationId);
        const oldest = waitingJourneys.reduce<number | null>((acc, j) => {
          const age = Math.max(0, Math.round((ctx.now.getTime() - Date.parse(j.createdAt)) / 1000));
          return acc === null || age > acc ? age : acc;
        }, null);
        const elevated = oldest !== null && oldest > QUEUE_AGE_ELEVATED_SECONDS;
        return {
          queueId: queueIdFor(d.destinationId),
          label: `${d.purpose.charAt(0)}${d.purpose.slice(1).toLowerCase().replace(/_/g, " ")} (${d.destinationId})`.slice(0, 80),
          waiting: waitingJourneys.length,
          oldestWaitSeconds: oldest,
          // Staffed-agent availability needs Talkdesk queue telemetry (TB-07 UNKNOWN): never invented.
          availableAgents: null,
          status: elevated ? "DEGRADED" : "UNKNOWN",
          source: deps.transfers.kind,
          reasonCode: elevated ? "QUEUE_AGE_ELEVATED" : "AGENT_AVAILABILITY_UNKNOWN",
        };
      });
      const snapshot = await deps.killSwitches.snapshot(tenantId);
      const switches = await deps.killSwitches.list(tenantId);
      const budgets = await budgetStatuses(ctx);
      let aiAdmission: C.OverviewResponse["aiAdmission"];
      if (killSwitchBlock(snapshot, { class: "PUBLIC", newSession: true }) === "KILL_SWITCH_AI_ADMISSION") aiAdmission = { state: "CLOSED_BY_KILL_SWITCH", reasonCode: "KILL_SWITCH_AI_ADMISSION" };
      else if (budgets.some((b) => b.exhausted)) aiAdmission = { state: "LIMITED_BY_BUDGET", reasonCode: "BUDGET_EXHAUSTED" };
      else if (!deps.capacity) aiAdmission = { state: "UNKNOWN", reasonCode: "CAPACITY_SIGNAL_UNAVAILABLE" };
      else if (deps.capacity.active().standard >= deps.capacity.limits().maxConcurrentAiSessions) aiAdmission = { state: "LIMITED_BY_CAPACITY", reasonCode: "CAPACITY_EXHAUSTED" };
      else aiAdmission = { state: "OPEN", reasonCode: null };
      const audit = await deps.auditHealth.status();
      const recon = await deps.actions.listNeedingReconciliation(tenantId, 500);
      const dead = (await deps.outbox.listDead(500)).filter((d) => d.tenantId === tenantId);
      const safety = safetyEventViews(await recentSafetyRows(deps.db, tenantId, ctx.identity.staffId, new Date(ctx.now.getTime() - SAFETY_EVENTS_WINDOW_MS)));
      return {
        generatedAt: ctx.now.toISOString(),
        liveSessions: { active: calls.length, inTransfer: calls.filter((c) => c.state === "IN_TRANSFER").length, safetyActive: calls.filter((c) => c.safetyFlag).length },
        queues,
        aiAdmission,
        dependencies: await deps.dependencyHealth(),
        audit: {
          backlogCount: audit.backlogCount,
          oldestUnshippedAgeSeconds: audit.oldestUnshippedAgeSeconds,
          sinkHealthy: audit.sinkHealthy,
          canAcceptConsequential: audit.canAcceptConsequential,
          reasonCode: audit.reasonCode,
        },
        killSwitchesEngaged: switches.filter((s) => s.engaged).length,
        reconciliationBacklog: recon.length + dead.length,
        openSafetyEvents: safety.filter((s) => s.outcome === "IN_PROGRESS").length,
      };
    },
  });

  register("calls.list", {
    handle: async (ctx): Promise<C.CallsListResponse> => ({ calls: await activeSummaries(ctx), generatedAt: ctx.now.toISOString() }),
  });

  const transferControl = (): C.ControlAvailability =>
    deps.telephonyTransferAvailable ? { available: true, reasonCode: null } : { available: false, reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" };

  register("calls.get", {
    handle: async (ctx): Promise<C.CallDetailResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const callId = ctx.params.callId as string;
      const events = await reader.eventsForCalls(tenantId, staffId, [callId]);
      const safety = await safetyRowsForCalls(deps.db, tenantId, staffId, [callId]);
      const journeys = (await deps.transfers.listActive()).filter((j) => j.tenantId === tenantId);
      const summary = summarizeCall(callId, events, safety, journeys, deps.localFixture);
      if (!summary) throw notFound();
      const { timeline, supportRequestRefs } = await buildTimeline(events, safety, {
        action: async (actionId) => {
          const v = await deps.actions.describe(tenantId, actionId);
          return v ? { kind: v.action.kind, state: v.action.state, receiptId: v.receipt?.receiptId ?? null } : null;
        },
        journey: async (handoffId) => {
          const j = await deps.transfers.get(handoffId);
          return j && j.tenantId === tenantId ? j : null;
        },
        supportRequest: async (id) => {
          const sr = await deps.supportRequests.get(tenantId, id);
          return sr ? { referenceNumber: sr.referenceNumber, syncState: sr.syncState } : null;
        },
      });
      // Read access to a call investigation is audited before any data is returned (fail closed).
      await auditRequired(ctx, { outcome: "ALLOWED", reasonCode: SENSITIVE_READ_REASON, callId });
      return {
        call: summary,
        versions: latestVersions(events),
        controls: { transfer: transferControl(), join: { available: false, reasonCode: "TALKDESK_CONTROL_UNAVAILABLE" } },
        timeline,
        supportRequestRefs,
        contentAvailable: false,
      };
    },
  });

  register("calls.transfer", {
    handle: async (ctx): Promise<C.TransferResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const callId = ctx.params.callId as string;
      const body = ctx.body as C.TransferRequest;
      requireAllowedReason(body.reason, OPERATOR_REASON_CODES["calls.transfer"]);
      const destination = deps.destinations.find((d) => d.destinationId === body.destinationId);
      if (!destination) return deny(ctx, badRequest("DESTINATION_NOT_ALLOWLISTED"), ctx.decision);
      const events = await reader.eventsForCalls(tenantId, staffId, [callId], 200);
      const summary = summarizeCall(callId, events, [], [], deps.localFixture);
      if (!summary) throw notFound();
      if (summary.state === "ENDED") throw conflict("CALL_ENDED");
      if (!deps.telephonyTransferAvailable) return deny(ctx, unavailable("TALKDESK_CONTROL_UNAVAILABLE", false), ctx.decision);
      // Write-ahead intent: nothing is attempted unless this is durable (OPS-01).
      const intentId = await auditRequired(ctx, { outcome: "PENDING", reasonCode: body.reason, callId, evidencePointers: [`db://destinations/${body.destinationId}`] });
      // Kill switches never gate the human route; the handoff service owns the transfer (SAFE-04/SAFE-05).
      const language = destination.languages.find((l) => /^[a-z]{2}(-[A-Z]{2})?$/.test(l)) ?? "en";
      // A staff-raised safety concern (spec section 10: human intervention is a safety signal) takes the FULL
      // safety path (SAFE-HANDOFF-05): priority route first, then pending mutations revoked, the session flagged
      // (resolved server-side by the handoff service), the restricted safety record and safety evidence.
      const staffSafety = body.reason === "SAFETY_PRIORITY" || destination.purpose === "SAFETY_PRIORITY";
      // The staff-selected destination is passed through; the handoff service re-checks it against the allowlist (SAFE-05).
      let result: Awaited<ReturnType<typeof deps.handoff.requestHuman>>;
      try {
        result = staffSafety
          ? await deps.handoff.requestSafetyRoute({ tenantId, callId, ctx: null, signals: [humanInterventionSignal(language)], locale: language, validatedAt: ctx.now, initiatedBy: { staffId }, correlationId: ctx.correlationId })
          : await deps.handoff.requestHuman({ tenantId, callId, ctx: null, reason: body.reason, language, issueCategory: null, destinationId: destination.destinationId, initiatedBy: { staffId } });
      } catch (err) {
        if (err instanceof AccessDeniedError && err.reasonCode === "DESTINATION_NOT_ALLOWLISTED") {
          await auditBestEffort(ctx, { outcome: "DENIED", reasonCode: "DESTINATION_NOT_ALLOWLISTED", callId, policyDecision: ctx.decision });
          throw badRequest("DESTINATION_NOT_ALLOWLISTED");
        }
        throw err;
      }
      // Defense in depth for the safety path: the call's pending mutations are revoked through the ledger even
      // when its live session cannot be resolved server-side (each cancellation is audited by the ledger).
      if (staffSafety || result.priority === "SAFETY") await revokePendingForCall(tenantId, staffId, callId, ctx.now);
      if (!result.transferId) {
        await auditBestEffort(ctx, { outcome: "PENDING", reasonCode: "TRANSFER_ROUTE_PENDING", callId, policyDecision: ctx.decision, evidencePointers: [`transfer_journey:${result.handoffId}`] });
        throw unavailable("TRANSFER_ROUTE_PENDING", false);
      }
      // The handoff service only ever dials an allowlisted destination; anything else is a defect (SAFE-05).
      if (!deps.destinations.some((d) => d.destinationId === result.destinationId)) throw new ConsoleHttpError(500, "INTERNAL_ERROR");
      const attempt = result.journey?.attempts.find((a) => a.transferId === result.transferId);
      const state: C.TransferState = attempt?.state ?? "REQUESTED";
      const doneId = await auditBestEffort(ctx, {
        outcome: "SUCCEEDED",
        reasonCode: staffSafety ? "SAFETY_ESCALATION_ROUTED" : result.destinationId === body.destinationId ? "TRANSFER_REQUESTED" : "TRANSFER_DESTINATION_SUBSTITUTED",
        callId,
        policyDecision: ctx.decision,
        evidencePointers: [`transfer:${result.transferId}`, `transfer_journey:${result.handoffId}`],
      });
      return { transferId: result.transferId, callId, destinationId: result.destinationId, state, auditEventId: doneId ?? intentId };
    },
  });

  /** Cancels the call's PREPARED/CONFIRMED actions (SAFETY_ESCALATION); never fails the escalation. */
  async function revokePendingForCall(tenantId: string, staffId: string, callId: string, now: Date): Promise<number> {
    let revoked = 0;
    try {
      const rows = (await pendingActionRows(deps.db, tenantId, staffId, now)).filter((r) => r.call_id === callId && (r.state === "PREPARED" || r.state === "CONFIRMED"));
      for (const r of rows) {
        try {
          await deps.actions.cancelPending(tenantId, r.action_id, { reasonCode: "SAFETY_ESCALATION", actorRef: staffId });
          revoked++;
        } catch (err) {
          // Already invalidated by the session escalation (or committed meanwhile): nothing left to revoke.
          if (!(err instanceof ConflictError || err instanceof AccessDeniedError)) deps.logger.warn("console.safety_revoke_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
        }
      }
    } catch (err) {
      deps.logger.warn("console.safety_revoke_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "UNCLASSIFIED_ERROR" });
    }
    return revoked;
  }

  /* ---------------- support request trace ---------------- */

  register("supportRequests.trace", {
    handle: async (ctx): Promise<C.SupportTraceResponse> => {
      const { tenantId } = ctx.identity;
      const ref = ctx.params.ref as string;
      // Worker-view metadata only decides which gate applies (existence + restricted flag); nothing from it is returned.
      const meta = await deps.supportRequests.trace(tenantId, ref);
      if (!meta || meta.supportRequest.tenantId !== tenantId) throw notFound();
      let restrictedReader = false;
      if (meta.supportRequest.restricted) {
        // Restricted privacy/safety records need a valid, time-bound, justified break-glass grant approved by someone else.
        await authorizeOrDeny(ctx, [{ action: "restricted_record:view", resource: { type: "restricted_record", tenantId } }]);
        restrictedReader = true;
      }
      // The data returned is read as app_console under row-level security; the restricted-reader
      // setting (app.restricted_reader, migration 0300) is set ONLY after the decision above allowed.
      const trace = await deps.supportRequests.trace(tenantId, ref, { reader: { kind: "console", restrictedReader } });
      if (!trace || trace.supportRequest.tenantId !== tenantId || trace.supportRequest.supportRequestId !== meta.supportRequest.supportRequestId) throw notFound();
      const sr = trace.supportRequest;
      const actions: C.SupportTraceResponse["actions"] = [];
      for (const actionId of trace.actionIds.slice(0, 64)) {
        const v = await deps.actions.describe(tenantId, actionId);
        if (!v) continue;
        actions.push({
          actionId,
          kind: v.action.kind,
          state: v.action.state,
          receiptId: v.receipt?.receiptId ?? null,
          commitOutcome: v.receipt?.outcome ?? (v.action.state === "UNKNOWN" ? "UNKNOWN" : v.action.state === "FAILED" ? "FAILED" : null),
          committedAt: v.receipt?.committedAt ?? null,
        });
      }
      const open = await deps.workflows.openTasks(tenantId, [...STAFF_ROLES]);
      const workflows: C.SupportTraceResponse["workflows"] = [];
      for (const workflowId of trace.workflowIds.slice(0, 32)) {
        const w = await deps.workflows.get(tenantId, workflowId);
        if (!w) continue;
        workflows.push({
          workflowId,
          type: w.type,
          state: w.state,
          definitionVersion: w.definitionVersion,
          ownerQueue: w.ownerQueue,
          deadline: w.deadline,
          openTaskIds: open.filter((t) => t.workflowId === workflowId).map((t) => t.taskId),
        });
      }
      await auditRequired(ctx, { outcome: "ALLOWED", reasonCode: SENSITIVE_READ_REASON, evidencePointers: [`support_request:${sr.supportRequestId}`] });
      return {
        supportRequest: {
          supportRequestId: sr.supportRequestId,
          referenceNumber: sr.referenceNumber,
          issueCategory: sr.issueCategory,
          disposition: sr.disposition,
          ownerQueue: sr.ownerQueue,
          priority: sr.priority,
          restricted: sr.restricted,
          sourceCallIds: [...sr.sourceCallIds],
          createdAt: sr.createdAt,
          updatedAt: sr.updatedAt,
        },
        sync: {
          state: trace.salesforce.syncState,
          attempts: trace.salesforce.attempts,
          lastAttemptAt: trace.salesforce.lastAttemptAt,
          lastReasonCode: trace.salesforce.lastReasonCode !== null && /^[A-Z][A-Z0-9_]{2,63}$/.test(trace.salesforce.lastReasonCode) ? trace.salesforce.lastReasonCode : null,
          // Null until Salesforce confirms the upsert; never invented.
          salesforceCaseId: trace.salesforce.caseId,
          syncedAt: trace.salesforce.syncState === "SYNCED" ? trace.salesforce.syncedAt : null,
          outboxMessageIds: trace.outboxMessageIds.slice(0, 64),
        },
        actions,
        workflows,
        auditEventIds: trace.auditEventIds.slice(0, 500),
      };
    },
  });

  /*
   * Operator repair of a dead-lettered Salesforce sync (spec section 8 "dead-letter queue and operator
   * repair flow"): the request goes back to PENDING with a fresh sync message. Upserts are idempotent by
   * external id, so a repair cannot create a duplicate Case (ACT-02). The business module audits the
   * repair in its own transaction (`support_request.repair_requeued`, actor = staff member); the console
   * writes a write-ahead intent event first and refuses (503 AUDIT_UNAVAILABLE) when it cannot.
   */
  register("supportRequests.repair", {
    handle: async (ctx): Promise<C.SupportRepairResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const ref = ctx.params.ref as string;
      const body = ctx.body as C.SupportRepairRequest;
      const code = requireAllowedReason(body.reason, OPERATOR_REASON_CODES["supportRequests.repair"]);
      const repair = deps.supportRequests.repairDeadLetter?.bind(deps.supportRequests);
      if (!repair) throw unavailable("REPAIR_PATH_UNAVAILABLE", false);
      // Worker-view metadata decides existence, the restricted gate and the state; nothing from it is returned.
      const meta = await deps.supportRequests.trace(tenantId, ref);
      if (!meta || meta.supportRequest.tenantId !== tenantId) throw notFound();
      const sr = meta.supportRequest;
      // Restricted privacy/safety records need the same valid, time-bound break-glass as reading them.
      if (sr.restricted) await authorizeOrDeny(ctx, [{ action: "restricted_record:view", resource: { type: "restricted_record", tenantId } }]);
      if (meta.salesforce.syncState !== "DEAD_LETTER") throw conflict("STATE_CONFLICT");
      await auditRequired(ctx, { outcome: "PENDING", reasonCode: code, evidencePointers: [`support_request:${sr.supportRequestId}`] });
      const repaired = await repair(tenantId, sr.supportRequestId, { actorRef: staffId, reasonCode: code });
      const moduleEvent = await reader.findEventId(tenantId, staffId, { action: "support_request.repair_requeued", correlationId: sr.supportRequestId });
      const doneId = await auditBestEffort(ctx, { outcome: "SUCCEEDED", reasonCode: code, policyDecision: ctx.decision, evidencePointers: [`support_request:${sr.supportRequestId}`] });
      const auditEventId = moduleEvent ?? doneId;
      if (!auditEventId) throw new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
      return { referenceNumber: repaired.referenceNumber, syncState: repaired.syncState, repaired: true, auditEventId };
    },
  });

  /* ---------------- pending actions ---------------- */

  register("actions.pending", {
    handle: async (ctx): Promise<C.PendingActionsResponse> => {
      const rows = await pendingActionRows(deps.db, ctx.identity.tenantId, ctx.identity.staffId, ctx.now);
      return {
        actions: rows.map((r) => ({
          actionId: r.action_id,
          kind: r.kind,
          state: r.state,
          callId: r.call_id,
          preparedAt: new Date(r.prepared_at).toISOString(),
          expiresAt: new Date(r.expires_at).toISOString(),
          requiresStepUp: r.requires_step_up,
          target: { system: r.system as C.ActionTargetSystem, recordType: r.record_type },
          digestPrefix: r.digest.slice(0, 12),
          cancellable: r.state !== "COMMITTING",
          notCancellableReason: r.state === "COMMITTING" ? "ACTION_NOT_CANCELLABLE" : null,
        })),
      };
    },
  });

  register("actions.cancel", {
    checks: async (ctx) => {
      const row = await pendingActionRow(deps.db, ctx.identity.tenantId, ctx.identity.staffId, ctx.params.actionId as string);
      const owner = row && deps.callOwnership ? await deps.callOwnership.ownerOf(ctx.identity.tenantId, row.call_id) : null;
      return [{ action: "pending_action:cancel", resource: { type: "pending_action", tenantId: ctx.identity.tenantId, assignedStaffId: owner } }];
    },
    handle: async (ctx): Promise<C.CancelActionResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const actionId = ctx.params.actionId as string;
      const body = ctx.body as C.CancelActionRequest;
      const code = requireAllowedReason(body.reason, OPERATOR_REASON_CODES["actions.cancel"]);
      const row = await pendingActionRow(deps.db, tenantId, staffId, actionId);
      if (!row) throw notFound();
      if (row.all_state !== "PREPARED" && row.all_state !== "CONFIRMED") return deny(ctx, conflict("ACTION_NOT_CANCELLABLE"), ctx.decision);
      if (row.all_state !== body.expectedState) throw conflict("STATE_CONFLICT");
      await auditRequired(ctx, { outcome: "PENDING", reasonCode: code, callId: row.call_id, evidencePointers: [`action:${actionId}`] });
      await deps.actions.cancelPending(tenantId, actionId, { reasonCode: code, actorRef: staffId });
      // The ledger audits the cancellation in the same transaction as the state change.
      const ledgerEvent = await reader.findEventId(tenantId, staffId, { action: "action.cancel", correlationId: actionId });
      const doneId = await auditBestEffort(ctx, { outcome: "SUCCEEDED", reasonCode: code, callId: row.call_id, policyDecision: ctx.decision, evidencePointers: [`action:${actionId}`] });
      const auditEventId = ledgerEvent ?? doneId;
      if (!auditEventId) throw new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
      return { actionId, state: "CANCELLED", auditEventId };
    },
  });

  /* ---------------- reconciliation ---------------- */

  const retryEligible = (latest: { result: string; consumed: boolean; at: string } | undefined, ledgerState: string, now: Date): boolean =>
    latest !== undefined && latest.result === "NOT_FOUND" && !latest.consumed && ledgerState === "CONFIRMED" && now.getTime() - Date.parse(latest.at) <= RETRY_RECONCILIATION_MAX_AGE_MS;

  register("reconciliation.list", {
    handle: async (ctx): Promise<C.ReconciliationResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const needing = await deps.actions.listNeedingReconciliation(tenantId, 500);
      const latest = await reconciliations.latestFor(tenantId, staffId, needing.map((a) => a.actionId));
      const items: C.ReconciliationItem[] = [];
      for (const a of needing) {
        if (a.state !== "UNKNOWN" && a.state !== "COMMITTING") continue;
        const v = await deps.actions.describe(tenantId, a.actionId);
        const l = latest.get(a.actionId);
        items.push({
          actionId: a.actionId,
          kind: a.kind,
          state: a.state,
          providerSystem: a.target.system,
          since: v?.committingSince ?? v?.lastReconciledAt ?? a.preparedAt,
          attempts: v?.reconcileAttempts ?? 0,
          lastReconcile: l ? { reconciliationId: l.reconciliationId, result: l.result, at: l.at, receiptId: l.receiptId } : null,
          retryEligible: retryEligible(l, a.state, ctx.now),
        });
      }
      const dead = (await deps.outbox.listDead(500)).filter((d) => d.tenantId === tenantId);
      return {
        actions: items,
        deadLetters: dead.map((d) => ({
          messageId: d.messageId,
          topic: d.topic,
          aggregateRef: d.key,
          attempts: d.attempts,
          lastReasonCode: d.lastErrorCode !== null && /^[A-Z][A-Z0-9_]{2,63}$/.test(d.lastErrorCode) ? d.lastErrorCode : null,
          createdAt: d.createdAt,
          deadAt: d.deadAt,
        })),
      };
    },
  });

  register("reconciliation.reconcile", {
    handle: async (ctx): Promise<C.ReconcileResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const actionId = ctx.params.actionId as string;
      const before = await deps.actions.describe(tenantId, actionId);
      if (!before) throw notFound();
      if (before.action.state !== "UNKNOWN" && before.action.state !== "COMMITTING") throw conflict("ACTION_NOT_RECONCILABLE");
      const provider = deps.providers[before.action.kind];
      if (!provider) throw unavailable("PROVIDER_LOOKUP_UNAVAILABLE", true);
      const callId = (await pendingActionRow(deps.db, tenantId, staffId, actionId))?.call_id ?? null;
      await auditRequired(ctx, { outcome: "PENDING", reasonCode: "OPERATOR_RECONCILE", callId, evidencePointers: [`action:${actionId}`] });
      // Provider lookup by the stable idempotency key; the ledger records the outcome in its own transaction (ACT-03).
      const receipt: CommitReceipt = await deps.actions.reconcile(actionId, provider);
      const result: C.ReconcileResultView["result"] = receipt.outcome === "COMMITTED" ? "COMMITTED" : receipt.outcome === "NOT_STARTED" ? "NOT_FOUND" : "UNKNOWN";
      const after = await deps.actions.describe(tenantId, actionId);
      const ledgerState = after?.action.state ?? before.action.state;
      const receiptId = result === "COMMITTED" ? receipt.receiptId : null;
      const { record, auditEventId } = await reconciliations.record(deps.audit, {
        tenantId,
        staffId,
        actionId,
        result,
        receiptId,
        ledgerState,
        ledgerAuditEventId: receipt.auditEventId,
        now: ctx.now,
        auditInput: (reconciliationId) =>
          auditInput(ctx, {
            outcome: "RECONCILED",
            reasonCode: `PROVIDER_${result}`,
            callId,
            policyDecision: ctx.decision,
            evidencePointers: [`action:${actionId}`, `db://console_reconciliations/${reconciliationId}`],
          }),
      });
      return {
        actionId,
        result: { reconciliationId: record.reconciliationId, result, at: record.at, receiptId },
        state: ledgerState,
        retryEligible: retryEligible(record, ledgerState, ctx.now),
        auditEventId,
      };
    },
  });

  register("reconciliation.retry", {
    handle: async (ctx): Promise<C.RetryResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const actionId = ctx.params.actionId as string;
      const body = ctx.body as C.RetryRequest;
      const code = requireAllowedReason(body.reason, OPERATOR_REASON_CODES["reconciliation.retry"]);
      const latest = (await reconciliations.latestFor(tenantId, staffId, [actionId])).get(actionId);
      // ACT-03: only against the LATEST, unconsumed, recent NOT_FOUND reconciliation made in this console flow.
      if (!latest || latest.reconciliationId !== body.reconciliationId || latest.result !== "NOT_FOUND" || latest.consumed || ctx.now.getTime() - Date.parse(latest.at) > RETRY_RECONCILIATION_MAX_AGE_MS) {
        return deny(ctx, conflict("RECONCILE_REQUIRED"), ctx.decision);
      }
      const current = await deps.actions.describe(tenantId, actionId);
      if (!current) throw notFound();
      // NOT_FOUND returns the action to CONFIRMED only while its confirmation is fresh; otherwise a new preparation is required.
      if (current.action.state !== "CONFIRMED") return deny(ctx, conflict("RETRY_NOT_ELIGIBLE"), ctx.decision);
      if (!deps.reconciledRetry) return deny(ctx, unavailable("RETRY_PATH_UNAVAILABLE", false), ctx.decision);
      await reconciliations.consume(deps.audit, {
        tenantId,
        staffId,
        reconciliationId: latest.reconciliationId,
        now: ctx.now,
        auditInput: auditInput(ctx, { outcome: "PENDING", reasonCode: code, callId: (await pendingActionRow(deps.db, tenantId, staffId, actionId))?.call_id ?? null, policyDecision: ctx.decision, evidencePointers: [`action:${actionId}`, `db://console_reconciliations/${latest.reconciliationId}`] }),
      });
      const receipt = await deps.reconciledRetry.retryAfterReconcile({ tenantId, actionId, reconciliationId: latest.reconciliationId, reasonCode: code, staff: staffActorOf(ctx.identity, ctx.now), correlationId: ctx.correlationId });
      const after = await deps.actions.describe(tenantId, actionId);
      return { actionId, state: after?.action.state ?? current.action.state, outcome: receipt.outcome, receiptId: receipt.outcome === "COMMITTED" ? receipt.receiptId : null, auditEventId: receipt.auditEventId };
    },
  });

  register("outbox.requeue", {
    handle: async (ctx): Promise<C.RequeueResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const messageId = ctx.params.messageId as string;
      const body = ctx.body as C.RequeueRequest;
      const code = requireAllowedReason(body.reason, OPERATOR_REASON_CODES["outbox.requeue"]);
      const dead = (await deps.outbox.listDead(500)).find((d) => d.messageId === messageId && d.tenantId === tenantId);
      if (!dead) throw notFound();
      await auditRequired(ctx, { outcome: "PENDING", reasonCode: code, evidencePointers: [`outbox:${messageId}`] });
      // Consumers deduplicate, so a requeue cannot create a duplicate effect (ACT-02). The dispatcher audits in its transaction.
      const requeued = await deps.outbox.requeueDead(messageId, { actorRef: staffId, reasonCode: code, correlationId: ctx.correlationId });
      if (!requeued) throw conflict("STATE_CONFLICT");
      const dispatcherEvent = await reader.findEventId(tenantId, staffId, { action: "outbox.requeue", correlationId: ctx.correlationId });
      const doneId = await auditBestEffort(ctx, { outcome: "SUCCEEDED", reasonCode: code, policyDecision: ctx.decision, evidencePointers: [`outbox:${messageId}`] });
      const auditEventId = dispatcherEvent ?? doneId;
      if (!auditEventId) throw new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
      return { messageId, requeued: true, auditEventId };
    },
  });

  /* ---------------- workflow human tasks ---------------- */

  const STAFF_ROLE = z.enum(STAFF_ROLES);
  const QUEUE = /^q_[a-z0-9_]{2,40}$/;

  register("workflows.tasks", {
    handle: async (ctx): Promise<C.WorkflowTasksResponse> => {
      const { tenantId } = ctx.identity;
      const tasks = await deps.workflows.openTasks(tenantId, [...ctx.identity.roles]);
      const out: C.HumanTaskView[] = [];
      for (const t of tasks) {
        const required = t.requiredStaffRoles.map((r) => STAFF_ROLE.safeParse(r)).flatMap((p) => (p.success ? [p.data] : []));
        if (required.length === 0 || !required.some((r) => ctx.identity.roles.includes(r))) continue;
        const w = await deps.workflows.get(tenantId, t.workflowId);
        if (!w || !QUEUE.test(w.ownerQueue)) continue;
        out.push({
          taskId: t.taskId,
          workflowId: t.workflowId,
          workflowType: w.type,
          workflowState: w.state,
          taskType: t.taskType,
          requiredStaffRoles: required,
          status: t.status,
          ownerQueue: w.ownerQueue,
          // The task is created on entering its human state; the instance's last transition is that entry.
          createdAt: w.updatedAt,
          expiresAt: t.expiresAt,
          sourceRecordRefs: w.sourceRecordRefs.filter((r) => /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/.test(r)).slice(0, 16),
        });
      }
      return { tasks: out };
    },
  });

  register("workflows.decision", {
    handle: async (ctx): Promise<C.WorkflowDecisionResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const taskId = ctx.params.taskId as string;
      const body = ctx.body as C.WorkflowDecisionRequest;
      const allowed = body.decision === "APPROVE" ? OPERATOR_REASON_CODES["workflows.decision.APPROVE"] : OPERATOR_REASON_CODES["workflows.decision.REJECT"];
      const code = requireAllowedReason(body.reason, allowed);
      const task = (await deps.workflows.openTasks(tenantId, [...STAFF_ROLES])).find((t) => t.taskId === taskId);
      if (!task) throw notFound();
      // Per-task rule: the staff member must hold one of the task's required roles.
      if (!task.requiredStaffRoles.some((r) => (ctx.identity.roles as string[]).includes(r))) return deny(ctx, forbidden("STAFF_ROLE_NOT_PERMITTED"), ctx.decision);
      await auditRequired(ctx, { outcome: "PENDING", reasonCode: code, evidencePointers: [`workflow:${task.workflowId}`, `workflow_task:${taskId}`] });
      const staff = staffActorOf(ctx.identity, ctx.now);
      let instance;
      try {
        // The task token is minted and consumed server-side within this request; it never leaves this scope.
        const issued = await deps.workflows.issueTaskToken({ tenantId, taskId, staff });
        instance = await deps.workflows.completeHumanTask({ tenantId, taskId, taskToken: issued.taskToken, decision: body.decision, staff });
      } catch (err) {
        if (err instanceof WorkflowRecheckDeniedError) throw conflict(err.reasonCode);
        if (err instanceof PlatformError && ["TASK_STALE", "TASK_NOT_OPEN", "TASK_EXPIRED", "TASK_COMPLETION_CONFLICT"].includes(err.reasonCode)) throw conflict("TASK_STALE");
        throw err;
      }
      const engineEvent = await reader.findEventId(tenantId, staffId, { action: "workflow.human_task.complete", pointer: `workflow_task:${taskId}` });
      const doneId = await auditBestEffort(ctx, { outcome: "SUCCEEDED", reasonCode: code, policyDecision: ctx.decision, evidencePointers: [`workflow:${task.workflowId}`, `workflow_task:${taskId}`] });
      const auditEventId = engineEvent ?? doneId;
      if (!auditEventId) throw new ConsoleHttpError(503, "AUDIT_UNAVAILABLE", true);
      return { taskId, workflowId: task.workflowId, decision: body.decision, workflowState: instance.state, auditEventId };
    },
  });

  /* ---------------- safety events ---------------- */

  register("safetyEvents.list", {
    handle: async (ctx): Promise<C.SafetyEventsResponse> => {
      const rows = await recentSafetyRows(deps.db, ctx.identity.tenantId, ctx.identity.staffId, new Date(ctx.now.getTime() - SAFETY_EVENTS_WINDOW_MS));
      const events = safetyEventViews(rows).slice(0, 500);
      await auditRequired(ctx, { outcome: "ALLOWED", reasonCode: SENSITIVE_READ_REASON });
      return { events };
    },
  });

  /* ---------------- releases ---------------- */

  const latestKnowledgeSnapshot = async (tenantId: string, staffId: string): Promise<{ version: string; digest: string } | null> => {
    const r = await consoleTx(deps.db, tenantId, staffId, (tx) =>
      tx.query<{ snapshot_version: string; snapshot_digest: string }>("select snapshot_version, snapshot_digest from knowledge_snapshots order by snapshot_seq desc limit 1"),
    );
    const row = r.rows[0];
    return row ? { version: row.snapshot_version, digest: row.snapshot_digest } : null;
  };

  register("releases.list", {
    handle: async (ctx): Promise<C.ReleasesResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const env = { environment: deps.environment, now: ctx.now };
      // The endpoint gate (release:view) covers knowledge snapshots; policy bundles additionally need policy:review.
      const canPolicy = (await authorize(deps.policy, ctx.identity, [{ action: "policy:review", resource: { type: "release_candidate", tenantId } }], env)).allowed;
      const submissions = (await releases.list(tenantId, staffId, 50)).filter((s) => s.kind !== "POLICY_BUNDLE" || canPolicy);
      const reviews = await releases.reviewsFor(tenantId, staffId, submissions.map((s) => s.releaseId));
      const snapshot = submissions.some((s) => s.kind === "KNOWLEDGE_SNAPSHOT") ? await latestKnowledgeSnapshot(tenantId, staffId) : null;
      const held =
        snapshot !== null
          ? (await deps.knowledge.reviewQueue(tenantId)).slice(0, 500).map((h) => ({
              ref: `kb:${h.sourceId}`.toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 121),
              version: h.version,
              status: h.status,
              reasonCodes: h.reasonCodes.filter((c) => /^[A-Z][A-Z0-9_]{2,63}$/.test(c)).slice(0, 16),
            }))
          : [];
      return {
        releases: submissions.map((s) => ({
          releaseId: s.releaseId,
          kind: s.kind,
          version: s.version,
          previousVersion: s.previousVersion,
          digest: s.digest,
          submittedAt: s.submittedAt,
          submittedBy: s.submittedBy,
          diffSummary: { added: s.diff.added, removed: s.diff.removed, changed: s.diff.changed, entries: s.diff.entries },
          reviews: (reviews.get(s.releaseId) ?? []).map((r) => ({ reviewId: r.reviewId, reviewerStaffId: r.reviewerStaffId, reviewerRole: r.reviewerRole, decision: r.decision, reason: r.reason, at: r.at })),
          requiredApprovalScope: s.kind === "POLICY_BUNDLE" ? "POLICY_RELEASE" : "KNOWLEDGE_RELEASE",
          // No signed approval record exists for any release (approvals/ holds none); the console cannot create one.
          approvalStatus: "MISSING",
          approvalId: null,
          ...(s.kind === "KNOWLEDGE_SNAPSHOT" && snapshot?.digest === s.digest ? { heldItems: held } : {}),
        })),
      };
    },
  });

  register("releases.review", {
    checks: async (ctx) => {
      const release = await releases.get(ctx.identity.tenantId, ctx.identity.staffId, ctx.params.releaseId as string);
      if (!release) throw notFound();
      return release.kind === "POLICY_BUNDLE"
        ? [{ action: "policy:approve", resource: { type: "release_candidate", tenantId: release.tenantId, initiatorStaffId: release.submittedBy } }]
        : [{ action: "knowledge:submit_release", resource: { type: "release_candidate", tenantId: release.tenantId, initiatorStaffId: release.submittedBy } }];
    },
    handle: async (ctx): Promise<C.ReleaseReviewResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const body = ctx.body as C.ReleaseReviewRequest;
      requireAllowedReason(body.reason, OPERATOR_REASON_CODES["releases.review"]);
      const release = await releases.get(tenantId, staffId, ctx.params.releaseId as string);
      if (!release) throw notFound();
      const role = RELEASE_REVIEW_ROLES[release.kind].find((r) => ctx.identity.roles.includes(r));
      if (!role) return deny(ctx, forbidden("STAFF_ROLE_NOT_PERMITTED"), ctx.decision);
      if (release.submittedBy === staffId) return deny(ctx, forbidden("SELF_REVIEW_FORBIDDEN"), ctx.decision);
      const { reviewId, auditEventId } = await releases.recordReview(deps.audit, {
        tenantId,
        staffId,
        role,
        release,
        decision: body.decision,
        reason: body.reason,
        now: ctx.now,
        auditInput: (id) =>
          consoleAuditInput({
            tenantId,
            correlationId: ctx.correlationId,
            staffId,
            role,
            action: auditActionFor("releases.review"),
            outcome: "SUCCEEDED",
            reasonCode: reasonCodeOf(body.reason),
            occurredAt: ctx.now,
            policyDecision: ctx.decision,
            evidencePointers: [`db://console_release_reviews/${id}`, `db://console_release_submissions/${release.releaseId}`],
            afterHash: digestOf({ releaseId: release.releaseId, digest: release.digest, decision: body.decision }),
          }),
      });
      return { reviewId, releaseId: release.releaseId, recordedAt: ctx.now.toISOString(), auditEventId, approvalRecordCreated: false };
    },
  });

  /* ---------------- budgets ---------------- */

  const budgetStatuses = async (ctx: AuthedCtx): Promise<C.BudgetView[]> => {
    const { tenantId, staffId } = ctx.identity;
    const scopes = await consoleTx(deps.db, tenantId, staffId, (tx) =>
      tx.query<{ cohort: string; workflow: string; vendor: string }>(
        `select distinct cohort, workflow, vendor from budgets where environment = $1 and period_start <= $2::timestamptz and period_end > $2::timestamptz order by cohort, workflow, vendor limit 200`,
        [deps.environment, ctx.now.toISOString()],
      ),
    );
    const byId = new Map<string, C.BudgetView>();
    for (const s of scopes.rows) {
      const statuses = await deps.budgets.statusFor({
        tenantId,
        environment: deps.environment,
        vendor: s.vendor === "*" ? null : s.vendor,
        workflow: s.workflow === "*" ? null : s.workflow,
        cohort: s.cohort === "*" ? "console" : s.cohort,
        now: ctx.now,
      });
      for (const st of statuses) {
        byId.set(st.budget.budgetId, {
          budgetId: st.budget.budgetId,
          scope: { ...st.budget.scope },
          periodStart: st.budget.periodStart,
          periodEnd: st.budget.periodEnd,
          limitUsd: st.budget.limitUsd,
          safetyReserveUsd: st.budget.safetyReserveUsd,
          spentUsd: st.spentUsd,
          safetySpentUsd: st.safetySpentUsd,
          nonSafetySpentUsd: st.nonSafetySpentUsd,
          burnRateUsdPerMinute: st.burnRateUsdPerMinute,
          projectedUsd: st.projectedUsd,
          nonessentialHeadroomUsd: st.nonessentialHeadroomUsd,
          safetyReserveRemainingUsd: st.safetyReserveRemainingUsd,
          meteringDelayMinutes: st.budget.meteringDelayMinutes,
          exhausted: st.exhausted,
          safetyReserveExceeded: st.safetyReserveExceeded,
          approvedBy: st.budget.approvedBy,
          version: st.budget.version,
        });
      }
    }
    return [...byId.values()].sort((a, b) => (a.budgetId < b.budgetId ? -1 : 1));
  };

  register("budgets.list", {
    handle: async (ctx): Promise<C.BudgetsResponse> => ({ budgets: await budgetStatuses(ctx), generatedAt: ctx.now.toISOString(), figuresIllustrative: deps.budgetFiguresIllustrative }),
  });

  /* ---------------- kill switches ---------------- */

  const killSwitchView = (s: { switchId: string; scope: C.KillSwitchScope; target: string; engaged: boolean; reason: string; changedBy: string; changedAt: string }): C.KillSwitchView => ({
    switchId: s.switchId,
    scope: s.scope,
    target: s.target,
    engaged: s.engaged,
    reason: s.reason,
    changedBy: s.changedBy,
    changedAt: s.changedAt,
  });

  register("killSwitches.list", {
    handle: async (ctx): Promise<C.KillSwitchesResponse> => {
      const tenantId = ctx.identity.tenantId;
      const [switches, snapshot] = await Promise.all([deps.killSwitches.list(tenantId), deps.killSwitches.snapshot(tenantId)]);
      return {
        switches: switches.map(killSwitchView),
        snapshot: { ...snapshot, intents: [...snapshot.intents], integrations: [...snapshot.integrations], modelVersions: [...snapshot.modelVersions], voiceVersions: [...snapshot.voiceVersions] },
        targets: {
          INTENT: [...deps.killSwitchTargets.INTENT],
          INTEGRATION: [...deps.killSwitchTargets.INTEGRATION],
          MODEL_VERSION: [...deps.killSwitchTargets.MODEL_VERSION],
          VOICE_VERSION: [...deps.killSwitchTargets.VOICE_VERSION],
        },
        // No switch gates the approved safety and human routes (ops/kill-switches.ts killSwitchBlock).
        safetyRoutesPreserved: true,
      };
    },
  });

  register("killSwitches.set", {
    checks: (ctx) => {
      const b = ctx.body as C.SetKillSwitchRequest;
      return [{ action: b.engaged ? "kill_switch:engage" : "kill_switch:release", resource: { type: "kill_switch", tenantId: ctx.identity.tenantId, killSwitchScope: b.scope } }];
    },
    handle: async (ctx): Promise<C.SetKillSwitchResponse> => {
      const { tenantId, staffId } = ctx.identity;
      const b = ctx.body as C.SetKillSwitchRequest;
      requireAllowedReason(b.reason, b.engaged ? OPERATOR_REASON_CODES["killSwitches.set.engage"] : OPERATOR_REASON_CODES["killSwitches.set.release"]);
      // Typed confirmation, re-checked server-side.
      if (b.confirmationPhrase !== `${b.engaged ? "ENGAGE" : "RELEASE"} ${b.scope} ${b.target}`) return deny(ctx, badRequest("CONFIRMATION_MISMATCH"), ctx.decision);
      const global = (GLOBAL_KILL_SWITCH_SCOPES as readonly string[]).includes(b.scope);
      const known = global ? b.target === "*" : (deps.killSwitchTargets[b.scope as keyof ConsoleApiDeps["killSwitchTargets"]] ?? []).includes(b.target);
      if (!known) return deny(ctx, badRequest("KILL_SWITCH_TARGET_UNKNOWN"), ctx.decision);
      // Per-scope roles (KILL_SWITCH_SCOPE_ROLES mirrors ops KILL_SWITCH_ROLES).
      if (!KILL_SWITCH_SCOPE_ROLES[b.scope].some((r) => ctx.identity.roles.includes(r))) return deny(ctx, forbidden("STAFF_ROLE_NOT_PERMITTED"), ctx.decision);
      // State, append-only history and the console audit event commit in ONE app_console transaction (ops module).
      const sw = await deps.killSwitches.set({ tenantId, scope: b.scope, target: b.target, engaged: b.engaged, reason: b.reason, staff: staffActorOf(ctx.identity, ctx.now), correlationId: ctx.correlationId });
      const auditEventId = await reader.findEventId(tenantId, staffId, { action: "killswitch.set", correlationId: ctx.correlationId });
      if (!auditEventId) throw new ConsoleHttpError(500, "AUDIT_EVENT_NOT_FOUND");
      return { switch: killSwitchView(sw), auditEventId, safetyRoutesPreserved: true };
    },
  });

  /* ---------------- audit search ---------------- */

  register("audit.search", {
    handle: async (ctx): Promise<C.AuditSearchResponse> => {
      const q = ctx.query as C.AuditSearchQuery;
      const events = await auditorQuery.search({ tenantId: ctx.identity.tenantId, ...q });
      // The search itself is recorded; if that is impossible, no results are returned (fail closed).
      const searchAuditEventId = await auditRequired(ctx, { outcome: "SUCCEEDED", reasonCode: "AUDIT_METADATA_SEARCH", callId: q.callId ?? null });
      return {
        events: events.map((e) => ({
          eventId: e.eventId,
          occurredAt: e.occurredAt,
          correlationId: e.correlationId,
          parentId: e.parentId,
          actorRef: e.actorRef,
          subjectRef: e.subjectRef,
          role: e.role,
          sourceComponent: e.sourceComponent,
          callId: e.callId,
          sessionGeneration: e.sessionGeneration,
          action: e.action,
          outcome: e.outcome,
          reasonCode: e.reasonCode,
          policyDecision: e.policyDecision ? { ...e.policyDecision, reasonCodes: [...e.policyDecision.reasonCodes] } : null,
          assurance: e.assurance,
          dataClass: e.dataClass,
          // Count only: evidence pointers need their own permission check.
          evidencePointerCount: e.evidencePointers.length,
          sourceStream: e.sourceStream,
          sequence: e.sequence,
          hash: e.hash,
        })),
        searchAuditEventId,
        limit: q.limit,
      };
    },
  });

  /* ---------------- destinations ---------------- */

  register("destinations.list", {
    handle: async (): Promise<C.DestinationsResponse> => ({
      destinations: deps.destinations.map((d) => ({
        destinationId: d.destinationId,
        purpose: d.purpose,
        fallbackDestinationIds: [...d.fallbackDestinationIds],
        languages: [...d.languages],
        // The vendor queue reference itself is never returned.
        vendorQueueConfigured: !/PLACEHOLDER/.test(d.vendorQueueRef),
      })),
      source: "trusted_configuration",
    }),
  });
}
