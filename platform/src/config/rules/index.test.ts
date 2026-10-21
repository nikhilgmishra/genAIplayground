/**
 * Registry completeness of the guard's rule files (WP-07; OPS-04): every file of platform/src/config/rules/ is
 * either a registered rule or a declared helper, so a rule can never be added without running.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_CAPABILITY_IDS } from "../../observability/composition-catalog.js";
import { ADAPTER_CAPABILITY, GUARD_RULES, RULE_HELPER_FILES } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("guard rule registry [OPS-04]", () => {
  it("[OPS-04] every rule file is registered (or a declared helper); ids and files are unique; each rule applies somewhere", () => {
    const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
    const ruleFiles = GUARD_RULES.map((r) => r.file);
    expect([...new Set([...ruleFiles, ...RULE_HELPER_FILES])].sort()).toEqual(files);
    expect(new Set(GUARD_RULES.map((r) => r.id)).size).toBe(GUARD_RULES.length);
    expect(new Set(ruleFiles).size).toBe(ruleFiles.length);
    for (const r of GUARD_RULES) expect(r.ruleSets.length, r.id).toBeGreaterThan(0);
    for (const set of ["offline", "sandbox", "full"] as const) expect(GUARD_RULES.some((r) => r.ruleSets.includes(set)), set).toBe(true);
  });

  it("[OPS-04] adversarial: the registry is frozen (a rule cannot be dropped or injected at run time)", () => {
    expect(Object.isFrozen(GUARD_RULES)).toBe(true);
    expect(() => (GUARD_RULES as unknown as unknown[]).pop()).toThrow();
    expect(Object.isFrozen(ADAPTER_CAPABILITY)).toBe(true);
  });

  it("[FO-00-30] every adapter capability is a runtime capability id", () => {
    for (const cap of Object.values(ADAPTER_CAPABILITY)) expect(RUNTIME_CAPABILITY_IDS).toContain(cap);
  });
});
