/**
 * Composition factory of the live domain adapters (WP-23; FO-06-74, FO-03-09, FO-11-02, FO-00-13).
 *
 * The composition root (platform/src/main, owned by WP-07) calls `createDomainAdapters` with the tenant's
 * connector profiles and domain bindings (configuration data) and the WP-06 connector runtime dependencies
 * (transport, secret resolver, clock, metrics). Every profile is admitted by `admitConnectorProfile` for the
 * environment and every binding by `admitBinding`; credential reuse across the set is refused
 * (`credentialReuseViolations`). Nothing is built when any of them is refused (no partial domain set).
 *
 * The result serves:
 *   - the canonical, party-scoped reads (HttpScheduling, HttpBilling, HttpClaims, HttpProviderNetwork,
 *     HttpReferralStatus);
 *   - the business layer's existing SchedulingSystem / BillingSystem / ProviderSystem ports, structurally, so the
 *     LOCAL FIXTURE systems can be replaced in live mode;
 *   - `commitPort`: the ProviderCommitPort (prepare, commit, receipt, reconcile, verify) the action executor uses
 *     for scheduling and billing actions; `legacyCommitPort` for a tenant on the non-idempotent legacy product.
 * The in-process business fixtures stay labelled unit fakes; nothing here falls back to them.
 */
import type { ConnectorHttpTransport } from "../connectors/http/transport.js";
import { credentialReuseViolations } from "../connectors/profile/credentials.js";
import { ProfileRejectedError, admitConnectorProfile } from "../connectors/profile/validate.js";
import type { AdmittedProfile } from "../connectors/profile/validate.js";
import { ConnectorRuntime } from "../connectors/runtime/connector.js";
import type { SecretResolver } from "../connectors/secrets/resolver.js";
import type { Logger, Metrics } from "../observability/ports.js";
import type { Environment } from "../protocol/common.js";
import type { Clock } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { HttpBilling, HttpClaims } from "./billing.js";
import { admitBinding } from "./binding.js";
import type { AdmittedBinding, DomainContract } from "./binding.js";
import { DomainCommitPort } from "./commit.js";
import type { DomainSystem } from "./contracts.js";
import { HttpLegacyScheduling } from "./legacy.js";
import { HttpProviderNetwork, HttpReferralStatus } from "./network.js";
import { DomainConnector } from "./runner.js";
import { HttpScheduling } from "./scheduling.js";

export interface DomainSystemConfig {
  /** Raw ConnectorProfile document (untrusted until admitted). */
  profile: unknown;
  /** Raw DomainBinding document (untrusted until admitted). */
  binding: unknown;
}

export interface DomainAdaptersDeps {
  environment: Environment;
  transport: ConnectorHttpTransport;
  secrets: SecretResolver;
  clock: Clock;
  metrics?: Metrics;
  logger?: Logger;
  systems: readonly DomainSystemConfig[];
}

export interface DomainAdapters {
  readonly scheduling: HttpScheduling | null;
  readonly billing: HttpBilling | null;
  readonly claims: HttpClaims | null;
  readonly provider: HttpProviderNetwork | null;
  readonly referrals: HttpReferralStatus | null;
  readonly legacyScheduling: HttpLegacyScheduling | null;
  /** Commit port of scheduling and billing actions (null when neither system is composed). */
  readonly commitPort: DomainCommitPort | null;
  /** Connector runtimes by profile id (health, probes, capability tests). */
  readonly runtimes: ReadonlyMap<string, ConnectorRuntime>;
  readonly connectors: ReadonlyMap<DomainContract, DomainConnector>;
}

const SYSTEM_OF: Readonly<Record<DomainContract, DomainSystem>> = Object.freeze({
  "scheduling.v1": "scheduling",
  "billing.v1": "billing",
  "claims.v1": "claims",
  "provider.v1": "provider",
  "referrals.v1": "referrals",
  "scheduling.legacy.v1": "scheduling",
});

/** Admits every profile and binding, then builds one connector runtime and one adapter per contract. */
export function createDomainAdapters(deps: DomainAdaptersDeps): DomainAdapters {
  const admitted: AdmittedProfile[] = deps.systems.map((s) => admitConnectorProfile(s.profile, deps.environment));
  const ids = new Set<string>();
  for (const a of admitted) {
    if (ids.has(a.profile.profileId)) throw new ProfileRejectedError(["PROFILE_DUPLICATE_ID"]);
    ids.add(a.profile.profileId);
  }
  const reuse = credentialReuseViolations([{ environment: deps.environment, profiles: admitted.map((a) => a.profile) }]);
  if (reuse.length > 0) throw new ProfileRejectedError(reuse.map((r) => r.code));
  const bindings: AdmittedBinding[] = deps.systems.map((s, i) => admitBinding(s.binding, admitted[i] as AdmittedProfile));
  const runtimes = new Map<string, ConnectorRuntime>();
  const connectors = new Map<DomainContract, DomainConnector>();
  bindings.forEach((b, i) => {
    const a = admitted[i] as AdmittedProfile;
    if (connectors.has(b.binding.contract)) throw new ValidationError("DOMAIN_CONTRACT_BOUND_TWICE");
    const rt = new ConnectorRuntime({ admitted: a, transport: deps.transport, secrets: deps.secrets, clock: deps.clock, metrics: deps.metrics, logger: deps.logger });
    runtimes.set(a.profile.profileId, rt);
    connectors.set(b.binding.contract, new DomainConnector(b, rt, SYSTEM_OF[b.binding.contract], deps.clock));
  });
  const of = <T>(c: DomainContract, make: (conn: DomainConnector) => T): T | null => {
    const conn = connectors.get(c);
    return conn ? make(conn) : null;
  };
  const scheduling = of("scheduling.v1", (c) => new HttpScheduling(c));
  const billing = of("billing.v1", (c) => new HttpBilling(c));
  return {
    scheduling,
    billing,
    claims: of("claims.v1", (c) => new HttpClaims(c)),
    provider: of("provider.v1", (c) => new HttpProviderNetwork(c)),
    referrals: of("referrals.v1", (c) => new HttpReferralStatus(c)),
    legacyScheduling: of("scheduling.legacy.v1", (c) => new HttpLegacyScheduling(c)),
    commitPort: scheduling || billing ? new DomainCommitPort({ scheduling, billing, clock: deps.clock }) : null,
    runtimes,
    connectors,
  };
}
