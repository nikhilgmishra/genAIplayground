/**
 * Composition-root tests. The deployed-environment cases use the COMMITTED
 * reviewed configuration files (platform/config/*.json); the local cases build
 * the LOCAL FIXTURE composition (PGlite, OPA WASM, SYNTHETIC data) and exercise
 * it through fastify.inject only (no sockets).
 */
import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBusiness } from "../business/index.js";
import { CALLS } from "../fixtures/synthetic-world.js";
import { LOCAL_FIXTURE_TOKENS } from "../gateway/auth.js";
import { CATALOG_FILE, loadPinnedCatalogFile } from "../gateway/catalog.js";
import { PgliteDb } from "../db/pglite.js";
import { createMemoryLogger } from "../observability/logger.js";
import { FakeClock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { buildContainer } from "./container.js";
import type { Container } from "./container.js";
import { STUB_TOOL_NAMES, createStubBusiness } from "./fixtures/stub-business.fixture.js";

const START = "2026-10-18T09:00:00.000Z";
let c: Container | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
  vi.restoreAllMocks();
});

const auth = (channel: keyof typeof LOCAL_FIXTURE_TOKENS) => ({ authorization: `Bearer ${LOCAL_FIXTURE_TOKENS[channel]}` });
const consent = (at: string) => ({ recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: at, capturedBy: "studio_flow" });

async function rejection(p: Promise<unknown>): Promise<ConfigurationRejectedError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConfigurationRejectedError) return e;
    throw e;
  }
  throw new Error("EXPECTED_CONFIGURATION_REJECTED");
}

async function startCall(container: Container, callId: string = CALLS.primary.callId): Promise<string> {
  const res = await container.app.inject({
    method: "POST",
    url: "/telephony/v1/calls",
    headers: auth("telephony_control"),
    payload: { callId, callerIdHash: null, consent: consent(container.clock.now().toISOString()) },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { sessionRef: string }).sessionRef;
}

async function mcpCall(container: Container, sessionRef: string | null, name: string, args: Record<string, unknown>) {
  const res = await container.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...auth("mcp_tools"), accept: "application/json, text/event-stream", "content-type": "application/json", ...(sessionRef ? { "x-vsp-session-ref": sessionRef } : {}) },
    payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { result: { structuredContent: { status: string; reasonCode: string | null; data: Record<string, unknown> | null } } }).result.structuredContent;
}

describe("composition root: deployed environments refuse (OPS-04)", () => {
  it("[OPS-04] buildContainer for committed production config throws ConfigurationRejectedError before binding any port", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const createDb = vi.spyOn(PgliteDb, "create");
    const stub = createStubBusiness();
    const build = vi.fn(stub.build);
    const { logger, records } = createMemoryLogger();
    const err = await rejection(buildContainer({ environment: "production", buildBusiness: build, clock: new FakeClock(START), env: {}, logger }));
    // The guard rejected the reviewed production file itself (not a later wiring failure).
    expect(err.violations.length).toBeGreaterThan(1);
    expect(err.violations.some((v) => v.startsWith("ADAPTER_LOCAL_FIXTURE@") || v.startsWith("APPROVAL_") || v.includes("PLACEHOLDER") || v.startsWith("TOOL_CATALOG_DIGEST_UNPINNED"))).toBe(true);
    expect(records.some((r) => r.event === "config.guard.rejected")).toBe(true);
    expect(listen).not.toHaveBeenCalled();
    expect(createDb).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("[OPS-04] staging and sandbox are refused too: the guard or the unavailable live composition, never a fixture fallback", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const createDb = vi.spyOn(PgliteDb, "create");
    for (const environment of ["staging", "sandbox"] as const) {
      const err = await rejection(buildContainer({ environment, buildBusiness: createStubBusiness().build, clock: new FakeClock(START), env: {}, logger: createMemoryLogger().logger }));
      expect(err.violations.length).toBeGreaterThan(0);
    }
    expect(listen).not.toHaveBeenCalled();
    expect(createDb).not.toHaveBeenCalled();
  });

  it("[OPS-04][OPS-06] an uncommitted (stub) catalogue is refused outside local/ci; locally the real business must match schemas/tools/catalog.json", async () => {
    const err = await rejection(buildContainer({ environment: "production", buildBusiness: createStubBusiness().build, allowUncommittedCatalog: true, env: {}, logger: createMemoryLogger().logger }));
    expect(err.violations).toEqual(["UNCOMMITTED_CATALOG_OUTSIDE_LOCAL_CI@toolCatalog"]);
    const drift = await rejection(buildContainer({ environment: "local", buildBusiness: createStubBusiness().build, clock: new FakeClock(START), env: {}, ingestKnowledge: false, logger: createMemoryLogger().logger }));
    expect(drift.violations).toEqual(["TOOL_CATALOG_DRIFT@schemas/tools/catalog.json"]);
  }, 60_000);

  it("[OPS-06] a configured toolCatalog.expectedDigest that differs from the committed catalogue is refused before any database exists", async () => {
    const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { CONFIG_DIR } = await import("../config/loader.js");
    const dir = mkdtempSync(join(tmpdir(), "vsp-config-"));
    try {
      cpSync(CONFIG_DIR, dir, { recursive: true });
      const file = join(dir, "local.json");
      const cfg = JSON.parse(readFileSync(file, "utf8")) as { toolCatalog: { expectedDigest: string | null } };
      cfg.toolCatalog.expectedDigest = "0".repeat(64);
      writeFileSync(file, JSON.stringify(cfg));
      const createDb = vi.spyOn(PgliteDb, "create");
      const err = await rejection(buildContainer({ environment: "local", buildBusiness, configDir: dir, env: {}, logger: createMemoryLogger().logger }));
      expect(err.violations).toEqual(["TOOL_CATALOG_DIGEST_MISMATCH@toolCatalog.expectedDigest"]);
      expect(createDb).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("[SPEC-12.write-fence] VSP_MUTATIONS_ENABLED must be exactly true/false; the fence defaults closed outside local/ci", async () => {
    await expect(buildContainer({ environment: "local", buildBusiness: createStubBusiness().build, env: { VSP_MUTATIONS_ENABLED: "yes" }, logger: createMemoryLogger().logger })).rejects.toThrow("INFRA_ENV_BOOLEAN_INVALID");
  });
});

describe("composition root: LOCAL FIXTURE composition", () => {
  it("[OPS-04][SPEC-16.local-badge] local builds over fixtures only: offline guard accepted, every adapter a labelled fixture, readiness green", async () => {
    const stub = createStubBusiness();
    const { logger } = createMemoryLogger();
    c = await buildContainer({ environment: "local", buildBusiness: stub.build, clock: new FakeClock(START), env: {}, allowUncommittedCatalog: true, metricToolNames: STUB_TOOL_NAMES, logger, rateLimit: null });
    expect(c.report.ruleSet).toBe("offline");
    expect(c.report.deployable).toBe(true);
    expect(c.label).toContain("LOCAL FIXTURE");
    expect(Object.values(c.adapters.kinds()).every((k) => k === "local_fixture")).toBe(true);
    expect(c.adapters.summary().badge).not.toBeNull();
    expect(c.mutationsEnabled).toBe(true);
    const ready = await c.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    const list = await c.app.inject({ method: "GET", url: "/v1/tools/catalog", headers: auth("mcp_tools") });
    expect((list.json() as { definitions: { name: string }[] }).definitions.map((d) => d.name).sort()).toEqual([...STUB_TOOL_NAMES].sort());
    expect(c.versions.toolCatalog).toBe(c.catalog.digest);
    expect(Object.isFrozen(c.versions)).toBe(true);
  }, 60_000);

  it("[SPEC-8.tool-pipeline][SAFE-02] the local container serves TC-01 and MCP tools/call through the real admission controller and illustrative local budget", async () => {
    const stub = createStubBusiness();
    c = await buildContainer({ environment: "local", buildBusiness: stub.build, clock: new FakeClock(START), env: {}, allowUncommittedCatalog: true, metricToolNames: STUB_TOOL_NAMES, logger: createMemoryLogger().logger, rateLimit: null, ingestKnowledge: false });
    const sessionRef = await startCall(c);
    const faq = await mcpCall(c, sessionRef, "fixture_public_faq", { topic: "portal_login" });
    expect(faq.status).toBe("SUCCESS");
    const human = await mcpCall(c, null, "fixture_request_human", { reason: "CALLER_REQUESTED_HUMAN", language: "en" });
    expect(human.status).toBe("PENDING");
  }, 60_000);

  it("[OPS-06][SPEC-8.tool-pipeline] with the REAL business module the built catalogue equals the committed file and business tools run end to end", async () => {
    c = await buildContainer({ environment: "local", buildBusiness, clock: new FakeClock(START), env: {}, logger: createMemoryLogger().logger, rateLimit: null });
    expect(c.catalog.digest).toBe(loadPinnedCatalogFile(CATALOG_FILE).manifest.digest);
    expect(c.versions.toolCatalog).toBe(c.catalog.digest);
    const sessionRef = await startCall(c);
    const search = await mcpCall(c, sessionRef, "search_approved_runbook", { intent: "payment_help", query: null, language: "en" });
    expect(search.status).toBe("SUCCESS");
    const safety = await mcpCall(c, sessionRef, "request_safety_route", { signalSource: "CALLER_REQUEST", concernSubject: "SELF", language: "en" });
    expect(["SUCCESS", "PENDING"]).toContain(safety.status);
    const human = await c.app.inject({ method: "POST", url: "/telephony/v1/session/human-request", headers: auth("telephony_control"), payload: { callId: CALLS.concurrent.callId, reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null } });
    expect(human.json()).toMatchObject({ accepted: true });
    expect(human.statusCode).toBe(200);
  }, 120_000);
});
