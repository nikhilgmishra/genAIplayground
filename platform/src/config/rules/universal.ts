/**
 * Universal rules (every environment): trusted destinations are structurally sound (SAFE-05, SAFE-02, OPS-02),
 * declared adapter kinds equal what was instantiated, every adapter key is classified to a runtime capability,
 * and the admission safety reserve fits inside capacity.
 */
import { capabilityForAdapter } from "./capabilities.js";
import { ALL_RULE_SETS, safeKey } from "./types.js";
import type { GuardRule } from "./types.js";

export const universalRule: GuardRule = {
  id: "universal",
  file: "universal.ts",
  ruleSets: ALL_RULE_SETS,
  evaluate({ config, ctx, v }) {
    const ids = new Set<string>();
    for (const [i, d] of config.destinations.entries()) {
      if (ids.has(d.destinationId)) v.add("DESTINATION_DUPLICATE_ID", `destinations.${i}`);
      ids.add(d.destinationId);
    }
    for (const [i, d] of config.destinations.entries()) {
      for (const f of d.fallbackDestinationIds) {
        if (f === d.destinationId) v.add("DESTINATION_FALLBACK_SELF", `destinations.${i}.fallbackDestinationIds`);
        else if (!ids.has(f)) v.add("DESTINATION_FALLBACK_UNKNOWN", `destinations.${i}.fallbackDestinationIds`);
      }
    }
    const purposes = new Set(config.destinations.map((d) => d.purpose));
    if (!purposes.has("SAFETY_PRIORITY")) v.add("DESTINATION_SAFETY_ROUTE_MISSING", "destinations");
    if (!purposes.has("STANDARD_SUPPORT")) v.add("DESTINATION_HUMAN_ROUTE_MISSING", "destinations");
    if (!purposes.has("OUTAGE_CONTINUITY")) v.add("DESTINATION_CONTINUITY_ROUTE_MISSING", "destinations");

    // Declared adapter kinds must match what was actually instantiated.
    for (const [name, a] of Object.entries(config.adapters)) {
      const runtime = Object.hasOwn(ctx.adapterKinds, name) ? ctx.adapterKinds[name] : undefined;
      if (runtime !== undefined && runtime !== a.kind) v.add("ADAPTER_KIND_MISMATCH", `adapters.${name}`);
      // An integration nobody classified to a capability can never be gated: refuse it everywhere.
      if (!capabilityForAdapter(name)) v.add("ADAPTER_CAPABILITY_UNKNOWN", `adapters.${safeKey(name)}`);
    }
    if (config.ops && config.ops.admission.safetyReserveSessions > config.ops.admission.maxConcurrentAiSessions) {
      v.add("OPS_SAFETY_RESERVE_EXCEEDS_CAPACITY", "ops.admission.safetyReserveSessions");
    }
  },
};
