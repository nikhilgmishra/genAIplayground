/**
 * Gateway HTTP limits (WP-07; STRIDE D, OPS-04). `gateway.http.rateLimit: null` switches off both the
 * per-integration request limiter and the tool-call limiter of buildGatewayApp; that is a regression-test
 * convenience (unbounded calls in local/ci) and is refused in every live rule set: a sandbox, staging or
 * production gateway always runs with a request ceiling (an absent `gateway.http` block keeps the composition's
 * default ceiling).
 */
import { LIVE_RULE_SETS } from "./types.js";
import type { GuardRule } from "./types.js";

export const gatewayLimitsRule: GuardRule = {
  id: "gateway-limits",
  file: "gateway.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, v }) {
    const http = (config.gateway as { http?: { rateLimit?: unknown } } | undefined)?.http;
    if (http && http.rateLimit === null) v.add("GATEWAY_RATE_LIMIT_DISABLED", "gateway.http.rateLimit");
  },
};
