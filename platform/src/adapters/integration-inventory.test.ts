import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FakeClock } from "../shared/clock.js";
import { INTEGRATION_INVENTORY, IntegrationInventoryEntrySchema, inventoryFor, validatedInventory } from "./integration-inventory.js";
import { createLocalFixtureSet } from "./local/fixture-set.js";
import { createBlockedLiveRegistry } from "./live/blocked-set.js";
import { TalkdeskExploreClient } from "./live/talkdesk-blocked.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

const PRQ_IDS = new Set((parseYaml(read("docs/prerequisites.yaml")) as { records: { id: string }[] }).records.map((r) => r.id));
const VQ_IDS = new Set(read("talkdesk/vendor-questions.md").match(/VQ-[A-Z]{2,4}-\d{2}/g) ?? []);
const SOURCE_REGISTER_URLS = new Set(read("docs/spec/voice-support-specification.txt").match(/https:\/\/\S+/g) ?? []);
const CONFIG_ADAPTER_KEYS = Object.keys((JSON.parse(read("platform/config/local.json")) as { adapters: Record<string, unknown> }).adapters);

describe("Integration inventory (machine-readable, spec section 16)", () => {
  it("[SPEC-16.inventory] every entry records method, endpoint, version, auth, schema, rate limit, retention, data class and source, with unique ids", () => {
    const entries = validatedInventory();
    expect(entries.length).toBeGreaterThanOrEqual(25);
    for (const e of entries) {
      for (const field of ["method", "endpoint", "version", "authMechanism", "schemaRef", "rateLimit", "retention", "sourceDoc"] as const) expect(e[field].length).toBeGreaterThan(0);
      expect(e.dataClass).toBeDefined();
    }
    expect(() => validatedInventory([...INTEGRATION_INVENTORY, INTEGRATION_INVENTORY[0]!])).toThrow(expect.objectContaining({ reasonCode: "INVENTORY_DUPLICATE_ID" }));
    expect(IntegrationInventoryEntrySchema.safeParse({ ...INTEGRATION_INVENTORY[0], status: "VERIFIED_SANDBOX" }).success).toBe(false);
  });

  it("[OPS-03] values that are not documented are UNKNOWN: an outbound integration without a source document has no method, endpoint or version", () => {
    for (const e of INTEGRATION_INVENTORY.filter((x) => x.sourceRef === "NONE_SUPPLIED" && x.direction === "outbound")) {
      expect(e.method.startsWith("UNKNOWN")).toBe(true);
      expect(e.endpoint.startsWith("UNKNOWN")).toBe(true);
      expect(e.version.startsWith("UNKNOWN")).toBe(true);
      expect(e.status).not.toBe("IMPLEMENTED_OFFLINE");
    }
    for (const e of inventoryFor("talkdesk-telephony")) expect([e.method, e.endpoint, e.version]).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    const explore = INTEGRATION_INVENTORY.find((e) => e.id === "talkdesk.explore.historical_reports");
    expect(explore?.endpoint.startsWith("UNKNOWN")).toBe(true);
    expect(explore?.status).toBe("BLOCKED");
  });

  it("[OPS-03][SPEC-16.status-vocabulary] no entry claims sandbox or production verification; IMPLEMENTED_OFFLINE is only used where an offline-tested live code path exists", () => {
    for (const e of INTEGRATION_INVENTORY) {
      expect(["UNKNOWN", "BLOCKED", "IMPLEMENTED_OFFLINE"]).toContain(e.status);
      expect(`${e.notes} ${e.status}`).not.toMatch(/VERIFIED_SANDBOX|VERIFIED_PRODUCTION|production[- ]ready|HIPAA[- ]compliant/i);
      if (e.status === "IMPLEMENTED_OFFLINE") {
        expect(e.implementation.live).not.toBeNull();
        expect(e.implementation.tests.length).toBeGreaterThan(0);
        expect(e.prerequisites.length).toBeGreaterThan(0);
      }
    }
    expect(INTEGRATION_INVENTORY.filter((e) => e.status === "IMPLEMENTED_OFFLINE").every((e) => e.integrationId === "salesforce")).toBe(true);
  });

  it("[SPEC-16.inventory] coverage: Salesforce, Talkdesk MCP inbound / Explore / telephony control / events, business systems, IdPs, notifications and AWS", () => {
    const ids = new Set(INTEGRATION_INVENTORY.map((e) => e.id));
    for (const required of [
      "salesforce.case.upsert",
      "salesforce.interaction.upsert",
      "salesforce.oauth.client_credentials",
      "talkdesk.mcp.inbound_tools",
      "talkdesk.explore.historical_reports",
      "talkdesk.telephony.transfer",
      "talkdesk.events.transfer_lifecycle",
      "scheduling.appointments",
      "billing.invoices",
      "claims.status",
      "provider.onboarding_remittance",
      "idp.client.oidc",
      "idp.provider.oidc",
      "idp.workforce.sso",
      "notifications.send",
      "aws.dynamodb.sessions",
      "aws.sqs.outbox",
      "aws.s3.audit_object_lock",
      "aws.stepfunctions.workflows",
      "aws.kms.signing",
      "aws.secretsmanager.credentials",
      "aws.aurora.postgresql",
    ]) {
      expect(ids.has(required)).toBe(true);
    }
    const integrationIds = new Set(INTEGRATION_INVENTORY.map((e) => e.integrationId));
    for (const key of CONFIG_ADAPTER_KEYS) expect(integrationIds.has(key)).toBe(true);
    const registered = [
      ...createLocalFixtureSet({ clock: new FakeClock() }).registry.summary().components,
      ...createBlockedLiveRegistry().summary().components,
    ].map((c) => c.integrationId);
    for (const id of [...registered, new TalkdeskExploreClient().integrationId]) expect(integrationIds.has(id)).toBe(true);
  });

  it("[SPEC-16.inventory] cross-references resolve: PRQ ids, vendor questions, source-register URLs and implementation files exist", () => {
    for (const e of INTEGRATION_INVENTORY) {
      for (const p of e.prerequisites) expect(PRQ_IDS.has(p)).toBe(true);
      for (const q of e.vendorQuestions) expect(VQ_IDS.has(q)).toBe(true);
      for (const url of e.sourceDoc.match(/https?:\/\/[^\s)]+/g) ?? []) expect(SOURCE_REGISTER_URLS.has(url)).toBe(true);
      for (const f of [e.implementation.live, e.implementation.fixture, ...e.implementation.tests]) if (f !== null) expect(existsSync(resolve(REPO, f))).toBe(true);
    }
  });

  it("[DATA-03] retention is never an invented duration — it is UNKNOWN or deferred to privacy counsel", () => {
    for (const e of INTEGRATION_INVENTORY) expect(e.retention).not.toMatch(/\b\d+\s*(day|days|month|months|year|years)\b/i);
    for (const e of INTEGRATION_INVENTORY.filter((x) => x.dataClass !== "NONE" && x.dataClass !== "UNKNOWN" && x.dataClass.includes("BUSINESS_RECORD") && x.integrationId !== "salesforce")) {
      expect(e.retention).toMatch(/UNKNOWN|PRQ-025/);
    }
  });
});
