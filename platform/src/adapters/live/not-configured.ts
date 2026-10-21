/**
 * NOT_CONFIGURED guard ports of the live composition (WP-07; FO-00-26, FO-00-30, FO-21-10).
 *
 * A capability whose live adapter or tenant inputs are missing is NOT_CONFIGURED in the per-capability
 * activation map (platform/src/main/capabilities.ts), and its work is refused BEFORE any port is called: the
 * admission gate refuses the intents that need it and the kill-switch hold holds its background work
 * (platform/src/ops/capability-gate.ts). The port the composition still has to pass to the services that
 * take it is this guard port. It is not a stub: it never answers, never returns canned success, an empty list,
 * a TEST id or "not implemented". Every call returns a promise rejected with the reason-coded refusal
 * CAPABILITY_NOT_CONFIGURED (DependencyError, NOT_STARTED, not retryable: nothing was sent anywhere), counts
 * vsp_capability_not_configured_reached_total{capability} and logs `capability.guard_port_reached`, which the
 * `capability-guard-port-reached` alarm watches: reaching a guard port means a path skipped its gate.
 * `health()` reports unhealthy with the same reason code, so readiness and the console show the state.
 */
import type { RuntimeCapabilityId } from "../../observability/composition-catalog.js";
import { silentLogger } from "../../observability/logger.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import { DependencyError } from "../../shared/errors.js";
import type { AdapterHealth } from "../ports.js";

export const CAPABILITY_NOT_CONFIGURED = "CAPABILITY_NOT_CONFIGURED";

/** Thrown by a guard port: the capability is NOT_CONFIGURED (reason code only; nothing was sent). */
export class CapabilityNotConfiguredError extends DependencyError {
  constructor(readonly capabilityId: RuntimeCapabilityId) {
    super(CAPABILITY_NOT_CONFIGURED, "NOT_STARTED", false);
  }
}

export interface GuardPortSpec {
  capabilityId: RuntimeCapabilityId;
  /** Component key (adapter key of platform/config, or a composition component). */
  component: string;
  /** Integration id the kill switches, budgets and breakers know the component by. */
  integrationId: string;
  metrics?: Metrics | null;
  logger?: Logger;
  /** Plain, non-function properties the port interface declares (for example a destination id); never operations. */
  props?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Properties every guard port answers itself; any other property is an operation that fails closed. */
export interface GuardPortMarker {
  readonly kind: "live";
  readonly notConfigured: true;
  readonly capabilityId: RuntimeCapabilityId;
  readonly component: string;
  readonly integrationId: string;
  health(): Promise<AdapterHealth>;
}

const COMPONENT = /^[a-z][a-z0-9-]{2,63}$/;

export function isGuardPort(value: unknown): value is GuardPortMarker {
  return (typeof value === "object" || typeof value === "function") && value !== null && (value as { notConfigured?: unknown }).notConfigured === true;
}

/**
 * A guard port typed as the port interface `T` it stands in for. Operations are resolved by name at call time
 * (a Proxy), so one implementation covers every port interface without a method list that could drift.
 */
function refusal(spec: GuardPortSpec): (operation: string) => Promise<never> {
  const logger = (spec.logger ?? silentLogger).child({ component: "capability_gate" });
  return (operation: string): Promise<never> => {
    try {
      spec.metrics?.increment("vsp_capability_not_configured_reached_total", { capability: spec.capabilityId });
    } catch {
      // the refusal below never depends on the metrics sink
    }
    logger.error("capability.guard_port_reached", { reasonCode: CAPABILITY_NOT_CONFIGURED, integration: spec.integrationId, action: /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(operation) ? operation : "unknown" });
    // Port operations are asynchronous: the refusal is a rejected promise (a caller's .catch() sees it).
    return Promise.reject(new CapabilityNotConfiguredError(spec.capabilityId));
  };
}

/**
 * A single NOT_CONFIGURED operation (a resolver function a service takes instead of a port object, for example
 * the call-session resolver's trusted integration identity). Same refusal, metric and alarm as a guard port:
 * it never answers null or a default, so a caller that swallows the refusal still leaves the paging signal.
 */
export function notConfiguredOperation<A extends unknown[], R>(spec: GuardPortSpec, operation: string): ((...args: A) => Promise<R>) & GuardPortMarker {
  if (!COMPONENT.test(spec.component)) throw new TypeError("GUARD_PORT_COMPONENT_INVALID");
  const reached = refusal(spec);
  const fn = (..._args: A): Promise<R> => reached(operation);
  return Object.freeze(
    Object.assign(fn, {
      kind: "live" as const,
      notConfigured: true as const,
      capabilityId: spec.capabilityId,
      component: spec.component,
      integrationId: spec.integrationId,
      health: async (): Promise<AdapterHealth> => ({ healthy: false, reasonCode: CAPABILITY_NOT_CONFIGURED }),
    }),
  );
}

export function notConfiguredPort<T extends object>(spec: GuardPortSpec): T & GuardPortMarker {
  if (!COMPONENT.test(spec.component)) throw new TypeError("GUARD_PORT_COMPONENT_INVALID");
  const reached = refusal(spec);
  const own: Record<string, unknown> = {
    ...(spec.props ?? {}),
    kind: "live",
    notConfigured: true,
    capabilityId: spec.capabilityId,
    component: spec.component,
    integrationId: spec.integrationId,
    health: async (): Promise<AdapterHealth> => ({ healthy: false, reasonCode: CAPABILITY_NOT_CONFIGURED }),
    toJSON: () => ({ notConfigured: true, capabilityId: spec.capabilityId, component: spec.component }),
    // Coercion to a string (a template literal, String(), a concatenation in a log line) is a description, never
    // an operation: an operation's rejected promise would surface as an unhandled rejection and end the process.
    toString: () => `[NOT_CONFIGURED ${spec.component}]`,
    valueOf: () => `[NOT_CONFIGURED ${spec.component}]`,
  };
  const described = `[NOT_CONFIGURED ${spec.component}]`;
  return new Proxy(Object.freeze({}), {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => described;
      if (typeof prop === "symbol") return undefined;
      // Not a thenable: awaiting a guard port must not look like a pending call.
      if (prop === "then") return undefined;
      if (Object.hasOwn(own, prop)) return own[prop];
      return (..._args: unknown[]) => reached(prop);
    },
    has(_t, prop) {
      return typeof prop === "string" && prop !== "then";
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  }) as T & GuardPortMarker;
}
