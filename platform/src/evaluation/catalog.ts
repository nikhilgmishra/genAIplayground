/**
 * Requirement catalogue loader (docs/requirements/catalog.yaml).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { sha256Hex } from "../shared/canonical.js";

export const REQUIREMENT_ID = /^(?:(?:AUTH|DATA|ACT|SAFE|OPS)-\d{2}|SPEC-\d{1,2}\.[a-z0-9][a-z0-9-]*)$/;
export const VerificationType = z.enum(["unit", "property", "contract", "adversarial", "workflow", "audio", "load", "manual", "operational"]);

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
});
export type RequirementEntry = z.infer<typeof RequirementEntry>;

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
