/**
 * Strict input schemas for SupportRecordSystem (platform/src/adapters/ports.ts),
 * shared by the LOCAL Salesforce-like fixture and the live Salesforce REST
 * adapter so both reject exactly the same inputs.
 *
 * External ids follow the protocol SupportRequest schema: `int_…` for the
 * interaction (one call) and `iss_…` for the issue (Case). One interaction may
 * address several issues; a repeat call may refer to an existing issue
 * (spec section 8).
 */
import { z } from "zod";
import { IsoDateTime, IssueCategory, OpaqueId, Outcome, Role, SupportReference } from "../protocol/index.js";
import type { CaseFields } from "./ports.js";

export const InteractionExternalId = z.string().regex(/^int_[A-Za-z0-9_-]{16,64}$/);
export const IssueExternalId = z.string().regex(/^iss_[A-Za-z0-9_-]{16,64}$/);
const Language = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

export const InteractionFieldsSchema = z.strictObject({
  callId: OpaqueId,
  language: Language,
  consentStatus: Code,
  startedAt: IsoDateTime,
});
export type InteractionFields = z.infer<typeof InteractionFieldsSchema>;

/** Strict validation of the CaseFields port type with the protocol's closed sets and bounds. */
export const CaseFieldsSchema = z.strictObject({
  subjectRef: OpaqueId.nullable(),
  audience: Role.nullable(),
  issueCategory: IssueCategory,
  disposition: Outcome,
  ownerQueue: z.string().regex(/^q_[a-z0-9_]{2,40}$/),
  priority: z.enum(["P1_SAFETY", "P2_URGENT", "P3_STANDARD", "P4_LOW"]),
  /** Minimized approved summary assembled from templates, never a transcript. */
  summary: z.string().max(600),
  attempted: z.array(z.string().regex(/^[a-z_.]{3,64}$/)).max(16),
  commitReceiptIds: z.array(OpaqueId).max(16),
  sourceCallIds: z.array(OpaqueId).min(1).max(32),
  language: Language,
  consentStatus: Code,
  nextStep: z.string().max(200).nullable(),
  deadline: IsoDateTime.nullable(),
  versions: z.string().regex(/^[A-Za-z0-9._:+=,;@/-]{1,512}$/),
  restricted: z.boolean(),
  supportReference: SupportReference,
}) satisfies z.ZodType<CaseFields>;

export const CASE_FIELD_KEYS = Object.keys(CaseFieldsSchema.shape) as (keyof CaseFields)[];
