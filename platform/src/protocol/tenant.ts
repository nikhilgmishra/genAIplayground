/**
 * TenantConfig (follow-on prompt sections 4 and 14; FO-04-35, FO-04-43).
 *
 * The published, versioned configuration of one tenant, separate from the deployment-scoped
 * PlatformConfig (platform/src/config/schema.ts; CONTRACT_ALIASES maps the two). It carries the
 * explicit business timezone used for every business date, locales, jurisdictions, regions,
 * processing purposes, retention per data class (null = not yet approved, which blocks only the
 * affected activation), connector profile references, enabled capabilities, escalation
 * destinations and required approvals. It holds references only: no secrets, no PHI.
 *
 * Created by WP-02 in phase B; owned by WP-31 from phase F (platform/src/tenant-config).
 */
import { z } from "zod";
import {
  BusinessTimeZone,
  CapabilityId,
  DataClass,
  EvidencePointer,
  Jurisdiction,
  ProcessingPurpose,
  Sha256Hex,
  envelope,
  opaqueIdWithPrefix,
  toBusinessDate,
} from "./common.js";
import { ApprovalScope } from "./release.js";
import { DestinationId } from "./support.js";

export const TENANT_CONFIG_SCHEMA_VERSION = "tenant-config.v1";

const AwsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-[0-9]$/);
const RetentionDays = z.number().int().min(1).max(36_500).nullable();

export const TenantConfig = z
  .strictObject({
    ...envelope(TENANT_CONFIG_SCHEMA_VERSION, ["tenantId", "occurredAt"], ["causationId"]),
    configVersion: z.number().int().min(1).max(1_000_000),
    status: z.enum(["DRAFT", "IN_REVIEW", "PUBLISHED", "ROLLED_BACK"]),
    /** Operator-facing label for the tenant (organization name, never a person). */
    label: z.string().min(2).max(80).regex(/^[A-Za-z0-9 .,&()'-]+$/),
    businessTimeZone: BusinessTimeZone,
    locales: z.array(z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/)).min(1).max(16),
    jurisdictions: z.array(Jurisdiction).min(1).max(32),
    regions: z.strictObject({ primary: AwsRegion, secondary: AwsRegion.nullable(), usOnly: z.boolean() }),
    processingPurposes: z.array(ProcessingPurpose).min(1).max(13),
    retentionDays: z.strictObject({
      TRANSIENT_CONVERSATION: RetentionDays,
      BUSINESS_RECORD: RetentionDays,
      RESTRICTED_QA_MEDIA: RetentionDays,
      SECURITY_AUDIT: RetentionDays,
    }),
    retentionPolicyRef: EvidencePointer.nullable(),
    connectorProfileRefs: z.array(opaqueIdWithPrefix("cnp")).max(64),
    enabledCapabilities: z.array(CapabilityId).max(128),
    escalationDestinations: z.array(DestinationId).max(64),
    approvalsRequired: z.array(ApprovalScope).max(16),
    /** sha256 over the canonical config without this field; pinned in releases and audit events. */
    configDigest: Sha256Hex,
    publishedBy: z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/).nullable(),
    reviewedBy: z.string().regex(/^stf_[A-Za-z0-9_-]{8,64}$/).nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.regions.usOnly && (!c.regions.primary.startsWith("us-") || (c.regions.secondary !== null && !c.regions.secondary.startsWith("us-")))) {
      ctx.addIssue({ code: "custom", message: "US_ONLY_REGION_OUTSIDE_US", path: ["regions"] });
    }
    if (c.processingPurposes.includes("marketing")) ctx.addIssue({ code: "custom", message: "SUPPORT_TENANT_MARKETING_PURPOSE", path: ["processingPurposes"] });
    if (c.status === "PUBLISHED") {
      if (c.publishedBy === null || c.reviewedBy === null) ctx.addIssue({ code: "custom", message: "PUBLISHED_WITHOUT_REVIEW", path: ["reviewedBy"] });
      else if (c.publishedBy === c.reviewedBy) ctx.addIssue({ code: "custom", message: "SELF_REVIEWED_PUBLICATION", path: ["reviewedBy"] });
    }
    if (new Set(c.jurisdictions).size !== c.jurisdictions.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_JURISDICTION", path: ["jurisdictions"] });
  });
export type TenantConfig = z.infer<typeof TenantConfig>;

/** Data classes whose retention is not yet configured; activation of capabilities storing them stays blocked. */
export const unsetRetentionClasses = (c: TenantConfig): DataClass[] => DataClass.options.filter((k) => c.retentionDays[k] === null);

/** Business date of an instant in the tenant's configured timezone (FO-04-43). */
export const tenantBusinessDate = (c: Pick<TenantConfig, "businessTimeZone">, instant: string): string => toBusinessDate(instant, c.businessTimeZone);
