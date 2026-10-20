/**
 * ConnectorProfile admission, credential separation, derived rules and reviewed changes (WP-06;
 * FO-06-12..18, FO-05-56, FO-05-39, FO-06-21; OPS-01, OPS-04, OPS-06). In-process production code over
 * the SYNTHETIC emulated-vendor profile and the committed platform/config environment files.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectorProfile } from "../../protocol/connector.js";
import type { ConnectorProfile as ConnectorProfileT } from "../../protocol/connector.js";
import { computeConnectorProfileDigest } from "../../protocol/digests.js";
import { EgressGuard } from "../../privacy/egress.js";
import { FakeClock } from "../../shared/clock.js";
import { emulatorProfile } from "../../../test/integration/connectors/profiles.js";
import { ConnectorProfileRegistry } from "./changes.js";
import type { ConnectorProfileAuditEvent } from "./changes.js";
import { committedConfigCredentialRefs, credentialReuseViolations } from "./credentials.js";
import { egressDestinationFor, profileDigestEntries, retentionRulesFor } from "./derive.js";
import { loadConnectorProfile, loadConnectorProfilesFromDir } from "./load.js";
import { ProfileRejectedError, admitConnectorProfile } from "./validate.js";

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../config");
const SM = (name: string) => `arn:aws:secretsmanager:us-east-1:111122223333:secret:vsp/${name}`;
const base = (o: Parameters<typeof emulatorProfile>[0]["mutate"] = undefined, extra: Partial<Parameters<typeof emulatorProfile>[0]> = {}) =>
  emulatorProfile({ readRef: SM("sched-read"), writeRef: SM("sched-write"), mutate: o, ...extra });

function violations(raw: unknown, env: Parameters<typeof admitConnectorProfile>[1] = "sandbox"): string[] {
  try {
    admitConnectorProfile(raw, env);
  } catch (e) {
    if (e instanceof ProfileRejectedError) return [...e.violations];
    throw e;
  }
  return [];
}

const redigest = (p: Omit<ConnectorProfileT, "configDigest">): ConnectorProfileT => ({ ...p, configDigest: computeConnectorProfileDigest(p) });

describe("profile admission [FO-06-12][FO-06-16][FO-06-17]", () => {
  it("[FO-06-12] positive: a complete profile is admitted with its digest and every mapping compiled", () => {
    const a = admitConnectorProfile(base(), "sandbox");
    expect(a.digest).toBe(a.profile.configDigest);
    expect([...a.mappings.keys()]).toEqual(["Appointment"]);
    expect(ConnectorProfile.parse(base()).profileVersion).toBe(1);
  });

  it("[FO-06-12] the loader rejects a profile missing vendor, API version, documentation URL or owner, each with its own code", () => {
    const p = base() as unknown as Record<string, unknown>;
    expect(violations({ ...p, vendor: { name: "reference", api: "scheduling-api" } })).toEqual(expect.arrayContaining(["PROFILE_API_VERSION_MISSING", "PROFILE_SCHEMA_INVALID"]));
    expect(violations({ ...p, vendor: undefined })).toEqual(expect.arrayContaining(["PROFILE_VENDOR_MISSING"]));
    expect(violations({ ...p, documentationUrl: undefined })).toEqual(expect.arrayContaining(["PROFILE_DOCUMENTATION_URL_MISSING"]));
    expect(violations({ ...p, ownerRole: "" })).toEqual(expect.arrayContaining(["PROFILE_OWNER_MISSING"]));
    expect(violations({ ...p, configDigest: "0".repeat(64) })).toEqual(["PROFILE_DIGEST_MISMATCH"]);
  });

  it("[FO-06-16][ACT-02][ACT-03] every enabled operation declares pagination, rate budget, timeout and capability; a write without idempotency or reconcile is refused", () => {
    const strip = (k: "pagination" | "rateBudget" | "timeoutMs" | "capability" | "params" | "successStatuses") =>
      violations(base((p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.get" ? { ...o, [k]: undefined } : o)) })));
    expect(strip("pagination")).toContain("OPERATION_PAGINATION_MISSING");
    expect(strip("rateBudget")).toContain("OPERATION_RATE_BUDGET_MISSING");
    expect(strip("timeoutMs")).toContain("OPERATION_TIMEOUT_MISSING");
    expect(strip("capability")).toContain("OPERATION_CAPABILITY_MISSING");
    expect(strip("params")).toContain("OPERATION_PARAMS_MISSING");
    expect(strip("successStatuses")).toContain("OPERATION_SUCCESS_STATUSES_MISSING");
    const write = (change: Record<string, unknown>) => violations(base((p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.upsert" ? { ...o, ...change } : o)) })));
    expect(write({ reconcileOperationId: null })).toContain("WRITE_WITHOUT_RECONCILE");
    expect(write({ idempotencyKeyHeader: null })).toContain("WRITE_IDEMPOTENCY_HEADER_MISSING");
    expect(write({ idempotency: "NATURALLY_IDEMPOTENT", method: "POST" })).toContain("WRITE_NOT_NATURALLY_IDEMPOTENT");
    expect(write({ idempotency: "EXTERNAL_ID_UPSERT", externalIdParam: null })).toContain("WRITE_EXTERNAL_ID_PARAM_MISSING");
    expect(write({ reconcileOperationId: "appointments.metadata" })).toEqual([]);
    expect(write({ reconcileOperationId: "appointments.cancel" })).toContain("RECONCILE_OPERATION_INVALID");
    expect(write({ rateBudget: { requestsPerSecond: 500, burst: 1, maxConcurrency: 1 } })).toContain("OPERATION_BUDGET_EXCEEDS_CONNECTOR");
  });

  it("[FO-06-06] pagination declarations are bounded and complete", () => {
    const list = (change: Record<string, unknown>) =>
      violations(base((p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.list" && o.pagination ? { ...o, pagination: { ...o.pagination, ...change } } : o)) })));
    expect(list({ nextPointer: null })).toContain("PAGINATION_NEXT_POINTER_MISSING");
    expect(list({ cursorParam: null })).toContain("PAGINATION_CURSOR_PARAM_MISSING");
    expect(list({ maxPageSize: 500 })).toContain("OPERATION_PAGE_SIZE_EXCEEDS_CONNECTOR");
    // OFFSET detects the last page by a short page, so it must request its page size.
    expect(list({ strategy: "OFFSET" })).toEqual([]);
    expect(list({ strategy: "OFFSET", pageSizeParam: null })).toContain("PAGINATION_PAGE_SIZE_PARAM_MISSING");
    expect(list({ pageSizeParam: null })).not.toContain("PAGINATION_PAGE_SIZE_PARAM_MISSING");
  });

  it("[FO-06-17] a profile without deletion behaviour and retention / egress class per stream is refused; streams cannot exceed the profile's egress class", () => {
    expect(violations(base((p) => ({ ...p, streams: undefined })))).toContain("PROFILE_STREAMS_MISSING");
    expect(violations(base((p) => ({ ...p, streams: [] })))).toContain("STREAM_MISSING_FOR_SOURCE_OBJECT");
    const raw = base() as unknown as Record<string, unknown> & { streams: Record<string, unknown>[] };
    expect(violations({ ...raw, streams: [{ ...raw.streams[0], deletionBehavior: undefined }] })).toContain("PROFILE_SCHEMA_INVALID");
    expect(violations(base((p) => ({ ...p, egressClass: "INTERNAL", streams: p.streams?.map((s) => ({ ...s, egressClass: "PHI" })) })))).toEqual(
      expect.arrayContaining(["STREAM_EGRESS_EXCEEDS_PROFILE", "MAPPING_CLASS_EXCEEDS_EGRESS_CLASS"]),
    );
  });

  it("[FO-06-13][FO-06-20] network and auth: token host must be allowlisted, address class explicit, writes need account verification", () => {
    expect(violations(base(undefined, { auth: { tokenUrl: "https://login.elsewhere.example.com/oauth/token" } }))).toContain("AUTH_TOKEN_HOST_NOT_ALLOWED");
    expect(violations(base((p) => ({ ...p, network: undefined })))).toContain("PROFILE_NETWORK_MISSING");
    expect(violations(base(undefined, { binding: { account: null, region: null } }))).toEqual(expect.arrayContaining(["WRITES_WITHOUT_ACCOUNT_VERIFICATION", "BINDING_VERIFIED_WITHOUT_SOURCE"]));
    expect(violations(base(undefined, { auth: { scheme: "API_KEY_HEADER", tokenUrl: null, clientAuth: null, apiKeyHeader: null } }))).toEqual(expect.arrayContaining(["AUTH_API_KEY_HEADER_MISSING", "BINDING_SOURCE_WITHOUT_TOKEN_RESPONSE"]));
    expect(violations(base((p) => ({ ...p, auth: undefined })))).toContain("PROFILE_AUTH_MISSING");
  });

  it("[OPS-04] write modes are tied to environments: no sandbox-write profile in production, no fixture credential outside local/ci", () => {
    expect(violations(base(), "production")).toContain("SANDBOX_WRITE_PROFILE_IN_PRODUCTION");
    const fixture = emulatorProfile({ readRef: "local-fixture:conn/read", writeRef: "local-fixture:conn/write" });
    expect(violations(fixture, "ci")).toEqual([]);
    expect(violations(fixture, "staging")).toContain("FIXTURE_CREDENTIAL_OUTSIDE_LOCAL");
  });

  it("[FO-06-23] mapping and template defects are refused at admission, not at the first call", () => {
    expect(violations(base((p) => ({ ...p, mappings: p.mappings.map((m) => (m.targetField === "status" ? { ...m, semantic: "enum:missing_table" } : m)) })))).toContain("DSL_ENUM_TABLE_UNKNOWN");
    expect(violations(base((p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.get" ? { ...o, pathTemplate: "/appointments/{other}" } : o)) })))).toContain("TEMPLATE_PLACEHOLDER_UNDECLARED");
    expect(violations(base((p) => ({ ...p, operations: p.operations.map((o) => (o.operationId === "appointments.get" ? { ...o, responseObject: "Patient" } : o)) })))).toContain("OPERATION_RESPONSE_OBJECT_UNMAPPED");
  });
});

describe("capability-scoped credentials [FO-05-56][FO-05-39][AUTH-02]", () => {
  it("[FO-05-56] one least-privilege credential per capability and access; reuse across capabilities, or a write credential as the default, is refused", () => {
    expect(violations(base(undefined, { writeRef: SM("sched-read") }))).toEqual(expect.arrayContaining(["CREDENTIAL_REUSED_ACROSS_CAPABILITIES", "DEFAULT_CREDENTIAL_IS_WRITE_CREDENTIAL"]));
    expect(violations(base((p) => ({ ...p, capabilityCredentials: undefined })))).toContain("CAPABILITY_CREDENTIALS_MISSING");
    expect(violations(base((p) => ({ ...p, capabilityCredentials: p.capabilityCredentials?.filter((c) => c.access === "READ") })))).toContain("CAPABILITY_CREDENTIAL_MISSING");
    expect(violations(base((p) => ({ ...p, capabilityCredentials: p.capabilityCredentials?.map((c) => (c.access === "WRITE" ? { ...c, scopes: [] } : c)) })))).toContain("CAPABILITY_CREDENTIAL_SCOPE_MISSING");
    expect(violations(base(undefined, { readRef: "arn:aws:kms:us-east-1:111122223333:key/abcd-1234" }))).toContain("CREDENTIAL_REF_NOT_A_SECRET");
  });

  it("[FO-05-56] the guard rules reject a reference reused across connectors, across environments, and against committed platform/config adapter references", () => {
    const committed = committedConfigCredentialRefs(CONFIG_DIR);
    expect(committed.map((c) => c.environment).sort()).toEqual(["ci", "local", "production", "sandbox", "staging"]);
    // The committed configuration itself is separated per environment and per integration.
    expect(credentialReuseViolations(committed.map((c) => ({ environment: c.environment, profiles: [], adapterCredentialRefs: c.adapterCredentialRefs })))).toEqual([]);
    const sandbox = base();
    const prod = base((p) => ({ ...p, profileId: "cnp_synthEmulatedVendorPrd" }), { readRef: SM("sched-read-prod"), writeRef: SM("sched-write-prod") });
    expect(credentialReuseViolations([{ environment: "sandbox", profiles: [sandbox] }, { environment: "production", profiles: [prod] }])).toEqual([]);
    const reusedEnv = base((p) => ({ ...p, profileId: "cnp_synthEmulatedVendorPrd" }), { readRef: SM("sched-read"), writeRef: SM("sched-write-prod") });
    expect(credentialReuseViolations([{ environment: "sandbox", profiles: [sandbox] }, { environment: "production", profiles: [reusedEnv] }]).map((v) => v.code)).toContain("CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS");
    const otherConnector = base((p) => ({ ...p, profileId: "cnp_synthOtherConnector01", system: "billing" }), { readRef: SM("billing-read"), writeRef: SM("sched-write") });
    expect(credentialReuseViolations([{ environment: "sandbox", profiles: [sandbox, otherConnector] }]).map((v) => v.code)).toContain("CREDENTIAL_REUSED_ACROSS_CONNECTORS");
    const sandboxAdapters = committed.find((c) => c.environment === "sandbox")?.adapterCredentialRefs ?? {};
    const reusesAdapter = base(undefined, { readRef: sandboxAdapters.scheduling ?? "x" });
    expect(credentialReuseViolations([{ environment: "production", profiles: [reusesAdapter] }, ...committed.map((c) => ({ environment: c.environment, profiles: [], adapterCredentialRefs: c.adapterCredentialRefs }))]).map((v) => v.code)).toContain("CREDENTIAL_REUSED_ACROSS_ENVIRONMENTS");
  });

  it("[FO-05-39] environments are separated by audience: a signed-assertion audience shared by two environments is reported", () => {
    const jwt = (env: string, read: string, write: string) =>
      base((p) => ({ ...p, profileId: `cnp_synthEmulatedVendor${env}` }), { readRef: SM(read), writeRef: SM(write), auth: { scheme: "OAUTH2_JWT_BEARER", clientAuth: "PRIVATE_KEY_JWT", audience: "https://auth.vendor.emulator.test/oauth/token" } });
    const v = credentialReuseViolations([
      { environment: "sandbox", profiles: [jwt("Sbx", "a1", "a2")] },
      { environment: "production", profiles: [jwt("Prd", "b1", "b2")] },
    ]);
    expect(v.map((x) => x.code)).toEqual(["AUDIENCE_REUSED_ACROSS_ENVIRONMENTS"]);
  });

  it("[FO-05-56] a directory load refuses credential reuse inside the set and is all-or-nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-profiles-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify(base()));
      writeFileSync(join(dir, "b.json"), JSON.stringify(base((p) => ({ ...p, profileId: "cnp_synthOtherConnector01", system: "billing" }), { readRef: SM("billing-read"), writeRef: SM("billing-write") })));
      expect(loadConnectorProfilesFromDir(dir, "sandbox")).toHaveLength(2);
      writeFileSync(join(dir, "c.json"), JSON.stringify(base((p) => ({ ...p, profileId: "cnp_synthThirdConnector01", system: "claims" }), { readRef: SM("claims-read"), writeRef: SM("billing-write") })));
      expect(() => loadConnectorProfilesFromDir(dir, "sandbox")).toThrow("CREDENTIAL_REUSED_ACROSS_CONNECTORS");
      expect(() => loadConnectorProfile("{not json", "sandbox")).toThrow("PROFILE_NOT_JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("derived rules [FO-06-17][FO-06-18][DATA-01]", () => {
  it("[FO-06-17][DATA-01] the egress destination derives from the profile; PHI without coverage and approval is refused by the guard", () => {
    const p = base();
    const d = egressDestinationFor(p, ["sandbox"], { baaRef: "baa-synthetic", approvalId: "apr_synthApprovalTest01" });
    expect(d.hosts).toEqual(p.allowedHosts);
    expect(d.allowedClasses).toEqual(expect.arrayContaining(["PHI", "INTERNAL"]));
    const g = new EgressGuard({ policyVersion: "derived-1", destinations: [d] }, { environment: "sandbox" });
    expect(g.check(new URL(`${p.baseUrl}/appointments`), "PHI").allowed).toBe(true);
    expect(g.check(new URL("https://elsewhere.example.com/x"), "PHI").allowed).toBe(false);
    expect(() => new EgressGuard({ policyVersion: "derived-2", destinations: [egressDestinationFor(p, ["sandbox"], { baaRef: null, approvalId: null })] }, { environment: "sandbox" })).toThrow(/PHI_COVERAGE_OR_APPROVAL_MISSING/);
    const cdp = base((x) => ({ ...x, family: "cdp" }));
    // A CDP is an analytics sink: content-free classes only, whatever the profile asks for (DATA-01).
    expect(() => new EgressGuard({ policyVersion: "derived-3", destinations: [egressDestinationFor(cdp, ["sandbox"], { baaRef: "baa-synthetic", approvalId: "apr_synthApprovalTest01" })] }, { environment: "sandbox" })).toThrow(/CONTENT_FREE_ONLY_DESTINATION/);
  });

  it("[FO-06-17] retention and vendor-deletion rules derive per stream", () => {
    const rules = retentionRulesFor(base());
    expect(rules).toEqual([expect.objectContaining({ streamId: "appointments", retentionClass: "BUSINESS_RECORD", deletionBehavior: "TOMBSTONE", vendorDeletion: "TOMBSTONE_EVENTS", vendorDeletionOperationId: null })]);
    const reconciled = retentionRulesFor(base((p) => ({ ...p, streams: p.streams?.map((s) => ({ ...s, deletionBehavior: "RECONCILIATION_ONLY" })) })));
    expect(reconciled[0]?.vendorDeletion).toBe("RECONCILIATION_ONLY");
  });

  it("[FO-06-18][OPS-06] release pins: configuration and mapping digests per admitted profile, sorted", () => {
    const a = admitConnectorProfile(base(), "sandbox");
    const b = admitConnectorProfile(base((p) => ({ ...p, profileId: "cnp_synthAaaaConnector01", system: "billing" }), { readRef: SM("billing-read"), writeRef: SM("billing-write") }), "sandbox");
    const pins = profileDigestEntries([a, b]);
    expect(pins.map((x) => x.profileId)).toEqual(["cnp_synthAaaaConnector01", "cnp_synthEmulatedVendor01"]);
    expect(pins[1]).toEqual({ profileId: a.profile.profileId, profileVersion: 1, system: "scheduling", configDigest: a.digest, mappingDigests: { Appointment: a.mappings.get("Appointment")?.digest } });
  });
});

describe("pinned, reviewed and audited changes [FO-06-18][OPS-01]", () => {
  const review = (digest: string, o: Partial<{ approvalId: string; authorRef: string; reviewerRef: string }> = {}) => ({ approvalId: "apr_synthApprovalTest01", authorRef: "stf_synthAuthor0001", reviewerRef: "stf_synthReviewer001", reviewedDigest: digest, ...o });

  it("[FO-06-18] a change needs a review bound to the exact digest by another person, a higher version, and an audit event written first", async () => {
    const events: ConnectorProfileAuditEvent[] = [];
    const reg = new ConnectorProfileRegistry({ record: async (e) => void events.push(e) }, new FakeClock(new Date("2026-10-19T12:00:00Z")));
    const v1 = admitConnectorProfile(base(), "sandbox");
    expect(await reg.activate(v1, review(v1.digest))).toBe(true);
    expect(await reg.activate(v1, null)).toBe(false); // unchanged: no review, no event
    const v2 = admitConnectorProfile(redigest({ ...base(), profileVersion: 2, limits: { ...base().limits, timeoutMs: 2_500 } }), "sandbox");
    await expect(reg.activate(v2, null)).rejects.toThrow("CONNECTOR_PROFILE_REVIEW_REQUIRED");
    await expect(reg.activate(v2, review(v2.digest, { reviewerRef: "stf_synthAuthor0001" }))).rejects.toThrow("CONNECTOR_PROFILE_SELF_REVIEW");
    await expect(reg.activate(v2, review(v1.digest))).rejects.toThrow("CONNECTOR_PROFILE_REVIEW_DIGEST_MISMATCH");
    const older = admitConnectorProfile(redigest({ ...base(), profileVersion: 1, limits: { ...base().limits, timeoutMs: 3_000 } }), "sandbox");
    await expect(reg.activate(older, review(older.digest))).rejects.toThrow("CONNECTOR_PROFILE_VERSION_NOT_INCREASED");
    expect(reg.get(v1.profile.tenantId, v1.profile.profileId)?.digest).toBe(v1.digest);
    expect(await reg.activate(v2, review(v2.digest))).toBe(true);
    expect(events.map((e) => [e.action, e.reasonCode])).toEqual([
      ["connector.profile.activated", "CONNECTOR_PROFILE_ACTIVATED"],
      ["connector.profile.change_refused", "CONNECTOR_PROFILE_REVIEW_REQUIRED"],
      ["connector.profile.change_refused", "CONNECTOR_PROFILE_SELF_REVIEW"],
      ["connector.profile.change_refused", "CONNECTOR_PROFILE_REVIEW_DIGEST_MISMATCH"],
      ["connector.profile.change_refused", "CONNECTOR_PROFILE_VERSION_NOT_INCREASED"],
      ["connector.profile.activated", "CONNECTOR_PROFILE_ACTIVATED"],
    ]);
    expect(events[5]).toMatchObject({ fromVersion: 1, toVersion: 2, fromDigest: v1.digest, toDigest: v2.digest, approvalId: "apr_synthApprovalTest01" });
    // Content free: no host, credential reference or mapping detail in the audit record (DATA-01).
    expect(JSON.stringify(events)).not.toMatch(/secretsmanager|vendor\.emulator|appointments/);
  });

  it("[FO-06-18][OPS-01] failure injection: when the audit cannot be written the change is refused and the old version stays active", async () => {
    let fail = false;
    const reg = new ConnectorProfileRegistry({ record: async () => (fail ? Promise.reject(new Error("audit down")) : undefined) }, new FakeClock(new Date()));
    const v1 = admitConnectorProfile(base(), "sandbox");
    await reg.activate(v1, review(v1.digest));
    fail = true;
    const v2 = admitConnectorProfile(redigest({ ...base(), profileVersion: 2, limits: { ...base().limits, timeoutMs: 2_500 } }), "sandbox");
    await expect(reg.activate(v2, review(v2.digest))).rejects.toThrow("CONNECTOR_PROFILE_AUDIT_UNAVAILABLE");
    expect(reg.get(v1.profile.tenantId, v1.profile.profileId)?.profile.profileVersion).toBe(1);
  });
});
