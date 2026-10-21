/**
 * Offline rule set (local, ci; the regression composition, FO-00-36, FO-22-21): synthetic fixtures only. Live
 * adapters, the Object Lock audit sink, PHI endpoints and PHI_PROCESSING scopes are rejected so no PHI or paid
 * vendor traffic can be reached from developer machines or CI.
 */
import { noPhiScope, safeKey } from "./types.js";
import type { GuardRule } from "./types.js";

export const offlineRule: GuardRule = {
  id: "offline",
  file: "offline.ts",
  ruleSets: ["offline"],
  evaluate({ config, ctx, v }) {
    for (const [name, a] of Object.entries(config.adapters)) {
      if (a.kind === "live") v.add("OFFLINE_LIVE_ADAPTER_FORBIDDEN", `adapters.${name}`);
    }
    for (const [name, kind] of Object.entries(ctx.adapterKinds)) {
      if (kind === "live") v.add("OFFLINE_LIVE_ADAPTER_FORBIDDEN", `runtime.${safeKey(name)}`);
    }
    if (config.audit.sink === "s3_object_lock") v.add("OFFLINE_LIVE_AUDIT_SINK_FORBIDDEN", "audit.sink");
    if (config.phi?.endpointsEnabled) v.add("PHI_ENDPOINTS_FORBIDDEN_IN_ENVIRONMENT", "phi.endpointsEnabled");
    noPhiScope(config, ctx, v);
  },
};
