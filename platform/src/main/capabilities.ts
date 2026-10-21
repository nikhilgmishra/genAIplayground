/**
 * Per-capability activation map of the live composition (WP-07; FO-00-26, FO-00-30, FO-19-06, FO-21-03).
 *
 * Every runtime capability (docs/followon/capabilities.yaml ids, RUNTIME_CAPABILITY_IDS) is CONFIGURED or
 * NOT_CONFIGURED in this process, with the reasons kept apart:
 *   - reasons:        reason codes from the configuration guard (`<CODE>@<config path>`, tenant inputs that are
 *                     missing or invalid) and from the composition (a component it could not build);
 *   - softwareGaps:   code that does not exist yet, with the package that owns it (never hidden behind a
 *                     missing input, FO-00-30: "an adapter stub is not a missing BAA");
 *   - externalInputs: the activation register entries (AIN ids) the capability waits on.
 * A NOT_CONFIGURED capability never fails the whole process: its gate refuses its work (ops/capability-gate.ts)
 * and its ports are guard ports (adapters/live/not-configured.ts). The map is exported as the gauge
 * vsp_capability_state{capability,state} and listed (ids and states only) by /health/ready.
 */
import type { GuardReport } from "../config/guard.js";
import type { PlatformConfig } from "../config/ports.js";
import { ADAPTER_CAPABILITY } from "../config/rules/index.js";
import { RUNTIME_CAPABILITY_IDS } from "../observability/composition-catalog.js";
import type { RuntimeCapabilityId } from "../observability/composition-catalog.js";
import type { Metrics } from "../observability/ports.js";
import type { CapabilityStateReader } from "../ops/capability-gate.js";

export type CapabilityState = "CONFIGURED" | "NOT_CONFIGURED";

/** Owners and activation register entries per capability (docs/followon/capabilities.yaml; the test keeps them equal). */
export const CAPABILITY_REGISTER: Readonly<Record<RuntimeCapabilityId, { owners: readonly string[]; activationIds: readonly string[] }>> = Object.freeze({
  "platform.substrate": { owners: ["WP-04", "WP-06", "WP-15"], activationIds: ["AIN-01", "AIN-03", "AIN-05", "AIN-34"] },
  "platform.composition": { owners: ["WP-07"], activationIds: ["AIN-01", "AIN-12", "AIN-13", "AIN-36", "AIN-37"] },
  "audit.independent": { owners: ["WP-04"], activationIds: ["AIN-01", "AIN-03", "AIN-25"] },
  "ingress.events": { owners: ["WP-04"], activationIds: ["AIN-01", "AIN-06", "AIN-07", "AIN-16", "AIN-36", "AIN-38"] },
  "identity.caller": { owners: ["WP-05", "WP-07", "WP-19"], activationIds: ["AIN-08", "AIN-12", "AIN-13", "AIN-15"] },
  "identity.workforce": { owners: ["WP-05", "WP-07"], activationIds: ["AIN-12", "AIN-13", "AIN-15"] },
  "authority.registries": { owners: ["WP-19", "WP-24", "WP-30"], activationIds: ["AIN-10", "AIN-12", "AIN-14", "AIN-24"] },
  "connectors.runtime": { owners: ["WP-04", "WP-06", "WP-07", "WP-32", "WP-40"], activationIds: ["AIN-01", "AIN-06", "AIN-09", "AIN-10", "AIN-12", "AIN-25", "AIN-36"] },
  "domain.business_systems": { owners: ["WP-23"], activationIds: ["AIN-06", "AIN-10", "AIN-11", "AIN-12", "AIN-36"] },
  "crm.salesforce": { owners: ["WP-29"], activationIds: ["AIN-01", "AIN-09", "AIN-34"] },
  "contact_center.talkdesk": { owners: ["WP-29"], activationIds: ["AIN-02", "AIN-06", "AIN-07", "AIN-08", "AIN-09", "AIN-19", "AIN-34", "AIN-39", "AIN-51"] },
  "handoff.transfer": { owners: ["WP-28", "WP-30"], activationIds: ["AIN-06", "AIN-07", "AIN-14", "AIN-18", "AIN-19", "AIN-20", "AIN-21", "AIN-22"] },
  "notifications.messaging": { owners: ["WP-27"], activationIds: ["AIN-02", "AIN-16"] },
  "knowledge.retrieval": { owners: ["WP-06", "WP-20"], activationIds: ["AIN-01", "AIN-02", "AIN-09", "AIN-13", "AIN-24", "AIN-27", "AIN-29", "AIN-32", "AIN-48"] },
  "operator.console": { owners: ["WP-07", "WP-38", "WP-39"], activationIds: ["AIN-01", "AIN-06", "AIN-12", "AIN-13", "AIN-16", "AIN-18", "AIN-19", "AIN-30", "AIN-31"] },
  "workflows.durable": { owners: ["WP-26"], activationIds: ["AIN-01", "AIN-02", "AIN-10", "AIN-11", "AIN-13", "AIN-38"] },
  "privacy.operations": { owners: ["WP-06", "WP-22", "WP-24", "WP-25", "WP-35", "WP-39", "WP-40"], activationIds: ["AIN-05", "AIN-14", "AIN-24", "AIN-25"] },
  "context.store": { owners: ["WP-18"], activationIds: ["AIN-38"] },
  "models.providers": { owners: ["WP-08", "WP-15", "WP-17"], activationIds: ["AIN-01", "AIN-02", "AIN-26", "AIN-27", "AIN-28", "AIN-48"] },
  "voice.media_runtime": { owners: ["WP-11"], activationIds: ["AIN-06", "AIN-08", "AIN-18", "AIN-46", "AIN-50"] },
  "conversation.harness": { owners: ["WP-10"], activationIds: ["AIN-02", "AIN-10", "AIN-16", "AIN-21", "AIN-22", "AIN-26", "AIN-31"] },
  "operations.resilience_cost": { owners: ["WP-42"], activationIds: ["AIN-01", "AIN-04", "AIN-19", "AIN-20", "AIN-30", "AIN-39"] },
});

/** What the composition knows about one capability beyond the configuration guard. */
export interface CompositionFact {
  /** False: the composition could not build the capability from what it has (reasons say why). */
  composed: boolean;
  reasons?: readonly string[];
  /** Code that does not exist yet (the composition composed a guard port in its place). */
  softwareGaps?: readonly { owner: string; reasonCode: string }[];
}

/**
 * audit.independent: the exporter unit's Object Lock sink needs the export block, the sink and the
 * counsel-approved SECURITY_AUDIT retention (the sink refuses AUDIT_RETENTION_UNAPPROVED otherwise), so the
 * capability is CONFIGURED only with all three.
 */
export function auditIndependentFact(config: Pick<PlatformConfig, "infrastructure" | "retention">): CompositionFact {
  const infra = config.infrastructure;
  if (!infra?.auditExport || !infra.auditSink) return { composed: false, reasons: ["AUDIT_EXPORT_NOT_CONFIGURED@infrastructure.auditExport"] };
  if (config.retention.SECURITY_AUDIT === null) return { composed: false, reasons: ["AUDIT_RETENTION_UNAPPROVED@retention.SECURITY_AUDIT"] };
  return { composed: true };
}

export interface CapabilityActivationEntry {
  capabilityId: RuntimeCapabilityId;
  state: CapabilityState;
  reasons: string[];
  softwareGaps: { owner: string; reasonCode: string }[];
  externalInputs: readonly string[];
  components: { component: string; state: CapabilityState }[];
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}(@[A-Za-z0-9_.:|[\]-]{1,160})?$/;

export class ActivationMap implements CapabilityStateReader {
  private readonly byId: ReadonlyMap<RuntimeCapabilityId, CapabilityActivationEntry>;

  constructor(entries: readonly CapabilityActivationEntry[]) {
    const m = new Map<RuntimeCapabilityId, CapabilityActivationEntry>();
    for (const e of entries) m.set(e.capabilityId, Object.freeze({ ...e, reasons: [...e.reasons], softwareGaps: [...e.softwareGaps], components: [...e.components] }) as CapabilityActivationEntry);
    for (const id of RUNTIME_CAPABILITY_IDS) if (!m.has(id)) throw new TypeError(`ACTIVATION_MAP_INCOMPLETE:${id}`);
    this.byId = m;
  }

  entries(): CapabilityActivationEntry[] {
    return RUNTIME_CAPABILITY_IDS.map((id) => this.byId.get(id) as CapabilityActivationEntry);
  }

  /** The capability's entry (state, reasons, software gaps, external inputs, components). */
  get(id: RuntimeCapabilityId): CapabilityActivationEntry | null {
    return this.byId.get(id) ?? null;
  }

  state(id: RuntimeCapabilityId): CapabilityState {
    return this.byId.get(id)?.state ?? "NOT_CONFIGURED";
  }

  isConfigured(id: RuntimeCapabilityId): boolean {
    return this.state(id) === "CONFIGURED";
  }

  capabilityOfIntegration(integrationId: string): RuntimeCapabilityId | null {
    return Object.hasOwn(ADAPTER_CAPABILITY, integrationId) ? (ADAPTER_CAPABILITY[integrationId] ?? null) : null;
  }

  notConfigured(): RuntimeCapabilityId[] {
    return this.entries()
      .filter((e) => e.state === "NOT_CONFIGURED")
      .map((e) => e.capabilityId);
  }

  /** Ids and states only (the unauthenticated readiness route never lists reasons or inputs). */
  health(): { capabilityId: RuntimeCapabilityId; state: CapabilityState }[] {
    return this.entries().map((e) => ({ capabilityId: e.capabilityId, state: e.state }));
  }

  /** Sets vsp_capability_state for every capability (1 for its state, 0 for the other). */
  export(metrics: Pick<Metrics, "gauge">): void {
    for (const e of this.entries()) {
      try {
        metrics.gauge("vsp_capability_state", e.state === "CONFIGURED" ? 1 : 0, { capability: e.capabilityId, state: "configured" });
        metrics.gauge("vsp_capability_state", e.state === "NOT_CONFIGURED" ? 1 : 0, { capability: e.capabilityId, state: "not_configured" });
      } catch {
        // metrics never change the activation state
      }
    }
  }
}

/**
 * Builds the map: a capability is CONFIGURED only when the guard reports none of its components
 * NOT_CONFIGURED, the composition composed it, and it has no software gap. Any doubt is NOT_CONFIGURED.
 */
export function buildActivationMap(report: Pick<GuardReport, "components">, facts: Readonly<Partial<Record<RuntimeCapabilityId, CompositionFact>>>): ActivationMap {
  const entries: CapabilityActivationEntry[] = RUNTIME_CAPABILITY_IDS.map((capabilityId) => {
    const components = report.components.filter((c) => c.capabilityId === capabilityId);
    const fact = facts[capabilityId];
    const reasons = [...new Set([...components.flatMap((c) => c.reasons), ...(fact?.reasons ?? [])])].filter((r) => REASON.test(r));
    const softwareGaps = [...(fact?.softwareGaps ?? [])];
    const configured = fact !== undefined && fact.composed && softwareGaps.length === 0 && components.every((c) => c.state === "CONFIGURED");
    if (fact === undefined) reasons.push("CAPABILITY_NOT_COMPOSED");
    return {
      capabilityId,
      state: configured ? "CONFIGURED" : "NOT_CONFIGURED",
      reasons,
      softwareGaps,
      externalInputs: CAPABILITY_REGISTER[capabilityId].activationIds,
      components: components.map((c) => ({ component: c.component, state: c.state })),
    };
  });
  return new ActivationMap(entries);
}
