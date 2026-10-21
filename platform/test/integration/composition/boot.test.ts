/**
 * Layer 2 (WP-07): the sandbox profile composes and starts the gateway and the worker from real adapters
 * against the emulators (FO-19-06, FO-16-11, FO-21-03, FO-21-10, FO-00-26, FO-00-30, FO-22-20, OPS-04).
 *
 * buildLiveContainer over PostgreSQL 16 (every migration; the login from a LocalStack Secrets Manager secret),
 * DynamoDB Local (sessions, route-audit journal), ElasticMQ (outbox), LocalStack KMS (assertion signing). What
 * is asserted: readiness lists every capability with its state; a capability without its live adapter or its
 * tenant inputs is NOT_CONFIGURED, its work is refused (guard ports, admission) and the environment still
 * starts; mandatory substrate that is missing refuses the environment before anything is served; the live
 * registry holds no fixture, no canned success, no TEST id and no "not implemented" stub (registry scan).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { CapabilityNotConfiguredError, isGuardPort } from "../../../src/adapters/live/not-configured.js";
import { ConfigInvalidError } from "../../../src/config/schema.js";
import type { KnowledgeItemInput } from "../../../src/knowledge/ports.js";
import { alarmRule, evaluateAlarm } from "../../../src/observability/alarms.js";
import { RUNTIME_CAPABILITY_IDS } from "../../../src/observability/composition-catalog.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import { liveWorkerLoopsFor } from "../../../src/worker/live-loops.js";
import { dynamoClient, uniqueName } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { emulatorProfile } from "../connectors/profiles.js";
import { SUBSTRATE, TENANT as TENANT_ID, bootLive, createKmsKey, createSecretValue, provisionSandbox, refusal } from "./support.js";
import type { Sandbox } from "./support.js";

const it = layer2([...SUBSTRATE]);

/** SYNTHETIC approved knowledge item (public audience, no personal data). */
const SYNTHETIC_KNOWLEDGE_ITEM: KnowledgeItemInput = {
  sourceId: "faq-composition-synthetic",
  sourceSystem: "approved_runbook",
  version: 1,
  title: "Synthetic composition article",
  body: "This synthetic article explains where the portal lists upcoming appointments.",
  owner: "team_support_knowledge",
  audiences: ["public"],
  permittedIntents: ["appointment_reschedule"],
  jurisdiction: "US",
  language: "en",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: "2030-12-31T23:59:59.000Z",
  sensitivity: "PUBLIC",
  approval: { status: "APPROVED", approvedBy: "SYNTHETIC_LAYER2_APPROVER", approvedAt: "2026-09-01T00:00:00.000Z" },
};

let sb: Sandbox;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
});
afterAll(async () => {
  await sb?.close();
});

describe("live composition in the sandbox profile [FO-19-06][FO-16-11]", () => {
  it("[FO-19-06][FO-16-11][FO-21-03][OPS-04] positive: the sandbox gateway starts from real adapters; /health/ready is 200 and lists every capability with its state", async () => {
    const { c, records } = await bootLive(sb);
    try {
      expect([c.label, c.environment, c.report.deployable, c.report.ruleSet]).toEqual(["LIVE COMPOSITION", "sandbox", true, "sandbox"]);
      expect([c.db.constructor.name, c.kv.kind, c.identity.sessions.kind, c.publisher.constructor.name, c.deferredAudit.constructor.name]).toEqual(["PgPoolDb", "live", "live", "SqsPublisher", "DurableDeferredAuditQueue"]);
      const res = await c.app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as { ready: boolean; capabilities: { capabilityId: string; state: string }[] };
      expect(body.ready).toBe(true);
      expect(body.capabilities.map((x) => x.capabilityId).sort()).toEqual([...RUNTIME_CAPABILITY_IDS].sort());
      const state = Object.fromEntries(body.capabilities.map((x) => [x.capabilityId, x.state]));
      for (const id of ["platform.substrate", "platform.composition", "workflows.durable", "operations.resilience_cost"]) expect(state[id], id).toBe("CONFIGURED");
      for (const id of ["domain.business_systems", "contact_center.talkdesk", "crm.salesforce", "identity.caller", "identity.workforce", "operator.console", "audit.independent", "ingress.events", "connectors.runtime"]) {
        expect(state[id], id).toBe("NOT_CONFIGURED");
      }
      // The readiness body never carries reasons or tenant inputs (unauthenticated route).
      expect(res.body).not.toMatch(/arn:aws|PLACEHOLDER|WP-\d\d|_MISSING|softwareGaps|externalInputs|@[a-z]/);
      expect(c.activation.get("domain.business_systems")?.softwareGaps.map((g) => g.owner)).toEqual(["WP-23"]);
      expect(records.some((r) => r.event === "container.ready")).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("[FO-00-30][FO-21-10][OPS-04] positive: the worker composes its live loops over the same container (outbox to SQS, durable deferred audit, route reconciler)", async () => {
    const { c } = await bootLive(sb, { unit: "worker" });
    try {
      const loops = liveWorkerLoopsFor(c, { instanceId: "worker-l2" });
      expect(loops.map((l) => l.name)).toEqual([
        "outbox.dispatch",
        "outbox.consume",
        "actions.reconcile",
        "actions.expire",
        "tools.idempotency_purge",
        "audit.deferred_flush",
        "audit.route_reconcile",
        "workflows.tick",
        "transfers.sweep",
        "retention.run",
        "support.sync_retry",
      ]);
      for (const l of loops) {
        const r = await l.runOnce();
        expect(r.ok, `${l.name} ${r.reasonCode ?? ""}`).toBe(true);
      }
    } finally {
      await c.close();
    }
  });

  it("[FO-00-26][FO-19-06][DATA-01] registry scan: every adapter port of the live registry is either live or a guard port that refuses with CAPABILITY_NOT_CONFIGURED; none answers with canned data", async () => {
    const { c } = await bootLive(sb);
    try {
      const adapters = c.deps.adapters as unknown as Record<string, Record<string, unknown>>;
      expect(Object.keys(adapters).sort()).toEqual(["billing", "claims", "identityDirectory", "notifications", "provider", "relationships", "scheduling", "supportRecords", "telephony"]);
      for (const [name, port] of Object.entries(adapters)) {
        // No fixture, and no stand-in that reports itself healthy: each port is live and, in this sandbox, NOT_CONFIGURED.
        expect(port.kind, name).toBe("live");
        expect(await (port.health as () => Promise<unknown>).call(port), name).toEqual({ healthy: false, reasonCode: "CAPABILITY_NOT_CONFIGURED" });
      }
      expect(["billing", "claims", "identityDirectory", "provider", "relationships", "scheduling", "telephony"].every((k) => isGuardPort(adapters[k]))).toBe(true);
      // Operations of a NOT_CONFIGURED port refuse; no empty history, no success, no TEST id.
      const scheduling = c.deps.adapters.scheduling as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const err = await scheduling.listAppointments!("sub_synthComposition0001").then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityNotConfiguredError);
      expect(err).toMatchObject({ reasonCode: "CAPABILITY_NOT_CONFIGURED", outcome: "NOT_STARTED", retryable: false });
      expect(c.localMetrics.find("vsp_capability_not_configured_reached_total").reduce((n, s) => n + s.value, 0)).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  });

  it("[FO-21-10][FO-00-26][OPS-01] runtime scan of EVERY injected port (business ports, verification, caller id-token verifier, interaction lookup, call-session resolver and its integration identity, quarantine, consent, account state): each is a reviewed live class or a guard port that refuses, counts and pages", async () => {
    const { c } = await bootLive(sb);
    try {
      const ports = c.ports as Record<string, unknown>;
      expect(Object.keys(ports).sort()).toEqual([
        "accountState",
        "billing",
        "callSessionIntegration",
        "callSessions",
        "claims",
        "consentRegistry",
        "identityDirectory",
        "interactionLookup",
        "notifications",
        "oidcVerifier",
        "provider",
        "quarantine",
        "relationships",
        "scheduling",
        "supportRecords",
        "supportRecordsInner",
        "telephony",
        "verification",
      ]);
      // Live implementations composed in this sandbox (their own dependencies are the guard ports listed below).
      const liveClasses: Record<string, string> = {
        callSessions: "InteractionIndexCallSessions",
        notifications: "KillSwitchGatedNotificationSender",
        supportRecords: "KillSwitchGatedSupportRecords",
        verification: "SecureVerificationService",
      };
      const guards = Object.keys(ports).filter((k) => !Object.hasOwn(liveClasses, k)).sort();
      for (const [name, cls] of Object.entries(liveClasses)) expect((ports[name] as object).constructor.name, name).toBe(cls);
      const reached = () => c.localMetrics.find("vsp_capability_not_configured_reached_total").reduce((n, s) => n + s.value, 0);
      for (const name of guards) {
        const port = ports[name] as Record<string, unknown> & ((...a: unknown[]) => Promise<unknown>);
        expect(isGuardPort(port), name).toBe(true);
        expect(port.kind, name).toBe("live");
        const before = reached();
        // Any operation of a guard port (or the guard operation itself) refuses: nothing is answered.
        const call = typeof port === "function" ? port() : (port as unknown as Record<string, () => Promise<unknown>>).anyOperation!();
        const e = await call.then(() => null, (x: unknown) => x);
        expect(e, name).toBeInstanceOf(CapabilityNotConfiguredError);
        expect(reached(), name).toBe(before + 1);
      }
      // The call-session resolver (session-less safety escalation, business/handoff.ts) no longer short-circuits
      // on a canned null: it reaches the telephony guard operation, which counts and pages; its answer stays null
      // (no session found) and the escalation falls back as before, now with the paging signal.
      const before = reached();
      expect(await c.deps.callSessions?.resolveForCall(TENANT_ID, "cal_synthComposition000001")).toBeNull();
      expect(reached()).toBe(before + 1);
      const samples = c.localMetrics.find("vsp_capability_not_configured_reached_total").map((s) => ({ metric: s.name, labels: s.labels, value: s.value }));
      expect(evaluateAlarm(alarmRule("capability-guard-port-reached"), samples)).toMatchObject({ state: "ALARM" });
      expect(samples.some((s) => s.labels.capability === "contact_center.talkdesk" && s.value > 0)).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("[FO-00-30][OPS-04] positive: a missing tenant input disables only its capability: without the connector profile connectors.runtime turns NOT_CONFIGURED with its reason, every other capability keeps its state and reasons, and the gateway still starts (readiness 200); without the OTP pepper only identity.caller's entry changes", async () => {
    // The tenant input: a connector profile (reviewed configuration of the tenant's vendor) with its credentials.
    const readRef = await createSecretValue(sb.sm, "boot-conn-read", JSON.stringify({ clientId: "client-read", clientSecret: "secret-read-boot-l2" }));
    const writeRef = await createSecretValue(sb.sm, "boot-conn-write", JSON.stringify({ clientId: "client-write", clientSecret: "secret-write-boot-l2" }));
    mkdirSync(join(sb.repoRoot, "connectors"), { recursive: true });
    writeFileSync(join(sb.repoRoot, "connectors", "vendor-emulated.json"), JSON.stringify(emulatorProfile({ readRef, writeRef, mutate: (p) => ({ ...p, tenantId: TENANT_ID }) }), null, 2));
    // More CONFIGURED capabilities in the baseline, so a coupling of one input into ANOTHER capability is visible
    // (a capability that is already NOT_CONFIGURED with the same reason cannot show it):
    //   knowledge.retrieval: one approved, retrievable knowledge item, ingested through the composed service;
    //   audit.independent: the export block (its own manifest key and its own exporter and verifier logins).
    {
      const { c } = await bootLive(sb);
      try {
        const ingested = await c.knowledge.ingest(TENANT_ID, [SYNTHETIC_KNOWLEDGE_ITEM]);
        expect(ingested.accepted).toEqual([SYNTHETIC_KNOWLEDGE_ITEM.sourceId]);
      } finally {
        await c.close();
      }
    }
    const manifestKey = await createKmsKey(sb.kms);
    const exporterRef = await createSecretValue(sb.sm, "boot-audit-exporter", "postgres://exporter-login-not-used-by-the-gateway");
    const verifierRef = await createSecretValue(sb.sm, "boot-audit-verifier", "postgres://verifier-login-not-used-by-the-gateway");
    const withExport = (cfg: ReturnType<Sandbox["config"]>) => {
      cfg.infrastructure.auditExport = { manifestSigningKeyId: manifestKey, exporterDatabaseRef: exporterRef, verifierDatabaseRef: verifierRef, trustedManifestKeyIds: [manifestKey] };
      return cfg;
    };
    type Entry = { state: string; reasons: string[] };
    /** Boots the gateway on `cfg` and returns every capability's state and reasons, readiness and deployability. */
    const boot = async (cfg: ReturnType<Sandbox["config"]>) => {
      sb.writeConfig(cfg);
      const { c } = await bootLive(sb);
      try {
        const ready = await c.app.inject({ method: "GET", url: "/health/ready" });
        const entries: Record<string, Entry> = Object.fromEntries(c.activation.entries().map((e) => [e.capabilityId, { state: e.state, reasons: [...e.reasons].sort() }]));
        return { entries, ready: ready.statusCode, readyBody: JSON.parse(ready.body) as { ready: boolean; capabilities: { capabilityId: string; state: string }[] }, deployable: c.report.deployable };
      } finally {
        await c.close();
      }
    };
    const changed = (a: Record<string, Entry>, b: Record<string, Entry>) => Object.keys(a).filter((id) => JSON.stringify(a[id]) !== JSON.stringify(b[id])).sort();
    try {
      const withProfile = withExport(sb.config());
      (withProfile as Record<string, unknown>).connectors = { profileDirectory: "connectors", feeds: [] };
      const before = await boot(withProfile);
      expect(before.deployable).toBe(true);
      expect(before.ready).toBe(200);
      expect(before.entries["connectors.runtime"]?.state).toBe("CONFIGURED");
      // Other capabilities are CONFIGURED too, so "nothing else changed" compares real states.
      for (const id of ["knowledge.retrieval", "audit.independent", "platform.substrate", "workflows.durable"]) expect(before.entries[id], id).toEqual({ state: "CONFIGURED", reasons: [] });

      // Remove exactly that input.
      const after = await boot(withExport(sb.config()));
      expect(after.deployable).toBe(true);
      expect(after.ready).toBe(200);
      expect(after.readyBody.ready).toBe(true);
      expect(after.entries["connectors.runtime"]).toMatchObject({ state: "NOT_CONFIGURED", reasons: expect.arrayContaining(["CONNECTOR_PROFILES_NOT_CONFIGURED@connectors.profileDirectory"]) });
      expect(after.readyBody.capabilities.find((x) => x.capabilityId === "connectors.runtime")?.state).toBe("NOT_CONFIGURED");
      expect(changed(before.entries, after.entries)).toEqual(["connectors.runtime"]);

      // A second tenant input of another capability: the OTP pepper of caller verification.
      const noOtp = withExport(sb.config());
      noOtp.infrastructure.secrets.otpPepperRef = null;
      const otp = await boot(noOtp);
      expect(otp.deployable).toBe(true);
      expect(otp.ready).toBe(200);
      expect(otp.entries["identity.caller"]?.reasons).toContain("OTP_PEPPER_REF_MISSING@infrastructure.secrets.otpPepperRef");
      expect(changed(after.entries, otp.entries)).toEqual(["identity.caller"]);
      for (const id of ["knowledge.retrieval", "audit.independent"]) expect(otp.entries[id], id).toEqual({ state: "CONFIGURED", reasons: [] });
    } finally {
      rmSync(join(sb.repoRoot, "connectors"), { recursive: true, force: true });
      await sb.idb.db.tx(async (tx) => tx.query("delete from knowledge_items where tenant_id = $1", [TENANT_ID]), { role: "owner" }).catch(() => undefined);
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-00-30] ingress.events reports missing code as a software gap, apart from its one tenant input: with every input supplied it stays NOT_CONFIGURED with the gap and no reason; an ingress.sourceDirectory key is refused by the strict schema (a key nothing reads never stands in for the code)", async () => {
    const entry = async (cfg: ReturnType<Sandbox["config"]>) => {
      sb.writeConfig(cfg);
      const { c } = await bootLive(sb);
      try {
        const e = c.activation.get("ingress.events");
        return { state: e?.state, reasons: [...(e?.reasons ?? [])], softwareGaps: [...(e?.softwareGaps ?? [])], externalInputs: [...(e?.externalInputs ?? [])], deployable: c.report.deployable };
      } finally {
        await c.close();
      }
    };
    const gap = [{ owner: "WP-07", reasonCode: "INGRESS_PLUGIN_NOT_COMPOSED" }];
    try {
      // Without the payload key: the tenant input is a reason, the missing code a software gap, listed apart.
      const base = await entry(sb.config());
      expect(base).toMatchObject({ state: "NOT_CONFIGURED", reasons: ["INGRESS_PAYLOAD_KEY_NOT_CONFIGURED@infrastructure.ingressPayloadKeyId"], softwareGaps: gap, deployable: true });
      expect(base.externalInputs.length).toBeGreaterThan(0);
      expect(base.reasons.some((r) => r.includes("ingress.") && !r.endsWith("@infrastructure.ingressPayloadKeyId"))).toBe(false);

      // Every tenant input supplied (a real ENCRYPT_DECRYPT KMS key): still NOT_CONFIGURED, only the gap remains.
      const withKey = sb.config();
      withKey.infrastructure.ingressPayloadKeyId = await createKmsKey(sb.kms, { usage: "ENCRYPT_DECRYPT" });
      const keyed = await entry(withKey);
      expect(keyed).toMatchObject({ state: "NOT_CONFIGURED", reasons: [], softwareGaps: gap, deployable: true });

      // A source directory key does not exist: the configuration is refused at load (never read as an input).
      const withDir = sb.config();
      (withDir as Record<string, unknown>).ingress = { sourceDirectory: "ingress" };
      sb.writeConfig(withDir);
      const err = await bootLive(sb).then(
        async (x) => {
          await x.c.close();
          return null;
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConfigInvalidError);
      expect((err as ConfigInvalidError).issues).toContain("$:unrecognized_keys");
    } finally {
      sb.writeConfig(sb.config());
    }
  });

  it("[OPS-04][FO-19-06] adversarial: missing mandatory substrate refuses the whole environment before anything is served (no outbox queue, no journal table, memory sessions, PGlite)", async () => {
    const cfg = sb.config();
    (cfg.infrastructure as Record<string, unknown>).outbox = null;
    (cfg.infrastructure as Record<string, unknown>).routeAuditJournalTable = null;
    (cfg as Record<string, unknown>).sessionStore = { kind: "memory", tableName: null };
    (cfg as Record<string, unknown>).database = { engine: "pglite", connectionRef: null };
    sb.writeConfig(cfg);
    try {
      const v = await refusal(bootLive(sb));
      expect(v).toEqual(
        expect.arrayContaining([
          "OUTBOX_QUEUE_NOT_CONFIGURED@infrastructure.outbox",
          "AUDIT_JOURNAL_TABLE_NOT_CONFIGURED@infrastructure.routeAuditJournalTable",
          "SESSION_STORE_MEMORY@sessionStore.kind",
          "DATABASE_ENGINE_PGLITE@database.engine",
        ]),
      );
    } finally {
      sb.writeConfig(sb.config());
    }
  });

  it("[OPS-04][FO-16-11] failure injection: a database whose schema is behind the code refuses the unit (SCHEMA_MIGRATIONS_PENDING) and nothing is listening", async () => {
    // Remove the newest migration's record: the serving process must not run on a schema older than its code.
    await sb.idb.db.tx(async (tx) => tx.query("delete from schema_migrations where name = (select max(name) from schema_migrations)"), { role: "owner" });
    try {
      const v = await refusal(bootLive(sb));
      expect(v.some((x) => x.startsWith("SCHEMA_MIGRATIONS_PENDING@migrations."))).toBe(true);
    } finally {
      // Re-applying the migration record restores the database for the rest of the file.
      const { listMigrations } = await import("../../../src/db/migrate.js");
      const last = listMigrations().at(-1);
      if (last) await sb.idb.db.tx(async (tx) => tx.query("insert into schema_migrations (name, checksum) values ($1, $2) on conflict do nothing", [last.name, last.checksum]), { role: "owner" });
    }
  });

  it("[FO-16-11][OPS-01] failure injection: a session store whose table is gone fails closed at use (the live DynamoDB store, not a memory fallback)", async () => {
    const cfg = sb.config();
    (cfg as Record<string, unknown>).sessionStore = { kind: "dynamodb", tableName: uniqueName("vsp-it-comp-missing") };
    sb.writeConfig(cfg);
    try {
      const { c } = await bootLive(sb);
      try {
        const err = await c.kv.get("sess#synthMissingTable").then(() => null, (e: unknown) => e);
        expect(err).not.toBeNull();
        // The real table keeps working for the rest of the file (a second client never sees the missing one).
        const dynamo = dynamoClient(sb.l2);
        await dynamo.send(new PutItemCommand({ TableName: sb.tables.sessions, Item: { pk: { S: "probe#composition" }, version: { N: "1" } } }));
        dynamo.destroy();
      } finally {
        await c.close();
      }
    } finally {
      sb.writeConfig(sb.config());
    }
  });
});
