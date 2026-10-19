/**
 * Self-tests of the Layer-2 harness (FO-16-23): unit fakes cannot be imported by Layer-2 tests, every
 * fragment of the composition follows the conventions the reports rely on (digest-pinned images,
 * loopback-only ports, emulation labels, classified volumes, no literal credentials), and the JSON
 * report carries the emulation labels of each test.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, onTestFinished } from "vitest";
import YAML from "yaml";
import { uniqueName } from "./clients.js";
import { PLATFORM_ROOT, REPO_ROOT } from "./env.js";
import { layer2 } from "./layer2.js";
import { unitFakeMatch } from "./no-unit-fakes.js";
import { scratchDir } from "./scratch.js";

const harnessOnly = layer2.withoutServices("self-test of the Layer-2 harness and the compose fragments; no emulator involved");
const COMPOSE_DIR = join(REPO_ROOT, "deploy", "local");

/**
 * Writes one probe test file into a throwaway guard-probe-* directory of the harness and runs it in a
 * separate vitest process with the Layer-2 config. VSP_LAYER2_PROBE=1 makes that config see probe
 * files only; regular runs exclude them, so a probe left behind by an interrupted run is inert.
 */
function runProbe(fileName: string, body: string, reportDir = ""): SpawnSyncReturns<string> {
  const dir = join(PLATFORM_ROOT, "test", "integration", "_harness", uniqueName("guard-probe"));
  mkdirSync(dir);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, fileName);
  writeFileSync(file, body);
  return spawnSync(process.execPath, [join(PLATFORM_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.integration.config.ts", file], {
    cwd: PLATFORM_ROOT,
    env: { ...process.env, VSP_INTEGRATION: "1", VSP_LAYER2_PROBE: "1", VSP_TEST_REPORT_DIR: reportDir },
    encoding: "utf8",
    timeout: 120_000,
  });
}

interface ComposeService {
  image?: string;
  ports?: (string | { host_ip?: string })[];
  labels?: Record<string, string>;
  environment?: Record<string, string>;
}

function fragments(): { file: string; doc: { services?: Record<string, ComposeService>; volumes?: Record<string, { labels?: Record<string, string> } | null> } }[] {
  const files = [join(COMPOSE_DIR, "compose.yaml"), ...readdirSync(join(COMPOSE_DIR, "services")).filter((f) => f.endsWith(".compose.yaml")).map((f) => join(COMPOSE_DIR, "services", f))];
  return files.map((file) => ({ file, doc: (YAML.parse(readFileSync(file, "utf8")) ?? {}) as never }));
}

describe("Layer-2 harness guards", () => {
  harnessOnly("[FO-16-23] a run-time import of PGlite from a Layer-2 test is refused; production modules load", async () => {
    // Static imports are refused at transform time (next test). Bare specifiers resolved at run time
    // pass the same hook. Computed relative specifiers resolved by the module runner itself do not,
    // which is why the static check is the guard a test author meets.
    const load = (specifier: string) => import(/* @vite-ignore */ specifier);
    await expect(load("@electric-sql/pglite")).rejects.toThrow(/UNIT_FAKE_IN_LAYER2/);
    await expect(load("../../../src/db/pg.js")).resolves.toHaveProperty("PgPoolDb");
    expect(unitFakeMatch("/repo/platform/src/adapters/local/oidc-fixture.ts")).toMatch(/LOCAL FIXTURE/);
    expect(unitFakeMatch("/repo/platform/src/db/testing.ts")).toMatch(/test helpers/);
    expect(unitFakeMatch("/repo/platform/src/identity/kv/memory-kv-store.ts")).toMatch(/in-memory/);
    expect(unitFakeMatch("/repo/platform/src/fixtures/synthetic-world.ts")).toMatch(/fixtures/);
    expect(unitFakeMatch("/repo/platform/src/audit/sinks/s3-object-lock.ts")).toBeNull();
  });

  harnessOnly("[FO-16-23] a Layer-2 test file that statically imports a unit fake fails to load (separate vitest run)", () => {
    const r = runProbe(
      "probe.test.ts",
      'import { it } from "vitest";\nimport { MemoryPublisherFixture } from "../../../../src/outbox/memory-publisher.fixture.js";\nit("never runs", () => void MemoryPublisherFixture);\n',
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/UNIT_FAKE_IN_LAYER2: \.\.\/\.\.\/\.\.\/\.\.\/src\/outbox\/memory-publisher\.fixture\.js/);
  });

  harnessOnly("[FO-16-23] a Layer-2 test that does not declare its services through layer2() fails (separate vitest run)", () => {
    const r = runProbe("unlabelled.test.ts", 'import { expect, it } from "vitest";\nit("plain vitest test without emulation labels", () => { expect(1).toBe(1); });\n');
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/LAYER2_UNLABELLED/);
  });

  harnessOnly("[FO-16-23] a Layer-2 test that declares a service the composition does not run fails with SERVICE_NOT_RUNNING; it is never skipped or passed (separate vitest run)", () => {
    const reports = scratchDir("vsp-it-probe-reports-");
    const r = runProbe(
      "missing-service.test.ts",
      'import { expect } from "vitest";\nimport { layer2 } from "../layer2.js";\nconst it = layer2(["no-such-service"]);\nit("needs a service that is not running", () => { expect(1).toBe(1); });\n',
      reports,
    );
    expect(r.status).not.toBe(0);
    const output = `${r.stdout}${r.stderr}`;
    expect(output).toMatch(/SERVICE_NOT_RUNNING: no-such-service not running in compose project/);
    expect(output).not.toMatch(/LAYER2_UNLABELLED/);
    const report = JSON.parse(readFileSync(join(reports, "vitest-integration.json"), "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({ numTotalTests: 1, numFailedTests: 1, numPassedTests: 0, numPendingTests: 0, numTodoTests: 0, success: false });
    const emulation = JSON.parse(readFileSync(join(reports, "vitest-integration.emulation.json"), "utf8")) as { tests: { state: string; emulated: string[]; unavailableServices: string[] }[] };
    expect(emulation.tests).toEqual([expect.objectContaining({ state: "failed", emulated: [], unavailableServices: ["no-such-service"] })]);
  });

  harnessOnly("[FO-16-23] a probe directory left behind by an interrupted run is not part of a regular Layer-2 run", () => {
    const dir = join(PLATFORM_ROOT, "test", "integration", "_harness", uniqueName("guard-probe"));
    mkdirSync(dir);
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "leftover.test.ts"), 'import { it } from "vitest";\nit("leftover probe", () => { throw new Error("must not run"); });\n');
    const r = spawnSync(process.execPath, [join(PLATFORM_ROOT, "node_modules", "vitest", "vitest.mjs"), "list", "--config", "vitest.integration.config.ts", "--filesOnly", "--json"], {
      cwd: PLATFORM_ROOT,
      env: { ...process.env, VSP_INTEGRATION: "1", VSP_TEST_REPORT_DIR: "" },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const files = (JSON.parse(r.stdout) as { file: string }[]).map((f) => f.file);
    expect(files.some((f) => f.endsWith("_harness/guards.test.ts"))).toBe(true);
    expect(files.filter((f) => f.includes("guard-probe-"))).toEqual([]);
  });

  harnessOnly("[FO-16-23][FO-16-01] every compose service is digest-pinned, loopback-bound, labelled with what it emulates, and takes credentials only from the generated state", () => {
    const services = fragments().flatMap(({ file, doc }) => Object.entries(doc.services ?? {}).map(([name, svc]) => ({ file, name, svc })));
    expect(services.length).toBeGreaterThanOrEqual(12);
    for (const { name, svc } of services) {
      expect(svc.image, name).toMatch(/^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
      for (const p of svc.ports ?? []) {
        if (typeof p === "string") expect(p, name).toMatch(/^127\.0\.0\.1:/);
        else expect(p.host_ip, name).toBe("127.0.0.1");
      }
      for (const label of ["io.vsp.emulates", "io.vsp.protocol", "io.vsp.not-emulated", "io.vsp.licence"]) expect(svc.labels?.[label], `${name} ${label}`).toBeTruthy();
      for (const [key, value] of Object.entries(svc.environment ?? {})) {
        if (/PASSWORD|SECRET|_KEYS?$|ACCESS_KEY|AUTH$/.test(key)) expect(String(value), `${name} ${key}`).toMatch(/^\$\{VSP_[A-Z_]+(:\?[^}]*)?\}/);
      }
    }
  });

  harnessOnly("[FO-19-64] every named volume declares its data class so down can protect audit evidence", () => {
    const volumes = fragments().flatMap(({ doc }) => Object.entries(doc.volumes ?? {}));
    expect(volumes.length).toBeGreaterThan(0);
    for (const [name, v] of volumes) expect(v?.labels?.["io.vsp.data-class"], name).toMatch(/^(audit|operational|cache|ephemeral)$/);
    expect(volumes.filter(([, v]) => v?.labels?.["io.vsp.data-class"] === "audit").map(([n]) => n).sort()).toEqual(["minio-data", "postgres-data"]);
  });

  harnessOnly("[FO-16-23] a Layer-2 test records its layer and labels in the test meta that the JSON report carries", ({ task }) => {
    expect(task.meta.layer).toBe("L2");
    expect(task.meta.noEmulatorReason).toMatch(/self-test/);
  });

  layer2(["postgres"])("[FO-16-23] a service test's meta carries its compose service's labels: what it stands in for, the protocol and what it does not prove", ({ task }) => {
    const pg = fragments()
      .flatMap(({ doc }) => Object.entries(doc.services ?? {}))
      .find(([name]) => name === "postgres")?.[1];
    expect(pg?.labels?.["io.vsp.emulates"] && pg.labels["io.vsp.not-emulated"] && pg.labels["io.vsp.protocol"], "core.compose.yaml labels postgres").toBeTruthy();
    expect(task.meta.layer).toBe("L2");
    expect(task.meta.emulated).toEqual([
      {
        service: "postgres",
        image: pg?.image,
        emulates: pg?.labels?.["io.vsp.emulates"],
        protocol: pg?.labels?.["io.vsp.protocol"],
        notEmulated: pg?.labels?.["io.vsp.not-emulated"],
      },
    ]);
  });
});
