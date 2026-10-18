/**
 * Base for LIVE adapters whose vendor API or tenant evidence is missing.
 *
 * "Unsupported capabilities must be BLOCKED, not simulated as production
 * success" (spec section 16; OPS-03). A BLOCKED stub declares kind "live" so the
 * configuration guard and adapter registry treat it as a real integration
 * slot, reports itself unhealthy, and rejects EVERY operation with
 * BlockedCapabilityError (reason code BLOCKED_CAPABILITY_UNVERIFIED) without any
 * network access. It never returns data, never fabricates success and never
 * calls an endpoint that has not been documented for our plan.
 */
import type { AdapterHealth } from "../ports.js";
import { BLOCKED_CAPABILITY_UNVERIFIED, BlockedCapabilityError, type BlockedCapability } from "../errors.js";

/** One piece of evidence that must exist before the stub may be replaced by a real implementation. */
export interface RequiredEvidence {
  capability: string;
  /** Exactly what must be supplied (documented API facts or tenant evidence). */
  evidence: string;
  /** PRQ ids in docs/prerequisites.yaml. */
  prerequisites: readonly string[];
  /** Question ids in talkdesk/vendor-questions.md. */
  vendorQuestions: readonly string[];
  /** Trust-boundary flag from docs/ARCHITECTURE.md section 5, when relevant. */
  trustBoundary: string | null;
}

export abstract class BlockedLiveAdapter implements BlockedCapability {
  readonly kind = "live" as const;
  readonly capabilityStatus = "BLOCKED" as const;
  abstract readonly integrationId: string;
  abstract readonly prerequisites: readonly string[];
  abstract readonly requiredEvidence: readonly RequiredEvidence[];

  async health(): Promise<AdapterHealth> {
    return { healthy: false, reasonCode: BLOCKED_CAPABILITY_UNVERIFIED };
  }

  protected blocked(operation: string): never {
    throw new BlockedCapabilityError(this.integrationId, operation, this.prerequisites);
  }
}
