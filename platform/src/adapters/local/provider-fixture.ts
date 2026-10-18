/**
 * LOCAL FIXTURE — ProviderSystem (provider network: onboarding and remittances)
 * over the SYNTHETIC world. NOT a vendor adapter; rejected by the production
 * configuration guard (OPS-04). The live provider-network adapter is BLOCKED
 * (live/business-systems-blocked.ts, PRQ-007).
 *
 *  - onboarding status is the stage and the missing document TYPES only; it
 *    never makes or predicts a credentialing decision (spec section 4);
 *  - remittances are filtered by practice and by period overlap with the
 *    requested date range. Organization scoping is also enforced by the
 *    gateway policy (delegated practice access, AUTH-05); this fixture never
 *    returns another practice's remittances for a practice id.
 */
import { z } from "zod";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { OpaqueId } from "../../protocol/index.js";
import { ValidationError } from "../../shared/errors.js";
import type { AdapterHealth, OnboardingStatus, ProviderSystem, Remittance } from "../ports.js";
import { READ_FAULTS, noFaults, type FaultInjector } from "./faults.js";
import { LOCAL_FIXTURE_LABEL, type StoredOnboarding, type StoredRemittance, type SyntheticStore } from "./synthetic-store.js";

const ListRemittancesInput = z.strictObject({ practiceId: OpaqueId, fromDate: z.iso.date(), toDate: z.iso.date() });
const MAX_RANGE_DAYS = 400;
const DAY_MS = 86_400_000;

export const PROVIDER_FIXTURE_OPERATIONS = { getOnboardingStatus: READ_FAULTS, listRemittances: READ_FAULTS } as const;

const toOnboarding = (o: StoredOnboarding): OnboardingStatus => ({
  providerId: o.providerId,
  stage: o.stage,
  missingDocumentTypes: [...o.missingDocumentTypes],
  asOf: o.asOf,
  organizationId: o.organizationId ?? null,
});

const toRemittance = (r: StoredRemittance): Remittance => ({
  remittanceId: r.remittanceId,
  practiceId: r.practiceId,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  totalMinor: r.totalMinor,
  status: r.status,
  paidOn: r.paidOn,
});

export interface ProviderFixtureOptions {
  store: SyntheticStore;
  faults?: FaultInjector;
  logger?: Logger;
}

export class ProviderFixture implements ProviderSystem {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "provider-system";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly store: SyntheticStore;
  private readonly faults: FaultInjector;
  private readonly logger: Logger;

  constructor(opts: ProviderFixtureOptions) {
    this.store = opts.store;
    this.faults = opts.faults ?? noFaults();
    this.logger = (opts.logger ?? silentLogger).child({ component: "provider_fixture" });
    this.faults.declare(this.integrationId, PROVIDER_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async getOnboardingStatus(providerId: string): Promise<OnboardingStatus | null> {
    if (!OpaqueId.safeParse(providerId).success) throw new ValidationError("PROVIDER_INPUT_INVALID");
    const f = this.faults.begin(this.integrationId, "getOnboardingStatus");
    await f.beforeSend();
    const o = f.has("STALE_READ") ? this.store.staleGet("onboarding", providerId) : this.store.get("onboarding", providerId);
    return o ? toOnboarding(o) : null;
  }

  async listRemittances(input: { practiceId: string; fromDate: string; toDate: string }): Promise<Remittance[]> {
    const parsed = ListRemittancesInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("PROVIDER_INPUT_INVALID");
    const q = parsed.data;
    const span = (Date.parse(q.toDate) - Date.parse(q.fromDate)) / DAY_MS;
    if (span < 0 || span + 1 > MAX_RANGE_DAYS) throw new ValidationError("REMITTANCE_RANGE_INVALID");
    const f = this.faults.begin(this.integrationId, "listRemittances");
    await f.beforeSend();
    const rows = f.has("STALE_READ") ? this.store.staleList("remittances") : this.store.list("remittances");
    this.logger.debug("fixture.provider.remittances.list", { stale: f.has("STALE_READ") });
    return rows
      .filter((r) => r.practiceId === q.practiceId && r.periodStart <= q.toDate && r.periodEnd >= q.fromDate)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.remittanceId.localeCompare(b.remittanceId))
      .map(toRemittance);
  }

  /** LOCAL FIXTURE helper: the provider network records an onboarding change. */
  simulateOnboardingUpdate(providerId: string, change: Partial<Pick<OnboardingStatus, "stage" | "missingDocumentTypes" | "asOf">>): void {
    this.store.update("onboarding", providerId, (o) => {
      if (change.stage !== undefined) o.stage = change.stage;
      if (change.missingDocumentTypes !== undefined) o.missingDocumentTypes = [...change.missingDocumentTypes];
      if (change.asOf !== undefined) o.asOf = change.asOf;
    });
  }

  /** LOCAL FIXTURE helper: a remittance status change (e.g. RETURNED). */
  simulateRemittanceUpdate(remittanceId: string, change: Partial<Pick<Remittance, "status" | "paidOn">>): void {
    this.store.update("remittances", remittanceId, (r) => {
      if (change.status !== undefined) r.status = change.status;
      if (change.paidOn !== undefined) r.paidOn = change.paidOn;
    });
  }
}
