// node --test scripts/ci/sbom.test.mjs
// Fixture packages are SYNTHETIC names; the real-workspace test reads pnpm output if present.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { buildSbom, indexLicenses, licenseEntry, purl } from "./sbom.mjs";

const fixture = [
  { name: "root-workspace", path: "/x", private: true },
  {
    name: "@vsp/fixture-app",
    version: "0.1.0",
    path: "/x/app",
    private: true,
    dependencies: {
      "@scope/runtime-lib": {
        from: "@scope/runtime-lib",
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/@scope/runtime-lib/-/runtime-lib-1.2.3.tgz",
        dependencies: { "shared-leaf": { from: "shared-leaf", version: "2.0.0" } },
      },
      "local-link": { from: "local-link", version: "link:../other" },
    },
    devDependencies: {
      "dev-only-tool": { from: "dev-only-tool", version: "9.9.9", dependencies: { "shared-leaf": { from: "shared-leaf", version: "2.0.0" } } },
    },
  },
];

const licenses = indexLicenses({
  MIT: [{ name: "@scope/runtime-lib", versions: ["1.2.3"], license: "MIT" }],
  "(MIT OR Apache-2.0)": [{ name: "shared-leaf", versions: ["2.0.0"], license: "(MIT OR Apache-2.0)" }],
  Custom: [{ name: "dev-only-tool", versions: ["9.9.9"], license: "SEE LICENSE IN LICENSE.md" }],
});

test("[SPEC-14.sbom] emits a CycloneDX 1.5 document with purls and a dependency graph", () => {
  const sbom = buildSbom(fixture, { licenses, timestamp: "2026-10-17T00:00:00.000Z" });
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const lib = sbom.components.find((c) => c.name === "runtime-lib");
  assert.equal(lib.group, "@scope");
  assert.equal(lib.purl, "pkg:npm/%40scope/runtime-lib@1.2.3");
  assert.deepEqual(lib.licenses, [{ license: { id: "MIT" } }]);
  assert.equal(lib.externalReferences[0].type, "distribution");
  const appDeps = sbom.dependencies.find((d) => d.ref === purl("@vsp/fixture-app", "0.1.0"));
  assert.ok(appDeps.dependsOn.includes("pkg:npm/%40scope/runtime-lib@1.2.3"));
});

test("[SPEC-14.sbom] dev-only components are scope excluded; shared runtime leaves stay required", () => {
  const sbom = buildSbom(fixture, { licenses, timestamp: "2026-10-17T00:00:00.000Z" });
  assert.equal(sbom.components.find((c) => c.name === "dev-only-tool").scope, "excluded");
  assert.equal(sbom.components.find((c) => c.name === "shared-leaf").scope, "required");
  assert.equal(sbom.components.filter((c) => c.name === "shared-leaf").length, 1, "deduplicated by purl");
  assert.equal(sbom.components.find((c) => c.name === "local-link"), undefined, "workspace links are not third-party components");
});

test("[SPEC-14.sbom] license expressions and non-SPDX licenses stay schema-valid", () => {
  assert.deepEqual(licenseEntry("(MIT OR Apache-2.0)"), [{ expression: "(MIT OR Apache-2.0)" }]);
  assert.deepEqual(licenseEntry("SEE LICENSE IN LICENSE.md"), [{ license: { name: "SEE LICENSE IN LICENSE.md" } }]);
  assert.equal(licenseEntry("UNKNOWN"), undefined);
});

test("[OPS-06] output is deterministic for the same input and timestamp", () => {
  const a = buildSbom(fixture, { licenses, timestamp: "2026-10-17T00:00:00.000Z" });
  const b = buildSbom(structuredClone(fixture), { licenses, timestamp: "2026-10-17T00:00:00.000Z" });
  assert.deepEqual(a, b);
});

test("[SPEC-14.sbom] rejects input that is not pnpm list output", () => {
  assert.throws(() => buildSbom({}), /SBOM_INPUT_INVALID/);
});

test("[SPEC-14.sbom] real workspace: every component has a version and a pkg:npm purl", { skip: process.env.VSP_SBOM_REAL !== "1" }, () => {
  const out = execFileSync("pnpm", ["list", "-r", "--json", "--depth", "Infinity"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const sbom = buildSbom(JSON.parse(out), { timestamp: "2026-10-17T00:00:00.000Z" });
  assert.ok(sbom.components.length > 10);
  for (const c of sbom.components) {
    assert.match(c.purl, /^pkg:npm\/.+@.+/);
    assert.ok(c.version);
  }
});
