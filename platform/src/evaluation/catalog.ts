/**
 * Requirement catalogue loader (docs/requirements/catalog.yaml).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { sha256Hex } from "../shared/canonical.js";

export const REQUIREMENT_ID = /^(?:(?:AUTH|DATA|ACT|SAFE|OPS)-\d{2}|SPEC-\d{1,2}\.[a-z0-9][a-z0-9-]*)$/;
export const VerificationType = z.enum(["unit", "property", "contract", "adversarial", "workflow", "audio", "load", "manual", "operational"]);

/** A test the invariant register names: repository-relative test file plus a distinctive part of its title. */
export const RegisterTestRef = z.strictObject({
  file: z.string().regex(/^(platform|console|policy|scripts)\/[A-Za-z0-9_./-]+\.test\.tsx?$/),
  title: z.string().min(12).max(240),
});
export type RegisterTestRef = z.infer<typeof RegisterTestRef>;

const WorkPackage = z.string().regex(/^WP-\d{2}$/);

/**
 * Invariant register record (FO-02-28: "for every invariant, enforcement location, threat, positive test, direct
 * adversarial test, failure injection, evidence artifact, owner and activation dependency"; WP-01 adds the
 * follow-on requirement row and its secondary packages). Enforcement locations are the entry's `enforcement`.
 */
export const InvariantRegister = z.strictObject({
  /** The follow-on invariant row (docs/followon/requirements.yaml FO-02-01..27). */
  followOnId: z.string().regex(/^FO-02-\d{2}$/),
  /** Rows of docs/security/threat-model.md that this invariant mitigates. */
  threatIds: z.array(z.string().regex(/^F?T-\d{2}$/)).min(1).max(12),
  positiveTests: z.array(RegisterTestRef).min(1).max(6),
  adversarialTests: z.array(RegisterTestRef).min(1).max(6),
  failureInjectionTests: z.array(RegisterTestRef).min(1).max(6),
  /** Where the joined test results for this invariant are recorded. */
  evidenceArtifact: z.string().regex(/^evidence\/[A-Za-z0-9_./#-]+$/),
  ownerRole: z.string().min(5).max(80),
  /** Package that owns the invariant row in the gap ledger. */
  ownerPackage: WorkPackage,
  /** Activation register entries (AIN-NN) the invariant's live verification waits for; empty = none. */
  activationDependency: z.array(z.string().regex(/^AIN-\d{2}$/)).max(8),
  /** Packages that add positive, adversarial and failure-injection tests at their own boundary. */
  secondaryPackages: z.array(WorkPackage).min(1).max(12),
  /** Open register gaps (reason codes), e.g. AUDIO_RELEASE_BOUNDARY_NOT_BUILT. */
  openGaps: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{3,63}$/)).max(8).default([]),
});
export type InvariantRegister = z.infer<typeof InvariantRegister>;

export const RequirementEntry = z.strictObject({
  id: z.string().regex(REQUIREMENT_ID),
  kind: z.enum(["invariant", "spec"]),
  section: z.string().min(1).max(120),
  text: z.string().min(10).max(800),
  enforcement: z.array(z.string().min(2).max(160)).min(1).max(8),
  verification: z.array(VerificationType).min(1).max(6),
  /** Tags already used by tests that resolve to this requirement. */
  aliases: z.array(z.string().regex(/^[A-Z][A-Z0-9]{1,7}-[A-Za-z0-9][A-Za-z0-9.-]*$/)).max(12).default([]),
  /** Verification beyond the offline slice depends on an external prerequisite. */
  externalBlock: z
    .strictObject({
      reason: z.string().min(5).max(300),
      prerequisites: z.array(z.string().regex(/^PRQ-\d{3}$/)).min(1).max(10),
    })
    .nullable(),
  /** Invariant register record (every attribute required when present); see `registerIssues`. */
  register: InvariantRegister.optional(),
});
export type RequirementEntry = z.infer<typeof RequirementEntry>;

/**
 * Register completeness (FO-02-28): every invariant has a register record and no spec entry has one. The
 * committed catalogue must have none of these issues (platform/test/invariants/register.test.ts and the
 * traceability generator's `--check`); fixture catalogues in unit tests may omit registers.
 */
export function registerIssues(catalog: RequirementCatalog): string[] {
  const out: string[] = [];
  for (const r of catalog.requirements) {
    if (r.kind === "invariant" && !r.register) out.push(`INVARIANT_REGISTER_MISSING ${r.id}`);
    if (r.kind === "spec" && r.register) out.push(`REGISTER_ONLY_FOR_INVARIANTS ${r.id}`);
  }
  return out;
}

export const RequirementCatalog = z.strictObject({
  catalogVersion: z.string().min(1).max(40),
  source: z.string().min(3).max(200),
  verificationTypes: z.array(VerificationType).min(1),
  requirements: z.array(RequirementEntry).min(1).max(400),
});
export type RequirementCatalog = z.infer<typeof RequirementCatalog>;

export class CatalogError extends Error {
  constructor(readonly reasonCode: string, detail = "") {
    super(detail ? `${reasonCode}: ${detail}` : reasonCode);
  }
}

export interface LoadedCatalog {
  catalog: RequirementCatalog;
  digest: string;
  /** Canonical id for every id and alias. */
  resolve: (tag: string) => string | undefined;
}

export function parseCatalog(text: string): LoadedCatalog {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new CatalogError("CATALOG_UNPARSEABLE");
  }
  const parsed = RequirementCatalog.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new CatalogError("CATALOG_INVALID", i ? `${i.path.join(".")}: ${i.message}` : "");
  }
  const index = new Map<string, string>();
  for (const r of parsed.data.requirements) {
    if (index.has(r.id)) throw new CatalogError("CATALOG_DUPLICATE_ID", r.id);
    index.set(r.id, r.id);
  }
  for (const r of parsed.data.requirements) {
    for (const a of r.aliases) {
      if (index.has(a)) throw new CatalogError("CATALOG_ALIAS_COLLISION", a);
      index.set(a, r.id);
    }
  }
  return { catalog: parsed.data, digest: sha256Hex(text), resolve: (tag) => index.get(tag) };
}

export const loadCatalog = (path: string): LoadedCatalog => parseCatalog(readFileSync(path, "utf8"));
