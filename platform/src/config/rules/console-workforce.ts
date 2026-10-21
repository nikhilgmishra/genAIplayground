/**
 * Console workforce sign-in (OPS-04, FO-03-49; WP-05 hand-off). Two parts:
 *
 *  1. Fixtures (blocking): outside local/ci, including sandbox, the console's local workforce sign-in routes
 *     and a local_fixture workforce IdP must never run (they would mint staff tokens for SYNTHETIC identities
 *     without SSO or MFA evidence). The RUNTIME components are refused in every non-offline environment; the
 *     DECLARED adapter kind additionally in staging/production (sandbox declares a fixture for a capability it
 *     does not configure, which is NOT_CONFIGURED, see capabilities.ts).
 *  2. Workforce SSO (capability-level): the module-local rules of console-api/sso-config.ts
 *     (`workforceSsoGuardViolations`). A missing or invalid `consoleAuth` makes identity.workforce and the
 *     console (operator.console) NOT_CONFIGURED; the gateway and worker still start.
 */
import { workforceSsoGuardViolations } from "../../console-api/sso-config.js";
import { CONSOLE_LOCAL_SIGN_IN_COMPONENT, WORKFORCE_IDP_ADAPTER_KEY } from "./capabilities.js";
import { LIVE_RULE_SETS } from "./types.js";
import type { GuardRule } from "./types.js";

export const consoleWorkforceRule: GuardRule = {
  id: "console-workforce",
  file: "console-workforce.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, ctx, ruleSet, v }) {
    if (ruleSet === "full" && config.adapters[WORKFORCE_IDP_ADAPTER_KEY]?.kind === "local_fixture") {
      v.add("WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE", `adapters.${WORKFORCE_IDP_ADAPTER_KEY}`);
    }
    if (Object.hasOwn(ctx.adapterKinds, WORKFORCE_IDP_ADAPTER_KEY) && ctx.adapterKinds[WORKFORCE_IDP_ADAPTER_KEY] === "local_fixture") {
      v.add("WORKFORCE_IDP_LOCAL_FIXTURE_OUTSIDE_OFFLINE", `runtime.${WORKFORCE_IDP_ADAPTER_KEY}`);
    }
    if (Object.hasOwn(ctx.adapterKinds, CONSOLE_LOCAL_SIGN_IN_COMPONENT)) v.add("CONSOLE_LOCAL_SIGN_IN_OUTSIDE_OFFLINE", `runtime.${CONSOLE_LOCAL_SIGN_IN_COMPONENT}`);

    for (const s of workforceSsoGuardViolations(config.consoleAuth ?? null, config.environment)) {
      const at = s.indexOf("@");
      const code = at > 0 ? s.slice(0, at) : s;
      const path = at > 0 ? s.slice(at + 1) : "consoleAuth";
      v.capability("identity.workforce", WORKFORCE_IDP_ADAPTER_KEY, code, path);
      v.capability("operator.console", "console", code, path);
    }
  },
};
