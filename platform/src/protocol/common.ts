/**
 * Shared protocol primitives. Every object schema in the protocol is strict
 * (unknown keys rejected => JSON Schema additionalProperties:false).
 *
 * Identifiers are opaque: a prefix plus random base64url. They never embed
 * names, dates of birth, phone numbers or any other PHI.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "2026-10-17.1";

/** Opaque identifier: `<prefix>_<16..64 base64url chars>`. */
export const OpaqueId = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/, "opaque identifier expected");
export type OpaqueId = z.infer<typeof OpaqueId>;

export const opaqueIdWithPrefix = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`), `opaque ${prefix}_ identifier expected`);

export const IsoDateTime = z.iso.datetime({ offset: false });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex digest expected");
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Semantic or date-based version label for pinned artifacts. */
export const VersionLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);

export const Environment = z.enum(["local", "ci", "sandbox", "staging", "production"]);
export type Environment = z.infer<typeof Environment>;

/** Caller audience selected during intake. A multi-role user selects exactly one. */
export const Role = z.enum([
  "client",
  "prospective_client",
  "provider",
  "practice_staff",
  "partner",
  "payer_representative",
  "personal_representative",
]);
export type Role = z.infer<typeof Role>;

/** Workforce roles (console, approvals). Separated per spec section 7. */
export const StaffRole = z.enum([
  "support_agent",
  "supervisor",
  "safety_responder",
  "auditor",
  "knowledge_editor",
  "policy_approver",
  "deployment_operator",
  "security_admin",
]);
export type StaffRole = z.infer<typeof StaffRole>;

/**
 * Application policy assurance tiers (NOT NIST AAL certifications).
 * A0 unverified, A1 verified possession, A2 account authenticated, A3 recent step-up.
 */
export const Assurance = z.enum(["A0", "A1", "A2", "A3"]);
export type Assurance = z.infer<typeof Assurance>;
export const ASSURANCE_RANK: Record<Assurance, number> = { A0: 0, A1: 1, A2: 2, A3: 3 };
export const meetsAssurance = (have: Assurance, need: Assurance): boolean =>
  ASSURANCE_RANK[have] >= ASSURANCE_RANK[need];

export const VerificationMethod = z.enum([
  "none",
  "secure_link_oidc",
  "portal_session",
  "otp_sms_registered_channel",
  "otp_voice_registered_channel",
  "human_verified",
]);
export type VerificationMethod = z.infer<typeof VerificationMethod>;

/** Record / payload classification used by policy and egress controls. */
export const Classification = z.enum([
  "PUBLIC",
  "INTERNAL",
  "PHI",
  "PHI_RESTRICTED",
  "FINANCIAL",
  "VERIFICATION_SECRET",
]);
export type Classification = z.infer<typeof Classification>;

/**
 * Classification a session, a context or a speaker may DISCLOSE up to: every Classification except
 * VERIFICATION_SECRET, which is never disclosed to anyone, never reaches a model, a transcript or a
 * caller-facing utterance, and so is never a disclosure ceiling (AUTH-06).
 */
export const DisclosureClassification = Classification.exclude(["VERIFICATION_SECRET"]);
export type DisclosureClassification = z.infer<typeof DisclosureClassification>;

/**
 * Largest clock skew tolerated between a trusted component's clock and a timestamp it reports
 * (ENGINEERING DEFAULT, 5 s). Evidence stamped further in the future than this is not evidence of
 * freshness: it is treated as unknown age, never as zero age.
 */
export const MAX_CLOCK_SKEW_MS = 5_000;

/** Retention data classes (spec section 6). Retention durations are set by counsel, never invented here. */
export const DataClass = z.enum([
  "TRANSIENT_CONVERSATION",
  "BUSINESS_RECORD",
  "RESTRICTED_QA_MEDIA",
  "SECURITY_AUDIT",
]);
export type DataClass = z.infer<typeof DataClass>;

/** Distinct interaction outcomes (spec section 4). HTTP 200, hang-up or Case creation never alone mean RESOLVED. */
export const Outcome = z.enum([
  "RESOLVED",
  "REQUEST_ACCEPTED",
  "TRANSFERRED",
  "INFORMATION_PROVIDED",
  "DECLINED_BY_POLICY",
  "CALLER_DISCONNECTED",
  "FAILED",
  "OUTCOME_UNKNOWN",
]);
export type Outcome = z.infer<typeof Outcome>;

/**
 * Consent value as captured in one call (ConsentState) and as read by the existing consumers
 * (business/recheck.ts consent registry port and snapshot parse, privacy/consent.ts, the evaluation
 * runner). Unchanged from the original protocol: it has no EXPIRED value, so a consumer that parses
 * a stored or registry value with it refuses EXPIRED and takes its fail-closed parse-failure branch
 * (the pre-disclosure recheck denies with an audited CONSENT_NOT_ESTABLISHED). The follow-on value
 * set with EXPIRED is ConsentValueV2; consumers switch to it only together with an explicit EXPIRED
 * denial of their own (README "Enum extensions").
 */
export const ConsentValue = z.enum(["GRANTED", "DECLINED", "UNKNOWN", "NOT_REQUIRED"]);
export type ConsentValue = z.infer<typeof ConsentValue>;

/**
 * Consent value of a standing consent dimension (follow-on prompt section 5): explicit opt-out
 * (DECLINED), unknown, expired and affirmative permission are separate states. EXPIRED is derived
 * from `expiresAt` (effectiveConsentValue) or recorded by a consent store, and never counts as
 * permission. Exactly the values of WP-02's deliverable "ConsentValue GRANTED, DECLINED, UNKNOWN,
 * EXPIRED, NOT_REQUIRED"; delivered as a separate enum because widening ConsentValue in place turned
 * an EXPIRED registry value into an unaudited RECHECK_POLICY_INPUT_INVALID error in
 * business/recheck.ts instead of its audited denial (probe in the WP-02 report).
 */
export const ConsentValueV2 = z.enum(["GRANTED", "DECLINED", "UNKNOWN", "EXPIRED", "NOT_REQUIRED"]);
export type ConsentValueV2 = z.infer<typeof ConsentValueV2>;

/**
 * Point-in-time answer captured in one call (ConsentState). A capture has no expiry of its own,
 * so EXPIRED is not one of its values; standing consent with an expiry is a ConsentDimensionState.
 * Same values as ConsentValue (the wire shape of ConsentState is unchanged from the original protocol).
 */
export const SessionConsentValue = ConsentValue;
export type SessionConsentValue = ConsentValue;

export const ConsentState = z.strictObject({
  recording: SessionConsentValue,
  automatedProcessing: SessionConsentValue,
  /** Jurisdiction-approved disclosure template version actually played. */
  disclosureTemplateVersion: VersionLabel.nullable(),
  capturedAt: IsoDateTime.nullable(),
  capturedBy: z.enum(["studio_flow", "human_agent", "portal", "none"]),
});
export type ConsentState = z.infer<typeof ConsentState>;

/** Pinned versions of everything that shapes caller-facing behaviour (OPS-06). */
export const VersionSet = z.strictObject({
  agentConfig: VersionLabel,
  model: VersionLabel,
  voice: VersionLabel,
  promptTemplates: VersionLabel,
  policyBundle: VersionLabel,
  toolCatalog: Sha256Hex,
  knowledgeSnapshot: VersionLabel,
  schema: VersionLabel,
});
export type VersionSet = z.infer<typeof VersionSet>;

/** Fields in the protocol that may only be set by trusted server components. */
export const SERVER_ESTABLISHED_FIELDS = [
  "tenantId",
  "callId",
  "sessionGeneration",
  "actorId",
  "selectedRole",
  "subjectId",
  "organizationId",
  "delegatedAuthority",
  "permittedScopes",
  "assurance",
  "authenticatedAt",
  "verificationMethod",
  "consent",
  "riskFlags",
  "policyVersion",
  "revoked",
] as const;

/* ======================================================================== */
/* Follow-on contract primitives (follow-on prompt section 4, WP-02)          */
/* ======================================================================== */

/**
 * Field names an untrusted proposal (a model decision, a caller utterance, a retrieved document,
 * a vendor-proposed tool argument) can never carry: the server-established identity fields above,
 * every other AuthContext field that states identity, authority or consent (stepUp, integration,
 * processingBasis, consentProfile, dataClassification) and the envelope fields that only trusted
 * components assign (AUTH-03). The scan below refuses each of these in any spelling, and also every
 * key that names one of their concepts (auth03.test.ts ties this list to AuthContext and the envelope).
 */
export const PROPOSAL_FORBIDDEN_FIELDS = [
  ...SERVER_ESTABLISHED_FIELDS,
  "actorRef",
  "subjectRef",
  "interactionId",
  "sessionRef",
  "causationId",
  "schemaVersion",
  "dataClassification",
  "processingBasis",
  "consentProfile",
  "stepUp",
  "integration",
] as const;

/** Keys that would reach an object prototype when merged; never accepted in untrusted payloads. */
export const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype"] as const;

/**
 * Words naming an identity, authority or consent concept that only trusted components establish
 * (AUTH-03: actor, subject, organization, assurance and consent, plus tenant, call, session, role,
 * scope, delegation, authentication/verification state, risk, revocation, grant, and the trusted
 * envelope concepts interaction, causation, classification and processing basis). `policy` is not a
 * concept word, because an insurance policy number is ordinary caller data; the exact field
 * `policyVersion` stays refused. A key
 * that contains one of these WORDS is refused, whatever else it says: `subject`, `subjectRef`,
 * `consent_recording`, `recordingConsent`, `rolesGranted`, `isVerified`, `tenantName`. Plural and
 * participle forms are matched as word prefixes (see below), so only forms a prefix cannot reach are
 * listed (`authorities`, `identities`, `calls`, `orgs`). A reviewed exemption (PROPOSAL_KEY_EXEMPTIONS)
 * is the only way an argument may use one of these words.
 */
export const PROPOSAL_FORBIDDEN_CONCEPTS = [
  "tenant",
  "call", "calls",
  "actor",
  "subject",
  "organization", "organisation", "org", "orgs",
  "role",
  "assurance",
  "consent",
  "scope",
  "delegate", "delegation",
  "authority", "authorities",
  "authentication", "authenticated",
  "authorization", "authorisation", "authorized", "authorised",
  "verification", "verified",
  "identity", "identities",
  "principal",
  "user",
  "impersonate", "impersonation",
  "permission",
  "entitlement",
  "grant",
  "session",
  "generation",
  "risk",
  "revoked", "revocation",
  "interaction",
  "causation",
  "classification",
  "basis",
] as const;

/**
 * Concepts NOT matched at the start of a longer glued word, because ordinary words begin with them
 * (`callback`, `organic`). Every other concept also matches as the start of a word, which covers its
 * plural and participle forms (`roles`, `scoped`, `delegated`, `sessions`) and all-lower-case
 * concatenations (`consentrecording`, `tenantname`).
 */
const PREFIX_EXCLUDED_CONCEPTS: ReadonlySet<string> = new Set(["call", "org"]);
/**
 * Concepts NOT matched at the end of a longer glued word, because ordinary words end with them
 * (`recall`, `cyborg`, `factor`, `telescope`, `possession`, `regeneration`, `immigrant`, `asterisk`,
 * `superuser`). They are still matched as whole words (`recall_actor`, `superUser`). Every other
 * concept also matches as the end of a word (`recordingconsent`, `callerrole`, `unverified`).
 */
const SUFFIX_EXCLUDED_CONCEPTS: ReadonlySet<string> = new Set(["call", "org", "actor", "scope", "session", "generation", "grant", "risk", "user"]);

/**
 * Reviewed exemptions: an argument key that contains a forbidden concept word but names something
 * else, accepted ONLY with one of the listed values. `concernSubject` is the required argument of the
 * request_safety_route tool (schemas/tools/catalog.json): whom a safety concern is about
 * (SELF / THIRD_PARTY / UNKNOWN), never an identity reference; refusing it would break the
 * session-less safety route (SAFE-02). Any other value under that key is refused like any other key
 * naming `subject`. The registry test ties this list to the catalog's enum.
 */
export const PROPOSAL_KEY_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  concernSubject: ["SELF", "THIRD_PARTY", "UNKNOWN"],
};

/**
 * Spelling-insensitive form of a key: lower case with `_` and `-` removed, so `tenant_id`,
 * `TenantId`, `TENANT-ID` and `tenantId` are the same name. The follow-on prompt itself writes the
 * server-established fields in snake_case, so a proposal is compared in this form (AUTH-03).
 */
export const normalizeFieldName = (key: string): string => key.replace(/[_-]/g, "").toLowerCase();

/**
 * Lower-case words of a key: split at `_`, `-`, any other non-alphanumeric character, camelCase and
 * PascalCase boundaries (`subjectID` -> subject, id; `XMLHttpRef` -> xml, http, ref) and letter/digit
 * boundaries (`subject2` -> subject, 2).
 */
export function fieldNameWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

const CONCEPTS: readonly string[] = PROPOSAL_FORBIDDEN_CONCEPTS;
const CONCEPT_SET: ReadonlySet<string> = new Set(CONCEPTS);
const PREFIX_CONCEPTS = CONCEPTS.filter((c) => !PREFIX_EXCLUDED_CONCEPTS.has(c));
const SUFFIX_CONCEPTS = CONCEPTS.filter((c) => !SUFFIX_EXCLUDED_CONCEPTS.has(c));
const EXACT_FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>([...PROPOSAL_FORBIDDEN_FIELDS, ...PROTOTYPE_KEYS].map(normalizeFieldName));

/** True when one word of a key is, begins with or ends with a forbidden concept (see the exclusions above). */
function wordNamesConcept(word: string): boolean {
  if (CONCEPT_SET.has(word)) return true;
  return PREFIX_CONCEPTS.some((c) => word.length > c.length && word.startsWith(c)) || SUFFIX_CONCEPTS.some((c) => word.length > c.length && word.endsWith(c));
}

/**
 * True when `key` names a server-established, identity, authority, consent or prototype field in any
 * spelling: an exact field of PROPOSAL_FORBIDDEN_FIELDS or PROTOTYPE_KEYS (case, `_` and `-`
 * insensitive), or any key one of whose words names a PROPOSAL_FORBIDDEN_CONCEPTS concept. It does
 * not apply PROPOSAL_KEY_EXEMPTIONS, which depend on the value (see findForbiddenProposalField).
 */
export function isForbiddenProposalKey(key: string): boolean {
  if (EXACT_FORBIDDEN_KEYS.has(normalizeFieldName(key))) return true;
  const words = fieldNameWords(key);
  return words.some(wordNamesConcept) || wordNamesConcept(normalizeFieldName(key).replace(/[^a-z0-9]/g, ""));
}

/** True when a forbidden-looking key carries one of its reviewed exempt values exactly. */
const isExemptEntry = (key: string, value: unknown): boolean => {
  const allowed = Object.prototype.hasOwnProperty.call(PROPOSAL_KEY_EXEMPTIONS, key) ? PROPOSAL_KEY_EXEMPTIONS[key] : undefined;
  return allowed !== undefined && typeof value === "string" && allowed.includes(value);
};

/**
 * Depth-first search of an untrusted JSON value for a server-established, identity, authority,
 * consent or prototype key, in any spelling (`tenant_id`, `TenantId`, `Assurance`, `subject`,
 * `consentRecording`, `__proto__`; see isForbiddenProposalKey). A reviewed exemption applies only
 * with one of its exact values. Returns the dotted path of the first offending key, or null. Values
 * deeper than `maxDepth` levels are reported as `"<too-deep>"` so a deeply nested payload cannot
 * hide a field (AUTH-03).
 */
export function findForbiddenProposalField(value: unknown, maxDepth = 8): string | null {
  const walk = (v: unknown, path: string, depth: number): string | null => {
    if (v === null || typeof v !== "object") return null;
    if (depth > maxDepth) return "<too-deep>";
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = walk(v[i], `${path}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const key of Object.getOwnPropertyNames(v)) {
      const here = path ? `${path}.${key}` : key;
      const child = (v as Record<string, unknown>)[key];
      if (isForbiddenProposalKey(key) && !isExemptEntry(key, child)) return here;
      const hit = walk(child, here, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(value, "", 0);
}

/**
 * Parses an untrusted value (raw model tool arguments, a raw tool request body) with `schema` after
 * scanning the RAW value for server-established and prototype keys. zod drops an own `__proto__` key
 * from records (no prototype pollution), so the raw scan is what turns such a payload into an
 * explicit refusal. Apply it to the untrusted part only, never to an envelope a trusted component set.
 */
export function safeParseUntrusted<T extends z.ZodType>(schema: T, raw: unknown): { success: true; data: z.infer<T> } | { success: false; reasonCode: string } {
  const hit = findForbiddenProposalField(raw);
  if (hit) return { success: false, reasonCode: `SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:${hit}` };
  const r = schema.safeParse(raw);
  return r.success ? { success: true, data: r.data as z.infer<T> } : { success: false, reasonCode: "PROPOSAL_SCHEMA_INVALID" };
}

/** Turn identifier issued by the conversation runtime. */
export const TurnId = z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/, "turn identifier expected");
export type TurnId = z.infer<typeof TurnId>;

/** Session generation: incremented on participant change, account switch, recovery, role change or revocation. */
export const SessionGeneration = z.number().int().min(1).max(1_000_000_000);

/** Per-contract schema version carried by every follow-on contract instance, e.g. `call-binding.v1`. */
export const ContractSchemaVersion = z.string().regex(/^[a-z][a-z0-9-]{1,48}\.v[1-9][0-9]{0,3}$/, "contract schema version expected");

/** Bounded evidence pointer (repository path, object key or URI without query string). */
export const EvidencePointer = z.string().min(3).max(256).regex(/^[A-Za-z0-9._~:/#@+=-]+$/, "evidence pointer expected");

/** Stable identifier of a source system, e.g. `scheduling`, `salesforce_service_cloud`. */
export const SourceSystemId = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);

/** UTC instant (Z suffix, no offset). Alias kept for readability in follow-on contracts. */
export const UtcInstant = IsoDateTime;

/** Calendar date in a business timezone (YYYY-MM-DD); never an instant. */
export const LocalDate = z.iso.date();
export type LocalDate = z.infer<typeof LocalDate>;

/** True when `tz` names a time zone the runtime's IANA database can resolve. */
export function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Explicit tenant business timezone (IANA name, e.g. `America/Chicago`); fixed offsets are refused. */
export const BusinessTimeZone = z
  .string()
  .min(3)
  .max(64)
  .regex(/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/, "IANA time zone name expected")
  .refine(isIanaTimeZone, "unknown time zone");
export type BusinessTimeZone = z.infer<typeof BusinessTimeZone>;

/** Calendar date of a UTC instant in the business timezone (FO-04-43). */
export function toBusinessDate(instant: string, timeZone: string): string {
  const at = IsoDateTime.parse(instant);
  const tz = BusinessTimeZone.parse(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/* ---- common envelope ---------------------------------------------------- */

/**
 * Common envelope fields (follow-on prompt section 4: tenant_id, interaction_id, case_id,
 * workflow_id, opaque actor/subject references, session_generation, turn_id, request_id,
 * causation_id, created_at, expires_at, data classification). The protocol keeps its camelCase
 * convention; ENVELOPE_SPEC_NAMES gives the prompt's name for each field. `schemaVersion` is
 * always present and set by `envelope()`.
 */
export const ENVELOPE_FIELDS = {
  tenantId: OpaqueId,
  interactionId: OpaqueId,
  caseId: OpaqueId,
  workflowId: OpaqueId,
  actorRef: OpaqueId,
  subjectRef: OpaqueId,
  sessionGeneration: SessionGeneration,
  turnId: TurnId,
  requestId: OpaqueId,
  causationId: OpaqueId,
  occurredAt: IsoDateTime,
  expiresAt: IsoDateTime,
  dataClassification: Classification,
} as const;
export type EnvelopeField = keyof typeof ENVELOPE_FIELDS;
export const ENVELOPE_FIELD_NAMES = Object.keys(ENVELOPE_FIELDS) as EnvelopeField[];

export const ENVELOPE_SPEC_NAMES: Readonly<Record<EnvelopeField | "schemaVersion", string>> = {
  schemaVersion: "schema_version",
  tenantId: "tenant_id",
  interactionId: "interaction_id",
  caseId: "case_id",
  workflowId: "workflow_id",
  actorRef: "actor reference (opaque)",
  subjectRef: "subject reference (opaque)",
  sessionGeneration: "session_generation",
  turnId: "turn_id",
  requestId: "request_id",
  causationId: "causation_id",
  occurredAt: "created_at",
  expiresAt: "expires_at",
  dataClassification: "data classification",
};

type EnvelopeShape<V extends string, R extends EnvelopeField, N extends EnvelopeField> = { schemaVersion: z.ZodLiteral<V> } & {
  [K in R]: (typeof ENVELOPE_FIELDS)[K];
} & { [K in N]: z.ZodNullable<(typeof ENVELOPE_FIELDS)[K]> };

/**
 * Builds the envelope part of a contract shape: `schemaVersion` pinned to `version`, the
 * `required` fields non-null and the `nullable` fields present but nullable. Spread it into a
 * `z.strictObject`; the registry test (registry.test.ts) checks every follow-on contract carries
 * the fields its descriptor declares.
 */
export function envelope<const V extends string, const R extends EnvelopeField = never, const N extends Exclude<EnvelopeField, R> = never>(
  version: V,
  required: readonly R[],
  nullable: readonly N[] = [],
): EnvelopeShape<V, R, N> {
  ContractSchemaVersion.parse(version);
  const shape: Record<string, z.ZodType> = { schemaVersion: z.literal(version) };
  for (const k of required) shape[k] = ENVELOPE_FIELDS[k];
  for (const k of nullable) {
    if (k in shape) throw new Error(`envelope field listed twice: ${k}`);
    shape[k] = ENVELOPE_FIELDS[k].nullable();
  }
  return shape as EnvelopeShape<V, R, N>;
}

/** True when `later` is strictly after `earlier` (both ISO instants). */
export const isAfter = (later: string, earlier: string): boolean => Date.parse(later) > Date.parse(earlier);

/* ---- pagination and time ranges ---------------------------------------- */

/** Largest page any list endpoint or contract returns (FO-04-03). */
export const MAX_PAGE_SIZE = 200;

/** Opaque, bounded cursor (base64url). Never carries PHI: it encodes an opaque position only. */
export const PageCursor = z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+$/, "opaque cursor expected");
export type PageCursor = z.infer<typeof PageCursor>;

export const PageRequest = z.strictObject({
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
  cursor: PageCursor.nullable(),
});
export type PageRequest = z.infer<typeof PageRequest>;

export const PageInfo = z
  .strictObject({
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    nextCursor: PageCursor.nullable(),
    hasMore: z.boolean(),
  })
  .refine((p) => p.hasMore === (p.nextCursor !== null), "hasMore must equal nextCursor !== null");
export type PageInfo = z.infer<typeof PageInfo>;

/** Position a cursor encodes: an opaque sort key and optional instant, nothing else. */
export const CursorPosition = z.strictObject({
  afterKey: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  afterTime: IsoDateTime.nullable(),
});
export type CursorPosition = z.infer<typeof CursorPosition>;

export function encodeCursor(position: CursorPosition): PageCursor {
  const p = CursorPosition.parse(position);
  const json = JSON.stringify({ afterKey: p.afterKey, afterTime: p.afterTime });
  return PageCursor.parse(toBase64Url(json));
}

/* Portable base64url (runs in Node, the media worker and the browser companion; no Buffer). */
function toBase64Url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Decodes a cursor received from a client; anything that is not a valid position is null (fail closed). */
export function decodeCursor(cursor: string): CursorPosition | null {
  if (!PageCursor.safeParse(cursor).success) return null;
  try {
    const parsed = CursorPosition.safeParse(JSON.parse(fromBase64Url(cursor)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A page of `item`: at most `maxItems` items and never more than the page size it declares. */
export function paged<T extends z.ZodType>(item: T, maxItems = MAX_PAGE_SIZE) {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_PAGE_SIZE) throw new Error("page bound out of range");
  return z
    .strictObject({ items: z.array(item).max(maxItems), page: PageInfo })
    .refine((p) => p.items.length <= p.page.pageSize, "more items than the declared page size");
}

/** Widest time range any query contract accepts (FO-04-03). */
export const MAX_TIME_RANGE_MS = 366 * 86_400_000;

/** Half-open UTC interval [from, to) with to > from and a bounded span. */
export function timeRange(maxSpanMs = MAX_TIME_RANGE_MS) {
  if (!Number.isInteger(maxSpanMs) || maxSpanMs < 1000 || maxSpanMs > MAX_TIME_RANGE_MS) throw new Error("time range bound out of range");
  return z
    .strictObject({ from: IsoDateTime, to: IsoDateTime })
    .superRefine((r, ctx) => {
      const span = Date.parse(r.to) - Date.parse(r.from);
      if (!(span > 0)) ctx.addIssue({ code: "custom", message: "TIME_RANGE_NOT_INCREASING", path: ["to"] });
      else if (span > maxSpanMs) ctx.addIssue({ code: "custom", message: "TIME_RANGE_TOO_WIDE", path: ["to"] });
    })
    .meta({ "x-max-span-ms": maxSpanMs });
}
export const TimeRange = timeRange();
export type TimeRange = z.infer<typeof TimeRange>;

/* ---- money -------------------------------------------------------------- */

/**
 * ISO 4217 List One active currency codes (precious metals, SDR, testing and "no currency" codes
 * excluded). Reviewed 2026-10; a code change is a contract change.
 */
export const CURRENCY_CODES = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD",
  "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP",
  "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD",
  "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK",
  "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK",
  "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR",
  "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS",
  "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
  "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF",
  "XPF", "YER", "ZAR", "ZMW", "ZWG",
] as const;
export const CurrencyCode = z.enum(CURRENCY_CODES);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

const ZERO_DECIMAL = ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"] as const;
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"] as const;
const FOUR_DECIMAL = ["CLF", "UYW"] as const;

/** ISO 4217 minor-unit exponent of a currency (2 unless listed otherwise). */
export function minorUnitExponent(currency: CurrencyCode): 0 | 2 | 3 | 4 {
  if ((ZERO_DECIMAL as readonly string[]).includes(currency)) return 0;
  if ((THREE_DECIMAL as readonly string[]).includes(currency)) return 3;
  if ((FOUR_DECIMAL as readonly string[]).includes(currency)) return 4;
  return 2;
}

/** Integer minor units; bounded so every value is exact in IEEE-754 and in canonical JSON. */
export const MinorUnits = z.number().int().min(-10_000_000_000_000).max(10_000_000_000_000);

/** Money: integer minor units plus ISO 4217 currency (FO-04-44). Never a float of major units. */
export const Money = z.strictObject({ currency: CurrencyCode, minorUnits: MinorUnits });
export type Money = z.infer<typeof Money>;

/** Exact decimal string of a money value in major units, e.g. {USD, 12345} -> "123.45" (readouts, never arithmetic). */
export function moneyToDecimalString(money: Money): string {
  const m = Money.parse(money);
  const exp = minorUnitExponent(m.currency);
  const negative = m.minorUnits < 0;
  const digits = Math.abs(m.minorUnits).toString().padStart(exp + 1, "0");
  const whole = exp === 0 ? digits : digits.slice(0, digits.length - exp);
  const frac = exp === 0 ? "" : `.${digits.slice(digits.length - exp)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/* ---- per-issue outcomes -------------------------------------------------- */

/**
 * Outcome labels per issue (follow-on prompt section 11). Case creation, workflow acceptance and a
 * dialled transfer are never RESOLVED_WITH_EVIDENCE or TRANSFERRED_WITH_ACCEPTANCE (ACT-04, SAFE-04).
 */
export const IssueOutcome = z.enum([
  "RESOLVED_WITH_EVIDENCE",
  "INFORMATION_PROVIDED",
  "REQUEST_ACCEPTED",
  "WAITING_FOR_SYSTEM",
  "WAITING_FOR_HUMAN",
  "WAITING_FOR_CALLER",
  "TRANSFERRED_WITH_ACCEPTANCE",
  "DECLINED_BY_POLICY",
  "CALLER_DISCONNECTED",
  "FAILED",
  "OUTCOME_UNKNOWN",
]);
export type IssueOutcome = z.infer<typeof IssueOutcome>;

/** Outcomes that need authoritative evidence (effect verification, receiver acceptance) to be recorded. */
export const EVIDENCE_REQUIRED_OUTCOMES: readonly IssueOutcome[] = ["RESOLVED_WITH_EVIDENCE", "TRANSFERRED_WITH_ACCEPTANCE"];

/**
 * One issue's outcome. `reopened` and `partiallyResolved` are preserved states, not outcomes;
 * evidence refs are required for the evidence outcomes and a partially resolved issue is never
 * RESOLVED_WITH_EVIDENCE.
 */
export const IssueOutcomeRecord = z
  .strictObject({
    outcome: IssueOutcome,
    reopened: z.boolean(),
    partiallyResolved: z.boolean(),
    /** Effect verification ids, receiver acceptance events or receipt ids supporting the outcome. */
    evidenceRefs: z.array(EvidencePointer).max(16),
    recordedAt: IsoDateTime,
  })
  .superRefine((r, ctx) => {
    if (EVIDENCE_REQUIRED_OUTCOMES.includes(r.outcome) && r.evidenceRefs.length === 0) {
      ctx.addIssue({ code: "custom", message: "OUTCOME_EVIDENCE_REQUIRED", path: ["evidenceRefs"] });
    }
    if (r.partiallyResolved && r.outcome === "RESOLVED_WITH_EVIDENCE") {
      ctx.addIssue({ code: "custom", message: "PARTIAL_RESOLUTION_IS_NOT_RESOLVED", path: ["partiallyResolved"] });
    }
  });
export type IssueOutcomeRecord = z.infer<typeof IssueOutcomeRecord>;

/**
 * Legacy interaction Outcome -> per-issue outcome. RESOLVED was recordable only with the resolution
 * contract's success evidence and TRANSFERRED only after receiver acceptance and caller connection
 * (SAFE-04), so both map to the evidence outcomes; no legacy value is dropped.
 */
export const LEGACY_OUTCOME_TO_ISSUE_OUTCOME: Readonly<Record<Outcome, IssueOutcome>> = {
  RESOLVED: "RESOLVED_WITH_EVIDENCE",
  REQUEST_ACCEPTED: "REQUEST_ACCEPTED",
  TRANSFERRED: "TRANSFERRED_WITH_ACCEPTANCE",
  INFORMATION_PROVIDED: "INFORMATION_PROVIDED",
  DECLINED_BY_POLICY: "DECLINED_BY_POLICY",
  CALLER_DISCONNECTED: "CALLER_DISCONNECTED",
  FAILED: "FAILED",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
};

/**
 * Per-issue outcome -> legacy interaction Outcome for consumers that still record the original
 * label (metrics, SupportRequest.disposition). The WAITING_* outcomes are open work and map to
 * REQUEST_ACCEPTED, never to RESOLVED.
 */
export const ISSUE_OUTCOME_TO_LEGACY_OUTCOME: Readonly<Record<IssueOutcome, Outcome>> = {
  RESOLVED_WITH_EVIDENCE: "RESOLVED",
  INFORMATION_PROVIDED: "INFORMATION_PROVIDED",
  REQUEST_ACCEPTED: "REQUEST_ACCEPTED",
  WAITING_FOR_SYSTEM: "REQUEST_ACCEPTED",
  WAITING_FOR_HUMAN: "REQUEST_ACCEPTED",
  WAITING_FOR_CALLER: "REQUEST_ACCEPTED",
  TRANSFERRED_WITH_ACCEPTANCE: "TRANSFERRED",
  DECLINED_BY_POLICY: "DECLINED_BY_POLICY",
  CALLER_DISCONNECTED: "CALLER_DISCONNECTED",
  FAILED: "FAILED",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
};

/* ---- consent dimensions --------------------------------------------------- */

/** Consent and permission dimensions that stay distinct (follow-on prompt section 5). */
export const ConsentDimension = z.enum([
  "recording",
  "transcriptionAiProcessing",
  "supportPurpose",
  "disclosureAuthority",
  "notificationSubscription",
  "marketing",
]);
export type ConsentDimension = z.infer<typeof ConsentDimension>;

export const ConsentDimensionState = z
  .strictObject({
    value: ConsentValueV2,
    /** Null for consent without an expiry; a past expiry makes the effective value EXPIRED. */
    expiresAt: IsoDateTime.nullable(),
    capturedAt: IsoDateTime.nullable(),
    capturedBy: z.enum(["studio_flow", "human_agent", "portal", "companion", "preference_center", "none"]),
    /** Approved disclosure or consent template version the caller actually heard or saw. */
    templateVersion: VersionLabel.nullable(),
    evidenceRef: EvidencePointer.nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.value === "GRANTED" && s.capturedAt === null) ctx.addIssue({ code: "custom", message: "GRANT_WITHOUT_CAPTURE", path: ["capturedAt"] });
    if (s.expiresAt !== null && s.capturedAt !== null && !isAfter(s.expiresAt, s.capturedAt)) {
      ctx.addIssue({ code: "custom", message: "EXPIRY_NOT_AFTER_CAPTURE", path: ["expiresAt"] });
    }
  });
export type ConsentDimensionState = z.infer<typeof ConsentDimensionState>;

/** Every dimension, each explicit; a missing record is UNKNOWN, never inferred from another dimension. */
export const ConsentProfile = z.strictObject({
  recording: ConsentDimensionState,
  transcriptionAiProcessing: ConsentDimensionState,
  supportPurpose: ConsentDimensionState,
  disclosureAuthority: ConsentDimensionState,
  notificationSubscription: ConsentDimensionState,
  marketing: ConsentDimensionState,
});
export type ConsentProfile = z.infer<typeof ConsentProfile>;

/** Effective value at `now`: a granted (or any) dimension past its expiry is EXPIRED. */
export function effectiveConsentValue(state: ConsentDimensionState, now: Date): ConsentValueV2 {
  if (state.expiresAt !== null && Date.parse(state.expiresAt) <= now.getTime()) return "EXPIRED";
  return state.value;
}

/** Only an unexpired GRANTED counts as permission; NOT_REQUIRED needs an approved rule decided elsewhere. */
export const consentPermits = (state: ConsentDimensionState, now: Date): boolean => effectiveConsentValue(state, now) === "GRANTED";

const UNKNOWN_DIMENSION: ConsentDimensionState = { value: "UNKNOWN", expiresAt: null, capturedAt: null, capturedBy: "none", templateVersion: null, evidenceRef: null };

/**
 * Consent profile from a call's ConsentState: recording -> recording, automatedProcessing ->
 * transcriptionAiProcessing. The other dimensions are UNKNOWN: a call capture never implies
 * disclosure authority, notification subscription or marketing consent.
 */
export function consentProfileFromSession(state: ConsentState): ConsentProfile {
  const s = ConsentState.parse(state);
  const capturedBy = s.capturedBy;
  const fromCapture = (value: SessionConsentValue): ConsentDimensionState => ({
    value,
    expiresAt: null,
    capturedAt: value === "UNKNOWN" ? null : s.capturedAt,
    capturedBy: value === "UNKNOWN" ? "none" : capturedBy,
    templateVersion: s.disclosureTemplateVersion,
    evidenceRef: null,
  });
  return ConsentProfile.parse({
    recording: fromCapture(s.recording),
    transcriptionAiProcessing: fromCapture(s.automatedProcessing),
    supportPurpose: UNKNOWN_DIMENSION,
    disclosureAuthority: UNKNOWN_DIMENSION,
    notificationSubscription: UNKNOWN_DIMENSION,
    marketing: UNKNOWN_DIMENSION,
  });
}

/* ---- processing purpose, basis and jurisdiction ----------------------------- */

/** Data-processing purpose (distinct from the authorization purpose in policy.ts PolicyPurpose). */
export const ProcessingPurpose = z.enum([
  "support_administration",
  "identity_verification",
  "safety_routing",
  "human_handoff",
  "case_follow_up",
  "notification_delivery",
  "quality_assurance",
  "evaluation",
  "model_improvement",
  "security_audit",
  "legal_obligation",
  "analytics_aggregate",
  "marketing",
]);
export type ProcessingPurpose = z.infer<typeof ProcessingPurpose>;

/**
 * Label of the processing basis in the counsel-approved jurisdiction/purpose matrix (follow-on
 * prompt section 15). Software records which approved basis applied; it never decides legality.
 */
export const ProcessingBasisKind = z.enum([
  "PUBLIC_INFORMATION",
  "INDIVIDUAL_REQUEST",
  "HIPAA_TREATMENT_PAYMENT_OPERATIONS",
  "HIPAA_AUTHORIZATION",
  "PART2_WRITTEN_CONSENT",
  "PERSONAL_REPRESENTATIVE_AUTHORITY",
  "DELEGATED_ADMINISTRATION",
  "PARTNER_CONTRACT_PURPOSE",
  "SAFETY_ROUTING",
  "LEGAL_REQUIREMENT",
  "UNKNOWN",
]);
export type ProcessingBasisKind = z.infer<typeof ProcessingBasisKind>;

/** ISO 3166-1 alpha-2 country, optionally with an ISO 3166-2 subdivision (US, US-CA); UNKNOWN never inherits a permissive policy. */
export const Jurisdiction = z.union([z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/), z.literal("UNKNOWN")]);
export type Jurisdiction = z.infer<typeof Jurisdiction>;

/* ---- two-axis status ------------------------------------------------------ */

/** Software axis (follow-on prompt section 0). */
export const SoftwareStatus = z.enum(["MISSING", "IMPLEMENTED", "VERIFIED_LOCAL", "RELEASE_PACKAGE_VERIFIED"]);
export type SoftwareStatus = z.infer<typeof SoftwareStatus>;

/** Environment axis (follow-on prompt section 0). */
export const EnvironmentStatus = z.enum(["NOT_CONFIGURED", "CONFIGURED", "VERIFIED_SANDBOX", "APPROVED_PILOT", "VERIFIED_PRODUCTION"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;

/** Qualification result; only PASS passes and NOT_RUN, INCONCLUSIVE and FAIL never count as PASS (OPS-03). */
export const QualificationResult = z.enum(["NOT_RUN", "FAIL", "INCONCLUSIVE", "PASS"]);
export type QualificationResult = z.infer<typeof QualificationResult>;

export const SOFTWARE_STATUS_RANK: Readonly<Record<SoftwareStatus, number>> = { MISSING: 0, IMPLEMENTED: 1, VERIFIED_LOCAL: 2, RELEASE_PACKAGE_VERIFIED: 3 };
export const ENVIRONMENT_STATUS_RANK: Readonly<Record<EnvironmentStatus, number>> = {
  NOT_CONFIGURED: 0,
  CONFIGURED: 1,
  VERIFIED_SANDBOX: 2,
  APPROVED_PILOT: 3,
  VERIFIED_PRODUCTION: 4,
};

/** Capability identifier, e.g. `platform.contracts`, `identity.caller`. */
export const CapabilityId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/);

/** Activation-register input identifier (docs/followon/activation-register.yaml). */
export const ActivationInputId = z.string().regex(/^AIN-[0-9]{2,3}$/);

/**
 * Consistency rules shared by every record that carries the two status axes (CapabilityStatus,
 * StatusAxes, ActivationRecord; OPS-03):
 * - qualification PASS needs evidence;
 * - software VERIFIED_LOCAL or RELEASE_PACKAGE_VERIFIED needs evidence;
 * - an environment at or above VERIFIED_SANDBOX (VERIFIED_SANDBOX, APPROVED_PILOT,
 *   VERIFIED_PRODUCTION) needs implemented software, evidence and a PASS qualification: a FAIL,
 *   INCONCLUSIVE or NOT_RUN qualification means the environment is not verified, whatever an earlier
 *   label said. A capability whose latest qualification failed is recorded at CONFIGURED (or below)
 *   with that FAIL, never left at its old verified level.
 * Returns the issue codes with the field each one concerns; an empty list means consistent.
 */
export function statusAxesIssues(s: {
  software: SoftwareStatus;
  environment: EnvironmentStatus;
  qualification: QualificationResult;
  evidenceRefs: readonly string[];
}): { code: string; path: string }[] {
  const out: { code: string; path: string }[] = [];
  const noEvidence = s.evidenceRefs.length === 0;
  if (s.qualification === "PASS" && noEvidence) out.push({ code: "PASS_WITHOUT_EVIDENCE", path: "evidenceRefs" });
  if (SOFTWARE_STATUS_RANK[s.software] >= SOFTWARE_STATUS_RANK.VERIFIED_LOCAL && noEvidence) out.push({ code: "VERIFIED_WITHOUT_EVIDENCE", path: "evidenceRefs" });
  if (ENVIRONMENT_STATUS_RANK[s.environment] >= ENVIRONMENT_STATUS_RANK.VERIFIED_SANDBOX) {
    if (s.software === "MISSING") out.push({ code: "ENVIRONMENT_VERIFIED_WITHOUT_SOFTWARE", path: "environment" });
    if (noEvidence) out.push({ code: "ENVIRONMENT_VERIFIED_WITHOUT_EVIDENCE", path: "evidenceRefs" });
    if (s.qualification !== "PASS") out.push({ code: "ENVIRONMENT_VERIFIED_WITHOUT_QUALIFICATION_PASS", path: "qualification" });
  }
  return out;
}

/** Both status axes plus qualification for one capability, with evidence. */
export const CapabilityStatus = z
  .strictObject({
    capabilityId: CapabilityId,
    software: SoftwareStatus,
    environment: EnvironmentStatus,
    qualification: QualificationResult,
    evidenceRefs: z.array(EvidencePointer).max(32),
    /** Missing external inputs that hold the environment axis back. */
    activationInputs: z.array(ActivationInputId).max(16),
  })
  .superRefine((c, ctx) => {
    for (const i of statusAxesIssues(c)) ctx.addIssue({ code: "custom", message: i.code, path: [i.path] });
  });
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;
