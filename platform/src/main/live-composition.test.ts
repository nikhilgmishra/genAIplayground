/**
 * Live composition root, Docker-free part (WP-07; FO-16-11, FO-19-06, FO-21-10, FO-14-53, FO-00-26). The
 * composition over the emulators is platform/test/integration/composition/.
 *
 *  - refusals that happen before any client, pool or port exists (offline environments, sandbox-only network
 *    overrides, missing infrastructure, endpoint overrides outside sandbox);
 *  - a static scan of every live composition source: no BLOCKED stub, no not-implemented refusal, no canned
 *    success, no TEST identifier, and the old wholesale refusal of non-local composition is gone.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR, REPO_ROOT } from "../config/loader.js";
import { PgPoolDb } from "../db/pg.js";
import { createMemoryLogger } from "../observability/logger.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { buildLiveContainer } from "./live-container.js";
import { statusOf } from "../gateway/tools/routing.js";

const PLATFORM = join(REPO_ROOT, "platform");
const notBuilt = () => {
  throw new Error("BUSINESS_MUST_NOT_BE_BUILT");
};
const rejection = async (p: Promise<unknown>): Promise<ConfigurationRejectedError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ConfigurationRejectedError);
  return e as ConfigurationRejectedError;
};

let tmp: string | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("live composition: refusals before any resource exists [FO-19-06][FO-14-53]", () => {
  it("[FO-00-36][FO-22-21] local and ci are the regression composition's: the live root refuses them", async () => {
    for (const environment of ["local", "ci"] as const) {
      expect((await rejection(buildLiveContainer({ environment, buildBusiness: notBuilt, env: {} }))).violations).toEqual(["LIVE_COMPOSITION_OFFLINE_ENVIRONMENT@environment"]);
    }
  });

  it("[FO-14-53] a network override (resolver / extra CA) is refused outside sandbox", async () => {
    for (const environment of ["staging", "production"] as const) {
      const err = await rejection(buildLiveContainer({ environment, buildBusiness: notBuilt, env: {}, network: { tlsCa: ["-----BEGIN CERTIFICATE-----"] } }));
      expect(err.violations).toEqual(["NETWORK_OVERRIDE_OUTSIDE_SANDBOX@network"]);
    }
  });

  it("[FO-19-06][OPS-04] the committed configurations (no infrastructure yet) are refused before any database pool exists, and the business module is never built", async () => {
    const pool = vi.spyOn(PgPoolDb, "fromConnectionString");
    const { logger } = createMemoryLogger();
    for (const environment of ["sandbox", "staging", "production"] as const) {
      const err = await rejection(buildLiveContainer({ environment, buildBusiness: notBuilt, env: {}, logger }));
      expect(err.violations).toEqual(["INFRASTRUCTURE_NOT_CONFIGURED@infrastructure"]);
    }
    expect(pool).not.toHaveBeenCalled();
  });

  it("[FO-14-53] adversarial: production with AWS endpoint overrides is refused by the client factory itself (defence in depth behind the guard)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "vsp-live-config-"));
    cpSync(CONFIG_DIR, tmp, { recursive: true });
    const file = join(tmp, "production.json");
    const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    cfg.infrastructure = {
      aws: { region: "us-east-1", endpointOverrides: { dynamodb: "http://localhost:8000", sqs: null, s3: null, kms: null, secretsManager: null, sts: null }, s3ForcePathStyle: false },
      privateNetworkHosts: [],
      outbox: null,
      routeAuditJournalTable: null,
      auditSink: null,
      auditExport: null,
      secrets: { requestHashPepperRef: null, otpPepperRef: null, consoleSessionSealerRef: null },
      ingressPayloadKeyId: null,
    };
    writeFileSync(file, JSON.stringify(cfg));
    const pool = vi.spyOn(PgPoolDb, "fromConnectionString");
    const err = await rejection(buildLiveContainer({ environment: "production", buildBusiness: notBuilt, env: {}, configDir: tmp }));
    expect(err.violations).toEqual(["INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN@infrastructure.aws.endpointOverrides"]);
    expect(pool).not.toHaveBeenCalled();
  });
});

/**
 * Every live composition source: the live entry points and their building blocks, the gateway and console
 * entry points, the live worker loops and runtime, the capability gate, and EVERY file of adapters/live (no file
 * is skipped by its name; the BLOCKED stubs are scanned too and their hits are allowlisted below with a reason).
 */
const LIVE_SOURCES = [
  ...readdirSync(join(PLATFORM, "src/main"))
    .filter((f) => /^live-[a-z-]+\.ts$/.test(f) && !f.endsWith(".test.ts"))
    .map((f) => `src/main/${f}`),
  "src/main/server.ts",
  "src/main/audit-exporter.ts",
  "src/main/capabilities.ts",
  "src/worker/live-loops.ts",
  "src/worker/loop-kit.ts",
  "src/worker/runtime.ts",
  "src/ops/capability-gate.ts",
  // The routing tools answer over the telephony guard port in every live environment of this build (SAFE-04).
  "src/gateway/tools/routing.ts",
  ...readdirSync(join(PLATFORM, "src/adapters/live"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".fixture.ts"))
    .map((f) => `src/adapters/live/${f}`),
];
const read = (rel: string) => readFileSync(join(PLATFORM, rel), "utf8");
/** Source without comments, line structure kept (the scan is about code, not about the documentation). */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Literal canned answers: an empty list, null, an empty object, a bare success, a function answering one. */
const CANNED: readonly RegExp[] = [/return\s+\[\]\s*;/, /return\s+null\s*;/, /return\s+\{\s*\}\s*;/, /\{\s*ok:\s*true\s*\}/, /=>\s*null\b/, /=>\s*\[\]/, /=>\s*\(\{\s*\}\)/];

/**
 * Reviewed canned-literal lines (file: code line, trimmed) and why each is not a canned answer. A new literal
 * anywhere in a live source fails the scan until it is reviewed here; a reviewed line that disappears fails too
 * (the list cannot go stale).
 */
const REVIEWED_CANNED: Readonly<Record<string, string>> = {
  "src/main/live-container.ts: return [];": "tool-name metric labels only: an unreadable pinned catalogue collapses them to `other`; the unit is refused by the catalogue drift check",
  "src/main/live-modules.ts: return null;": "null IS the guard input TOOL_CATALOG_NOT_LOADED (fail closed in the full rule set)",
  "src/main/live-worker.ts: if (feeds.length === 0) return [];": "no feed configured composes no feed loop; connectors.runtime is NOT_CONFIGURED in the activation map",
  "src/worker/live-loops.ts: await this.dedup.processOnceForTenant(tenantId, consumerName, messageId, async () => null);": "the dedup marker transaction has no statement of its own; the effect ran (and succeeded) before",
  "src/worker/loop-kit.ts: await this.dedup.processOnceForTenant(tenantId, consumerName, m.messageId, async () => null);": "same dedup marker in the shared consumer loop",
  "src/worker/loop-kit.ts: const pending = await this.job.pendingVendorDeletions().catch(() => null);": "gauge refresh only: a failed read leaves the last gauge value; the retention run reports its own outcome",
  "src/ops/capability-gate.ts: if (!intent) return null;": "gate predicate: no intent, no capability to refuse (not a port answer)",
  "src/ops/capability-gate.ts: return null;": "gate predicate: no NOT_CONFIGURED capability blocks the intent",
  "src/adapters/live/oidc-client.ts: if (claim === null) return null;": "no groups claim configured: absent, and the verifier then grants no role",
  "src/adapters/live/oidc-client.ts: if (!Array.isArray(v) || v.length > 128 || !v.every((g) => typeof g === \"string\" && g.length >= 1 && g.length <= 256)) return null;": "a malformed groups claim counts as absent (no role), never as a group",
  "src/adapters/live/pg-transfer-store.ts: if (!OPAQUE.test(handoffId)) return null;": "an id that cannot exist is not found (no query with an unvalidated id)",
  "src/adapters/live/pg-transfer-store.ts: if (!OPAQUE.test(transferId)) return null;": "same for a transfer id",
  "src/adapters/live/pg-transfer-store.ts: if (tenantId !== this.tenantId) return [];": "another tenant's journeys are invisible (the RLS answer, without a query)",
  "src/adapters/live/salesforce-rest-support-records.ts: if (v === null || !/^\\d{1,6}$/.test(v.trim())) return null;": "Retry-After header absent or not seconds: no server-advised delay",
  "src/adapters/live/salesforce-rest-support-records.ts: if (res === null) return null;": "the vendor answered 404 for the external id: the record does not exist",
  "src/adapters/live/salesforce-rest-support-records.ts: return null;": "HTTP 404 of the by-external-id read, recorded as a successful lookup",
};

describe("live composition sources: no stub, no canned result [FO-21-10][FO-00-26]", () => {
  it("[FO-21-10] no live source returns canned success, a TEST id, an empty history or a not-implemented refusal", () => {
    const forbidden: [RegExp, string][] = [
      [/NOT_IMPLEMENTED|NotImplemented|notImplemented/, "not-implemented"],
      [/\bTEST_[A-Z]|_TESTONLY|apr_TESTONLY|\btest_only\b/i, "TEST id"],
      [/BLOCKED_CAPABILITY_UNVERIFIED|createBlockedLiveRegistry|BlockedLiveAdapter/, "blocked stub"],
      [/console\.log\(/, "log-only implementation"],
    ];
    // Reviewed exceptions: the BLOCKED stub files are not composed (next test) and stay only because the
    // adapters module's exports and inventory (WP-06 files) still list them; the Salesforce adapter keeps its
    // BLOCKED schema mode for the regression and contract tests and is composed with a PROVIDED schema only.
    const allowed = new Set([
      "src/adapters/live/salesforce-rest-support-records.ts: blocked stub",
      "src/adapters/live/blocked-base.ts: blocked stub",
      "src/adapters/live/blocked-set.ts: blocked stub",
      "src/adapters/live/business-systems-blocked.ts: blocked stub",
      "src/adapters/live/talkdesk-blocked.ts: blocked stub",
    ]);
    const hits: string[] = [];
    for (const rel of LIVE_SOURCES) for (const [re, what] of forbidden) if (re.test(code(rel)) && !allowed.has(`${rel}: ${what}`)) hits.push(`${rel}: ${what}`);
    expect(hits).toEqual([]);
    const live = code("src/main/live-container.ts");
    expect(live).toMatch(/schema: \{ status: "PROVIDED"/);
    expect(live).not.toMatch(/status: "BLOCKED"|status: "EMULATED_CONTRACT_TEST"/);
    expect(LIVE_SOURCES).toEqual(expect.arrayContaining(["src/main/live-console.ts", "src/main/server.ts", "src/adapters/live/blocked-set.ts", "src/adapters/live/not-configured.ts", "src/gateway/tools/routing.ts"]));
  });

  it("[FO-21-10][SAFE-04] the routing tools never claim a transfer for a journey without a reachable route (no canned TRANSFER_REQUESTED)", () => {
    // Every journey shape a NOT_CONFIGURED telephony port leaves behind, and the in-flight shape as the control.
    expect(statusOf(null)).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
    expect(statusOf({ status: "ROUTING", connectedAt: null, awaitingRetry: true })).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
    expect(statusOf({ status: "HOLDING_FOR_OPERATIONS", connectedAt: null, awaitingRetry: false })).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
    expect(statusOf({ status: "ROUTING", connectedAt: null, awaitingRetry: false })).toBe("TRANSFER_REQUESTED");
    // The status is computed, never a literal answer of the tool bodies.
    expect(code("src/gateway/tools/routing.ts")).not.toMatch(/status:\s*"TRANSFER_REQUESTED"/);
  });

  it("[FO-21-10] every literal canned answer (empty list, null, empty object, bare ok, a function answering one) in a live source is a reviewed line; the review list has no stale entry", () => {
    const found = new Map<string, number>();
    for (const rel of LIVE_SOURCES) {
      for (const line of code(rel).split("\n")) {
        if (!CANNED.some((re) => re.test(line))) continue;
        const key = `${rel}: ${line.trim()}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
    const unreviewed = [...found.keys()].filter((k) => !Object.hasOwn(REVIEWED_CANNED, k));
    expect(unreviewed).toEqual([]);
    const stale = Object.keys(REVIEWED_CANNED).filter((k) => !found.has(k));
    expect(stale).toEqual([]);
    // The call-session resolver's integration identity is a guard operation, never a canned null.
    expect(code("src/main/live-container.ts")).not.toMatch(/integration:\s*async\s*\(\)\s*=>/);
    // A mutant that reintroduces a canned answer is caught (the scan sees it).
    const mutant = "    const callSessions = new InteractionIndexCallSessions({ lookup, sessions, integration: async () => null });";
    expect(CANNED.some((re) => re.test(mutant))).toBe(true);
  });

  it("[FO-00-26][FO-16-11] no composition imports the BLOCKED stubs, and the wholesale refusal of non-local composition is gone", () => {
    const compositions = ["src/main/container.ts", "src/main/live-container.ts", "src/main/live-modules.ts", "src/main/live-worker.ts", "src/main/server.ts", "src/main/console.ts", "src/main/local.ts", "src/main/audit-exporter.ts", "src/worker/main.ts", "src/worker/worker.ts", "src/worker/live-loops.ts"];
    for (const rel of compositions) expect(read(rel), rel).not.toMatch(/adapters\/live\/(blocked-set|blocked-base|business-systems-blocked|talkdesk-blocked)\.js/);
    for (const dir of ["src/main", "src/config"]) {
      for (const f of readdirSync(join(PLATFORM, dir), { recursive: true }) as string[]) {
        if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
        expect(read(`${dir}/${f}`), `${dir}/${f}`).not.toContain("LIVE_COMPOSITION_NOT_IMPLEMENTED");
      }
    }
  });
});
