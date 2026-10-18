/**
 * Session binding for tool calls (TB-01; ADR-0003; spec section 7 "Bind the
 * opaque session reference to the authenticated Talkdesk integration and current
 * call; possession of an interaction ID alone is not authority").
 *
 * Modes (PlatformConfig.sessionBinding.mode):
 *  - trusted_header: the session reference comes ONLY from the trusted transport
 *    header (X-VSP-Session-Ref) that Talkdesk injects from non-model context.
 *    A `sessionRef` in tool arguments is never read.
 *  - server_to_server_lookup: the trusted transport supplies the vendor
 *    interaction id (X-VSP-Interaction-Id); an InteractionLookup maps
 *    (tenant, integration, interaction id) to the session TC-01 bound for that
 *    call. Offline this is a LOCAL FIXTURE populated by the telephony-control
 *    start-call operation; live it is BLOCKED pending TB-01 (no undocumented
 *    vendor API is assumed). The resolved session must belong to that call.
 *  - tool_argument_lookup_exception: the model-supplied `sessionRef` argument is
 *    accepted ONLY with an approved security exception (AR-09) recorded in
 *    configuration. All binding checks still apply.
 *
 * Whatever the mode, the AuthContext is reconstructed from server-side state by
 * SessionService.resolve (integration, tenant, environment, expiry, revocation,
 * end of call, generation) on every request.
 */
import { BlockedCapabilityError } from "../adapters/errors.js";
import type { IntegrationIdentity } from "../protocol/index.js";
import { OpaqueId, SessionRef } from "../protocol/index.js";
import type { AuthContext } from "../protocol/index.js";
import { DependencyError, PlatformError, SessionInvalidError } from "../shared/errors.js";
import type { SessionService } from "../identity/ports.js";

export type SessionBindingMode = "trusted_header" | "server_to_server_lookup" | "tool_argument_lookup_exception";

/** Trusted transport header names (proposed in talkdesk/mcp-connection.md section 5). */
export const SESSION_REF_HEADER = "x-vsp-session-ref";
export const INTERACTION_ID_HEADER = "x-vsp-interaction-id";
export const TURN_ID_HEADER = "x-vsp-turn-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export interface InteractionLookup {
  readonly kind: "local_fixture" | "live";
  /** Returns the bearer session reference bound to this call by TC-01, or null. */
  lookup(input: { tenantId: string; integrationId: string; interactionId: string }): Promise<string | null>;
}

/**
 * LOCAL FIXTURE: in-memory (per process) interaction -> session index, written by
 * the telephony-control start-call route. Holds bearer references in memory only;
 * never logged, persisted or returned by any route.
 */
export class LocalInteractionLookupFixture implements InteractionLookup {
  readonly kind = "local_fixture" as const;
  private readonly map = new Map<string, string>();
  private static key(i: { tenantId: string; integrationId: string; interactionId: string }): string {
    return `${i.tenantId}\u0000${i.integrationId}\u0000${i.interactionId}`;
  }
  bind(input: { tenantId: string; integrationId: string; interactionId: string }, sessionRef: string): void {
    this.map.set(LocalInteractionLookupFixture.key(input), sessionRef);
  }
  unbind(input: { tenantId: string; integrationId: string; interactionId: string }): void {
    this.map.delete(LocalInteractionLookupFixture.key(input));
  }
  async lookup(input: { tenantId: string; integrationId: string; interactionId: string }): Promise<string | null> {
    return this.map.get(LocalInteractionLookupFixture.key(input)) ?? null;
  }
}

/** Live interaction lookup: BLOCKED until Talkdesk documents the mechanism (TB-01, VQ-TD-23). */
export class BlockedInteractionLookup implements InteractionLookup {
  readonly kind = "live" as const;
  readonly capabilityStatus = "BLOCKED" as const;
  readonly prerequisites = ["PRQ-013", "PRQ-034"] as const;
  async lookup(): Promise<string | null> {
    throw new BlockedCapabilityError("talkdesk-telephony", "interaction_lookup", this.prerequisites);
  }
}

export interface BindingTransport {
  /** Value of the trusted session header, or null. */
  sessionRefHeader: string | null;
  /** Value of the trusted interaction-id header, or null. */
  interactionIdHeader: string | null;
}

export type BindingResult =
  | { ok: true; ctx: AuthContext; sessionRef: string }
  | { ok: false; reasonCode: string; retryable: boolean; sessionRef: string | null; callId: string | null };

export interface SessionBindingOptions {
  mode: SessionBindingMode;
  /** Approved exception id (required for tool_argument_lookup_exception; the config guard verifies it). */
  exceptionApprovalId: string | null;
  sessions: SessionService;
  lookup: InteractionLookup;
}

const HEADER_VALUE = /^[A-Za-z0-9_-]{4,128}$/;

export class SessionBindingResolver {
  readonly mode: SessionBindingMode;
  private readonly opts: SessionBindingOptions;

  constructor(opts: SessionBindingOptions) {
    this.opts = opts;
    this.mode = opts.mode;
    if (opts.mode === "tool_argument_lookup_exception" && !opts.exceptionApprovalId) {
      throw new PlatformError("SESSION_BINDING_EXCEPTION_UNAPPROVED");
    }
  }

  /** True when this mode reads the session reference from the `sessionRef` tool argument (approved exception only). */
  get readsArgumentSessionRef(): boolean {
    return this.mode === "tool_argument_lookup_exception" && this.opts.exceptionApprovalId !== null;
  }

  /**
   * Resolves the trusted AuthContext for a tool call. Never throws; failures are
   * reason codes so the pipeline can fail closed (or continue for SAFETY_AND_HUMAN_ROUTE).
   */
  async resolve(transport: BindingTransport, integration: IntegrationIdentity, argumentSessionRef: string | null): Promise<BindingResult> {
    let sessionRef: string | null = null;
    let expectedCallId: string | undefined;
    // The interaction id is an identifier only (never authority). When the trusted transport
    // supplies it, the session must belong to that call (MB-02), and it lets a sessionless
    // safety or human route name the call it is for (SAFE-02).
    const interactionHint = cleanHeader(transport.interactionIdHeader);
    const callHint = interactionHint && OpaqueId.safeParse(interactionHint).success ? interactionHint : null;
    if (this.mode === "trusted_header") {
      sessionRef = cleanHeader(transport.sessionRefHeader);
      if (callHint) expectedCallId = callHint;
      if (!sessionRef) return fail("SESSION_REF_MISSING", null, callHint);
    } else if (this.mode === "server_to_server_lookup") {
      const interactionId = cleanHeader(transport.interactionIdHeader);
      if (!interactionId) return fail("INTERACTION_ID_MISSING", null, null);
      const callId = OpaqueId.safeParse(interactionId).success ? interactionId : null;
      try {
        sessionRef = await this.opts.lookup.lookup({ tenantId: integration.tenantId, integrationId: integration.integrationId, interactionId });
      } catch (err) {
        return fail(err instanceof PlatformError ? err.reasonCode : "INTERACTION_LOOKUP_FAILED", null, callId, err instanceof DependencyError && err.outcome === "NOT_STARTED");
      }
      if (!sessionRef) return fail("SESSION_NOT_BOUND_TO_INTERACTION", null, callId);
      expectedCallId = interactionId;
    } else {
      if (!this.readsArgumentSessionRef) return fail("SESSION_BINDING_EXCEPTION_UNAPPROVED", null, callHint);
      sessionRef = typeof argumentSessionRef === "string" ? argumentSessionRef : null;
      if (callHint) expectedCallId = callHint;
      if (!sessionRef) return fail("SESSION_REF_MISSING", null, callHint);
    }
    if (!SessionRef.safeParse(sessionRef).success) return fail("SESSION_REF_INVALID", null, expectedCallId ?? null);
    try {
      const resolver = this.opts.sessions as SessionService & {
        resolve(ref: string, integ: IntegrationIdentity, options?: { expectedCallId?: string }): Promise<AuthContext>;
      };
      const ctx = await resolver.resolve(sessionRef, integration, expectedCallId !== undefined ? { expectedCallId } : undefined);
      if (expectedCallId !== undefined && ctx.callId !== expectedCallId) return fail("SESSION_CALL_MISMATCH", sessionRef, expectedCallId);
      return { ok: true, ctx, sessionRef };
    } catch (err) {
      if (err instanceof SessionInvalidError) return fail(err.reasonCode, sessionRef, expectedCallId ?? null);
      if (err instanceof DependencyError) return fail("SESSION_STORE_UNAVAILABLE", sessionRef, expectedCallId ?? null, err.outcome === "NOT_STARTED");
      return fail(err instanceof PlatformError ? err.reasonCode : "SESSION_RESOLUTION_FAILED", sessionRef, expectedCallId ?? null);
    }
  }
}

function cleanHeader(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return HEADER_VALUE.test(t) ? t : null;
}

function fail(reasonCode: string, sessionRef: string | null, callId: string | null, retryable = false): BindingResult {
  return { ok: false, reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(reasonCode) ? reasonCode : "SESSION_RESOLUTION_FAILED", retryable, sessionRef, callId };
}
