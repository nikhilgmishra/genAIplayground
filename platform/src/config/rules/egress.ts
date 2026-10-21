/**
 * Egress allowlist of the live composition (WP-07; DATA-01, FO-14-53, AUTH-02).
 *
 * Every outbound client of the live composition (connector adapters, the workforce and caller IdPs, the OTLP
 * exporter) goes through the WP-06 egress-classified transport, which refuses a host the egress policy does
 * not list for this environment. The guard applies the same rule at startup so the activation map is honest:
 * a live adapter or IdP whose host is not allowlisted is NOT_CONFIGURED (capability violation) instead of
 * failing on its first call. A missing egress policy, or one that violates a hard rule, refuses the
 * environment (blocking).
 */
import { EgressGuard } from "../../privacy/egress.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import type { PlatformConfig } from "../ports.js";
import { capabilityForAdapter } from "./capabilities.js";
import { LIVE_RULE_SETS, tryUrl } from "./types.js";
import type { GuardRule } from "./types.js";

type Destination = NonNullable<PlatformConfig["egress"]>["destinations"][number];

/** The egress destination that lists the URL's exact host[:port] for this environment, or null. */
export function egressDestinationFor(config: PlatformConfig, url: URL): Destination | null {
  const host = url.hostname.toLowerCase();
  const key = url.port ? `${host}:${url.port}` : host;
  for (const d of config.egress?.destinations ?? []) {
    if (d.hosts.includes(key) && d.environments.includes(config.environment)) return d;
  }
  return null;
}

export const egressRule: GuardRule = {
  id: "egress",
  file: "egress.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, v }) {
    // The live composition builds one EgressGuard for every outbound client; without a policy nothing may leave.
    if (!config.egress) v.add("EGRESS_POLICY_NOT_CONFIGURED", "egress");
    else {
      try {
        new EgressGuard(config.egress, { environment: config.environment });
      } catch (err) {
        v.add(err instanceof ConfigurationRejectedError ? "EGRESS_POLICY_REJECTED" : "EGRESS_POLICY_INVALID", "egress");
      }
    }
    for (const [name, a] of Object.entries(config.adapters)) {
      if (a.kind !== "live" || !a.endpoint) continue;
      const url = tryUrl(a.endpoint);
      if (!url || url.protocol !== "https:") continue; // reported by the live adapter rules
      const cap = capabilityForAdapter(name);
      if (cap && !egressDestinationFor(config, url)) v.capability(cap, name, "ADAPTER_ENDPOINT_NOT_ALLOWLISTED", `adapters.${name}.endpoint`);
    }
    for (const [i, idp] of (config.callerIdentity?.idps ?? []).entries()) {
      const url = tryUrl(idp.issuer);
      if (url && !egressDestinationFor(config, url)) v.capability("identity.caller", idp.adapterKey, "CALLER_IDP_ISSUER_NOT_ALLOWLISTED", `callerIdentity.idps.${i}.issuer`);
    }
    if (config.consoleAuth) {
      const url = tryUrl(config.consoleAuth.issuer);
      if (url && !egressDestinationFor(config, url)) v.capability("identity.workforce", "workforce-sso", "WORKFORCE_ISSUER_NOT_ALLOWLISTED", "consoleAuth.issuer");
    }
  },
};
