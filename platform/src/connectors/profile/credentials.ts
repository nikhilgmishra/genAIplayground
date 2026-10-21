/**
 * Credential separation rules across connectors, capabilities and environments (WP-06; FO-05-56,
 * FO-05-39; AUTH-02). Module-local guard rule set: the configuration guard (platform/src/config/guard.ts,
 * config group, WP-07 in phase B) calls `credentialReuseViolations` with the profiles of every committed
 * environment; until then the connector loader and the tests call it directly.
 *
 *   CREDENTIAL_REUSED_ACROSS_CAPABILITIES   one reference serves two (capability, access) pairs
 *   CREDENTIAL_REUSED_ACROSS_CONNECTORS     one reference appears in two connectors of an environment
 *   CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS   one reference appears in two environments, compared with every
 *                                           committed platform/config/<environment>.json adapter reference too
 *   AUDIENCE_REUSED_ACROSS_ENVIRONMENTS     a signed-assertion audience is shared between environments
 *                                           (environments are separated by audience, FO-05-39)
 * Violations carry codes plus opaque positions (environment, profile id, capability), never values.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Environment } from "../../protocol/common.js";
import type { ConnectorProfile } from "../../protocol/connector.js";

export interface EnvironmentCredentialSet {
  environment: Environment;
  profiles: readonly ConnectorProfile[];
  /** Credential references of the environment's other integrations (adapter keys -> reference). */
  adapterCredentialRefs?: Readonly<Record<string, string>>;
}

export interface CredentialViolation {
  code: "CREDENTIAL_REUSED_ACROSS_CAPABILITIES" | "CREDENTIAL_REUSED_ACROSS_CONNECTORS" | "CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS" | "AUDIENCE_REUSED_ACROSS_ENVIRONMENTS";
  environment: Environment;
  /** Opaque position of the second use: `profile:<profileId>:<capability>:<access>` or `adapter:<key>`. */
  position: string;
}

interface Use {
  environment: Environment;
  owner: string;
  pair: string;
  position: string;
}

function usesOf(set: EnvironmentCredentialSet): { ref: string; use: Use }[] {
  const out: { ref: string; use: Use }[] = [];
  for (const p of set.profiles) {
    const owner = `profile:${p.profileId}`;
    out.push({ ref: p.credentialRef, use: { environment: set.environment, owner, pair: "default|READ", position: `${owner}:default:READ` } });
    for (const c of p.capabilityCredentials ?? []) {
      out.push({ ref: c.credentialRef, use: { environment: set.environment, owner, pair: `${c.capability}|${c.access}`, position: `${owner}:${c.capability}:${c.access}` } });
    }
  }
  for (const [key, ref] of Object.entries(set.adapterCredentialRefs ?? {})) {
    out.push({ ref, use: { environment: set.environment, owner: `adapter:${key}`, pair: "adapter", position: `adapter:${key}` } });
  }
  return out;
}

/** Every reuse violation across the given environments (empty: credentials are separated). */
export function credentialReuseViolations(sets: readonly EnvironmentCredentialSet[]): CredentialViolation[] {
  const v: CredentialViolation[] = [];
  const byRef = new Map<string, Use[]>();
  for (const set of sets) {
    for (const { ref, use } of usesOf(set)) byRef.set(ref, [...(byRef.get(ref) ?? []), use]);
  }
  for (const uses of byRef.values()) {
    const firstEnv = uses[0]?.environment;
    for (const u of uses) if (u.environment !== firstEnv) v.push({ code: "CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS", environment: u.environment, position: u.position });
    const sameEnv = uses.filter((u) => u.environment === firstEnv);
    const firstOwner = sameEnv[0]?.owner;
    for (const u of sameEnv) if (u.owner !== firstOwner) v.push({ code: "CREDENTIAL_REUSED_ACROSS_CONNECTORS", environment: u.environment, position: u.position });
    const own = sameEnv.filter((u) => u.owner === firstOwner);
    const scoped = [...new Set(own.map((u) => u.pair).filter((x) => x !== "default|READ" && x !== "adapter"))];
    const hasDefault = own.some((u) => u.pair === "default|READ");
    // One reference serves one (capability, access) pair; the profile default may name one READ credential only.
    if (scoped.length > 1 || (hasDefault && scoped.some((x) => x.endsWith("|WRITE")))) {
      const last = own[own.length - 1];
      if (last) v.push({ code: "CREDENTIAL_REUSED_ACROSS_CAPABILITIES", environment: last.environment, position: last.position });
    }
  }
  const audiences = new Map<string, Environment>();
  for (const set of sets) {
    for (const p of set.profiles) {
      const aud = p.auth?.audience;
      if (!aud) continue;
      const k = `${p.system}|${aud}`;
      const prior = audiences.get(k);
      if (prior !== undefined && prior !== set.environment) v.push({ code: "AUDIENCE_REUSED_ACROSS_ENVIRONMENTS", environment: set.environment, position: `profile:${p.profileId}:audience` });
      else audiences.set(k, set.environment);
    }
  }
  return v;
}

/**
 * Adapter credential references of the committed environment configurations (platform/config/<env>.json,
 * `adapters.<key>.credentialRef`), so a connector credential that reuses another environment's (or another
 * integration's) reference is caught by `credentialReuseViolations`.
 */
export function committedConfigCredentialRefs(configDir: string): { environment: Environment; adapterCredentialRefs: Record<string, string> }[] {
  const out: { environment: Environment; adapterCredentialRefs: Record<string, string> }[] = [];
  for (const f of readdirSync(configDir).filter((n) => /^[a-z]+\.json$/.test(n)).sort()) {
    const doc = JSON.parse(readFileSync(join(configDir, f), "utf8")) as { environment?: unknown; adapters?: Record<string, { credentialRef?: unknown }> };
    const env = Environment.safeParse(doc.environment);
    if (!env.success) continue;
    const refs: Record<string, string> = {};
    for (const [k, a] of Object.entries(doc.adapters ?? {})) if (typeof a?.credentialRef === "string") refs[k] = a.credentialRef;
    out.push({ environment: env.data, adapterCredentialRefs: refs });
  }
  return out;
}
