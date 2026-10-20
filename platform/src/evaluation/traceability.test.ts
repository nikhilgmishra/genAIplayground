import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog, parseCatalog } from "./catalog.js";
import { loadCorpus } from "./corpus.js";
import { buildFaultRegistry } from "./fault-registry.js";
import type { LedgerFaultRow } from "./fault-registry.js";
import { REPO_ROOT } from "./paths.js";
import { buildResultIndex, buildTraceability, extractRegoTests, extractVitestTitles, followOnIssues, loadFollowOn, main, parseFollowOn, renderTraceabilityMarkdown, rollupEnvironment, rollupSoftware, scanTaggedTests } from "./traceability.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const call = (fn: string, title: string, quote = '"') => [fn, "(", quote, title, quote, ", () => {});"].join("");
const write = (root: string, rel: string, content: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

const FIXTURE_CATALOG = `catalogVersion: "fixture-1"
source: fixture
verificationTypes: [unit]
requirements:
  - id: AUTH-01
    kind: invariant
    section: "fixture"
    text: "Caller ID, DOB, NPI and spoken claims never authenticate a session alone."
    enforcement: [platform/src/identity]
    verification: [unit]
    externalBlock: null
  - id: AUTH-04
    kind: invariant
    section: "fixture"
    text: "Expired or revoked sessions fail closed even if TTL cleanup has not run."
    enforcement: [platform/src/identity]
    verification: [unit]
    externalBlock: null
  - id: SAFE-04
    kind: invariant
    section: "fixture"
    text: "Transfer succeeds only with receiver acceptance and verified connection."
    enforcement: [platform/src/workflows/transfer.ts]
    verification: [unit]
    externalBlock: { reason: "vendor transfer events", prerequisites: [PRQ-019] }
  - id: SPEC-13.console
    kind: spec
    section: "fixture"
    text: "Console requirement used to test alias resolution in the fixture catalogue."
    enforcement: [console/]
    verification: [unit]
    aliases: [SPEC-13.4]
    externalBlock: null
  - id: SPEC-8.outbox
    kind: spec
    section: "fixture"
    text: "Outbox requirement exercised only by a rego fixture test in this catalogue."
    enforcement: [platform/src/outbox]
    verification: [unit]
    externalBlock: null
  - id: OPS-03
    kind: invariant
    section: "fixture"
    text: "Unknown capabilities, missing evidence and unrun tests are not PASS."
    enforcement: [platform/src/evaluation]
    verification: [unit]
    externalBlock: null
`;

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "vsp-trace-"));
  dirs.push(root);
  write(root, "docs/requirements/catalog.yaml", FIXTURE_CATALOG);
  // Fixture sources are assembled with `call()` so this file never contains a literal tagged test call
  // (the repository scan would otherwise attribute the fixture titles to real requirements).
  write(
    root,
    "platform/src/identity/session.test.ts",
    [
      'import { describe, it } from "vitest";',
      `${call("describe", "[AUTH-04] session expiry")}`.replace("() => {});", "() => {"),
      `  ${call("it", "[AUTH-01] caller id never authenticates")}`,
      `  ${call("it", "[AUTH-04] expired at ${'T'} fails closed", "`")}`,
      `  ${call("it", "[TB-99] tag that is not in the catalogue")}`,
      "});",
      `${call("it.skip", "[AUTH-01] skipped variant")}`,
    ].join("\n"),
  );
  write(root, "platform/test/transfer.test.ts", `import { it } from "vitest";\n${call("it", "[SAFE-04] transfer requires acceptance")}\n`);
  write(root, "console/src/App.test.tsx", `import { it } from 'vitest';\n${call("it", "[SPEC-13.4] console cancels uncommitted work", "'")}\n`);
  write(root, "policy/outbox_test.rego", "package vsp.test\n\n# [SPEC-8.outbox] dedup decision\n# [OPS-03]\ntest_dedup if {\n  true\n}\n\ntest_untagged if { true }\n");
  const report = {
    success: false,
    testResults: [
      {
        name: join(root, "platform/src/identity/session.test.ts"),
        assertionResults: [
          { ancestorTitles: ["[AUTH-04] session expiry"], title: "[AUTH-01] caller id never authenticates", status: "passed" },
          { ancestorTitles: ["[AUTH-04] session expiry"], title: "[AUTH-04] expired at T fails closed", status: "passed" },
          { ancestorTitles: [], title: "[AUTH-01] skipped variant", status: "skipped" },
          { ancestorTitles: ["[AUTH-04] session expiry"], title: "[TB-99] tag that is not in the catalogue", status: "passed" },
        ],
      },
      { name: join(root, "platform/test/transfer.test.ts"), assertionResults: [{ ancestorTitles: [], title: "[SAFE-04] transfer requires acceptance", status: "failed" }] },
    ],
  };
  write(root, "evidence/test-reports/vitest-platform.json", JSON.stringify(report));
  write(root, "evidence/test-reports/opa.json", JSON.stringify([{ location: { file: "policy/outbox_test.rego" }, package: "data.vsp.test", name: "test_dedup" }]));
  return root;
}

describe("requirements traceability generator", () => {
  it("[SPEC-14.traceability] extracts tagged it/test/describe titles and rego '# [TAG]' comments", () => {
    const t = extractVitestTitles([call("it", "[A-1] no"), call("describe", "[OPS-03][AUTH-01] both", "'"), call("test.skip", "[ACT-02] x")].join("\n"), "f.test.ts");
    expect(t.map((x) => [x.kind, x.tags, x.line])).toEqual([
      ["describe", ["OPS-03", "AUTH-01"], 2],
      ["test", ["ACT-02"], 3],
    ]);
    const r = extractRegoTests("# [AUTH-05]\n# helper\ntest_a if { true }\nallow := true\n# [OPS-03]\nx := 1\ntest_b if { true }", "p_test.rego");
    expect(r.map((x) => [x.title, x.tags])).toEqual([["test_a", ["AUTH-05"]]]);
  });

  it("[SPEC-14.traceability][OPS-03] statuses on a fixture tree: IMPLEMENTED_OFFLINE, NOT_RUN, NO_TEST, FAILING and BLOCKED override", () => {
    const root = fixtureTree();
    const catalog = loadCatalog(join(root, "docs/requirements/catalog.yaml"));
    const tests = scanTaggedTests(root);
    expect(tests.map((t) => t.file)).toEqual([
      "console/src/App.test.tsx",
      "platform/src/identity/session.test.ts",
      "platform/src/identity/session.test.ts",
      "platform/src/identity/session.test.ts",
      "platform/src/identity/session.test.ts",
      "platform/src/identity/session.test.ts",
      "platform/test/transfer.test.ts",
      "policy/outbox_test.rego",
    ]);
    const index = buildResultIndex(root, [join(root, "evidence/test-reports/vitest-platform.json")], [join(root, "evidence/test-reports/opa.json")]);
    const rep = buildTraceability(catalog, tests, index, "2026-10-17T15:00:00.000Z");
    const row = (id: string) => rep.rows.find((r) => r.id === id);
    expect(row("AUTH-04")).toMatchObject({ latestResult: "PASS" });
    expect(row("AUTH-01")).toMatchObject({ latestResult: "NOT_RUN" }); // one tagged test was skipped
    expect(row("SAFE-04")).toMatchObject({ latestResult: "FAIL" });
    expect(row("SAFE-04")?.externalBlock?.prerequisites).toEqual(["PRQ-019"]);
    expect(row("SPEC-13.console")).toMatchObject({ latestResult: "NOT_RUN" }); // console report not supplied
    expect(row("SPEC-13.console")?.tests[0]?.viaAlias).toBe("SPEC-13.4");
    expect(row("SPEC-8.outbox")).toMatchObject({ latestResult: "PASS", evidence: ["evidence/test-reports/opa.json"] });
    expect(row("OPS-03")).toMatchObject({ latestResult: "PASS" });
    expect(row("AUTH-04")?.evidence).toEqual(["evidence/test-reports/vitest-platform.json"]);
    // Without follow-on inputs there are no axes: nothing is inferred from tags.
    expect(rep.rows.every((r) => r.axes === null)).toBe(true);
    expect(rep.unknownTags.map((u) => u.tag)).toEqual(["TB-99"]);
    expect(rep.gaps).toEqual([]);
    expect(rep.summary.localTests).toEqual({ PASS: 3, FAIL: 1, NOT_RUN: 2, NO_TEST: 0 });
    const md = renderTraceabilityMarkdown(rep);
    expect(md).toContain("| Requirement | Text (short) | Enforcement location | Test IDs | Local tests | Evidence path | FO rows | Software | Environment | Qualification |");
    expect(md).toContain("FAIL (1 failed)");
    expect(md).toContain("`TB-99`");
    expect(md).not.toContain("IMPLEMENTED_OFFLINE");
  });

  it("[OPS-03] without any result report every tagged requirement is NOT_RUN and untagged ones are NO_TEST gaps", () => {
    const root = fixtureTree();
    writeFileSync(join(root, "policy/outbox_test.rego"), "package vsp.test\n");
    const catalog = loadCatalog(join(root, "docs/requirements/catalog.yaml"));
    const rep = buildTraceability(catalog, scanTaggedTests(root), null, "2026-10-17T15:00:00.000Z");
    expect(rep.rows.filter((r) => r.tests.length > 0).every((r) => r.latestResult === "NOT_RUN")).toBe(true);
    expect(rep.gaps).toEqual(["SPEC-8.outbox", "OPS-03"]);
    expect(rep.rows.find((r) => r.id === "SPEC-8.outbox")?.latestResult).toBe("NO_TEST");
    expect(renderTraceabilityMarkdown(rep)).toContain("No test-result report was supplied");
  });

  it("[SPEC-14.traceability] the CLI writes the matrix (and JSON) to the requested paths", () => {
    const root = fixtureTree();
    const out = join(root, "out/TRACE.md");
    mkdirSync(dirname(out), { recursive: true });
    const code = main(["--root", root, "--vitest-report", join(root, "evidence/test-reports/vitest-platform.json"), "--out", out, "--json", join(root, "out/trace.json"), "--generated-at", "2026-10-17T15:00:00.000Z"]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("Generated at 2026-10-17T15:00:00.000Z");
    expect(JSON.parse(readFileSync(join(root, "out/trace.json"), "utf8")).summary.requirements).toBe(6);
  });

  it("[SPEC-14.traceability] rejects duplicate ids and alias collisions in a catalogue", () => {
    expect(() => parseCatalog(FIXTURE_CATALOG.replace("id: AUTH-04", "id: AUTH-01"))).toThrow("CATALOG_DUPLICATE_ID");
    expect(() => parseCatalog(FIXTURE_CATALOG.replace("aliases: [SPEC-13.4]", "aliases: [AUTH-01]"))).toThrow("CATALOG_ALIAS_COLLISION");
    expect(() => parseCatalog("catalogVersion: 1")).toThrow("CATALOG_INVALID");
  });
});

describe("repository requirement catalogue (docs/requirements/catalog.yaml)", () => {
  const catalog = loadCatalog(join(REPO_ROOT, "docs/requirements/catalog.yaml"));
  const reqs = catalog.catalog.requirements;

  it("[SPEC-14.traceability] contains every acceptance invariant with the exact specification text", () => {
    const spec = readFileSync(join(REPO_ROOT, "docs/spec/voice-support-specification.txt"), "utf8");
    const invariants = [...spec.matchAll(/^((?:AUTH|DATA|ACT|SAFE|OPS)-\d{2})\s+(.+)$/gm)].map((m) => [m[1], (m[2] as string).trim()] as const);
    expect(invariants).toHaveLength(27);
    for (const [id, text] of invariants) expect(reqs.find((r) => r.id === id)?.text, id).toBe(text);
  });

  it("[SPEC-14.traceability] has 60+ SPEC requirements covering sections 2 to 16 with enforcement, verification type and block status", () => {
    const specReqs = reqs.filter((r) => r.kind === "spec");
    expect(specReqs.length).toBeGreaterThanOrEqual(60);
    const sections = new Set(specReqs.map((r) => Number(/^SPEC-(\d+)\./.exec(r.id)?.[1])));
    for (let s = 2; s <= 16; s++) expect(sections.has(s), `section ${s}`).toBe(true);
    for (const r of reqs) {
      expect(r.enforcement.length).toBeGreaterThan(0);
      expect(r.verification.length).toBeGreaterThan(0);
    }
    for (const id of ["SPEC-14.risk-corpus", "SPEC-14.test-layers", "SPEC-12.load-test", "SPEC-3.vendor-capability-gate", "SPEC-13.incident-playbooks"]) {
      expect(reqs.find((r) => r.id === id)?.externalBlock, id).not.toBeNull();
    }
    for (const id of ["SPEC-4.outcomes", "SPEC-7.otp-limits", "SPEC-8.tool-schema", "SPEC-8.outbox", "SPEC-9.workflow", "SPEC-9.retrieval", "SPEC-10.transfer", "SPEC-11.barge-in", "SPEC-12.admission", "SPEC-13.audit-model", "SPEC-13.killswitch", "SPEC-13.console", "SPEC-14.policy-expansion", "SPEC-16.prod-guard", "SPEC-16.journeys"]) {
      expect(catalog.resolve(id), id).toBe(id);
    }
  });

  it("[SPEC-14.traceability] scanning the repository resolves this module's own tags (catalogue ids, aliases or follow-on ids)", () => {
    const fo = new Set(loadFollowOn(REPO_ROOT).requirements.map((r) => r.id));
    const tests = scanTaggedTests(REPO_ROOT).filter((t) => t.file.startsWith("platform/src/evaluation/") || t.file.startsWith("platform/test/invariants/"));
    expect(tests.length).toBeGreaterThan(30);
    for (const t of tests) for (const tag of t.tags) expect(catalog.resolve(tag) ?? (fo.has(tag) ? tag : undefined), `${t.file}:${t.line} ${tag}`).toBeDefined();
  });
});

describe("[FO-00-29][FO-00-37] two status axes from docs/followon", () => {
  const FIXTURE_FO = {
    requirements: `asOf: '2026-10-19'
requirements:
  - { id: FO-02-01, section: '2', kind: software, text: caller id never authenticates, originalIds: [AUTH-01], capabilityIds: [identity.core] }
  - { id: FO-02-04, section: '2', kind: software, text: expiry fails closed, originalIds: [AUTH-04, SPEC-13.4], capabilityIds: [identity.core] }
  - { id: FO-17-14, section: '17', kind: evaluation, text: fixed denominator, originalIds: [OPS-03, SAFE-04, SPEC-8.outbox], capabilityIds: [evaluation.test_truth] }
`,
    gapLedger: `entries:
  - { id: FO-02-01, softwareStatus: VERIFIED_LOCAL, environmentStatus: NOT_CONFIGURED, qualification: NOT_RUN, workPackage: WP-43 }
  - { id: FO-02-04, softwareStatus: IMPLEMENTED, environmentStatus: NOT_CONFIGURED, qualification: PASS, workPackage: WP-43 }
  - { id: FO-17-14, softwareStatus: IMPLEMENTED, environmentStatus: NOT_CONFIGURED, qualification: FAIL, workPackage: WP-01 }
`,
    capabilities: `capabilities:
  - { id: identity.core, title: Identity, softwareRollup: IMPLEMENTED, environmentRollup: NOT_CONFIGURED, memberRequirementIds: [FO-02-01, FO-02-04] }
  - { id: evaluation.test_truth, title: Test truth, softwareRollup: IMPLEMENTED, environmentRollup: NOT_CONFIGURED, memberRequirementIds: [FO-17-14] }
`,
    activationRegister: `entries:
  - { id: AIN-08 }
`,
  };
  const fixtureCatalog = () => parseCatalog(FIXTURE_CATALOG);

  it("[FO-00-29] emits Software, Environment and Qualification per requirement, capability and catalogue id (least advanced member; qualification PASS only when every member is PASS)", () => {
    const fo = parseFollowOn(FIXTURE_FO);
    const catalog = fixtureCatalog();
    expect(followOnIssues(fo, catalog)).toEqual([
      "INVARIANT_REGISTER_MISSING AUTH-01",
      "INVARIANT_REGISTER_MISSING AUTH-04",
      "INVARIANT_REGISTER_MISSING SAFE-04",
      "INVARIANT_REGISTER_MISSING OPS-03",
    ]);
    const rep = buildTraceability(catalog, [], null, "2026-10-19T12:00:00.000Z", fo, null);
    expect(rep.followOnRows.map((r) => [r.id, r.software, r.environment, r.qualification])).toEqual([
      ["FO-02-01", "VERIFIED_LOCAL", "NOT_CONFIGURED", "NOT_RUN"],
      ["FO-02-04", "IMPLEMENTED", "NOT_CONFIGURED", "PASS"],
      ["FO-17-14", "IMPLEMENTED", "NOT_CONFIGURED", "FAIL"],
    ]);
    expect(rep.capabilities.map((c) => [c.id, c.software, c.environment, c.qualification])).toEqual([
      ["identity.core", "IMPLEMENTED", "NOT_CONFIGURED", "INCONCLUSIVE"],
      ["evaluation.test_truth", "IMPLEMENTED", "NOT_CONFIGURED", "FAIL"],
    ]);
    expect(rep.rows.find((r) => r.id === "AUTH-01")?.axes).toEqual({ software: "VERIFIED_LOCAL", environment: "NOT_CONFIGURED", qualification: "NOT_RUN" });
    expect(rep.rows.find((r) => r.id === "SPEC-13.console")?.followOnIds).toEqual(["FO-02-04"]); // via its alias
    expect(rollupSoftware([])).toBe("MISSING");
    expect(rollupEnvironment(["VERIFIED_SANDBOX", "CONFIGURED"])).toBe("CONFIGURED");
    const md = renderTraceabilityMarkdown(rep);
    expect(md).toContain("| Software | `MISSING` < `IMPLEMENTED` < `VERIFIED_LOCAL` < `RELEASE_PACKAGE_VERIFIED`");
    expect(md).toContain("| `identity.core` | Identity | 2 | IMPLEMENTED | NOT_CONFIGURED | INCONCLUSIVE |");
  });

  it("[FO-00-37][FO-00-29] fails on an unresolved originalId, an AIN id used as an originalId, a catalogue id without a follow-on row, a missing ledger row, a stale capability roll-up and an unknown status value", () => {
    const catalog = fixtureCatalog();
    const issues = (over: Partial<typeof FIXTURE_FO>) => followOnIssues(parseFollowOn({ ...FIXTURE_FO, ...over }), catalog).filter((i) => !i.startsWith("INVARIANT_REGISTER_MISSING"));
    expect(issues({})).toEqual([]);
    expect(issues({ requirements: FIXTURE_FO.requirements.replace("originalIds: [AUTH-01]", "originalIds: [AUTH-01, SPEC-99.nothing]") })).toEqual(["ORIGINAL_ID_UNRESOLVED FO-02-01 SPEC-99.nothing"]);
    expect(issues({ requirements: FIXTURE_FO.requirements.replace("originalIds: [AUTH-01]", "originalIds: [AUTH-01, AIN-08]") })).toEqual(["AIN_AS_ORIGINAL_ID FO-02-01 AIN-08"]);
    expect(issues({ requirements: FIXTURE_FO.requirements.replace("originalIds: [OPS-03, SAFE-04, SPEC-8.outbox]", "originalIds: [OPS-03, SAFE-04]") })).toEqual(["CATALOG_ID_WITHOUT_FO_ROW SPEC-8.outbox"]);
    expect(issues({ gapLedger: FIXTURE_FO.gapLedger.split("\n").filter((l) => !l.includes("FO-17-14")).join("\n") })).toEqual(["LEDGER_ROW_MISSING FO-17-14", "CAPABILITY_ROLLUP_MISMATCH evaluation.test_truth software=IMPLEMENTED members=MISSING"]);
    expect(issues({ capabilities: FIXTURE_FO.capabilities.replace("title: Identity, softwareRollup: IMPLEMENTED", "title: Identity, softwareRollup: VERIFIED_LOCAL") })).toEqual(["CAPABILITY_ROLLUP_MISMATCH identity.core software=VERIFIED_LOCAL members=IMPLEMENTED"]);
    expect(issues({ gapLedger: FIXTURE_FO.gapLedger.replace("qualification: PASS", "qualification: PASSED") })).toEqual(["STATUS_VALUE_UNKNOWN FO-02-04 qualification=PASSED"]);
    expect(issues({ requirements: FIXTURE_FO.requirements.replace("capabilityIds: [evaluation.test_truth]", "capabilityIds: [no.such]") })).toEqual(["CAPABILITY_UNKNOWN FO-17-14 no.such"]);
  });

  it("[FO-00-29][FO-00-37][FO-02-28][FO-19-05] the repository's follow-on inputs, catalogue and register resolve with no issue; every invariant row has its three roles", () => {
    const catalog = loadCatalog(join(REPO_ROOT, "docs/requirements/catalog.yaml"));
    const fo = loadFollowOn(REPO_ROOT);
    expect(followOnIssues(fo, catalog)).toEqual([]);
    const rep = buildTraceability(catalog, scanTaggedTests(REPO_ROOT), null, "2026-10-19T12:00:00.000Z", fo, null);
    expect(rep.issues).toEqual([]);
    expect(rep.followOnRows.length).toBe(fo.requirements.length);
    expect(rep.capabilities.length).toBe(fo.capabilities.length);
    expect(rep.invariants).toHaveLength(27);
    // Without a recorded report nothing is PASS (OPS-03).
    expect(rep.invariants.every((i) => i.allRoles === "NOT_RUN")).toBe(true);
    expect(rep.invariants.every((i) => i.failureInjection.tests.every((t) => t.line !== null))).toBe(true);
    expect(rep.rows.every((r) => r.followOnIds.length > 0)).toBe(true);
  });
});

describe("[FO-17-24][OPS-03] the fault registry section shows every plan versus gap-ledger disagreement and every orphan fault tag", () => {
  const plans = loadCorpus().faultPlans;
  const ledgerRow = (faultId: string, over: Partial<LedgerFaultRow> = {}): LedgerFaultRow => {
    const p = plans.get(faultId);
    if (!p) throw new Error(`no plan ${faultId}`);
    return { id: `FO-17-24.${faultId}`, faultId, workPackage: p.registry.layer2Owner, faultSource: "registry", injectionPointPackages: [...p.registry.injectionPointPackages], postconditionPackages: [...p.registry.postconditionPackages], softwareStatus: "IMPLEMENTED", ...over };
  };
  const render = (ledger: LedgerFaultRow[] | null, orphan = false) => {
    const tests = orphan ? [{ faultId: "NO_SUCH_FAULT", file: "platform/test/invariants/x.test.ts", line: 7, title: "[FAULT:NO_SUCH_FAULT] x", seam: false, layer: "layer1" as const, suite: null }] : [];
    const faults = buildFaultRegistry(plans, tests, null, ledger);
    const rep = buildTraceability(parseCatalog(FIXTURE_CATALOG), [], null, "2026-10-19T12:00:00.000Z", null, faults);
    return { faults, md: renderTraceabilityMarkdown(rep) };
  };

  it("[FO-17-24] a stale faultSource and a missing ledger row are listed in the report (and counted in the summary), never reported as none", () => {
    const rows = [...plans.keys()].filter((id) => id !== "ASR_FAILURE").map((id) => ledgerRow(id, id === "BUDGET_EXHAUSTED" ? { faultSource: "prompt section 17" } : {}));
    const { faults, md } = render(rows, true);
    expect(faults.ledgerIssues).toEqual(["LEDGER_FAULT_SOURCE_STALE BUDGET_EXHAUSTED faultSource=prompt section 17", "PLAN_WITHOUT_LEDGER_ROW ASR_FAILURE"]);
    expect(md).toContain("plan versus gap-ledger disagreements 2; fault tags naming no plan 1.");
    expect(md).toContain("Plan versus gap-ledger disagreements (fault-registry.ts crossCheckLedger; resolved by regenerating docs/followon from its sources): 2.");
    expect(md).toContain("- `LEDGER_FAULT_SOURCE_STALE BUDGET_EXHAUSTED faultSource=prompt section 17`");
    expect(md).toContain("- `PLAN_WITHOUT_LEDGER_ROW ASR_FAILURE`");
    expect(md).toContain("Fault tags naming no plan: `NO_SUCH_FAULT` (platform/test/invariants/x.test.ts:7).");
  });

  it("[FO-17-24] a consistent ledger reads none, and an unread ledger says it was not checked", () => {
    expect(render([...plans.keys()].map((id) => ledgerRow(id))).md).toContain("resolved by regenerating docs/followon from its sources): none.");
    const unread = render(null).md;
    expect(unread).toContain("gap ledger not read");
    expect(unread).toContain("not checked (gap ledger not read)");
    expect(unread).toContain("Fault tags naming no plan: none.");
  });
});
