/**
 * Canonical digests for follow-on contracts that are bound by digest (Node-only: uses node:crypto
 * through shared/canonical.ts, so it is kept out of the browser-importable contract files).
 *
 * - SpeechPlan.outputDecisionDigest: the release guard verifies it before rendering and again
 *   before emission (follow-on prompt section 10, pre-emission checks).
 * - ConnectorProfile.configDigest and TenantConfig.configDigest: pinned in releases and audit.
 *
 * Each digest is sha256 over canonical JSON (sorted keys, no whitespace) of the parsed contract
 * without its own digest field, so unknown fields can never enter a digest.
 */
import { canonicalJson, constantTimeEqualHex, sha256Hex } from "../shared/canonical.js";
import { ConnectorProfile } from "./connector.js";
import { SpeechPlan } from "./media.js";
import { TenantConfig } from "./tenant.js";

type WithoutKey<T, K extends keyof T> = Omit<T, K>;

const ZERO = "0".repeat(64);

/** sha256 of the canonical plan with `outputDecisionDigest` excluded. The input is strictly re-parsed. */
export function computeSpeechPlanDigest(plan: WithoutKey<SpeechPlan, "outputDecisionDigest"> | SpeechPlan): string {
  const parsed = SpeechPlan.parse({ ...plan, outputDecisionDigest: ZERO });
  const { outputDecisionDigest: _omit, ...rest } = parsed;
  return sha256Hex(canonicalJson(rest));
}

/** Constant-time check of a plan's own digest; any parse failure is "not verified" (fail closed). */
export function verifySpeechPlanDigest(plan: SpeechPlan): boolean {
  try {
    return constantTimeEqualHex(computeSpeechPlanDigest(plan), plan.outputDecisionDigest);
  } catch {
    return false;
  }
}

/** Returns the plan with its output-decision digest set. */
export function sealSpeechPlan(plan: WithoutKey<SpeechPlan, "outputDecisionDigest">): SpeechPlan {
  return SpeechPlan.parse({ ...plan, outputDecisionDigest: computeSpeechPlanDigest(plan) });
}

export function computeConnectorProfileDigest(profile: WithoutKey<ConnectorProfile, "configDigest"> | ConnectorProfile): string {
  const parsed = ConnectorProfile.parse({ ...profile, configDigest: ZERO });
  const { configDigest: _omit, ...rest } = parsed;
  return sha256Hex(canonicalJson(rest));
}

export function computeTenantConfigDigest(config: WithoutKey<TenantConfig, "configDigest"> | TenantConfig): string {
  const parsed = TenantConfig.parse({ ...config, configDigest: ZERO });
  const { configDigest: _omit, ...rest } = parsed;
  return sha256Hex(canonicalJson(rest));
}
