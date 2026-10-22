/**
 * RECORDING_REFUSED injection seam (WP-11 builds it; WP-25 drives it from the Layer-2 [FAULT:RECORDING_REFUSED]
 * test; scenarios/fixtures/failures/RECORDING_REFUSED.json).
 *
 * The fault is "the caller declines recording on the media path at call start". The seam does not fake an outcome:
 * when armed for a call it makes the runtime take the production decline path at the consent step, exactly as the
 * caller's decline key (DtmfMenu DECLINE_RECORDING) does: the local taps close, the recorder is never started or is
 * stopped, the gateway records the decline (`media.consent.declined`, the independent reach evidence) and returns
 * the configured alternative. A caller pressing the decline key reaches the same path with no seam at all, which is
 * how the Layer-2 media suite proves it.
 *
 * Arming: only in the local and ci environments, only when the worker's configuration enables fault seams, and only
 * for a dispatch whose job metadata names the fault (`{"vspFault":"RECORDING_REFUSED"}`). In any other environment the
 * configuration refuses `faultSeams: true` (worker/config.ts), and metadata naming a fault is ignored.
 */
import type { Environment } from "@vsp/platform/src/protocol/common.js";

export const RECORDING_REFUSED_FAULT = "RECORDING_REFUSED";

export interface FaultSeamPolicy {
  environment: Environment;
  faultSeams: boolean;
}

const KNOWN = new Set([RECORDING_REFUSED_FAULT]);

/** The fault seams armed for one job; empty unless the policy allows seams and the metadata names a known one. */
export function armedFaultSeams(policy: FaultSeamPolicy, jobMetadata: string | undefined): ReadonlySet<string> {
  if (!policy.faultSeams || (policy.environment !== "local" && policy.environment !== "ci") || !jobMetadata) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jobMetadata);
  } catch {
    return new Set();
  }
  const fault = (parsed as { vspFault?: unknown } | null)?.vspFault;
  return typeof fault === "string" && KNOWN.has(fault) ? new Set([fault]) : new Set();
}
