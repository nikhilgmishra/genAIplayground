/**
 * AdapterRegistry — records every adapter instantiated at startup with its
 * `kind` ("local_fixture" | "live"), integration id and capability status.
 *
 * Consumers:
 *  - the production configuration guard (platform/src/config/guard.ts) takes
 *    `kinds()` as `GuardContext.adapterKinds` and rejects any local_fixture in
 *    staging/production and any kind that differs from the declared config
 *    (OPS-04). The registry itself only reports; enforcement lives in the guard;
 *  - the operations console shows the "LOCAL FIXTURE" badge from `summary().badge`
 *    whenever ANY registered adapter is a fixture (spec section 16: "explicit
 *    local-adapter badge");
 *  - BLOCKED live stubs are listed separately so a BLOCKED capability is never
 *    reported as available (OPS-03).
 *
 * The registry fails closed: an adapter without a valid kind or integration id,
 * a duplicate component key or a registration after `freeze()` is rejected.
 * Component keys match the `adapters` keys in platform/config/*.json.
 */
import { SYNTHETIC_BADGE } from "../fixtures/synthetic-world.js";
import { PlatformError, ValidationError } from "../shared/errors.js";
import { REFUSAL_REASONS, UNSUPPORTED_UNDOCUMENTED, isBlockedCapability } from "./errors.js";
import type { RefusalReason } from "./errors.js";
import type { Adapter, AdapterHealth, AdapterKind } from "./ports.js";

const COMPONENT_KEY = /^[a-z][a-z0-9-]{2,63}$/;
const INTEGRATION_ID = /^[a-z][a-z0-9_-]{2,63}$/;

export interface AdapterRegistration {
  component: string;
  kind: AdapterKind;
  integrationId: string;
  /** "BLOCKED" for stubs whose capability is unverified; otherwise the adapter's declared status or "AVAILABLE". */
  capabilityStatus: string;
  prerequisites: string[];
  /** Fixture label (e.g. "LOCAL FIXTURE — SYNTHETIC DATA ONLY") when the adapter declares one. */
  label: string | null;
  /**
   * Operations the adapter refuses, with the typed reason (FO-06-25). A BLOCKED stub that declares none is
   * recorded as refusing every operation UNSUPPORTED_UNDOCUMENTED (`*`).
   */
  refusals: Record<string, RefusalReason>;
}

/** One refused operation of a live adapter (input of the live-composition scan). */
export interface LiveRefusal {
  component: string;
  integrationId: string;
  operation: string;
  refusal: RefusalReason;
}

export interface AdapterSummary {
  components: AdapterRegistration[];
  /** Exactly the shape of GuardContext.adapterKinds. */
  kinds: Record<string, AdapterKind>;
  localFixtureComponents: string[];
  liveComponents: string[];
  blockedComponents: string[];
  anyLocalFixture: boolean;
  /** Console badge text; null only when no registered adapter is a local fixture. */
  badge: string | null;
  frozen: boolean;
}

export interface AdapterHealthRow {
  component: string;
  integrationId: string;
  kind: AdapterKind;
  healthy: boolean;
  reasonCode: string | null;
}

export class AdapterRegistry {
  private readonly entries = new Map<string, { adapter: Adapter; registration: AdapterRegistration }>();
  private frozenFlag = false;

  register<T extends Adapter>(component: string, adapter: T): T {
    if (this.frozenFlag) throw new ValidationError("ADAPTER_REGISTRY_FROZEN");
    if (!COMPONENT_KEY.test(component)) throw new ValidationError("ADAPTER_COMPONENT_INVALID");
    if (this.entries.has(component)) throw new ValidationError("ADAPTER_COMPONENT_DUPLICATE");
    const kind = (adapter as { kind?: unknown } | null)?.kind;
    if (kind !== "local_fixture" && kind !== "live") throw new ValidationError("ADAPTER_KIND_INVALID");
    const integrationId = (adapter as { integrationId?: unknown }).integrationId;
    if (typeof integrationId !== "string" || !INTEGRATION_ID.test(integrationId)) throw new ValidationError("ADAPTER_INTEGRATION_ID_INVALID");
    if (typeof (adapter as { health?: unknown }).health !== "function") throw new ValidationError("ADAPTER_HEALTH_MISSING");
    const declared = (adapter as { capabilityStatus?: unknown }).capabilityStatus;
    const prerequisites = (adapter as { prerequisites?: unknown }).prerequisites;
    const label = (adapter as { label?: unknown }).label;
    this.entries.set(component, {
      adapter,
      registration: {
        component,
        kind,
        integrationId,
        capabilityStatus: isBlockedCapability(adapter) ? "BLOCKED" : typeof declared === "string" ? declared : "AVAILABLE",
        prerequisites: Array.isArray(prerequisites) ? prerequisites.filter((p): p is string => typeof p === "string") : [],
        label: typeof label === "string" ? label : null,
        refusals: declaredRefusals(adapter),
      },
    });
    return adapter;
  }

  /** No further registrations (call after startup wiring). */
  freeze(): this {
    this.frozenFlag = true;
    return this;
  }

  get frozen(): boolean {
    return this.frozenFlag;
  }

  has(component: string): boolean {
    return this.entries.has(component);
  }

  get<T extends Adapter = Adapter>(component: string): T {
    const e = this.entries.get(component);
    if (!e) throw new ValidationError("ADAPTER_NOT_REGISTERED");
    return e.adapter as T;
  }

  /** `kind` of every registered component, for GuardContext.adapterKinds. */
  kinds(): Record<string, AdapterKind> {
    const out: Record<string, AdapterKind> = {};
    for (const [component, e] of [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) out[component] = e.registration.kind;
    return out;
  }

  summary(): AdapterSummary {
    const components = [...this.entries.values()]
      .map((e) => ({ ...e.registration, prerequisites: [...e.registration.prerequisites], refusals: { ...e.registration.refusals } }))
      .sort((a, b) => a.component.localeCompare(b.component));
    const localFixtureComponents = components.filter((c) => c.kind === "local_fixture").map((c) => c.component);
    return {
      components,
      kinds: this.kinds(),
      localFixtureComponents,
      liveComponents: components.filter((c) => c.kind === "live").map((c) => c.component),
      blockedComponents: components.filter((c) => c.capabilityStatus === "BLOCKED").map((c) => c.component),
      anyLocalFixture: localFixtureComponents.length > 0,
      badge: localFixtureComponents.length > 0 ? SYNTHETIC_BADGE : null,
      frozen: this.frozenFlag,
    };
  }

  /**
   * Refused operations of the LIVE adapters, typed (FO-06-25). The live composition root refuses to start
   * when any is NOT_IMPLEMENTED (documented behaviour that is not built); UNSUPPORTED_UNDOCUMENTED rows are
   * reported as unavailable capabilities, never as success.
   */
  liveCompositionRefusals(): LiveRefusal[] {
    const out: LiveRefusal[] = [];
    for (const { registration: r } of this.entries.values()) {
      if (r.kind !== "live") continue;
      for (const [operation, refusal] of Object.entries(r.refusals)) out.push({ component: r.component, integrationId: r.integrationId, operation, refusal });
    }
    return out.sort((a, b) => a.component.localeCompare(b.component) || a.operation.localeCompare(b.operation));
  }

  /** Live components with a NOT_IMPLEMENTED operation: each one makes a live composition fail closed. */
  notImplementedLiveOperations(): LiveRefusal[] {
    return this.liveCompositionRefusals().filter((r) => r.refusal === "NOT_IMPLEMENTED");
  }

  /** Health of every adapter; a throwing or slow health check reports unhealthy (fail closed). */
  async healthReport(timeoutMs = 2_000): Promise<AdapterHealthRow[]> {
    const rows = await Promise.all(
      [...this.entries.values()].map(async ({ adapter, registration }) => {
        const h = await checkHealth(adapter, timeoutMs);
        return { component: registration.component, integrationId: registration.integrationId, kind: registration.kind, healthy: h.healthy, reasonCode: h.reasonCode };
      }),
    );
    return rows.sort((a, b) => a.component.localeCompare(b.component));
  }
}

async function checkHealth(adapter: Adapter, timeoutMs: number): Promise<AdapterHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AdapterHealth>((resolve) => {
    timer = setTimeout(() => resolve({ healthy: false, reasonCode: "HEALTH_CHECK_TIMEOUT" }), timeoutMs);
  });
  try {
    const h = await Promise.race([adapter.health(), timeout]);
    return typeof h?.healthy === "boolean" ? { healthy: h.healthy, reasonCode: h.healthy ? null : (h.reasonCode ?? "UNHEALTHY") } : { healthy: false, reasonCode: "HEALTH_CHECK_INVALID" };
  } catch (err) {
    return { healthy: false, reasonCode: err instanceof PlatformError ? err.reasonCode : "HEALTH_CHECK_FAILED" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function declaredRefusals(adapter: Adapter): Record<string, RefusalReason> {
  const raw = (adapter as { refusals?: unknown }).refusals;
  const out: Record<string, RefusalReason> = {};
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError("ADAPTER_REFUSALS_INVALID");
    for (const [op, reason] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^([a-z][a-zA-Z0-9_.]{1,63}|\*)$/.test(op) || !REFUSAL_REASONS.includes(reason as RefusalReason)) throw new ValidationError("ADAPTER_REFUSALS_INVALID");
      out[op] = reason as RefusalReason;
    }
  }
  if (isBlockedCapability(adapter) && Object.keys(out).length === 0) out["*"] = UNSUPPORTED_UNDOCUMENTED;
  return out;
}
