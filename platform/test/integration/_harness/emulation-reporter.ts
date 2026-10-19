/**
 * Emulation summary for the Layer-2 report (FO-16-23, ADR-0018 decision 6.2): which emulated
 * services each test used, what each service stands in for and what it does not prove. Printed at
 * the end of the run and, with VSP_TEST_REPORT_DIR set, written to
 * <dir>/vitest-integration.emulation.json next to vitest-integration.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import type { EmulationLabel } from "./discovery.js";

interface ServiceSummary {
  label: EmulationLabel;
  tests: number;
  passed: number;
  failed: number;
}

export default class EmulationReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const services = new Map<string, ServiceSummary>();
    const tests: { file: string; name: string; state: string; emulated: string[]; noEmulatorReason: string | null; realLocal: string[]; unavailableServices: string[] }[] = [];
    for (const mod of testModules) {
      for (const t of mod.children.allTests()) {
        const meta = t.meta();
        const state = t.result().state;
        const emulated = meta.emulated ?? [];
        tests.push({
          file: relative(process.cwd(), mod.moduleId),
          name: t.fullName,
          state,
          emulated: emulated.map((e) => e.service),
          noEmulatorReason: meta.noEmulatorReason ?? null,
          realLocal: meta.realLocal ?? [],
          unavailableServices: meta.unavailableServices ?? [],
        });
        for (const e of emulated) {
          const s = services.get(e.service) ?? { label: e, tests: 0, passed: 0, failed: 0 };
          s.tests += 1;
          if (state === "passed") s.passed += 1;
          if (state === "failed") s.failed += 1;
          services.set(e.service, s);
        }
      }
    }
    const summary = {
      schema: "vsp.layer2-emulation.v1",
      layer: "L2",
      note: "Production adapters over real protocols against local emulators. Behaviour listed under notEmulated is not proven here and stays NOT_RUN until a sandbox qualification (Layer 5).",
      services: [...services.values()].sort((a, b) => a.label.service.localeCompare(b.label.service)),
      tests,
    };
    const lines = ["", "Layer-2 emulation summary (service: tests passed/failed -> stands in for):"];
    for (const s of summary.services) lines.push(`  EMULATED ${s.label.service}: ${s.passed}/${s.tests} passed, ${s.failed} failed -> ${s.label.emulates}`);
    const without = tests.filter((t) => t.noEmulatorReason);
    if (without.length > 0) lines.push(`  ${without.length} test(s) use no emulator (process-level checks; reasons in the JSON summary)`);
    const unavailable = tests.filter((t) => t.unavailableServices.length > 0);
    if (unavailable.length > 0) lines.push(`  ${unavailable.length} test(s) FAILED because a declared service was not running or healthy: ${[...new Set(unavailable.flatMap((t) => t.unavailableServices))].join(", ")}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    const dir = process.env.VSP_TEST_REPORT_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "vitest-integration.emulation.json"), `${JSON.stringify(summary, null, 2)}\n`);
    }
  }
}
