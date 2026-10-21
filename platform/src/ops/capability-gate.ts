/**
 * Per-capability gate of the live composition (WP-07; FO-00-26, FO-00-30, FO-21-10; SAFE-02, OPS-01).
 *
 * A capability that is NOT_CONFIGURED in the activation map (platform/src/main/capabilities.ts) is refused
 * before any of its ports is reached, on two surfaces:
 *
 *  - admission (`CapabilityGatedAdmission`): a tool call whose intent needs an integration of a NOT_CONFIGURED
 *    capability (the policy catalogue's `integrations` of the intent's actions) or a capability the intent
 *    depends on directly (knowledge for public FAQ answers) is refused CAPABILITY_NOT_CONFIGURED with the
 *    HUMAN_QUEUE continuity route, never a silent drop and never a canned answer. Safety and human routes are
 *    never gated (SAFE-02): the pipeline does not ask admission for them, and this gate also admits the SAFETY
 *    and HUMAN_ROUTE classes itself (defence in depth).
 *  - hold (`CapabilityHoldKillSwitches`): background work of a NOT_CONFIGURED integration (support-record
 *    sync, notifications) is HELD exactly as if its INTEGRATION kill switch were engaged: the snapshot every
 *    gate reads lists the integration as switched off. Held work stays pending; nothing is dropped.
 *
 * Both count vsp_capability_refusals_total{capability, surface}. A path that skips both reaches a guard port
 * (adapters/live/not-configured.ts), which fails closed and pages (capability-guard-port-reached).
 */
import type { RuntimeCapabilityId } from "../observability/composition-catalog.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { AdmissionController, AdmissionDecision, KillSwitchService, KillSwitchSnapshot } from "./ports.js";

export const CAPABILITY_NOT_CONFIGURED_REASON = "CAPABILITY_NOT_CONFIGURED";

/** The activation map as the gate reads it. */
export interface CapabilityStateReader {
  isConfigured(capabilityId: RuntimeCapabilityId): boolean;
  /** Runtime capability of an integration id (policy catalogue / adapter key), or null when unknown. */
  capabilityOfIntegration(integrationId: string): RuntimeCapabilityId | null;
}

/** intent -> integrations, from the policy catalogue (every action of the intent contributes its integrations). */
export function intentIntegrationsFrom(catalogue: { actions: Record<string, { intent?: string; integrations?: readonly string[] }> } | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of Object.values(catalogue?.actions ?? {})) {
    if (!a.intent) continue;
    const set = out.get(a.intent) ?? new Set<string>();
    for (const i of a.integrations ?? []) set.add(i);
    out.set(a.intent, set);
  }
  return out;
}

/** Intents that depend on a capability without naming an integration in the policy catalogue. */
export const INTENT_CAPABILITY_DEPENDENCIES: Readonly<Record<string, readonly RuntimeCapabilityId[]>> = Object.freeze({
  public_faq: ["knowledge.retrieval"],
  login_help: ["knowledge.retrieval"],
});

export interface CapabilityGateOptions {
  states: CapabilityStateReader;
  intentIntegrations: ReadonlyMap<string, ReadonlySet<string>>;
  metrics?: Metrics | null;
  logger?: Logger;
}

function blockingCapability(intent: string | null, o: CapabilityGateOptions): RuntimeCapabilityId | null {
  if (!intent) return null;
  for (const integration of o.intentIntegrations.get(intent) ?? []) {
    const cap = o.states.capabilityOfIntegration(integration);
    // An integration nobody classified is treated as NOT_CONFIGURED (fail closed).
    if (cap === null) return "platform.composition";
    if (!o.states.isConfigured(cap)) return cap;
  }
  for (const cap of INTENT_CAPABILITY_DEPENDENCIES[intent] ?? []) if (!o.states.isConfigured(cap)) return cap;
  return null;
}

export class CapabilityGatedAdmission implements AdmissionController {
  private readonly logger: Logger;

  constructor(
    private readonly inner: AdmissionController,
    private readonly o: CapabilityGateOptions,
  ) {
    this.logger = (o.logger ?? silentLogger).child({ component: "capability_gate" });
  }

  async admit(input: Parameters<AdmissionController["admit"]>[0]): Promise<AdmissionDecision> {
    if (input.class !== "SAFETY" && input.class !== "HUMAN_ROUTE") {
      const cap = blockingCapability(input.workflow, this.o);
      if (cap) {
        try {
          this.o.metrics?.increment("vsp_capability_refusals_total", { capability: cap, surface: "admission" });
        } catch {
          // a metrics failure never turns a refusal into an admission
        }
        this.logger.info("capability.admission_refused", { reasonCode: CAPABILITY_NOT_CONFIGURED_REASON, intent: input.workflow });
        return { admitted: false, continuity: "HUMAN_QUEUE", reasonCode: CAPABILITY_NOT_CONFIGURED_REASON, sessionLeaseId: null };
      }
    }
    return this.inner.admit(input);
  }

  recordCost(input: Parameters<AdmissionController["recordCost"]>[0]): Promise<void> {
    return this.inner.recordCost(input);
  }

  releaseSession(leaseId: string): void {
    this.inner.releaseSession?.(leaseId);
  }
}

/**
 * Kill-switch service whose snapshot also lists every integration of a NOT_CONFIGURED capability as switched
 * off (held). Engaging and listing switches pass through unchanged (the console shows the real switches).
 */
export class CapabilityHoldKillSwitches implements KillSwitchService {
  private readonly states: CapabilityStateReader;
  private readonly integrations: readonly string[];
  private readonly metrics: Metrics | null;

  constructor(
    private readonly inner: KillSwitchService,
    o: { states: CapabilityStateReader; integrations: readonly string[]; metrics?: Metrics | null },
  ) {
    this.states = o.states;
    this.integrations = [...o.integrations];
    this.metrics = o.metrics ?? null;
  }

  /** Integrations held because their capability is NOT_CONFIGURED (read from the activation map on each call). */
  get heldIntegrations(): readonly string[] {
    return this.integrations.filter((i) => {
      const cap = this.states.capabilityOfIntegration(i);
      return cap === null || !this.states.isConfigured(cap);
    });
  }

  async snapshot(tenantId: string): Promise<KillSwitchSnapshot> {
    const s = await this.inner.snapshot(tenantId);
    const held = this.heldIntegrations;
    if (held.length === 0) return s;
    return { ...s, integrations: [...new Set([...s.integrations, ...held])] };
  }

  /** Counts a background item held for a NOT_CONFIGURED integration (the gates call it when they hold). */
  countHold(integrationId: string): void {
    const cap = this.states.capabilityOfIntegration(integrationId);
    if (!cap || !this.heldIntegrations.includes(integrationId)) return;
    try {
      this.metrics?.increment("vsp_capability_refusals_total", { capability: cap, surface: "hold" });
    } catch {
      // never affects the hold
    }
  }

  set(input: Parameters<KillSwitchService["set"]>[0]): ReturnType<KillSwitchService["set"]> {
    return this.inner.set(input);
  }

  list(tenantId: string): ReturnType<KillSwitchService["list"]> {
    return this.inner.list(tenantId);
  }
}
