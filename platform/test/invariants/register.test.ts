/**
 * The invariant register (docs/requirements/catalog.yaml `register`; FO-02-28: "Register has all eight attributes
 * for all 27 invariants and a test fails on any missing attribute"; FO-00-37: follow-on requirements map to the
 * original ids without redefining them; FO-19-05: positive, direct adversarial and failure-injection tests per
 * invariant).
 *
 * Every attribute is checked against its source of truth, so a stale register fails here:
 *  - the schema (catalog.ts InvariantRegister) requires every attribute for every invariant;
 *  - the follow-on row is the FO-02 row whose single invariant originalId is this invariant, and the owner package,
 *    secondary packages and activation dependencies equal that row in docs/followon/gap-ledger.yaml;
 *  - every threat id is a row of docs/security/threat-model.md that names the invariant;
 *  - every test reference is an it/test title in the named file that contains the given text and carries the
 *    invariant's tag (directly or through a catalogue alias); the three roles never cite the same test;
 *  - the audio release boundary gap is recorded for ACT-05, AUTH-06 and DATA-02 until that boundary exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import { CatalogError, loadCatalog, parseCatalog, registerIssues } from "../../src/evaluation/catalog.js";
import type { RegisterTestRef, RequirementEntry } from "../../src/evaluation/catalog.js";
import { REPO_ROOT, repoPaths } from "../../src/evaluation/paths.js";
import { extractVitestTitles } from "../../src/evaluation/traceability.js";

const catalog = loadCatalog(repoPaths(REPO_ROOT).catalog);
const invariants = catalog.catalog.requirements.filter((r) => r.kind === "invariant");
const INVARIANT_IDS = [
  ...["01", "02", "03", "04", "05", "06", "07"].map((n) => `AUTH-${n}`),
  ...["01", "02", "03", "04"].map((n) => `DATA-${n}`),
  ...["01", "02", "03", "04", "05"].map((n) => `ACT-${n}`),
  ...["01", "02", "03", "04", "05"].map((n) => `SAFE-${n}`),
  ...["01", "02", "03", "04", "05", "06"].map((n) => `OPS-${n}`),
];

const yamlOf = (rel: string) => parseYaml(readFileSync(join(REPO_ROOT, rel), "utf8")) as Record<string, unknown>;
const followOn = (yamlOf("docs/followon/requirements.yaml").requirements as { id: string; originalIds: string[] }[]).filter((r) => /^FO-02-(0[1-9]|1\d|2[0-7])$/.test(r.id));
const ledger = new Map((yamlOf("docs/followon/gap-ledger.yaml").entries as { id: string; workPackage: string; secondaryPackages?: string[]; activation?: string[] }[]).map((e) => [e.id, e] as const));
const threatModel = readFileSync(join(REPO_ROOT, "docs/security/threat-model.md"), "utf8");
const threatRow = (id: string): string | null => threatModel.split("\n").find((l) => l.startsWith(`| ${id} |`)) ?? null;

const titleCache = new Map<string, ReturnType<typeof extractVitestTitles>>();
const titlesOf = (file: string) => {
  if (!titleCache.has(file)) titleCache.set(file, extractVitestTitles(readFileSync(join(REPO_ROOT, file), "utf8"), file).filter((t) => t.kind !== "describe"));
  return titleCache.get(file) ?? [];
};
const reg = (r: RequirementEntry) => {
  if (!r.register) throw new Error(`${r.id}: register missing`);
  return r.register;
};

describe("[FO-02-28][FO-00-37][FO-19-05] invariant register", () => {
  it("[FO-02-28] the catalogue holds exactly the 27 invariants and every one has a complete register record", () => {
    expect(invariants.map((r) => r.id).sort()).toEqual([...INVARIANT_IDS].sort());
    for (const r of invariants) {
      const g = reg(r);
      expect(r.enforcement.length, r.id).toBeGreaterThan(0);
      expect(g.threatIds.length, r.id).toBeGreaterThan(0);
      expect(g.positiveTests.length, r.id).toBeGreaterThan(0);
      expect(g.adversarialTests.length, r.id).toBeGreaterThan(0);
      expect(g.failureInjectionTests.length, r.id).toBeGreaterThan(0);
      expect(g.evidenceArtifact, r.id).toBe(`evidence/test-reports/traceability.json#invariants/${r.id}`);
      expect(g.ownerRole.length, r.id).toBeGreaterThan(4);
      expect(g.ownerPackage, r.id).toMatch(/^WP-\d{2}$/);
      expect(Array.isArray(g.activationDependency), r.id).toBe(true);
      expect(g.secondaryPackages.length, r.id).toBeGreaterThan(0);
    }
    expect(catalog.catalog.requirements.filter((r) => r.kind === "spec").every((r) => r.register === undefined)).toBe(true);
    expect(registerIssues(catalog.catalog)).toEqual([]);
  });

  it("[FO-02-28] a register with any attribute removed (or an invariant without a register) is refused by the catalogue loader", () => {
    const raw = parseYaml(readFileSync(repoPaths(REPO_ROOT).catalog, "utf8")) as { requirements: Record<string, unknown>[] };
    const attributes = ["followOnId", "threatIds", "positiveTests", "adversarialTests", "failureInjectionTests", "evidenceArtifact", "ownerRole", "ownerPackage", "activationDependency", "secondaryPackages"];
    for (const attr of attributes) {
      const copy = structuredClone(raw);
      const first = copy.requirements.find((r) => r.kind === "invariant") as { register: Record<string, unknown> };
      delete first.register[attr];
      expect(() => parseCatalog(stringify(copy)), attr).toThrow(CatalogError);
    }
    const none = structuredClone(raw);
    delete (none.requirements.find((r) => r.kind === "invariant") as Record<string, unknown>).register;
    const first = (none.requirements.find((r) => r.kind === "invariant") as { id: string }).id;
    expect(registerIssues(parseCatalog(stringify(none)).catalog)).toEqual([`INVARIANT_REGISTER_MISSING ${first}`]);
    const empty = structuredClone(raw);
    ((empty.requirements.find((r) => r.kind === "invariant") as { register: { failureInjectionTests: unknown[] } }).register.failureInjectionTests = []);
    expect(() => parseCatalog(stringify(empty))).toThrow(CatalogError);
  });

  it("[FO-00-37][FO-02-28] each invariant maps to exactly one FO-02 row; owner, secondary packages and activation dependencies equal the gap ledger", () => {
    expect(followOn).toHaveLength(27);
    const seen = new Set<string>();
    for (const r of invariants) {
      const g = reg(r);
      const row = followOn.find((f) => f.id === g.followOnId);
      expect(row, r.id).toBeDefined();
      expect(row?.originalIds.filter((o) => INVARIANT_IDS.includes(o)), r.id).toEqual([r.id]);
      expect(seen.has(g.followOnId), g.followOnId).toBe(false);
      seen.add(g.followOnId);
      const l = ledger.get(g.followOnId);
      expect(l?.workPackage, r.id).toBe(g.ownerPackage);
      expect([...(l?.secondaryPackages ?? [])].sort(), r.id).toEqual([...g.secondaryPackages].sort());
      expect([...(l?.activation ?? [])].sort(), r.id).toEqual([...g.activationDependency].sort());
    }
  });

  it("[FO-02-28] every threat id is a threat-model row that names the invariant; each invariant has at least one", () => {
    for (const r of invariants) {
      for (const t of reg(r).threatIds) {
        const row = threatRow(t);
        expect(row, `${r.id} -> ${t}`).not.toBeNull();
        expect(new RegExp(`\\b${r.id}\\b`).test(row ?? ""), `${t} names ${r.id}`).toBe(true);
      }
    }
  });

  it("[FO-19-05][FO-02-28] every positive, adversarial and failure-injection test exists, carries the invariant's tag and is distinct across roles", () => {
    const resolveTagged = (ref: RegisterTestRef, inv: string) => {
      expect(existsSync(join(REPO_ROOT, ref.file)), ref.file).toBe(true);
      const hits = titlesOf(ref.file).filter((t) => t.title.includes(ref.title));
      expect(hits.length, `${inv}: "${ref.title}" in ${ref.file}`).toBe(1);
      const tags = (hits[0]?.tags ?? []).map((tag) => catalog.resolve(tag) ?? tag);
      expect(tags, `${inv}: tag on "${ref.title}"`).toContain(inv);
      return `${ref.file}:${hits[0]?.line}`;
    };
    for (const r of invariants) {
      const g = reg(r);
      const roles = { positive: g.positiveTests, adversarial: g.adversarialTests, failure: g.failureInjectionTests };
      const where = Object.fromEntries(Object.entries(roles).map(([k, refs]) => [k, refs.map((ref) => resolveTagged(ref, r.id))]));
      const all = Object.values(where).flat();
      expect(new Set(all).size, `${r.id}: a test cited for two roles`).toBe(all.length);
    }
  });

  it("[FO-19-05] the failure-injection tests this package adds carry the [FAILURE:<invariant>] role tag", () => {
    const own = ["platform/test/invariants/failure-injection.test.ts", "platform/test/invariants/evaluation-boundary.test.ts"];
    for (const r of invariants) {
      for (const ref of reg(r).failureInjectionTests.filter((t) => own.includes(t.file))) {
        const hit = titlesOf(ref.file).find((t) => t.title.includes(ref.title));
        expect(hit?.title, ref.title).toContain(`[FAILURE:${r.id}]`);
      }
    }
  });

  it("[FO-19-05] the audio release boundary is an open gap for ACT-05, AUTH-06 and DATA-02 (no audio boundary exists yet)", () => {
    for (const id of ["ACT-05", "AUTH-06", "DATA-02"]) expect(reg(invariants.find((r) => r.id === id) as RequirementEntry).openGaps, id).toContain("AUDIO_RELEASE_BOUNDARY_NOT_BUILT");
  });
});
