/**
 * Strict schema for the versioned authorization catalogue carried as bundle
 * data (policy/vsp/data.json -> data.vsp.catalogue). The engine validates the
 * catalogue when a bundle loads: a catalogue that does not parse, or that
 * breaks a structural safety invariant, makes the bundle unloadable (fail
 * closed), in addition to the Rego catalogue lint tests.
 *
 * The catalogue holds ENGINEERING DEFAULTS pending the POLICY_RELEASE approval
 * (PRQ-031); it is not an approved permission matrix.
 */
import { z } from "zod";
import { Assurance, Classification, Role, StaffRole } from "../protocol/common.js";
import { RelationshipFact } from "../protocol/auth.js";
import { KillSwitchScope } from "../protocol/contracts.js";
import { PolicyAction, PolicyPurpose } from "../protocol/policy.js";

/** The only actions that bypass every check (SAFE-02). Fixed in Rego; mirrored here. */
export const ALWAYS_AVAILABLE_ACTIONS = ["safety:route", "human:request"] as const;
export type AlwaysAvailableAction = (typeof ALWAYS_AVAILABLE_ACTIONS)[number];

export const isAlwaysAvailableAction = (action: string): action is AlwaysAvailableAction =>
  (ALWAYS_AVAILABLE_ACTIONS as readonly string[]).includes(action);

export const ActionClass = z.enum([
  "SAFETY_AND_HUMAN_ROUTE",
  "PUBLIC_READ",
  "INTAKE",
  "VERIFICATION",
  "PROTECTED_READ",
  "PREPARE_MUTATION",
  "COMMIT_MUTATION",
  "HUMAN_BOUNDARY",
]);
export type ActionClass = z.infer<typeof ActionClass>;

export const KillSwitchClass = z.enum(["EXEMPT", "STANDARD", "WRITE"]);

export const PolicyObligation = z.enum(["REQUIRE_CONFIRMATION", "REQUIRE_STEP_UP", "REQUIRE_HUMAN", "AUDIT_READ", "RESTRICTED_RECORD"]);

const Wildcard = z.literal("*");
const FieldName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/);
const FactType = RelationshipFact.shape.type;
const FactSource = RelationshipFact.shape.source;
const GrantReason = z.string().regex(/^ALLOW_[A-Z0-9_]{2,57}$/);
const Intent = z.string().regex(/^[a-z][a-z_]{2,63}$/);
const IntegrationId = z.string().regex(/^[a-z0-9-]{3,64}$/);

export const AccessPath = z.strictObject({
  id: z.string().regex(/^[a-z_]{2,40}$/),
  grantReason: GrantReason,
  roles: z.array(z.union([Role, Wildcard])).min(1),
  factTypes: z.array(FactType),
  target: z.enum(["none", "subject", "organization", "organization_with_subject"]),
  requireAuthSubject: z.boolean(),
  scope: PolicyAction.nullable(),
  minAssurance: Assurance,
  purposes: z.array(PolicyPurpose).min(1),
  classifications: z.array(Classification).min(1),
});
export type AccessPath = z.infer<typeof AccessPath>;

export const CatalogueAction = z.strictObject({
  description: z.string().min(10).max(400),
  class: ActionClass,
  intent: Intent,
  killSwitchClass: KillSwitchClass,
  minAssurance: Assurance,
  protected: z.boolean(),
  roles: z.array(z.union([Role, Wildcard])).min(1),
  purposes: z.array(z.union([PolicyPurpose, Wildcard])).min(1),
  classifications: z.array(z.union([Classification, Wildcard])).min(1),
  resourceTypes: z.array(z.union([z.string().regex(/^[a-z_]{3,40}$/), Wildcard])).min(1),
  integrations: z.array(IntegrationId),
  requiresActionDigest: z.boolean(),
  fieldMask: z.array(FieldName).max(64),
  obligations: z.array(PolicyObligation).max(8),
  access: z.array(AccessPath).max(8),
});
export type CatalogueAction = z.infer<typeof CatalogueAction>;

export const ConsoleCatalogueAction = z.strictObject({
  description: z.string().min(10).max(400),
  roles: z.array(StaffRole),
  assignedRoles: z.array(StaffRole),
  scopeRoles: z.record(KillSwitchScope, z.array(StaffRole)).nullable(),
  mutates: z.boolean(),
  prohibited: z.boolean(),
  requiresBreakGlass: z.boolean(),
  forbidSelfInitiated: z.boolean(),
  obligations: z.array(z.enum(["AUDIT_READ"])).max(4),
});
export type ConsoleCatalogueAction = z.infer<typeof ConsoleCatalogueAction>;

export const BreakGlassJustification = z.enum([
  "ACTIVE_SAFETY_INCIDENT",
  "AUDIT_INVESTIGATION",
  "DEPENDENCY_OUTAGE_RECOVERY",
  "PRIVACY_INCIDENT",
  "SECURITY_INCIDENT",
]);

export const PolicyCatalogue = z
  .strictObject({
    schemaVersion: z.literal(1),
    label: z.string().min(10).max(400),
    roleFactTypes: z.record(Role, z.array(FactType)),
    factSources: z.record(FactType, z.array(FactSource).min(1)),
    actions: z.record(PolicyAction, CatalogueAction),
    console: z.strictObject({
      maxAuthAgeSeconds: z.number().int().min(60).max(86_400),
      authFutureSkewSeconds: z.number().int().min(0).max(900),
      breakGlass: z.strictObject({
        maxDurationSeconds: z.number().int().min(60).max(86_400),
        justificationCodes: z.array(BreakGlassJustification).min(1),
      }),
      actions: z.record(PolicyAction, ConsoleCatalogueAction),
    }),
  })
  .superRefine((c, ctx) => {
    for (const issue of catalogueInvariantViolations(c)) ctx.addIssue({ code: "custom", message: issue });
  });
export type PolicyCatalogue = z.infer<typeof PolicyCatalogue>;

/** Bundle data document: { vsp: { catalogue } }. */
export const PolicyBundleData = z.strictObject({ vsp: z.strictObject({ catalogue: PolicyCatalogue }) });
export type PolicyBundleData = z.infer<typeof PolicyBundleData>;

const SENSITIVE: ReadonlySet<string> = new Set(["PHI", "PHI_RESTRICTED", "FINANCIAL", "VERIFICATION_SECRET"]);
const MUTATIONS: ReadonlySet<ActionClass> = new Set(["PREPARE_MUTATION", "COMMIT_MUTATION"]);

/**
 * Structural safety invariants (mirrors policy/vsp/catalogue_test.rego). Returns
 * reason codes with the action name; never free text from the data.
 */
export function catalogueInvariantViolations(c: {
  actions: Record<string, CatalogueAction>;
  roleFactTypes: Partial<Record<string, readonly string[]>>;
  console: { actions: Record<string, ConsoleCatalogueAction> };
}): string[] {
  const out: string[] = [];
  for (const name of ALWAYS_AVAILABLE_ACTIONS) if (!c.actions[name]) out.push(`ALWAYS_AVAILABLE_ACTION_MISSING:${name}`);
  for (const [name, a] of Object.entries(c.actions)) {
    const always = isAlwaysAvailableAction(name);
    if ((a.class === "SAFETY_AND_HUMAN_ROUTE") !== always || (a.killSwitchClass === "EXEMPT") !== always) out.push(`EXEMPTION_OUTSIDE_SAFETY_HUMAN:${name}`);
    if (MUTATIONS.has(a.class) !== (a.killSwitchClass === "WRITE")) out.push(`MUTATION_KILL_SWITCH_CLASS:${name}`);
    if ((a.class === "COMMIT_MUTATION") !== a.requiresActionDigest) out.push(`COMMIT_DIGEST_REQUIREMENT:${name}`);
    if (MUTATIONS.has(a.class) && !a.obligations.includes("REQUIRE_CONFIRMATION")) out.push(`MUTATION_WITHOUT_CONFIRMATION:${name}`);
    if (a.class === "HUMAN_BOUNDARY" && (a.access.length > 0 || a.fieldMask.length > 0)) out.push(`HUMAN_BOUNDARY_GRANTS_ACCESS:${name}`);
    const readsSensitive = !always && a.class !== "HUMAN_BOUNDARY" && a.class !== "INTAKE" && a.classifications.some((x) => SENSITIVE.has(x));
    if (readsSensitive && !a.protected) out.push(`SENSITIVE_ACTION_UNPROTECTED:${name}`);
    if (a.class === "INTAKE" && a.fieldMask.some((f) => f !== "status" && f !== "supportReference")) out.push(`INTAKE_DISCLOSES_FIELDS:${name}`);
    for (const p of a.access) {
      if (readsSensitive && (p.target === "none" || p.factTypes.length === 0 || (p.minAssurance !== "A2" && p.minAssurance !== "A3"))) {
        out.push(`SENSITIVE_PATH_WEAK:${name}:${p.id}`);
      }
      if (p.target === "none" && p.factTypes.length > 0) out.push(`OPEN_PATH_WITH_FACTS:${name}:${p.id}`);
      if (p.target === "none" && a.class !== "INTAKE" && p.classifications.some((x) => SENSITIVE.has(x))) out.push(`OPEN_PATH_SENSITIVE:${name}:${p.id}`);
      if (!a.roles.includes("*") && p.roles.some((r) => !a.roles.includes(r))) out.push(`PATH_WIDENS_ROLES:${name}:${p.id}`);
      if (!a.purposes.includes("*") && p.purposes.some((x) => !a.purposes.includes(x))) out.push(`PATH_WIDENS_PURPOSES:${name}:${p.id}`);
      if (!a.classifications.includes("*") && p.classifications.some((x) => !a.classifications.includes(x))) out.push(`PATH_WIDENS_CLASSIFICATIONS:${name}:${p.id}`);
      if (p.roles.some((r) => r === "partner" || r === "payer_representative") && p.target !== "organization") out.push(`PARTNER_PATH_NOT_ORGANIZATION:${name}:${p.id}`);
      for (const t of p.factTypes) {
        if (!p.roles.some((r) => r !== "*" && (c.roleFactTypes[r] ?? []).includes(t))) out.push(`PATH_FACT_TYPE_ROLE:${name}:${p.id}`);
      }
    }
  }
  for (const [name, a] of Object.entries(c.console.actions)) {
    if (a.roles.includes("auditor") && a.mutates) out.push(`AUDITOR_MUTATES:${name}`);
    if (a.prohibited && (a.roles.length > 0 || a.assignedRoles.length > 0 || a.scopeRoles !== null)) out.push(`PROHIBITED_HAS_ROLES:${name}`);
  }
  return out;
}
