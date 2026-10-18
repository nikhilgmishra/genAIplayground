import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog, parseCatalog } from "./catalog.js";
import { REPO_ROOT } from "./paths.js";
import { buildResultIndex, buildTraceability, extractRegoTests, extractVitestTitles, main, renderTraceabilityMarkdown, scanTaggedTests } from "./traceability.js";

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
    expect(row("AUTH-04")).toMatchObject({ offlineStatus: "IMPLEMENTED_OFFLINE", releaseStatus: "IMPLEMENTED_OFFLINE", latestResult: "PASS" });
    expect(row("AUTH-01")).toMatchObject({ offlineStatus: "NOT_RUN" }); // one tagged test was skipped
    expect(row("SAFE-04")).toMatchObject({ offlineStatus: "FAILING", releaseStatus: "BLOCKED", latestResult: "FAIL" });
    expect(row("SPEC-13.console")).toMatchObject({ offlineStatus: "NOT_RUN" }); // console report not supplied
    expect(row("SPEC-13.console")?.tests[0]?.viaAlias).toBe("SPEC-13.4");
    expect(row("SPEC-8.outbox")).toMatchObject({ offlineStatus: "IMPLEMENTED_OFFLINE", evidence: ["evidence/test-reports/opa.json"] });
    expect(row("OPS-03")).toMatchObject({ offlineStatus: "IMPLEMENTED_OFFLINE" });
    expect(row("AUTH-04")?.evidence).toEqual(["evidence/test-reports/vitest-platform.json"]);
    expect(rep.unknownTags.map((u) => u.tag)).toEqual(["TB-99"]);
    expect(rep.gaps).toEqual([]);
    const md = renderTraceabilityMarkdown(rep);
    expect(md).toContain("| Requirement | Text (short) | Enforcement location | Test IDs | Latest result | Evidence path | Release status |");
    expect(md).toContain("BLOCKED (offline: FAILING; PRQ-019)");
    expect(md).toContain("`TB-99`");
  });

  it("[OPS-03] without any result report every tagged requirement is NOT_RUN and untagged ones are NO_TEST gaps", () => {
    const root = fixtureTree();
    writeFileSync(join(root, "policy/outbox_test.rego"), "package vsp.test\n");
    const catalog = loadCatalog(join(root, "docs/requirements/catalog.yaml"));
    const rep = buildTraceability(catalog, scanTaggedTests(root), null, "2026-10-17T15:00:00.000Z");
    expect(rep.rows.filter((r) => r.tests.length > 0).every((r) => r.offlineStatus === "NOT_RUN")).toBe(true);
    expect(rep.gaps).toEqual(["SPEC-8.outbox", "OPS-03"]);
    expect(rep.rows.find((r) => r.id === "SPEC-8.outbox")?.offlineStatus).toBe("NO_TEST");
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

  it("[SPEC-14.traceability] scanning the repository resolves this module's own tags", () => {
    const tests = scanTaggedTests(REPO_ROOT).filter((t) => t.file.startsWith("platform/src/evaluation/"));
    expect(tests.length).toBeGreaterThan(30);
    for (const t of tests) for (const tag of t.tags) expect(catalog.resolve(tag), `${t.file}:${t.line} ${tag}`).toBeDefined();
  });
});
