/**
 * Live adapter wiring for environments whose prerequisites are not evidenced:
 * every business-system and Talkdesk slot is a BLOCKED live stub and the
 * Salesforce slot is the documented REST adapter in BLOCKED schema state (no
 * endpoint, no credentials, no network). This is what a staging/production
 * process would hold today: the configuration guard sees kind "live"
 * everywhere (no fixtures, OPS-04), and every capability fails closed with
 * BLOCKED_CAPABILITY_UNVERIFIED (OPS-03) instead of simulating success.
 */
import { BlockedCapabilityError } from "../errors.js";
import { AdapterRegistry } from "../registry.js";
import {
  BillingLiveBlocked,
  ClaimsLiveBlocked,
  ProviderSystemLiveBlocked,
  RelationshipDirectoryLiveBlocked,
  SchedulingLiveBlocked,
} from "./business-systems-blocked.js";
import { SALESFORCE_SCHEMA_OWNER, SalesforceRestSupportRecords } from "./salesforce-rest-support-records.js";
import { TalkdeskTelephonyLive } from "./talkdesk-blocked.js";

export function createBlockedLiveRegistry(opts: { freeze?: boolean } = {}): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register("scheduling", new SchedulingLiveBlocked());
  registry.register("billing", new BillingLiveBlocked());
  registry.register("claims", new ClaimsLiveBlocked());
  registry.register("provider-system", new ProviderSystemLiveBlocked());
  registry.register("relationship-directory", new RelationshipDirectoryLiveBlocked());
  registry.register("talkdesk-telephony", new TalkdeskTelephonyLive());
  registry.register(
    "salesforce",
    new SalesforceRestSupportRecords(
      {
        myDomainUrl: null,
        apiVersion: null,
        timeoutMs: 2_500,
        schema: { status: "BLOCKED", prerequisite: "PRQ-006", owner: SALESFORCE_SCHEMA_OWNER },
      },
      {
        credentials: async () => {
          throw new BlockedCapabilityError("salesforce", "credentials", ["PRQ-006"]);
        },
      },
    ),
  );
  if (opts.freeze ?? true) registry.freeze();
  return registry;
}
