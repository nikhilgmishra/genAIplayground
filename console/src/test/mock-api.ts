/**
 * LOCAL TEST FIXTURE — in-memory console API backend for component tests.
 *
 * Routes requests by the contract's CONSOLE_ENDPOINTS table and, like the real
 * backend must, ENFORCES authentication and ENDPOINT_ROLES (plus per-scope
 * kill-switch roles and per-task roles) on every request, independent of what
 * the UI shows. Every request is recorded so tests can assert exact payloads.
 */
import {
  CONSOLE_ENDPOINTS,
  ENDPOINT_ROLES,
  KILL_SWITCH_SCOPE_ROLES,
  OPERATOR_REASON_PATTERN,
  PUBLIC_ENDPOINTS,
} from "../api/contract";
import type {
  AuthConfigResponse,
  AuthenticatedEndpointKey,
  ConsoleEndpointTypes,
  EndpointKey,
  KillSwitchScope,
  KillSwitchView,
  MeResponse,
  ReconcileResultView,
  StaffView,
} from "../api/contract";
import * as fx from "./fixtures";

export interface RecordedRequest {
  key: EndpointKey | null;
  method: string;
  path: string;
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  params: Record<string, string>;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

export interface HandlerContext {
  req: RecordedRequest;
  staff: StaffView | null;
  state: MockState;
}

export type Handler = (ctx: HandlerContext) => MockResponse | Promise<MockResponse>;

export interface MockState {
  authConfig: AuthConfigResponse;
  meOverrides: Partial<MeResponse>;
  killSwitches: ReturnType<typeof fx.killSwitches>;
  reconciliation: ReturnType<typeof fx.reconciliation>;
  /** Next provider lookup result per action id (default UNKNOWN). */
  reconcileOutcomes: Record<string, ReconcileResultView["result"]>;
  latestReconcile: Record<string, ReconcileResultView>;
  pending: ReturnType<typeof fx.pendingActions>;
  tasks: ReturnType<typeof fx.workflowTasks>;
  /** Extra fields injected into GET responses to prove the UI ignores them. */
  inject: Partial<Record<EndpointKey, Record<string, unknown>>>;
  sequence: number;
}

export interface MockApiOptions {
  authConfig?: AuthConfigResponse;
  meOverrides?: Partial<MeResponse>;
  handlers?: Partial<Record<EndpointKey, Handler>>;
  staff?: StaffView[];
}

export interface MockApi {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  calls: (key: EndpointKey) => RecordedRequest[];
  state: MockState;
  registerStaff: (staff: StaffView) => void;
  tokenFor: (staff: StaffView) => string;
  setHandler: (key: EndpointKey, handler: Handler | null) => void;
}

const json = (status: number, body: unknown): MockResponse => ({ status, body });
export const errorResponse = (status: number, reasonCode: string): MockResponse =>
  json(status, { error: { reasonCode, correlationId: "cor_synthCorrelation0099", retryable: false } });

const OPERATOR_REASON_RE = new RegExp(OPERATOR_REASON_PATTERN);
const PUBLIC: ReadonlySet<string> = new Set(PUBLIC_ENDPOINTS);

const ROUTES = (Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[]).map((key) => {
  const spec = CONSOLE_ENDPOINTS[key];
  const names: string[] = [];
  const pattern = spec.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { key, method: spec.method as string, re: new RegExp(`^${pattern}$`), names };
});

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

const roleAllowed = (staff: StaffView, roles: readonly string[]): boolean => roles.some((r) => staff.roles.includes(r as StaffView["roles"][number]));

function nextId(state: MockState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}_synthMock${String(state.sequence).padStart(12, "0")}`;
}

function defaults(): Record<EndpointKey, Handler> {
  return {
    "auth.config": ({ state }) => json(200, state.authConfig),
    "auth.localStaff": () =>
      json(200, {
        label: "LOCAL DEV SIGN-IN (synthetic staff)",
        staff: fx.ALL_STAFF_KEYS.map((k) => {
          const s = fx.staffView(k);
          return { staffId: s.staffId, displayLabel: s.displayLabel, roles: s.roles };
        }),
      }),
    "auth.localToken": ({ req }) => {
      const staffId = (req.body as { staffId?: string } | undefined)?.staffId ?? "";
      return json(200, { accessToken: `synthetic-token.${staffId}`, tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z", localFixture: true, sessionKind: "LOCAL_FIXTURE", idleTimeoutSeconds: null });
    },
    "auth.oidcStart": ({ req, state }) => {
      const body = req.body as { redirectUri?: string; codeChallenge?: string } | undefined;
      const endpoint = state.authConfig.oidc?.authorizationEndpoint;
      if (!endpoint || state.authConfig.oidc?.status !== "CONFIGURED") return errorResponse(503, "OIDC_NOT_CONFIGURED");
      // The backend creates state and nonce and keeps them server side (SYNTHETIC values).
      const backendState = `S${"t".repeat(42)}`;
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: state.authConfig.oidc?.clientId ?? "",
        redirect_uri: body?.redirectUri ?? "",
        scope: "openid",
        state: backendState,
        nonce: `N${"n".repeat(42)}`,
        code_challenge: body?.codeChallenge ?? "",
        code_challenge_method: "S256",
      }).toString();
      return json(200, { authorizationUrl: url.toString(), state: backendState, expiresAt: "2099-01-01T00:00:00.000Z" });
    },
    "auth.oidcExchange": () =>
      json(200, { accessToken: `synthetic-token.${fx.staffView("supervisor").staffId}`, tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z", localFixture: false, sessionKind: "OIDC_SSO", idleTimeoutSeconds: 900 }),
    "auth.refresh": () => errorResponse(401, "SESSION_INVALID"),
    "auth.recoveryChallenge": () => errorResponse(503, "RECOVERY_NOT_CONFIGURED"),
    "auth.recoveryActivate": () => errorResponse(503, "RECOVERY_NOT_CONFIGURED"),
    "auth.logout": () => json(200, { loggedOut: true }),
    me: ({ staff, state }) => json(200, fx.meFor(staff as StaffView, state.meOverrides)),
    overview: () => json(200, fx.overview()),
    "calls.list": () => json(200, fx.callsList()),
    "calls.get": ({ req }) => json(200, fx.callDetail(req.params.callId)),
    "calls.transfer": ({ req, state }) => {
      const body = req.body as ConsoleEndpointTypes["calls.transfer"]["body"];
      if (!fx.destinations().destinations.some((d) => d.destinationId === body.destinationId)) return errorResponse(400, "DESTINATION_NOT_ALLOWLISTED");
      return json(200, { transferId: nextId(state, "xfr"), callId: req.params.callId, destinationId: body.destinationId, state: "REQUESTED", auditEventId: nextId(state, "aud") });
    },
    "supportRequests.trace": () => json(200, fx.supportTrace()),
    // Mirrors the backend: only a DEAD_LETTER sync can be repaired; the request goes back to PENDING (asynchronous sync).
    "supportRequests.repair": ({ req, state }) => {
      const body = req.body as ConsoleEndpointTypes["supportRequests.repair"]["body"];
      if (!OPERATOR_REASON_RE.test(body.reason ?? "")) return errorResponse(400, "REASON_NOT_ALLOWED");
      return json(200, { referenceNumber: req.params.ref, syncState: "PENDING", repaired: true, auditEventId: nextId(state, "aud") });
    },
    "actions.pending": ({ state }) => json(200, state.pending),
    "actions.cancel": ({ req, state }) => {
      const action = state.pending.actions.find((a) => a.actionId === req.params.actionId);
      if (!action) return errorResponse(404, "NOT_FOUND");
      if (!action.cancellable || action.state === "COMMITTING") return errorResponse(409, "ACTION_NOT_CANCELLABLE");
      const body = req.body as ConsoleEndpointTypes["actions.cancel"]["body"];
      if (!OPERATOR_REASON_RE.test(body.reason)) return errorResponse(400, "REASON_NOT_ALLOWED");
      state.pending = { actions: state.pending.actions.filter((a) => a.actionId !== action.actionId) };
      return json(200, { actionId: action.actionId, state: "CANCELLED", auditEventId: nextId(state, "aud") });
    },
    "reconciliation.list": ({ state }) => json(200, state.reconciliation),
    "reconciliation.reconcile": ({ req, state }) => {
      const actionId = req.params.actionId ?? "";
      const result: ReconcileResultView = {
        reconciliationId: nextId(state, "rcn"),
        result: state.reconcileOutcomes[actionId] ?? "UNKNOWN",
        at: fx.NOW,
        receiptId: null,
      };
      state.latestReconcile[actionId] = result;
      return json(200, { actionId, result, state: "UNKNOWN", retryEligible: result.result === "NOT_FOUND", auditEventId: nextId(state, "aud") });
    },
    "reconciliation.retry": ({ req, state }) => {
      const actionId = req.params.actionId ?? "";
      const body = req.body as ConsoleEndpointTypes["reconciliation.retry"]["body"];
      const latest = state.latestReconcile[actionId];
      if (!latest || latest.result !== "NOT_FOUND" || latest.reconciliationId !== body.reconciliationId) return errorResponse(409, "RECONCILE_REQUIRED");
      return json(200, { actionId, state: "COMMITTED", outcome: "COMMITTED", receiptId: nextId(state, "rcp"), auditEventId: nextId(state, "aud") });
    },
    "outbox.requeue": ({ req, state }) => json(200, { messageId: req.params.messageId, requeued: true, auditEventId: nextId(state, "aud") }),
    "workflows.tasks": ({ state, staff }) =>
      json(200, { tasks: state.tasks.tasks.filter((t) => staff !== null && roleAllowed(staff, t.requiredStaffRoles)).map((t) => ({ ...t })) }),
    "workflows.decision": ({ req, state, staff }) => {
      const task = state.tasks.tasks.find((t) => t.taskId === req.params.taskId);
      if (!task) return errorResponse(404, "NOT_FOUND");
      if (!staff || !roleAllowed(staff, task.requiredStaffRoles)) return errorResponse(403, "STAFF_ROLE_NOT_PERMITTED");
      const body = req.body as ConsoleEndpointTypes["workflows.decision"]["body"];
      if (!OPERATOR_REASON_RE.test(body.reason ?? "")) return errorResponse(400, "REASON_NOT_ALLOWED");
      state.tasks = { tasks: state.tasks.tasks.filter((t) => t.taskId !== task.taskId) };
      return json(200, {
        taskId: task.taskId,
        workflowId: task.workflowId,
        decision: body.decision,
        workflowState: body.decision === "APPROVE" ? "READY_TO_COMMIT" : "CANCELLED",
        auditEventId: nextId(state, "aud"),
      });
    },
    "safetyEvents.list": () => json(200, fx.safetyEvents()),
    // Mirrors the backend: knowledge snapshot items carry the (optional, content-free) held-item list.
    "releases.list": () => json(200, { releases: fx.releases().releases.map((r) => (r.kind === "KNOWLEDGE_SNAPSHOT" ? { ...r, heldItems: [] } : r)) }),
    "releases.review": ({ req, state }) =>
      json(200, { reviewId: nextId(state, "rvw"), releaseId: req.params.releaseId, recordedAt: fx.NOW, auditEventId: nextId(state, "aud"), approvalRecordCreated: false }),
    "budgets.list": () => json(200, fx.budgets()),
    "killSwitches.list": ({ state }) => json(200, state.killSwitches),
    "killSwitches.set": ({ req, state, staff }) => {
      const body = req.body as ConsoleEndpointTypes["killSwitches.set"]["body"];
      const scope = body.scope as KillSwitchScope;
      if (!staff || !KILL_SWITCH_SCOPE_ROLES[scope] || !roleAllowed(staff, KILL_SWITCH_SCOPE_ROLES[scope])) return errorResponse(403, "STAFF_ROLE_NOT_PERMITTED");
      if (!OPERATOR_REASON_RE.test(body.reason)) return errorResponse(400, "REASON_NOT_ALLOWED");
      if (body.confirmationPhrase !== `${body.engaged ? "ENGAGE" : "RELEASE"} ${body.scope} ${body.target}`) return errorResponse(400, "CONFIRMATION_MISMATCH");
      const existing = state.killSwitches.switches.find((s) => s.scope === scope && s.target === body.target);
      const updated: KillSwitchView = {
        switchId: existing?.switchId ?? nextId(state, "ksw"),
        scope,
        target: body.target,
        engaged: body.engaged,
        reason: body.reason,
        changedBy: staff.staffId,
        changedAt: fx.NOW,
      };
      state.killSwitches = {
        ...state.killSwitches,
        switches: existing ? state.killSwitches.switches.map((s) => (s === existing ? updated : s)) : [...state.killSwitches.switches, updated],
      };
      return json(200, { switch: updated, auditEventId: nextId(state, "aud"), safetyRoutesPreserved: true });
    },
    "audit.search": () => json(200, fx.auditSearch()),
    "destinations.list": () => json(200, fx.destinations()),
    "breakGlass.list": () => json(200, { requests: [] }),
    "breakGlass.request": ({ req, staff, state }) => {
      const body = req.body as { justificationCode: string; durationSeconds: number };
      return json(200, {
        request: {
          requestId: nextId(state, "bgr"),
          requestedBy: (staff as StaffView).staffId,
          justificationCode: body.justificationCode,
          durationSeconds: body.durationSeconds,
          requestedAt: "2026-10-17T15:00:00.000Z",
          decideBy: "2026-10-17T16:00:00.000Z",
          status: "PENDING",
          decidedBy: null,
          decidedAt: null,
          grantId: null,
          grantExpiresAt: null,
        },
      });
    },
    "breakGlass.decide": () => errorResponse(404, "NOT_FOUND"),
    "accessReviews.list": () => json(200, { reviews: [] }),
    "accessReviews.complete": () => errorResponse(404, "NOT_FOUND"),
    "recoveryIdentities.list": () => json(200, { identities: [] }),
    "recoveryIdentities.propose": () => errorResponse(503, "RECOVERY_NOT_CONFIGURED"),
    "recoveryIdentities.confirm": () => errorResponse(404, "NOT_FOUND"),
    "recoveryIdentities.approve": () => errorResponse(404, "NOT_FOUND"),
    "recoveryIdentities.revoke": () => errorResponse(404, "NOT_FOUND"),
  };
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const staffByToken = new Map<string, StaffView>();
  const tokenFor = (s: StaffView) => `synthetic-token.${s.staffId}`;
  const registerStaff = (s: StaffView) => staffByToken.set(tokenFor(s), s);
  for (const k of fx.ALL_STAFF_KEYS) registerStaff(fx.staffView(k));
  for (const s of options.staff ?? []) registerStaff(s);

  const state: MockState = {
    authConfig: options.authConfig ?? fx.authConfigLocal(),
    meOverrides: options.meOverrides ?? {},
    killSwitches: fx.killSwitches(),
    reconciliation: fx.reconciliation(),
    reconcileOutcomes: {},
    latestReconcile: {},
    pending: fx.pendingActions(),
    tasks: fx.workflowTasks(),
    inject: {},
    sequence: 0,
  };
  const handlers: Partial<Record<EndpointKey, Handler>> = { ...options.handlers };
  const base = defaults();
  let rotations = 0;
  // SYNTHETIC session refresh: the presented bearer is rotated to a new one for the same staff member.
  base["auth.refresh"] = ({ req }) => {
    const auth = req.headers.authorization ?? "";
    const current = auth.startsWith("Bearer ") ? staffByToken.get(auth.slice(7)) : undefined;
    if (!current) return errorResponse(401, "SESSION_INVALID");
    rotations += 1;
    const next = `${tokenFor(current)}.r${rotations}`;
    staffByToken.set(next, current);
    staffByToken.delete(auth.slice(7));
    return json(200, { accessToken: next, tokenType: "Bearer", expiresAt: "2099-01-01T00:00:00.000Z", localFixture: false, sessionKind: "OIDC_SSO", idleTimeoutSeconds: 900 });
  };
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://console.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToRecord(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as unknown;
    const route = ROUTES.find((r) => r.method === method && r.re.test(url.pathname));
    const params: Record<string, string> = {};
    if (route) {
      const m = route.re.exec(url.pathname);
      route.names.forEach((n, i) => {
        params[n] = decodeURIComponent(m?.[i + 1] ?? "");
      });
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const req: RecordedRequest = { key: route?.key ?? null, method, path: url.pathname, url: raw, query, headers, body, params };
    requests.push(req);

    let res: MockResponse;
    let staff: StaffView | null = null;
    if (!route) {
      res = errorResponse(404, "NOT_FOUND");
    } else {
      if (!PUBLIC.has(route.key)) {
        const auth = headers.authorization ?? "";
        staff = auth.startsWith("Bearer ") ? (staffByToken.get(auth.slice(7)) ?? null) : null;
      }
      if (!PUBLIC.has(route.key) && !staff) {
        res = errorResponse(401, "UNAUTHENTICATED");
      } else if (staff && !roleAllowed(staff, ENDPOINT_ROLES[route.key as AuthenticatedEndpointKey])) {
        res = errorResponse(403, "STAFF_ROLE_NOT_PERMITTED");
      } else {
        const handler = handlers[route.key] ?? base[route.key];
        res = await handler({ req, staff, state });
        const extra = state.inject[route.key];
        if (extra && res.status === 200 && res.body && typeof res.body === "object") res = { ...res, body: { ...(res.body as object), ...extra } };
      }
    }
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  };

  return {
    fetch: fetchImpl as typeof fetch,
    requests,
    calls: (key) => requests.filter((r) => r.key === key),
    state,
    registerStaff,
    tokenFor,
    setHandler: (key, handler) => {
      if (handler) handlers[key] = handler;
      else delete handlers[key];
    },
  };
}
