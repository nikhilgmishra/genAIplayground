/**
 * Content-free audit helper for gateway session, verification, confirmation and
 * safety events (spec section 13 audit event model). Audit events carry the
 * NON-bearer session binding ref (identity/keys.ts sessionBindingRefFor), never
 * the bearer session reference; reason codes only; no caller words, digits,
 * locators, tokens or transcript text.
 */
import type { AuditWriter } from "../audit/ports.js";
import { buildAuditInput } from "../audit/build-input.js";
import { isSessionBindingRef, sessionBindingRefFor } from "../identity/keys.js";
import type { Logger } from "../observability/ports.js";
import type { AuditOutcome, AuditSourceComponent, AuthContext, VersionSet } from "../protocol/index.js";
import { OpaqueId } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { PlatformError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";

export interface GatewayAuditEvent {
  tenantId: string;
  action: string;
  outcome: AuditOutcome;
  sourceComponent: AuditSourceComponent;
  ctx?: AuthContext | null;
  /** Bearer reference when no AuthContext resolved; converted to the binding ref (never stored as is). */
  sessionRef?: string | null;
  callId?: string | null;
  /**
   * Added (additive): the NON-bearer session binding ref (`ses_bnd_...`) when no AuthContext or
   * bearer ref is at hand (portal verification completion). Stored as is; anything else is dropped.
   */
  sessionBindingRef?: string | null;
  /** Added (additive): session generation when no AuthContext resolved (portal verification completion). */
  sessionGeneration?: number | null;
  reasonCode?: string | null;
  evidencePointers?: string[];
  correlationId?: string;
  turnId?: string | null;
  idempotencyKey?: string | null;
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

function bindingRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    return sessionBindingRefFor(ref);
  } catch {
    return null;
  }
}

export class GatewayAudit {
  constructor(
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly versions: VersionSet | null,
  ) {}

  /** Appends one event standalone. Returns the event id, or null when it could not be written (logged). */
  async record(e: GatewayAuditEvent): Promise<string | null> {
    try {
      const ctx = e.ctx ?? null;
      const input = buildAuditInput(
        {
          tenantId: e.tenantId,
          correlationId: e.correlationId && OpaqueId.safeParse(e.correlationId).success ? e.correlationId : newId("cor"),
          sourceComponent: e.sourceComponent,
          action: e.action,
          outcome: e.outcome,
          actorRef: ctx?.actorId ?? null,
          subjectRef: ctx?.subjectId ?? null,
          role: ctx?.selectedRole ?? null,
          callId: ctx?.callId ?? (e.callId && OpaqueId.safeParse(e.callId).success ? e.callId : null),
          sessionRef: bindingRef(ctx?.sessionRef ?? e.sessionRef ?? null) ?? (e.sessionBindingRef && isSessionBindingRef(e.sessionBindingRef) ? e.sessionBindingRef : null),
          sessionGeneration: ctx?.sessionGeneration ?? (typeof e.sessionGeneration === "number" && Number.isSafeInteger(e.sessionGeneration) && e.sessionGeneration >= 1 ? e.sessionGeneration : null),
          turnId: e.turnId ?? null,
          versions: this.versions,
          assurance: ctx?.assurance ?? null,
          evidencePointers: (e.evidencePointers ?? []).slice(0, 16),
          idempotencyKey: e.idempotencyKey ?? null,
          reasonCode: e.reasonCode && REASON.test(e.reasonCode) && !/\d{4,}/.test(e.reasonCode) ? e.reasonCode : null,
        },
        this.clock,
      );
      return (await this.audit.appendStandalone(input)).eventId;
    } catch (err) {
      this.logger.warn("gateway.audit.append_failed", { reasonCode: err instanceof PlatformError ? err.reasonCode : "AUDIT_UNAVAILABLE", action: e.action });
      return null;
    }
  }
}
