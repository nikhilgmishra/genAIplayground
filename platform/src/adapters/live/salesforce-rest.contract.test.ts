/**
 * EMULATED CONTRACT TESTS for the live Salesforce REST adapter. The server is a
 * 127.0.0.1 emulator of the documented REST responses (salesforce-emulator.fixture.ts);
 * passing these tests is NOT sandbox evidence and says nothing about any real org.
 * All data is SYNTHETIC.
 */
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALLS, PEOPLE } from "../../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../../observability/logger.js";
import { isSafeToRetry } from "../../resilience/classify.js";
import { FakeClock } from "../../shared/clock.js";
import { ConflictError, DependencyError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId, newSupportReference } from "../../shared/ids.js";
import { AdapterDependencyError, BLOCKED_CAPABILITY_UNVERIFIED } from "../errors.js";
import type { CaseFields } from "../ports.js";
import { SalesforceRestEmulator, type SalesforceEmulatorOptions } from "./salesforce-emulator.fixture.js";
import {
  PLACEHOLDER_SALESFORCE_MAPPING,
  SALESFORCE_SCHEMA_OWNER,
  SalesforceRestSupportRecords,
  type SalesforceRestConfig,
} from "./salesforce-rest-support-records.js";

/** SYNTHETIC connected-app credentials for the emulator only. */
const CLIENT = { clientId: "synthetic-emulator-client-id", clientSecret: "synthetic-emulator-client-secret" };
/** EMULATED version label; deliberately not a claim about any org's API version. */
const API = "v99.0";
const M = PLACEHOLDER_SALESFORCE_MAPPING;
const INT_PATH = `/services/data/${API}/sobjects/${M.interaction.sobject}/${M.interaction.externalIdField}/`;
const CASE_PATH = `/services/data/${API}/sobjects/${M.case.sobject}/${M.case.externalIdField}/`;
const LINK_PATH = `/services/data/${API}/sobjects/${M.link.sobject}/${M.link.externalIdField}/`;

const interactionFields = () => ({ callId: CALLS.primary.callId, language: "en", consentStatus: "GRANTED", startedAt: "2026-10-17T15:00:00.000Z" });
const caseFields = (over: Partial<CaseFields> = {}): CaseFields => ({
  subjectRef: PEOPLE.avery.subjectId,
  audience: "client",
  issueCategory: "billing_dispute",
  disposition: "REQUEST_ACCEPTED",
  ownerQueue: "q_billing_review",
  priority: "P3_STANDARD",
  summary: "Caller disputes a late cancellation line; review requested; no refund promised.",
  attempted: ["billing.review.submit"],
  commitReceiptIds: [newId("rcp")],
  sourceCallIds: [CALLS.primary.callId],
  language: "en",
  consentStatus: "GRANTED",
  nextStep: "Billing specialist review",
  deadline: "2026-10-24T15:00:00.000Z",
  versions: "policy-2026-10-17.1;catalog-1",
  restricted: false,
  supportReference: newSupportReference(),
  ...over,
});

let emu: SalesforceRestEmulator;
let clock: FakeClock;
let mem: ReturnType<typeof createMemoryLogger>;

async function startEmulator(over: Partial<SalesforceEmulatorOptions> = {}): Promise<void> {
  await emu?.close();
  emu = await SalesforceRestEmulator.start({ ...CLIENT, apiVersion: API, ...over });
}

function adapter(over: Partial<SalesforceRestConfig> = {}, deps: { fetch?: typeof fetch } = {}): SalesforceRestSupportRecords {
  return new SalesforceRestSupportRecords(
    { myDomainUrl: emu.origin, apiVersion: API, timeoutMs: 1_000, schema: { status: "EMULATED_CONTRACT_TEST" }, ...over },
    { credentials: async () => ({ ...CLIENT }), clock, logger: mem.logger, ...deps },
  );
}

async function rejection(p: Promise<unknown>): Promise<PlatformError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PlatformError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

beforeEach(async () => {
  clock = new FakeClock("2026-10-17T15:00:00.000Z");
  mem = createMemoryLogger();
  emu = await SalesforceRestEmulator.start({ ...CLIENT, apiVersion: API });
});
afterEach(async () => {
  await emu.close();
});

describe("SalesforceRestSupportRecords — EMULATED contract (not sandbox evidence)", () => {
  it("[SPEC-8.4] interaction upsert by external id: 201 created then 200 updated, same record, never a duplicate", async () => {
    const sf = adapter();
    const ext = newId("int");
    const first = await sf.upsertInteraction(ext, interactionFields());
    const second = await sf.upsertInteraction(ext, { ...interactionFields(), consentStatus: "DECLINED" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ recordId: first.recordId, created: false });
    expect(emu.findByExternalId(M.interaction.sobject, M.interaction.externalIdField, ext)).toHaveLength(1);

    const patch = emu.requests.find((r) => r.method === "PATCH");
    expect(patch?.path).toBe(`${INT_PATH}${ext}`);
    expect(patch?.contentType).toMatch(/^application\/json/);
    expect(patch?.authorization).toMatch(/^Bearer 00DEMULATED!/);
    const body = JSON.parse(patch?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty(M.interaction.externalIdField);
    expect(body).toEqual({
      [M.interaction.fields.callId]: CALLS.primary.callId,
      [M.interaction.fields.language]: "en",
      [M.interaction.fields.consentStatus]: "GRANTED",
      [M.interaction.fields.startedAt]: "2026-10-17T15:00:00.000Z",
    });
  });

  it("[SPEC-8.4] 204 update (older API versions) is followed by a minimal read-back of the record id", async () => {
    await startEmulator({ updateStatus: 204 });
    const sf = adapter();
    const ext = newId("int");
    const first = await sf.upsertInteraction(ext, interactionFields());
    const second = await sf.upsertInteraction(ext, interactionFields());
    expect(second).toEqual({ recordId: first.recordId, created: false });
    const readBack = emu.requests.find((r) => r.method === "GET");
    expect(readBack?.query.fields).toBe("Id");
  });

  it("[SPEC-8.4] Case upsert links interactions many-to-many; repeats never duplicate Cases or links", async () => {
    const sf = adapter();
    const callA = newId("int");
    const callB = newId("int"); // repeat call about an existing issue
    const issue1 = newId("iss");
    const issue2 = newId("iss");
    await sf.upsertInteraction(callA, interactionFields());
    await sf.upsertInteraction(callB, { ...interactionFields(), callId: CALLS.repeat.callId });
    const c1 = await sf.upsertCase(issue1, callA, caseFields());
    const c2 = await sf.upsertCase(issue2, callA, caseFields({ issueCategory: "appointment", ownerQueue: "q_scheduling" }));
    const c1again = await sf.upsertCase(issue1, callB, caseFields({ sourceCallIds: [CALLS.primary.callId, CALLS.repeat.callId] }));
    expect(c1.created).toBe(true);
    expect(c2.created).toBe(true);
    expect(c1again).toEqual({ caseId: c1.caseId, created: false });
    // Replay everything: still two Cases and three links.
    await sf.upsertCase(issue1, callA, caseFields());
    await sf.upsertCase(issue2, callA, caseFields());
    await sf.upsertCase(issue1, callB, caseFields());
    expect(emu.recordsOf("Case")).toHaveLength(2);
    expect(emu.recordsOf(M.link.sobject)).toHaveLength(3);
    const caseBody = JSON.parse(emu.requests.find((r) => r.method === "PATCH" && r.path.startsWith(CASE_PATH))?.body ?? "{}") as Record<string, unknown>;
    expect(caseBody[M.case.fields.attempted]).toBe("billing.review.submit");
    expect(caseBody[M.case.fields.restricted]).toBe(false);
    expect(caseBody).not.toHaveProperty(M.case.externalIdField);
    const linkBody = JSON.parse(emu.requests.find((r) => r.path.startsWith(LINK_PATH))?.body ?? "{}") as Record<string, unknown>;
    expect(linkBody).toEqual({
      [M.link.interactionRelationship]: { [M.interaction.externalIdField]: callA },
      [M.link.caseRelationship]: { [M.case.externalIdField]: issue1 },
    });
  });

  it("[AUTH-02] client-credentials token from the My Domain token endpoint is requested once and cached", async () => {
    const sf = adapter();
    await sf.upsertInteraction(newId("int"), interactionFields());
    await sf.upsertInteraction(newId("int"), interactionFields());
    await sf.getCaseByExternalId(newId("iss"));
    expect(emu.tokenRequests).toBe(1);
    const tokenReq = emu.requests.find((r) => r.path === "/services/oauth2/token");
    expect(tokenReq?.method).toBe("POST");
    expect(tokenReq?.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(tokenReq?.body ?? "");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT.clientId);
  });

  it("[AUTH-04] cached token expires by the client-side bound (or a shorter advertised expires_in) and is re-requested", async () => {
    const sf = adapter({ tokenMaxAgeSeconds: 900 });
    await sf.getCaseByExternalId(newId("iss"));
    clock.advanceSeconds(869);
    await sf.getCaseByExternalId(newId("iss"));
    expect(emu.tokenRequests).toBe(1);
    clock.advanceSeconds(2);
    await sf.getCaseByExternalId(newId("iss"));
    expect(emu.tokenRequests).toBe(2);

    await startEmulator({ tokenExpiresIn: 120 });
    const short = adapter({ tokenMaxAgeSeconds: 900 });
    await short.getCaseByExternalId(newId("iss"));
    clock.advanceSeconds(91);
    await short.getCaseByExternalId(newId("iss"));
    expect(emu.tokenRequests).toBe(2);
  });

  it("[SPEC-8.4] 300 Multiple Choices (external id matches several records) is a ConflictError, never a silent pick", async () => {
    const sf = adapter();
    const ext = newId("iss");
    emu.forceMultipleMatches("Case", M.case.externalIdField, ext);
    await sf.upsertInteraction(newId("int"), interactionFields());
    const err = await rejection(sf.upsertCase(ext, newId("int"), caseFields()));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.reasonCode).toBe("SALESFORCE_EXTERNAL_ID_MULTIPLE_MATCHES");
    await expect(sf.getCaseByExternalId(ext)).rejects.toMatchObject({ reasonCode: "SALESFORCE_EXTERNAL_ID_MULTIPLE_MATCHES" });
  });

  it("[AUTH-02] 401 invalidates the cached token, refreshes once and retries once", async () => {
    const sf = adapter();
    const ext = newId("int");
    await sf.upsertInteraction(ext, interactionFields());
    emu.revokeTokens();
    const r = await sf.upsertInteraction(ext, interactionFields());
    expect(r.created).toBe(false);
    expect(emu.tokenRequests).toBe(2);
  });

  it("[AUTH-02] persistent 401 fails closed after exactly one refresh (no refresh loop)", async () => {
    const sf = adapter();
    emu.script({ method: "PATCH", times: 5, response: { status: 401, body: [{ errorCode: "INVALID_SESSION_ID" }] } });
    const err = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(err).toBeInstanceOf(DependencyError);
    expect(err).toMatchObject({ reasonCode: "SALESFORCE_AUTH_FAILED", outcome: "FAILED", retryable: false, httpStatus: 401 });
    expect(emu.tokenRequests).toBe(2);
    expect(emu.requests.filter((q) => q.method === "PATCH")).toHaveLength(2);
  });

  it("[ACT-03] 429 and 503 map to retryable NOT_STARTED with Retry-After; nothing is written", async () => {
    const sf = adapter();
    emu.script({ method: "PATCH", response: { status: 429, body: [{ errorCode: "REQUEST_LIMIT_EXCEEDED" }], headers: { "Retry-After": "7" } } });
    const e429 = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(e429).toMatchObject({ reasonCode: "HTTP_429", outcome: "NOT_STARTED", retryable: true, httpStatus: 429, retryAfterMs: 7_000 });
    expect(isSafeToRetry(e429, ["HTTP_429", "HTTP_503"])).toBe(true);

    emu.script({ method: "PATCH", response: { status: 503, body: [{ errorCode: "SERVER_UNAVAILABLE" }] } });
    const e503 = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(e503).toMatchObject({ reasonCode: "HTTP_503", outcome: "NOT_STARTED", retryable: true, httpStatus: 503 });
    expect(emu.recordsOf(M.interaction.sobject)).toHaveLength(0);
  });

  it("[ACT-03] 400 and 404 are permanent failures (FAILED, not retryable)", async () => {
    const sf = adapter();
    emu.script({ method: "PATCH", response: { status: 400, body: [{ errorCode: "INVALID_FIELD" }] } });
    const e400 = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(e400).toMatchObject({ reasonCode: "SALESFORCE_REQUEST_REJECTED", outcome: "FAILED", retryable: false });
    expect(isSafeToRetry(e400)).toBe(false);
    emu.script({ method: "PATCH", response: { status: 404, body: [{ errorCode: "NOT_FOUND" }] } });
    const e404 = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(e404).toMatchObject({ reasonCode: "SALESFORCE_RESOURCE_NOT_FOUND", outcome: "FAILED", retryable: false });
  });

  it("[ACT-03] 403 REQUEST_LIMIT_EXCEEDED (org API limit) is NOT_STARTED and not retried immediately", async () => {
    const sf = adapter();
    emu.script({ method: "PATCH", response: { status: 403, body: [{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "TotalRequests Limit exceeded." }] } });
    const err = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(err).toMatchObject({ reasonCode: "SALESFORCE_API_LIMIT_EXCEEDED", outcome: "NOT_STARTED", retryable: false });
    emu.script({ method: "PATCH", response: { status: 403, body: [{ errorCode: "INSUFFICIENT_ACCESS" }] } });
    expect(await rejection(sf.upsertInteraction(newId("int"), interactionFields()))).toMatchObject({ reasonCode: "SALESFORCE_FORBIDDEN", outcome: "FAILED" });
  });

  it("[ACT-03] network timeout after the write was sent is UNKNOWN; reconcile by external id finds it; the retry does not duplicate", async () => {
    const sf = adapter({ timeoutMs: 300 });
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interactionFields());
    emu.script({ method: "PATCH", pathIncludes: CASE_PATH, response: { action: "apply_then_hang" } });
    const err = await rejection(sf.upsertCase(issue, call, caseFields()));
    expect(err).toBeInstanceOf(AdapterDependencyError);
    expect(err).toMatchObject({ reasonCode: "TIMEOUT_AFTER_SEND", outcome: "UNKNOWN", retryable: false });
    expect(isSafeToRetry(err, ["TIMEOUT_BEFORE_SEND", "HTTP_429", "HTTP_503"])).toBe(false);

    const found = await sf.getCaseByExternalId(issue);
    expect(found?.caseId).toMatch(/^500/);
    const retried = await sf.upsertCase(issue, call, caseFields());
    expect(retried).toEqual({ caseId: found?.caseId, created: false });
    expect(emu.recordsOf("Case")).toHaveLength(1);
  });

  it("[ACT-03] a connection dropped after the write was sent is UNKNOWN (not assumed to have failed)", async () => {
    const sf = adapter();
    await sf.getCaseByExternalId(newId("iss")); // token
    emu.script({ method: "PATCH", response: { action: "destroy" } });
    const err = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(err).toMatchObject({ outcome: "UNKNOWN", retryable: false });
  });

  it("[ACT-03] connection refused before anything was sent is NOT_STARTED", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        const p = typeof a === "object" && a ? a.port : 0;
        s.close(() => resolve(p));
      });
    });
    const sf = adapter({ myDomainUrl: `http://127.0.0.1:${port}` });
    const err = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(err).toMatchObject({ reasonCode: "CONNECTION_REFUSED", outcome: "NOT_STARTED", retryable: true });
  });

  it("[ACT-03] link failure after the Case upsert is PARTIAL_WRITE (UNKNOWN); an idempotent retry completes it without duplicates", async () => {
    const sf = adapter();
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interactionFields());
    emu.script({ method: "PATCH", pathIncludes: LINK_PATH, response: { status: 503, body: [{ errorCode: "SERVER_UNAVAILABLE" }] } });
    const err = await rejection(sf.upsertCase(issue, call, caseFields()));
    expect(err).toMatchObject({ reasonCode: "PARTIAL_WRITE", outcome: "UNKNOWN" });
    expect(emu.recordsOf("Case")).toHaveLength(1);
    expect(emu.recordsOf(M.link.sobject)).toHaveLength(0);
    const retry = await sf.upsertCase(issue, call, caseFields());
    expect(retry.created).toBe(false);
    expect(emu.recordsOf("Case")).toHaveLength(1);
    expect(emu.recordsOf(M.link.sobject)).toHaveLength(1);
  });

  it("[SPEC-8.4] getCaseByExternalId requests minimal fields and maps 404 to null", async () => {
    const sf = adapter();
    expect(await sf.getCaseByExternalId(newId("iss"))).toBeNull();
    const get = emu.requests.find((r) => r.method === "GET");
    expect(get?.query.fields).toBe(`Id,Status,${M.case.fields.ownerQueue}`);
    const call = newId("int");
    const issue = newId("iss");
    await sf.upsertInteraction(call, interactionFields());
    const c = await sf.upsertCase(issue, call, caseFields());
    expect(await sf.getCaseByExternalId(issue)).toEqual({ caseId: c.caseId, status: "UNKNOWN", ownerQueue: "q_billing_review" });
  });

  it("[SPEC-12.quota] the documented Sforce-Limit-Info API usage header is recorded for quota monitoring", async () => {
    await startEmulator({ apiLimit: 15_000 });
    const sf = adapter();
    await sf.upsertInteraction(newId("int"), interactionFields());
    expect(sf.lastApiUsage).toEqual({ used: 1, limit: 15_000 });
  });

  it("[SPEC-8.4] instance_url in the token response must equal the configured org origin (no token-driven SSRF)", async () => {
    await startEmulator({ instanceUrlOverride: "https://attacker.example.invalid" });
    const sf = adapter();
    const err = await rejection(sf.upsertInteraction(newId("int"), interactionFields()));
    expect(err).toMatchObject({ reasonCode: "SALESFORCE_INSTANCE_URL_UNEXPECTED", outcome: "FAILED" });
    expect(emu.requests.every((r) => r.path === "/services/oauth2/token")).toBe(true);
  });

  it("[ACT-03] oversized responses are rejected: UNKNOWN for writes, FAILED for reads", async () => {
    const sf = adapter({ maxResponseBytes: 1_024 });
    emu.script({ method: "GET", response: { status: 200, body: { Id: "500EMU000000000001", Status: "x".repeat(5_000) } } });
    expect(await rejection(sf.getCaseByExternalId(newId("iss")))).toMatchObject({ reasonCode: "SALESFORCE_RESPONSE_TOO_LARGE", outcome: "FAILED" });
    emu.script({ method: "PATCH", response: { status: 201, body: { id: "a0EEMU000000000001", padding: "x".repeat(5_000) } } });
    expect(await rejection(sf.upsertInteraction(newId("int"), interactionFields()))).toMatchObject({ reasonCode: "SALESFORCE_RESPONSE_TOO_LARGE", outcome: "UNKNOWN" });
  });

  it("[DATA-01] errors and logs carry reason codes only — never response bodies, tokens, secrets or record values", async () => {
    const sf = adapter();
    emu.script({
      method: "PATCH",
      response: { status: 400, body: [{ errorCode: "INVALID_FIELD", message: `bad value ${PEOPLE.avery.fullName} ${PEOPLE.avery.dateOfBirth}` }] },
    });
    const err = await rejection(sf.upsertCase(newId("iss"), newId("int"), caseFields()));
    expect(err.message).toBe(err.reasonCode);
    const logged = JSON.stringify(mem.records);
    for (const secret of [PEOPLE.avery.fullName, PEOPLE.avery.dateOfBirth ?? "", CLIENT.clientSecret, "00DEMULATED!", "late cancellation"]) {
      expect(logged).not.toContain(secret);
      expect(err.message).not.toContain(secret);
    }
  });

  it("[ACT-02] invalid inputs are rejected by strict schemas before any network call", async () => {
    const sf = adapter();
    await expect(sf.upsertInteraction("not-an-external-id", interactionFields())).rejects.toBeInstanceOf(ValidationError);
    await expect(sf.upsertInteraction(newId("int"), { ...interactionFields(), extra: "x" } as never)).rejects.toMatchObject({ reasonCode: "SUPPORT_INTERACTION_FIELDS_INVALID" });
    await expect(sf.upsertCase(newId("iss"), newId("int"), { ...caseFields(), summary: "x".repeat(601) })).rejects.toMatchObject({ reasonCode: "SUPPORT_CASE_FIELDS_INVALID" });
    await expect(sf.getCaseByExternalId("iss_short")).rejects.toBeInstanceOf(ValidationError);
    expect(emu.requests).toHaveLength(0);
  });
});

describe("SalesforceRestSupportRecords — schema BLOCKED and configuration guards", () => {
  const blockedSchema = { status: "BLOCKED", prerequisite: "PRQ-006", owner: SALESFORCE_SCHEMA_OWNER } as const;

  it("[OPS-03] BLOCKED schema: every operation fails closed with BLOCKED_CAPABILITY_UNVERIFIED and no network access", async () => {
    let fetched = 0;
    const sf = new SalesforceRestSupportRecords(
      { myDomainUrl: null, apiVersion: null, timeoutMs: 1_000, schema: blockedSchema },
      {
        credentials: async () => CLIENT,
        fetch: (async () => {
          fetched += 1;
          throw new Error("network must not be used");
        }) as typeof fetch,
      },
    );
    expect(sf.capabilityStatus).toBe("BLOCKED");
    for (const p of [sf.upsertInteraction(newId("int"), interactionFields()), sf.upsertCase(newId("iss"), newId("int"), caseFields()), sf.getCaseByExternalId(newId("iss"))]) {
      await expect(p).rejects.toMatchObject({ reasonCode: BLOCKED_CAPABILITY_UNVERIFIED });
    }
    expect(await sf.health()).toEqual({ healthy: false, reasonCode: BLOCKED_CAPABILITY_UNVERIFIED });
    expect(fetched).toBe(0);
  });

  it("[OPS-04] PROVIDED schema with PLACEHOLDER names, non-My-Domain hosts, emulation off loopback and a missing apiVersion are rejected", () => {
    const deps = { credentials: async () => CLIENT };
    const provided = { status: "PROVIDED", providedBy: SALESFORCE_SCHEMA_OWNER, evidenceRef: "evidence://none-yet", approvalId: "apr_hypothetical01" } as const;
    expect(() => new SalesforceRestSupportRecords({ myDomainUrl: "https://synthetic.my.salesforce.com", apiVersion: API, timeoutMs: 1_000, schema: provided }, deps)).toThrow(
      expect.objectContaining({ reasonCode: "SALESFORCE_MAPPING_PLACEHOLDER" }),
    );
    expect(() => new SalesforceRestSupportRecords({ myDomainUrl: "https://salesforce.example.invalid", apiVersion: API, timeoutMs: 1_000, schema: blockedSchema }, deps)).toThrow(
      expect.objectContaining({ reasonCode: "SALESFORCE_ENDPOINT_INVALID" }),
    );
    expect(() => new SalesforceRestSupportRecords({ myDomainUrl: "http://synthetic.my.salesforce.com", apiVersion: API, timeoutMs: 1_000, schema: blockedSchema }, deps)).toThrow(
      expect.objectContaining({ reasonCode: "SALESFORCE_ENDPOINT_INVALID" }),
    );
    expect(
      () => new SalesforceRestSupportRecords({ myDomainUrl: "https://synthetic.my.salesforce.com", apiVersion: API, timeoutMs: 1_000, schema: { status: "EMULATED_CONTRACT_TEST" } }, deps),
    ).toThrow(expect.objectContaining({ reasonCode: "SALESFORCE_EMULATION_REQUIRES_LOOPBACK" }));
    expect(() => new SalesforceRestSupportRecords({ myDomainUrl: emu.origin, apiVersion: null, timeoutMs: 1_000, schema: { status: "EMULATED_CONTRACT_TEST" } }, deps)).toThrow(
      expect.objectContaining({ reasonCode: "SALESFORCE_API_VERSION_REQUIRED" }),
    );
    expect(() => new SalesforceRestSupportRecords({ myDomainUrl: `${emu.origin}/path?x=1`, apiVersion: API, timeoutMs: 1_000, schema: { status: "EMULATED_CONTRACT_TEST" } }, deps)).toThrow(
      expect.objectContaining({ reasonCode: "SALESFORCE_ENDPOINT_INVALID" }),
    );
  });
});
