/**
 * LOCAL FIXTURE wiring: one SyntheticStore, one FaultInjector and every
 * business-system / vendor fixture owned by the adapters module, registered in
 * an AdapterRegistry under the `adapters` keys of platform/config/*.json.
 * SYNTHETIC DATA ONLY — the production configuration guard rejects every one of
 * these components (OPS-04) and the console shows the LOCAL FIXTURE badge.
 *
 * Identity fixtures (identity directory, OIDC, notifications) are owned by the
 * identity module; pass them in `extra` to register them in the same registry.
 */
import type { Logger } from "../../observability/ports.js";
import { systemClock, type Clock } from "../../shared/clock.js";
import type { Adapter } from "../ports.js";
import { AdapterRegistry } from "../registry.js";
import { BillingFixture } from "./billing-fixture.js";
import { ClaimsFixture } from "./claims-fixture.js";
import { FaultInjector } from "./faults.js";
import { ProviderFixture } from "./provider-fixture.js";
import { RelationshipDirectoryFixture } from "./relationship-directory-fixture.js";
import { SchedulingFixture } from "./scheduling-fixture.js";
import { SupportRecordsFixture } from "./support-records-fixture.js";
import { SyntheticStore } from "./synthetic-store.js";
import { TelephonyFixture, type TrustedTransferDestination } from "./telephony-fixture.js";

export interface LocalFixtureSetOptions {
  clock?: Clock;
  store?: SyntheticStore;
  faults?: FaultInjector;
  logger?: Logger;
  /** Trusted transfer allowlist; defaults to the SYNTHETIC DESTINATIONS. */
  destinations?: readonly TrustedTransferDestination[];
  approvedTemplateIds?: readonly string[];
  /** Additional adapters (e.g. identity fixtures) keyed by config component name. */
  extra?: Readonly<Record<string, Adapter>>;
  /** Freeze the registry after wiring (default true). */
  freeze?: boolean;
}

export interface LocalFixtureSet {
  store: SyntheticStore;
  faults: FaultInjector;
  registry: AdapterRegistry;
  scheduling: SchedulingFixture;
  billing: BillingFixture;
  claims: ClaimsFixture;
  provider: ProviderFixture;
  relationships: RelationshipDirectoryFixture;
  supportRecords: SupportRecordsFixture;
  telephony: TelephonyFixture;
}

export function createLocalFixtureSet(opts: LocalFixtureSetOptions = {}): LocalFixtureSet {
  const clock = opts.clock ?? systemClock;
  const store = opts.store ?? new SyntheticStore();
  const faults = opts.faults ?? new FaultInjector();
  const common = { store, faults, clock, ...(opts.logger ? { logger: opts.logger } : {}) };
  const set: LocalFixtureSet = {
    store,
    faults,
    registry: new AdapterRegistry(),
    scheduling: new SchedulingFixture(common),
    billing: new BillingFixture(common),
    claims: new ClaimsFixture(common),
    provider: new ProviderFixture(common),
    relationships: new RelationshipDirectoryFixture(common),
    supportRecords: new SupportRecordsFixture({ faults, clock, ...(opts.logger ? { logger: opts.logger } : {}) }),
    telephony: new TelephonyFixture({
      destinations: opts.destinations ?? store.list("destinations").map((d) => ({ destinationId: d.destinationId, vendorQueueRef: d.vendorQueueRef, purpose: d.purpose })),
      faults,
      clock,
      ...(opts.approvedTemplateIds ? { approvedTemplateIds: opts.approvedTemplateIds } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    }),
  };
  set.registry.register("scheduling", set.scheduling);
  set.registry.register("billing", set.billing);
  set.registry.register("claims", set.claims);
  set.registry.register("provider-system", set.provider);
  set.registry.register("relationship-directory", set.relationships);
  set.registry.register("salesforce", set.supportRecords);
  set.registry.register("talkdesk-telephony", set.telephony);
  for (const [component, adapter] of Object.entries(opts.extra ?? {})) set.registry.register(component, adapter);
  if (opts.freeze ?? true) set.registry.freeze();
  return set;
}
