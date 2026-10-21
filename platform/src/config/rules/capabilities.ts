/**
 * Which runtime capability each configured component serves (WP-07; FO-00-26, FO-00-30, FO-19-06).
 *
 * The guard reports a tenant-input problem of a component (a missing endpoint, a placeholder credential, an
 * unapproved sandbox integration, a missing workforce SSO block) against the capability the component serves,
 * so that capability is NOT_CONFIGURED in the activation map and the environment still starts. Capability ids
 * are docs/followon/capabilities.yaml ids (RUNTIME_CAPABILITY_IDS). An adapter key outside this map is a
 * blocking violation (ADAPTER_CAPABILITY_UNKNOWN): an integration nobody classified never runs quietly.
 */
import type { RuntimeCapabilityId } from "../../observability/composition-catalog.js";
import type { PlatformConfig } from "../ports.js";
import type { CapabilityViolation, RuleSet } from "./types.js";

/** Workforce IdP adapter key (platform/config/*.json) and the console's local sign-in runtime component. */
export const WORKFORCE_IDP_ADAPTER_KEY = "workforce-sso";
export const CONSOLE_LOCAL_SIGN_IN_COMPONENT = "console-local-sign-in";

export const ADAPTER_CAPABILITY: Readonly<Record<string, RuntimeCapabilityId>> = Object.freeze({
  "identity-directory": "identity.caller",
  "oidc-client-idp": "identity.caller",
  "oidc-provider-idp": "identity.caller",
  [WORKFORCE_IDP_ADAPTER_KEY]: "identity.workforce",
  "relationship-directory": "authority.registries",
  notifications: "notifications.messaging",
  scheduling: "domain.business_systems",
  billing: "domain.business_systems",
  claims: "domain.business_systems",
  "provider-system": "domain.business_systems",
  salesforce: "crm.salesforce",
  "talkdesk-telephony": "contact_center.talkdesk",
});

export function capabilityForAdapter(name: string): RuntimeCapabilityId | null {
  return Object.hasOwn(ADAPTER_CAPABILITY, name) ? (ADAPTER_CAPABILITY[name] ?? null) : null;
}

/** Config-governed state of one component (adapter key or config block) in a non-offline environment. */
export interface ComponentGuardState {
  component: string;
  capabilityId: RuntimeCapabilityId;
  state: "CONFIGURED" | "NOT_CONFIGURED";
  /** `<CODE>@<path>` reasons (codes and paths only). */
  reasons: string[];
}

/**
 * Component states for the activation map. Offline rule set: every component is served by the labelled
 * regression fixtures, so there is nothing to activate (empty). Sandbox: a component declared local_fixture
 * is NOT_CONFIGURED (ADAPTER_NOT_DECLARED_LIVE; the live composition never instantiates a fixture for it);
 * staging/production refuse a declared fixture outright (blocking ADAPTER_LOCAL_FIXTURE), so it never gets
 * here as a state. Every capability violation makes its component NOT_CONFIGURED.
 */
export function componentGuardStates(config: PlatformConfig, ruleSet: RuleSet, capabilityViolations: readonly CapabilityViolation[]): ComponentGuardState[] {
  if (ruleSet === "offline") return [];
  const out = new Map<string, ComponentGuardState>();
  const entry = (component: string, capabilityId: RuntimeCapabilityId): ComponentGuardState => {
    const key = `${capabilityId}|${component}`;
    let e = out.get(key);
    if (!e) {
      e = { component, capabilityId, state: "CONFIGURED", reasons: [] };
      out.set(key, e);
    }
    return e;
  };
  for (const [name, a] of Object.entries(config.adapters)) {
    const cap = capabilityForAdapter(name);
    if (!cap) continue;
    const e = entry(name, cap);
    if (a.kind === "local_fixture") {
      e.state = "NOT_CONFIGURED";
      e.reasons.push(`ADAPTER_NOT_DECLARED_LIVE@adapters.${name}`);
    }
  }
  for (const cv of capabilityViolations) {
    const e = entry(cv.component, cv.capabilityId);
    e.state = "NOT_CONFIGURED";
    const reason = `${cv.code}@${cv.path}`;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
  }
  return [...out.values()].sort((a, b) => (a.capabilityId === b.capabilityId ? a.component.localeCompare(b.component) : a.capabilityId.localeCompare(b.capabilityId)));
}
