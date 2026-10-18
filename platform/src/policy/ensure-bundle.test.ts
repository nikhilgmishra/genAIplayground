import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./engine.js";
import { PolicyBundleBuildError, bundleStatus, computeSourcesDigest, ensurePolicyBundle, policySourceFiles } from "./ensure-bundle.js";

const roots: string[] = [];
let previousOpaBin: string | undefined;

beforeAll(() => {
  previousOpaBin = process.env.OPA_BIN;
  process.env.OPA_BIN = join(REPO_ROOT, ".tools", "opa");
});
afterAll(() => {
  if (previousOpaBin === undefined) delete process.env.OPA_BIN;
  else process.env.OPA_BIN = previousOpaBin;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "vsp-ensure-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO_ROOT, "scripts", "policy.sh"), join(root, "scripts", "policy.sh"));
  mkdirSync(join(root, "policy"));
  cpSync(join(REPO_ROOT, "policy", "vsp"), join(root, "policy", "vsp"), { recursive: true });
  for (const f of ["VERSION", "wasm-capabilities.json"]) copyFileSync(join(REPO_ROOT, "policy", f), join(root, "policy", f));
  return root;
}

describe("ensurePolicyBundle (test helper)", () => {
  it("[OPS-06] the TypeScript sources digest equals scripts/policy.sh digest", () => {
    const fromScript = execFileSync("bash", [join(REPO_ROOT, "scripts", "policy.sh"), "digest"]).toString("utf8").trim();
    expect(computeSourcesDigest()).toBe(fromScript);
    expect(policySourceFiles()).toEqual(expect.arrayContaining(["VERSION", "wasm-capabilities.json", "vsp/authz.rego", "vsp/console.rego", "vsp/data.json", "vsp/lib.rego"]));
    expect(policySourceFiles().some((f) => f.endsWith("_test.rego"))).toBe(false);
  });

  it("[OPS-06] builds when missing, skips when fresh, rebuilds when sources change", () => {
    const root = tempRepo();
    const policy = join(root, "policy");
    expect(bundleStatus(policy).reasonCode).toBe("BUNDLE_MISSING");
    const first = ensurePolicyBundle({ repoRoot: root });
    expect(first.rebuilt).toBe(true);
    expect(bundleStatus(policy)).toMatchObject({ fresh: true, reasonCode: "BUNDLE_FRESH" });
    expect(ensurePolicyBundle({ repoRoot: root }).rebuilt).toBe(false);

    appendFileSync(join(policy, "vsp", "lib.rego"), "\n# synthetic comment changes the sources digest\n");
    expect(bundleStatus(policy).reasonCode).toBe("BUNDLE_SOURCES_STALE");
    const second = ensurePolicyBundle({ repoRoot: root });
    expect(second.rebuilt).toBe(true);
    expect(second.sourcesDigest).not.toBe(first.sourcesDigest);
  });

  it("[OPS-06] test files do not affect the bundle sources digest", () => {
    const root = tempRepo();
    const before = computeSourcesDigest(join(root, "policy"));
    appendFileSync(join(root, "policy", "vsp", "lib_test.rego"), "\n# test-only change\n");
    expect(computeSourcesDigest(join(root, "policy"))).toBe(before);
  });

  it("[OPS-06] a tampered bundle digest file is detected as not fresh", () => {
    const root = tempRepo();
    ensurePolicyBundle({ repoRoot: root });
    writeFileSync(join(root, "policy", "build", "bundle.sha256"), `${"0".repeat(64)}  bundle.tar.gz\n`);
    expect(bundleStatus(join(root, "policy")).reasonCode).toBe("BUNDLE_DIGEST_FILE_MISMATCH");
  });

  it("[OPS-03] a Rego compile error fails the build loudly (no stale bundle is reported as fresh)", () => {
    const root = tempRepo();
    appendFileSync(join(root, "policy", "vsp", "authz.rego"), "\nbroken_rule if {\n");
    expect(() => ensurePolicyBundle({ repoRoot: root })).toThrow(PolicyBundleBuildError);
  });
});
