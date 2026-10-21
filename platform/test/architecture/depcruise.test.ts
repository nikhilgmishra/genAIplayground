/**
 * dependency-cruiser rules generated from the module register (WP-06; FO-03-11; OPS-04): the repository
 * cruises clean, and a synthetic tree with one violation of each kind fails with the expected rule. The
 * rules come from .dependency-cruiser.cjs, which reads platform/architecture/modules.yaml at load time.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cruise, type IConfiguration, type ICruiseResult } from "dependency-cruiser";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { REPO, readRepoFile, type RegisterDoc } from "./support.js";

const config = createRequire(import.meta.url)(join(REPO, ".dependency-cruiser.cjs")) as IConfiguration;
const doc = YAML.parse(readRepoFile(REPO, "platform/architecture/modules.yaml")) as RegisterDoc;
const probeRoots: string[] = [];
afterAll(() => {
  for (const r of probeRoots) rmSync(r, { recursive: true, force: true });
});

async function run(baseDir: string, dirs: string[]): Promise<ICruiseResult> {
  const out = await cruise(dirs, { ...config.options, ruleSet: config, validate: true, baseDir });
  return out.output as ICruiseResult;
}

const violations = (r: ICruiseResult) => r.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();

describe("dependency-cruiser module rules [FO-03-11]", () => {
  it("[FO-03-11] there is one rule per bounded module, plus undeclared, package-root, entry-point and decision-gate rules", () => {
    const names = (config.forbidden ?? []).map((r) => r.name);
    expect(names.filter((n) => n?.startsWith("module-") && !["module-undeclared", "module-target-undeclared", "module-package-root-import"].includes(n))).toHaveLength(doc.modules.filter((m) => !(m.allow ?? []).includes("*")).length);
    expect(names).toEqual(expect.arrayContaining(["module-undeclared", "module-target-undeclared", "module-package-root-import", "entry-point-live-container", "entry-point-live-modules", "entry-point-server", "entry-point-main"]));
    expect(names.filter((n) => n?.startsWith("decision-gate-")).sort()).toEqual(doc.decisionGates.filter((g) => g.decision === null).map((g) => `decision-gate-${g.id}`).sort());
  });

  it("[FO-03-11][OPS-04] the repository's TypeScript roots cruise with zero violations", async () => {
    const dirs = ["platform/src", "console/src", "media/src", "companion/src"].filter((d) => existsSync(join(REPO, d)));
    const r = await run(REPO, dirs);
    expect(r.summary.totalCruised).toBeGreaterThan(600);
    expect(violations(r)).toEqual([]);
  }, 60_000);

  it("[FO-03-11][OPS-04][FO-03-25] adversarial probe tree: each kind of violation fails with its rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "vsp-depcruise-"));
    probeRoots.push(root);
    const files: Record<string, string> = {
      "platform/src/actions/action-service.ts": "export const a = 1;\n",
      "platform/src/harness/probe.ts": 'import { a } from "../actions/action-service.js";\nexport const h = a;\n',
      "platform/src/fixtures/world.ts": "export const w = 1;\n",
      "platform/src/policy/engine.ts": 'import { w } from "../fixtures/world.js";\nexport const p = w;\n',
      "platform/src/main/live-container.ts": 'import { p } from "../policy/engine.js";\nexport const c = p;\n',
      "platform/src/connectors/http/transport.ts": "export const t = 1;\n",
      "platform/src/models/ok.ts": 'import { t } from "../connectors/http/transport.js";\nexport const m = t;\n',
      "platform/src/models/gate.ts": 'import { EventBridgeClient } from "@aws-sdk/client-eventbridge";\nexport const e = EventBridgeClient;\n',
      "platform/src/unknownmod/x.ts": "export const u = 1;\n",
      "platform/src/shared/tgt.ts": 'import { u } from "../unknownmod/x.js";\nexport const z = u;\n',
      "platform/src/adapters/local/fx.ts": "export const l = 1;\n",
      "platform/src/adapters/live/bad.ts": 'import { l } from "../local/fx.js";\nexport const lv = l;\n',
      "platform/src/harness/probe.test.ts": 'import { a } from "../actions/action-service.js";\nexport const ok = a;\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const r = await run(root, ["platform/src"]);
    expect(violations(r)).toEqual(
      [
        "decision-gate-eventbridge-fanout: platform/src/models/gate.ts -> @aws-sdk/client-eventbridge",
        "entry-point-live-container: platform/src/main/live-container.ts -> platform/src/fixtures/world.ts",
        "module-adapters-live: platform/src/adapters/live/bad.ts -> platform/src/adapters/local/fx.ts",
        "module-harness: platform/src/harness/probe.ts -> platform/src/actions/action-service.ts",
        "module-shared: platform/src/shared/tgt.ts -> platform/src/unknownmod/x.ts",
        "module-target-undeclared: platform/src/shared/tgt.ts -> platform/src/unknownmod/x.ts",
      ].sort(),
    );
  }, 60_000);
});
