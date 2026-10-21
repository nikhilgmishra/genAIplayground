/**
 * Connector credential separation (WP-06 module-local rule set, connectors/profile/credentials.ts; FO-05-56,
 * FO-05-39, AUTH-02). When the composition supplies the connector profiles of this environment together with
 * the adapter references of every committed environment (`GuardContext.connectorCredentialSets`), a reference
 * that serves two capabilities, two connectors or two environments, or an audience shared between
 * environments, refuses the environment: a reused credential is a separation failure, not a missing input.
 *
 * References are compared by IDENTITY, not by spelling (WP-07, FT-91): before `credentialReuseViolations` (which
 * keys on the reference string) runs, every reference is rewritten to one spelling per secret or key identity
 * (rules/types.ts `canonicalReferences`, the closure of `sameKeyOrSecret`), so a full Secrets Manager ARN and the
 * partial ARN of the same secret are one credential in two adapters, in a profile and an adapter, or in two
 * environments. This environment's own adapter references are always compared: they are taken from the
 * configuration under evaluation for every adapter key the supplied sets do not already hold (also when no sets are
 * supplied). The key separation rule (key-separation.ts) leaves adapter and connector-profile pairs to this rule and
 * compares them with every other secret of the configuration.
 */
import { credentialReuseViolations } from "../../connectors/profile/credentials.js";
import type { EnvironmentCredentialSet } from "../../connectors/profile/credentials.js";
import type { PlatformConfig } from "../ports.js";
import { ALL_RULE_SETS, canonicalReferences } from "./types.js";
import type { GuardRule } from "./types.js";

const POSITION = /^[A-Za-z0-9_:.|-]{1,160}$/;

/** The supplied sets plus this environment's adapter references from `config` (keys the sets do not hold). */
export function withConfiguredAdapters(sets: readonly EnvironmentCredentialSet[], config: Pick<PlatformConfig, "environment" | "adapters">): EnvironmentCredentialSet[] {
  const own: Record<string, string> = {};
  for (const [k, a] of Object.entries(config.adapters ?? {})) if (typeof a?.credentialRef === "string" && a.credentialRef.length > 0) own[k] = a.credentialRef;
  const out = sets.map((s) => (s.environment === config.environment ? { ...s, adapterCredentialRefs: { ...own, ...(s.adapterCredentialRefs ?? {}) } } : s));
  if (!out.some((s) => s.environment === config.environment) && Object.keys(own).length > 0) out.unshift({ environment: config.environment, profiles: [], adapterCredentialRefs: own });
  return out;
}

/** The sets with every credential reference rewritten to one spelling per identity (profiles are copied, never mutated). */
export function normalizeCredentialSets(sets: readonly EnvironmentCredentialSet[]): EnvironmentCredentialSet[] {
  const refs: string[] = [];
  for (const s of sets) {
    for (const p of s.profiles) {
      refs.push(p.credentialRef);
      for (const c of p.capabilityCredentials ?? []) refs.push(c.credentialRef);
    }
    refs.push(...Object.values(s.adapterCredentialRefs ?? {}));
  }
  const canon = canonicalReferences(refs);
  const to = (r: string) => canon.get(r) ?? r;
  return sets.map((s) => ({
    environment: s.environment,
    profiles: s.profiles.map((p) => ({ ...p, credentialRef: to(p.credentialRef), ...(p.capabilityCredentials ? { capabilityCredentials: p.capabilityCredentials.map((c) => ({ ...c, credentialRef: to(c.credentialRef) })) } : {}) })),
    ...(s.adapterCredentialRefs ? { adapterCredentialRefs: Object.fromEntries(Object.entries(s.adapterCredentialRefs).map(([k, r]) => [k, to(r)])) } : {}),
  }));
}

export const connectorCredentialRule: GuardRule = {
  id: "connector-credentials",
  file: "connectors.ts",
  ruleSets: ALL_RULE_SETS,
  evaluate({ config, ctx, v }) {
    const sets = withConfiguredAdapters(ctx.connectorCredentialSets ?? [], config);
    if (sets.length === 0) return;
    for (const c of credentialReuseViolations(normalizeCredentialSets(sets))) {
      v.add(c.code, `connectors.credentials.${c.environment}.${POSITION.test(c.position) ? c.position : "unnamed"}`);
    }
  },
};
