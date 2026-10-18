/**
 * INTEGRATION / WRITES kill-switch gate for background integration calls (spec section 13
 * "kill switch for ... an integration"; RB-KILL-SWITCH "Calls to that integration stop";
 * OPS-KS-02).
 *
 * The gateway already refuses tool calls whose policy action lists an engaged integration.
 * Background work (the worker's support_request.sync consumer and the support.sync_retry
 * sweep) reached Salesforce without reading any switch. This module provides:
 *
 *  - `integrationHold(snapshot, { integration, write })`: pure decision. A WRITE is held
 *    when WRITES or INTEGRATION <integration> is engaged; a read when INTEGRATION
 *    <integration> is engaged. An unreadable snapshot holds everything (fail closed).
 *  - `KillSwitchGatedSupportRecords`: wraps the SupportRecordSystem port (Salesforce) so
 *    every upsert / lookup checks the current snapshot before the vendor is called and
 *    throws IntegrationHeldError (outcome NOT_STARTED: nothing reached the vendor) when held.
 *    It also exposes `holdReason(write)` (HoldAwareIntegration) so a caller can check before
 *    claiming work and spend no retry attempt on a held call.
 *  - `integrationHoldReader`: the same decision for sweeps that should not even enqueue work.
 *
 * A hold is not a failure: callers keep the work pending (no retry budget is spent, nothing
 * is dead-lettered) and resume after the switch is released. Safety and human routes never
 * depend on these calls (support records are synchronized asynchronously).
 */
import type { AdapterHealth, CaseFields, SupportRecordSystem } from "../adapters/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger } from "../observability/ports.js";
import { DependencyError, PlatformError } from "../shared/errors.js";
import type { KillSwitchSnapshot } from "./ports.js";

export type IntegrationHoldReason = "KILL_SWITCH_INTEGRATION" | "KILL_SWITCH_WRITES" | "KILL_SWITCH_STATE_UNAVAILABLE";

/** Thrown before the vendor is called; `held` marks it as "keep pending", not as a failure. */
export class IntegrationHeldError extends DependencyError {
  readonly held = true as const;
  constructor(reasonCode: IntegrationHoldReason) {
    super(reasonCode, "NOT_STARTED", true);
  }
}

export function isIntegrationHeld(err: unknown): err is IntegrationHeldError {
  return err instanceof IntegrationHeldError || (err instanceof PlatformError && (err as { held?: unknown }).held === true);
}

export function integrationHold(snapshot: KillSwitchSnapshot | null, req: { integration: string; write: boolean }): IntegrationHoldReason | null {
  if (!snapshot || typeof snapshot.writes !== "boolean" || !Array.isArray(snapshot.integrations)) return "KILL_SWITCH_STATE_UNAVAILABLE";
  if (snapshot.integrations.includes(req.integration)) return "KILL_SWITCH_INTEGRATION";
  if (req.write && snapshot.writes) return "KILL_SWITCH_WRITES";
  return null;
}

/** Reads the snapshot and returns the hold reason; any read failure holds (fail closed). */
export async function integrationHoldReader(snapshot: () => Promise<KillSwitchSnapshot>, req: { integration: string; write: boolean }): Promise<IntegrationHoldReason | null> {
  let s: KillSwitchSnapshot | null;
  try {
    s = await snapshot();
  } catch {
    s = null;
  }
  return integrationHold(s, req);
}

/**
 * Adapters that can say, before any work is claimed, whether a call would be held. Callers that
 * must not spend a retry attempt on a held call (support_request.sync) check this first.
 */
export interface HoldAwareIntegration {
  holdReason(write: boolean): Promise<IntegrationHoldReason | null>;
}

/** The adapter's hold check, or null for an adapter composed without a kill-switch gate. */
export async function holdReasonOf(adapter: unknown, write: boolean): Promise<IntegrationHoldReason | null> {
  const fn = (adapter as Partial<HoldAwareIntegration> | null)?.holdReason;
  return typeof fn === "function" ? fn.call(adapter, write) : null;
}

export interface KillSwitchGatedSupportRecordsOptions {
  inner: SupportRecordSystem;
  /** Snapshot for the deployment's tenant (KillSwitchService.snapshot); failures hold. */
  snapshot: () => Promise<KillSwitchSnapshot>;
  logger?: Logger;
}

export class KillSwitchGatedSupportRecords implements SupportRecordSystem, HoldAwareIntegration {
  readonly kind: SupportRecordSystem["kind"];
  readonly integrationId: string;
  private readonly logger: Logger;

  constructor(private readonly opts: KillSwitchGatedSupportRecordsOptions) {
    this.kind = opts.inner.kind;
    this.integrationId = opts.inner.integrationId;
    this.logger = (opts.logger ?? silentLogger).child({ component: "integration_gate" });
  }

  health(): Promise<AdapterHealth> {
    return this.opts.inner.health();
  }

  holdReason(write: boolean): Promise<IntegrationHoldReason | null> {
    return integrationHoldReader(this.opts.snapshot, { integration: this.integrationId, write });
  }

  private async gate(write: boolean): Promise<void> {
    const reason = await this.holdReason(write);
    if (reason) {
      this.logger.warn("integration.call_held_by_kill_switch", { integration: this.integrationId, reasonCode: reason });
      throw new IntegrationHeldError(reason);
    }
  }

  async upsertInteraction(externalId: string, fields: { callId: string; language: string; consentStatus: string; startedAt: string }): Promise<{ recordId: string; created: boolean }> {
    await this.gate(true);
    return this.opts.inner.upsertInteraction(externalId, fields);
  }

  async upsertCase(externalId: string, interactionExternalId: string, fields: CaseFields): Promise<{ caseId: string; created: boolean }> {
    await this.gate(true);
    return this.opts.inner.upsertCase(externalId, interactionExternalId, fields);
  }

  async getCaseByExternalId(externalId: string): Promise<{ caseId: string; status: string; ownerQueue: string } | null> {
    await this.gate(false);
    return this.opts.inner.getCaseByExternalId(externalId);
  }
}
