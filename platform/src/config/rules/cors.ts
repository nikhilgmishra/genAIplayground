/**
 * Browser origins and session binding (sandbox, staging, production): exact https origins only, never a
 * wildcard or a reserved host; a session-binding exception needs its own signed SECURITY_REVIEW approval.
 */
import { LIVE_RULE_SETS, nonRoutableHost, tryUrl } from "./types.js";
import type { GuardRule } from "./types.js";

export const corsAndBindingRule: GuardRule = {
  id: "cors-and-binding",
  file: "cors.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, v, l }) {
    for (const [i, origin] of config.cors.allowedOrigins.entries()) {
      const path = `cors.allowedOrigins.${i}`;
      if (origin.includes("*")) {
        v.add("CORS_WILDCARD", path);
        continue;
      }
      const url = tryUrl(origin);
      if (!url) {
        v.add("CORS_ORIGIN_INVALID", path);
        continue;
      }
      if (url.protocol !== "https:") v.add("CORS_NON_HTTPS_ORIGIN", path);
      if (url.origin !== origin) v.add("CORS_ORIGIN_NOT_EXACT", path);
      if (nonRoutableHost(url.hostname)) v.add("CORS_ORIGIN_NOT_ROUTABLE", path);
    }
    if (config.sessionBinding.mode === "tool_argument_lookup_exception" && !l.referencedValid(config.sessionBinding.exceptionApprovalId, "SECURITY_REVIEW")) {
      v.add("SESSION_BINDING_EXCEPTION_UNAPPROVED", "sessionBinding.exceptionApprovalId");
    }
  },
};
