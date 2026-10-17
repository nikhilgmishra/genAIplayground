/**
 * LOCAL FIXTURE — ClaimsSystem over the SYNTHETIC world. NOT a vendor adapter;
 * rejected by the production configuration guard (OPS-04). The live claims
 * adapter is BLOCKED (live/business-systems-blocked.ts, PRQ-007).
 *
 * Claim status is the INSURER-REPORTED status with its as-of time and nothing
 * else: no eligibility decision, no coverage decision, no payment guarantee and
 * no expected amount (spec section 4). The returned object has exactly the
 * ClaimStatus port fields.
 */
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { OpaqueId } from "../../protocol/index.js";
import { ValidationError } from "../../shared/errors.js";
import type { AdapterHealth, ClaimStatus, ClaimsSystem } from "../ports.js";
import { READ_FAULTS, noFaults, type FaultInjector } from "./faults.js";
import { LOCAL_FIXTURE_LABEL, type StoredClaim, type SyntheticStore } from "./synthetic-store.js";

export const CLAIMS_FIXTURE_OPERATIONS = { listClaims: READ_FAULTS, getClaim: READ_FAULTS } as const;

const toClaim = (c: StoredClaim): ClaimStatus => ({
  claimId: c.claimId,
  subjectId: c.subjectId,
  serviceDate: c.serviceDate,
  payerDisplayName: c.payerDisplayName,
  insurerStatus: c.insurerStatus,
  statusAsOf: c.statusAsOf,
});

export interface ClaimsFixtureOptions {
  store: SyntheticStore;
  faults?: FaultInjector;
  logger?: Logger;
}

export class ClaimsFixture implements ClaimsSystem {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "claims";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly store: SyntheticStore;
  private readonly faults: FaultInjector;
  private readonly logger: Logger;

  constructor(opts: ClaimsFixtureOptions) {
    this.store = opts.store;
    this.faults = opts.faults ?? noFaults();
    this.logger = (opts.logger ?? silentLogger).child({ component: "claims_fixture" });
    this.faults.declare(this.integrationId, CLAIMS_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async listClaims(subjectId: string): Promise<ClaimStatus[]> {
    if (!OpaqueId.safeParse(subjectId).success) throw new ValidationError("CLAIMS_INPUT_INVALID");
    const f = this.faults.begin(this.integrationId, "listClaims");
    await f.beforeSend();
    const rows = f.has("STALE_READ") ? this.store.staleList("claims") : this.store.list("claims");
    this.logger.debug("fixture.claims.list", { stale: f.has("STALE_READ") });
    return rows
      .filter((c) => c.subjectId === subjectId)
      .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.claimId.localeCompare(b.claimId))
      .map(toClaim);
  }

  async getClaim(claimId: string): Promise<ClaimStatus | null> {
    if (!OpaqueId.safeParse(claimId).success) throw new ValidationError("CLAIMS_INPUT_INVALID");
    const f = this.faults.begin(this.integrationId, "getClaim");
    await f.beforeSend();
    const c = f.has("STALE_READ") ? this.store.staleGet("claims", claimId) : this.store.get("claims", claimId);
    return c ? toClaim(c) : null;
  }

  /** LOCAL FIXTURE helper: the insurer reports a new status (e.g. adjudication). */
  simulateInsurerUpdate(claimId: string, insurerStatus: ClaimStatus["insurerStatus"], statusAsOf: string): void {
    this.store.update("claims", claimId, (c) => {
      c.insurerStatus = insurerStatus;
      c.statusAsOf = statusAsOf;
    });
  }
}
