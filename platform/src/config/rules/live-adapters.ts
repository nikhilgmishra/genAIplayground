/**
 * Tenant inputs of one live adapter (helper of the sandbox and full rule sets; FO-00-26, FO-00-30).
 *
 * A live adapter needs an https, routable, non-placeholder endpoint, a real (not placeholder, not local)
 * credential reference and real authentication; a static bearer credential needs its own signed
 * STATIC_CREDENTIAL_EXCEPTION approval. Each problem is a CAPABILITY violation: the adapter's capability is
 * NOT_CONFIGURED (its gate refuses its work) instead of the whole environment being refused, because a
 * missing tenant input is not missing code and must not hide it (FO-00-30).
 */
import type { PlatformConfig } from "../ports.js";
import { capabilityForAdapter } from "./capabilities.js";
import { isPlaceholder, nonRoutableHost, refProblem, tryUrl } from "./types.js";
import type { Collector, Lookups } from "./types.js";

export function liveAdapterRules(name: string, a: PlatformConfig["adapters"][string], v: Collector, l: Lookups): void {
  const cap = capabilityForAdapter(name);
  const path = `adapters.${name}`;
  const report = (code: string, p: string) => (cap ? v.capability(cap, name, code, p) : v.add(code, p));
  if (!a.endpoint) report("ADAPTER_ENDPOINT_MISSING", `${path}.endpoint`);
  else {
    const url = tryUrl(a.endpoint);
    if (!url) report("ADAPTER_ENDPOINT_INVALID", `${path}.endpoint`);
    else {
      if (url.protocol !== "https:") report("ADAPTER_ENDPOINT_NOT_HTTPS", `${path}.endpoint`);
      if (nonRoutableHost(url.hostname)) report("ADAPTER_ENDPOINT_NOT_ROUTABLE", `${path}.endpoint`);
      if (isPlaceholder(a.endpoint)) report("ADAPTER_ENDPOINT_PLACEHOLDER", `${path}.endpoint`);
    }
  }
  if (a.authMethod === "none") report("ADAPTER_AUTH_NONE", `${path}.authMethod`);
  const ref = refProblem(a.credentialRef, "ADAPTER_CREDENTIAL");
  if (ref) report(ref, `${path}.credentialRef`);
  if (a.authMethod === "bearer_static_exception" && !l.referencedValid(a.exceptionApprovalId, "STATIC_CREDENTIAL_EXCEPTION")) {
    report("STATIC_CREDENTIAL_EXCEPTION_UNAPPROVED", `${path}.exceptionApprovalId`);
  }
}
