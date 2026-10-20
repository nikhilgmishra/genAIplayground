/**
 * Rules derived FROM the admitted profiles, so retention, egress and release pinning never drift from
 * the connector configuration (WP-06; FO-06-17, FO-06-18):
 *   - `egressDestinationFor`: the EgressGuard destination of a connector (hosts = allowedHosts, classes
 *     = the profile and stream egress classes); the guard's hard rules still apply, so a PHI class
 *     without coverage and approval is refused at construction (DATA-01);
 *   - `retentionRulesFor`: per stream, the retention class, deletion behaviour and vendor-copy deletion
 *     path the retention registry (platform/src/retention, WP-22) consumes;
 *   - `profileDigestEntries`: the per-profile configuration and mapping digests the release manifest
 *     pins (FO-06-18; the manifest builder is WP-01/WP-34/WP-40's platform/src/evaluation/manifest.ts).
 */
import type { Classification, Environment } from "../../protocol/common.js";
import type { ConnectorProfile } from "../../protocol/connector.js";
import type { EgressDestination } from "../../privacy/egress.js";
import type { AdmittedProfile } from "./validate.js";

const FAMILY_DESTINATION_KIND: Record<ConnectorProfile["family"], EgressDestination["kind"]> = {
  contact_center: "SYSTEM_OF_RECORD",
  sip_carrier: "PHI_PROCESSOR",
  crm: "SYSTEM_OF_RECORD",
  cdp: "ANALYTICS_SINK",
  warehouse: "SYSTEM_OF_RECORD",
  lakehouse: "SYSTEM_OF_RECORD",
  business_system: "SYSTEM_OF_RECORD",
  knowledge: "SYSTEM_OF_RECORD",
  notification: "PHI_PROCESSOR",
  identity: "VERIFICATION_SERVICE",
  model_provider: "MODEL_ENDPOINT",
};

export interface EgressCoverage {
  baaRef: string | null;
  approvalId: string | null;
}

/** EgressGuard destination of one connector, for the given environments and coverage. */
export function egressDestinationFor(p: ConnectorProfile, environments: readonly Environment[], coverage: EgressCoverage): EgressDestination {
  const classes = new Set<Classification>(["INTERNAL", p.egressClass]);
  for (const s of p.streams ?? []) classes.add(s.egressClass);
  const id = `egr_${p.system}`.slice(0, 44);
  return {
    destinationId: id,
    kind: FAMILY_DESTINATION_KIND[p.family],
    hosts: [...p.allowedHosts].slice(0, 8),
    allowedClasses: [...classes].slice(0, 6),
    coverage: { baaRef: coverage.baaRef, approvalId: coverage.approvalId },
    environments: [...environments],
    adapterKind: p.credentialRef.startsWith("local-fixture:") ? "local_fixture" : "live",
  };
}

export interface ConnectorRetentionRule {
  system: string;
  profileId: string;
  streamId: string;
  sourceObject: string;
  retentionClass: ConnectorProfile["retentionClass"];
  egressClass: Classification;
  deletionBehavior: NonNullable<ConnectorProfile["streams"]>[number]["deletionBehavior"];
  /** How a privacy deletion reaches the vendor copy. */
  vendorDeletion: "VENDOR_DELETE_OPERATION" | "TOMBSTONE_EVENTS" | "RECONCILIATION_ONLY" | "NOT_SUPPORTED";
  vendorDeletionOperationId: string | null;
}

/** Retention and vendor-deletion rule per stream (FO-06-17). */
export function retentionRulesFor(p: ConnectorProfile): ConnectorRetentionRule[] {
  return (p.streams ?? []).map((s) => ({
    system: p.system,
    profileId: p.profileId,
    streamId: s.streamId,
    sourceObject: s.sourceObject,
    retentionClass: s.retentionClass,
    egressClass: s.egressClass,
    deletionBehavior: s.deletionBehavior,
    vendorDeletion:
      s.vendorDeletionOperationId !== null
        ? "VENDOR_DELETE_OPERATION"
        : s.deletionBehavior === "DELETE_EVENT" || s.deletionBehavior === "TOMBSTONE" || s.deletionBehavior === "SOFT_DELETE_FLAG"
          ? "TOMBSTONE_EVENTS"
          : s.deletionBehavior === "RECONCILIATION_ONLY"
            ? "RECONCILIATION_ONLY"
            : "NOT_SUPPORTED",
    vendorDeletionOperationId: s.vendorDeletionOperationId,
  }));
}

export interface ProfileDigestEntry {
  profileId: string;
  profileVersion: number;
  system: string;
  configDigest: string;
  /** Compiled mapping digest per source object (FO-06-23: mapping digests pinned). */
  mappingDigests: Record<string, string>;
}

/** Release-manifest pins of the admitted connector profiles, sorted by profile id. */
export function profileDigestEntries(admitted: readonly AdmittedProfile[]): ProfileDigestEntry[] {
  return admitted
    .map((a) => ({
      profileId: a.profile.profileId,
      profileVersion: a.profile.profileVersion,
      system: a.profile.system,
      configDigest: a.digest,
      mappingDigests: Object.fromEntries([...a.mappings.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([obj, m]) => [obj, m.digest])),
    }))
    .sort((x, y) => x.profileId.localeCompare(y.profileId));
}
