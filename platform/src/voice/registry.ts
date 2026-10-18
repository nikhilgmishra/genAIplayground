/**
 * Approved-template catalog and registry (spec section 11; OPS-06).
 *
 * Caller-facing text comes only from these templates with typed slots. The
 * catalog files in ./templates are a LOCAL DRAFT: every template is DRAFT,
 * PENDING_CLINICAL_APPROVAL (safety / clinical boundary) or
 * PENDING_LEGAL_APPROVAL (recording, consent, disclosure). The coding agent
 * cannot approve any of them. An APPROVED status only counts when its
 * `approvedBy` approval-record id has been verified by the configuration
 * module's approval loader (`verifiedApprovalIds`); editing the JSON alone can
 * never make a template speakable in production.
 *
 * Load-time validation fails closed on: unknown fields, placeholders that do
 * not match declared slots, stray braces, class/approval inconsistencies,
 * missing review markers, over-long safety text, cross-locale drift, and any
 * diagnostic / therapeutic / medication advice pattern (SAFE-01).
 */
import { z } from "zod";
import { ResponseClass, VersionLabel } from "../protocol/index.js";
import type { Environment } from "../protocol/index.js";
import { digestOf } from "../shared/canonical.js";
import { ConfigurationRejectedError, ValidationError } from "../shared/errors.js";
import type { TemplateDefinition, TemplateRegistry } from "./ports.js";
import type { CatalogSlotSpec } from "./slots.js";
import enUSCatalog from "./templates/en-US.json" with { type: "json" };
import esUSCatalog from "./templates/es-US.json" with { type: "json" };

export const TEMPLATE_ID_RE = /^[a-z][a-z0-9_.]{2,63}$/;
export const SLOT_NAME_RE = /^[a-z][a-zA-Z0-9]{0,40}$/;
export const APPROVAL_ID_RE = /^apr_[A-Za-z0-9_-]{8,64}$/;
const LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/;
const PLACEHOLDER_RE = /\{([a-z][a-zA-Z0-9]{0,40})\}/g;
export const MAX_TEMPLATE_TEXT_CHARS = 300;
export const MAX_SAFETY_TEMPLATE_TEXT_CHARS = 160;
export const CLINICAL_REVIEW_MARKER = "[PENDING CLINICAL SAFETY LEAD APPROVAL]";
export const LEGAL_REVIEW_MARKER = "[PENDING LEGAL APPROVAL]";

const SlotType = z.enum(["date", "time", "time_zone", "money_minor_usd", "person_display_name", "support_reference", "enum", "count", "spelled_code", "portal_path", "match_code"]);

const SlotSpecSchema = z.strictObject({
  type: SlotType,
  enumValues: z.array(z.string().min(1).max(80)).min(1).max(32).optional(),
  labels: z.record(z.string(), z.string().min(1).max(80)).optional(),
  spell: z.boolean().optional(),
});

export const ApprovalStatus = z.enum(["APPROVED", "PENDING_CLINICAL_APPROVAL", "PENDING_LEGAL_APPROVAL", "DRAFT"]);

const TemplateMetadataSchema = z.strictObject({
  owner: z.enum(["clinical_safety_lead", "privacy_counsel", "support_operations", "qa_language_lead"]),
  reviewMarker: z.string().min(3).max(80),
  languageReview: z.enum(["SOURCE_LOCALE", "PENDING_NATIVE_SPEAKER_REVIEW", "APPROVED"]),
  purpose: z.string().min(5).max(400),
  notes: z.string().max(600),
  /** Acknowledgment such as "Let me check that." — never counts as resolution. */
  acknowledgmentOnly: z.boolean(),
});
export type TemplateMetadata = z.infer<typeof TemplateMetadataSchema>;

const CatalogTemplateSchema = z.strictObject({
  templateId: z.string().regex(TEMPLATE_ID_RE),
  version: VersionLabel,
  responseClass: ResponseClass,
  text: z.string().min(1).max(MAX_TEMPLATE_TEXT_CHARS),
  slots: z.record(z.string().regex(SLOT_NAME_RE), SlotSpecSchema),
  approval: z.strictObject({ status: ApprovalStatus, approvedBy: z.string().max(80).nullable() }),
  metadata: TemplateMetadataSchema,
});

export const TemplateCatalogFileSchema = z.strictObject({
  catalogId: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
  catalogVersion: VersionLabel,
  locale: z.string().regex(LOCALE_RE),
  label: z.string().min(10).max(600),
  templates: z.array(CatalogTemplateSchema).min(1).max(200),
});
export type TemplateCatalogFile = z.infer<typeof TemplateCatalogFileSchema>;

/** A registry entry: the port's TemplateDefinition plus review metadata. */
export interface CatalogTemplate extends TemplateDefinition {
  slots: Record<string, CatalogSlotSpec>;
  metadata: TemplateMetadata;
  catalogVersion: string;
}

/**
 * Patterns that must never appear in caller-facing text: diagnosis, therapy,
 * screening, medication advice, invented feelings or unsolicited clinical
 * reassurance (SAFE-01, spec section 11). Applied at load and after render.
 */
export const PROHIBITED_CLINICAL_CONTENT: readonly RegExp[] = [
  /\byou (may|might|probably|likely|could) have\b/i,
  /\bsounds like (you have|depression|anxiety|a disorder)\b/i,
  /\byou(?:'re| are) (depressed|bipolar|anxious|suicidal|mentally ill)\b/i,
  /\bdiagnos(?:is|ed|e|tic)\b/i,
  /\b(take|taking) (\d+|more|less|your|an extra) ?(mg|pills?|medication|meds|dose|doses)\b/i,
  /\bdosage\b/i,
  /\b(increase|decrease|lower|raise) (your|the) (dose|medication|meds)\b/i,
  /\b(stop|start) taking\b/i,
  /\bprescri(be|ption)\b/i,
  /\b(antidepressant|ssri|benzodiazepine)s?\b/i,
  /\b(breathing|grounding|relaxation|coping) (exercise|technique|skill)s?\b/i,
  /\bcalm down\b/i,
  /\byou should (see|try|take|feel|talk)\b/i,
  /\b(it|things|everything) will (get|be) (better|ok|okay|fine|alright)\b/i,
  /\bdon'?t worry\b/i,
  /\bi (understand how you feel|feel|am feeling|care about you)\b/i,
  /diagn[oó]stic/i,
  /\bdosis\b/i,
  /\b(tome|tomar) (m[aá]s|menos|\d+|su|sus) (mg|pastillas?|medicamentos?|dosis)\b/i,
  /\b(deje|empiece) de tomar\b|\bempiece a tomar\b/i,
  /\brecet(ar|arle|a m[eé]dica)\b/i,
  /\bantidepresiv/i,
  /\bejercicios? de (respiraci[oó]n|relajaci[oó]n)\b/i,
  /\bc[aá]lmese\b/i,
  /\btodo (va a estar|estar[aá]) bien\b/i,
  /\bno se preocupe\b/i,
  /\b(entiendo c[oó]mo se siente|me siento)\b/i,
];

/** C0 control characters or DEL (never valid in caller-facing text). */
export function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function containsProhibitedClinicalContent(text: string): boolean {
  return PROHIBITED_CLINICAL_CONTENT.some((re) => re.test(text));
}

export class TemplateCatalogError extends ValidationError {
  constructor(readonly violations: string[]) {
    super("TEMPLATE_CATALOG_INVALID", `TEMPLATE_CATALOG_INVALID: ${violations.slice(0, 20).join("; ")}`);
  }
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? "");
}

function templateViolations(t: z.infer<typeof CatalogTemplateSchema>, locale: string): string[] {
  const at = `${t.templateId}@${locale}`;
  const v: string[] = [];
  const used = placeholders(t.text);
  const declared = Object.keys(t.slots);
  for (const p of used) if (!declared.includes(p)) v.push(`PLACEHOLDER_UNDECLARED:${at}:${p}`);
  for (const d of declared) if (!used.includes(d)) v.push(`SLOT_UNUSED:${at}:${d}`);
  if (new Set(used).size !== used.length) v.push(`PLACEHOLDER_REPEATED:${at}`);
  if (/[{}]/.test(t.text.replace(PLACEHOLDER_RE, ""))) v.push(`TEMPLATE_BRACES_INVALID:${at}`);
  for (const [name, spec] of Object.entries(t.slots)) {
    if (spec.type === "enum" && !spec.enumValues?.length) v.push(`ENUM_VALUES_MISSING:${at}:${name}`);
    if (spec.type !== "enum" && (spec.enumValues || spec.labels)) v.push(`ENUM_VALUES_ON_NON_ENUM:${at}:${name}`);
    for (const k of Object.keys(spec.labels ?? {})) if (!(spec.enumValues ?? []).includes(k)) v.push(`ENUM_LABEL_UNKNOWN:${at}:${name}`);
    if (spec.spell && spec.type !== "person_display_name" && spec.type !== "spelled_code") v.push(`SPELL_NOT_SUPPORTED:${at}:${name}`);
  }
  const { status, approvedBy } = t.approval;
  if (status === "APPROVED" && (approvedBy === null || !APPROVAL_ID_RE.test(approvedBy))) v.push(`APPROVED_WITHOUT_APPROVAL_RECORD:${at}`);
  if (status !== "APPROVED" && approvedBy !== null) v.push(`APPROVER_ON_UNAPPROVED_TEMPLATE:${at}`);
  const clinical = t.responseClass === "SAFETY" || t.responseClass === "CLINICAL_BOUNDARY";
  if (clinical) {
    if (status !== "APPROVED" && status !== "PENDING_CLINICAL_APPROVAL") v.push(`CLINICAL_TEMPLATE_STATUS_INVALID:${at}`);
    if (status !== "APPROVED" && t.metadata.reviewMarker !== CLINICAL_REVIEW_MARKER) v.push(`CLINICAL_REVIEW_MARKER_MISSING:${at}`);
    if (t.metadata.owner !== "clinical_safety_lead") v.push(`CLINICAL_TEMPLATE_OWNER_INVALID:${at}`);
    if (t.text.length > MAX_SAFETY_TEMPLATE_TEXT_CHARS) v.push(`SAFETY_TEMPLATE_TOO_LONG:${at}`);
    if (declared.length > 0) v.push(`SAFETY_TEMPLATE_HAS_SLOTS:${at}`);
  }
  if (t.responseClass === "RECORDING_DISCLOSURE") {
    if (status !== "APPROVED" && status !== "PENDING_LEGAL_APPROVAL") v.push(`DISCLOSURE_TEMPLATE_STATUS_INVALID:${at}`);
    if (status !== "APPROVED" && t.metadata.reviewMarker !== LEGAL_REVIEW_MARKER) v.push(`LEGAL_REVIEW_MARKER_MISSING:${at}`);
  }
  if (!clinical && t.responseClass !== "RECORDING_DISCLOSURE" && status !== "APPROVED" && status !== "DRAFT") v.push(`TEMPLATE_STATUS_CLASS_MISMATCH:${at}`);
  if (t.metadata.acknowledgmentOnly && t.responseClass !== "GENERIC_STATUS") v.push(`ACKNOWLEDGMENT_CLASS_INVALID:${at}`);
  if (containsProhibitedClinicalContent(t.text)) v.push(`TEMPLATE_CLINICAL_ADVICE_PROHIBITED:${at}`);
  if (hasControlCharacters(t.text)) v.push(`TEMPLATE_CONTROL_CHARACTERS:${at}`);
  return v;
}

const slotShape = (slots: Record<string, CatalogSlotSpec>) =>
  Object.fromEntries(Object.entries(slots).sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, { type: s.type, enumValues: s.enumValues ?? null }]));

export interface TemplateRegistryOptions {
  /** Approval record ids verified (signature, scope, expiry) by the configuration module. */
  verifiedApprovalIds?: ReadonlySet<string>;
  /** Every template id must exist in every locale (default true). */
  requireLocaleParity?: boolean;
}

export class CatalogTemplateRegistry implements TemplateRegistry {
  /** The registry is real code; the bundled catalog content is a LOCAL DRAFT. */
  readonly catalogStatus: "LOCAL_DRAFT" | "REVIEWED";
  private readonly byKey = new Map<string, CatalogTemplate>();
  private readonly verified: ReadonlySet<string>;
  private readonly digestValue: string;
  private readonly localeList: string[];

  private constructor(entries: CatalogTemplate[], verified: ReadonlySet<string>, catalogs: TemplateCatalogFile[]) {
    for (const e of entries) this.byKey.set(`${e.locale}|${e.templateId}`, Object.freeze(e));
    this.verified = verified;
    this.localeList = [...new Set(entries.map((e) => e.locale))].sort();
    this.catalogStatus = entries.every((e) => e.approval.status === "APPROVED") ? "REVIEWED" : "LOCAL_DRAFT";
    const canonical = catalogs
      .map((c) => ({ catalogId: c.catalogId, catalogVersion: c.catalogVersion, locale: c.locale, templates: [...c.templates].sort((a, b) => a.templateId.localeCompare(b.templateId)) }))
      .sort((a, b) => a.locale.localeCompare(b.locale));
    this.digestValue = digestOf(canonical);
  }

  /** Validates and loads catalogs; throws TemplateCatalogError listing every violation. */
  static fromCatalogs(raw: readonly unknown[], opts: TemplateRegistryOptions = {}): CatalogTemplateRegistry {
    const violations: string[] = [];
    const catalogs: TemplateCatalogFile[] = [];
    for (const [i, c] of raw.entries()) {
      const parsed = TemplateCatalogFileSchema.safeParse(c);
      if (!parsed.success) {
        violations.push(...parsed.error.issues.slice(0, 10).map((iss) => `CATALOG_SCHEMA_INVALID:${i}:${iss.path.join(".")}`));
        continue;
      }
      catalogs.push(parsed.data);
    }
    const entries: CatalogTemplate[] = [];
    const seenLocales = new Set<string>();
    for (const cat of catalogs) {
      if (seenLocales.has(cat.locale)) violations.push(`CATALOG_LOCALE_DUPLICATE:${cat.locale}`);
      seenLocales.add(cat.locale);
      const ids = new Set<string>();
      for (const t of cat.templates) {
        if (ids.has(t.templateId)) violations.push(`TEMPLATE_ID_DUPLICATE:${t.templateId}@${cat.locale}`);
        ids.add(t.templateId);
        violations.push(...templateViolations(t, cat.locale));
        entries.push({ ...t, slots: t.slots as Record<string, CatalogSlotSpec>, locale: cat.locale, catalogVersion: cat.catalogVersion });
      }
    }
    if (catalogs.length > 1 && opts.requireLocaleParity !== false) {
      const byId = new Map<string, CatalogTemplate[]>();
      for (const e of entries) byId.set(e.templateId, [...(byId.get(e.templateId) ?? []), e]);
      for (const [id, list] of byId) {
        if (list.length !== catalogs.length) violations.push(`LOCALE_PARITY_MISSING:${id}`);
        const first = list[0];
        if (!first) continue;
        for (const other of list.slice(1)) {
          if (other.version !== first.version) violations.push(`LOCALE_PARITY_VERSION:${id}`);
          if (other.responseClass !== first.responseClass) violations.push(`LOCALE_PARITY_CLASS:${id}`);
          if (digestOf(slotShape(other.slots)) !== digestOf(slotShape(first.slots))) violations.push(`LOCALE_PARITY_SLOTS:${id}`);
        }
      }
    }
    if (violations.length > 0) throw new TemplateCatalogError(violations);
    return new CatalogTemplateRegistry(entries, opts.verifiedApprovalIds ?? new Set(), catalogs);
  }

  get(templateId: string, locale: string): CatalogTemplate | null {
    return this.byKey.get(`${locale}|${templateId}`) ?? null;
  }

  list(): CatalogTemplate[] {
    return [...this.byKey.values()].sort((a, b) => (a.locale + a.templateId).localeCompare(b.locale + b.templateId));
  }

  locales(): string[] {
    return [...this.localeList];
  }

  /** sha256 over the canonical catalog set; pinned as VersionSet.promptTemplates (OPS-06). */
  digest(): string {
    return this.digestValue;
  }

  /** APPROVED only when the referenced approval record was verified; otherwise the declared pending status. */
  effectiveApproval(def: TemplateDefinition): z.infer<typeof ApprovalStatus> | "APPROVAL_UNVERIFIED" {
    if (def.approval.status !== "APPROVED") return def.approval.status;
    return def.approval.approvedBy !== null && this.verified.has(def.approval.approvedBy) ? "APPROVED" : "APPROVAL_UNVERIFIED";
  }
}

/** Registry over the bundled LOCAL DRAFT catalogs (en-US, es-US). */
export function loadDefaultTemplateRegistry(opts: TemplateRegistryOptions = {}): CatalogTemplateRegistry {
  return CatalogTemplateRegistry.fromCatalogs([enUSCatalog, esUSCatalog], opts);
}

/** Templates every deployed locale must have approved before the voice layer can serve callers. */
export const REQUIRED_PRODUCTION_TEMPLATE_IDS: readonly string[] = [
  "fallback.safe_explanation",
  "safety.acknowledgment",
  "transfer.safety_update",
  "clinical.boundary",
  "opening.disclosure",
  "recording.consent_question",
  "recording.decline_alternative",
  "human.offer",
  "transfer.in_progress",
  "transfer.failed_next_route",
  "language.unsupported",
  "outage.continuity",
];

/**
 * Startup check (OPS-04 style). Outside local/ci every required template must
 * be effectively APPROVED in every locale; returns violation codes.
 */
export function catalogDeploymentViolations(registry: CatalogTemplateRegistry, environment: Environment): string[] {
  if (environment === "local" || environment === "ci") return [];
  const v: string[] = [];
  for (const locale of registry.locales()) {
    for (const id of REQUIRED_PRODUCTION_TEMPLATE_IDS) {
      const def = registry.get(id, locale);
      if (!def) v.push(`REQUIRED_TEMPLATE_MISSING:${id}@${locale}`);
      else if (registry.effectiveApproval(def) !== "APPROVED") v.push(`REQUIRED_TEMPLATE_NOT_APPROVED:${id}@${locale}`);
    }
  }
  return v;
}

export function assertCatalogDeployable(registry: CatalogTemplateRegistry, environment: Environment): void {
  const v = catalogDeploymentViolations(registry, environment);
  if (v.length > 0) throw new ConfigurationRejectedError(v);
}
