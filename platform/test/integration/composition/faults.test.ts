/**
 * Layer 2 (WP-07): the composition's fault runs, at their real injection points.
 *
 * [FAULT:AUTH_EXPIRY_MID_CALL] (FO-17-24.AUTH_EXPIRY_MID_CALL; AUTH-02, OPS-04). The composed live gateway
 * (buildLiveContainer, sandbox) over the DynamoDB Local session store, with the WP-05 SessionExpirySeam as the
 * container's clock. A call is started, its session is used by a commit that passes the session step, the seam
 * moves time past the session's hard expiry, and the next commit fails closed SESSION_EXPIRED; the refusal is
 * in the durable audit outbox and the DynamoDB item still exists (TTL is never the gate).
 *
 * What makes "nothing downstream ran" falsifiable here: the pipeline's step after the session step is the
 * admission gate, and in this build every scheduling intent is refused there (domain.business_systems is
 * NOT_CONFIGURED: no live scheduling adapter exists, WP-23), counted in vsp_capability_refusals_total{surface:
 * admission}. The control commit before the expiry MUST move that counter by one (it passed the session step
 * and reached admission); the commit after the expiry must leave it, and the guard-port counter, unchanged: it
 * stopped at the session step, before admission, policy, the ledger and any provider. A mutant that skips the
 * expiry check reaches admission and fails both assertions. Not covered (gap, stated in the report): a real
 * prepare and a commit that reaches a provider, which needs a live scheduling adapter (WP-23); and the
 * EvaluationResult requestedFault/reachedFault record (WP-34).
 * Seam scope: SessionExpirySeam.wrap refuses every environment but local/ci (fault seams never run deployed),
 * so it is wrapped with "ci" and handed to the sandbox container as its clock (labelled test plumbing); the
 * container itself runs the sandbox rule set.
 *
 * Test plumbing, labelled: the caller's verified state (A2) is written through the production SessionStore,
 * because caller verification is NOT_CONFIGURED in this build (identity.caller, WP-19).
 *
 * [FAULT:DLQ_FULL] (FO-17-24.DLQ_FULL; OPS-01, DATA-01). The live worker's connector change feed composed by
 * composeConnectorFeeds over the live container: the WP-06 ConnectorRuntime (egress-classified transport, TLS,
 * Secrets Manager credentials) against the vendor emulator on the private host interface, the IncrementalReader
 * with durable PostgreSQL checkpoints, the content-free feed index and the SQS dead-letter writer on ElasticMQ.
 * The WP-04 seam makes the dead-letter queue unwritable (deleted). A record without a key must be
 * dead-lettered; the write is refused, so the page rolls back: consumption stops (no further page is read),
 * the paging alarm rule fires, the checkpoint is kept and nothing is indexed. Once the queue accepts again the
 * next run resumes from the kept checkpoint and every record is indexed or dead-lettered.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { CreateQueueCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, onTestFinished } from "vitest";
import { applyMapping, compileMapping } from "../../../src/connectors/dsl/mapping.js";
import type { ConnectorMappingTables, FieldMapping } from "../../../src/protocol/connector.js";
import { sessionRefHash } from "../../../src/identity/keys.js";
import { SessionExpirySeam } from "../../../src/identity/expiry-seam.js";
import { composeConnectorFeeds } from "../../../src/main/live-worker.js";
import { alarmRule, evaluateAlarm } from "../../../src/observability/alarms.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import type { IntegrationIdentity } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { ConnectorFeedLoop } from "../../../src/worker/live-loops.js";
import { dynamoClient } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { VendorEmulator } from "../connectors/emulator.js";
import { API_HOST, AUTH_HOST, PROFILE_ID, emulatorProfile } from "../connectors/profiles.js";
import { createSecret } from "../connectors/support.js";
import { refusingDeadLetterQueue } from "../substrate/seams.js";
import { SUBSTRATE, TENANT, bootLive, createPki, createQueue, privateInterfaceAddress, privateResolver, provisionSandbox } from "./support.js";
import type { Sandbox, TestPki } from "./support.js";

const it = layer2([...SUBSTRATE]);

let sb: Sandbox;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
});
afterAll(async () => {
  await sb?.close();
});

const counter = (samples: readonly { value: number }[]) => samples.reduce((n, s) => n + s.value, 0);

/**
 * Independent reference of the feed's keyed digests (DATA-01; not the production FeedDigester): HMAC-SHA256
 * under the HKDF-SHA256 subkey (salt "vsp.connector-feed", info "vsp.connector-feed.digest.v1") of the
 * sandbox's request-hash pepper, read back from Secrets Manager, over NUL-joined fields. A digest that matches
 * this for the sandbox's own pepper is keyed by that environment's secret: an unkeyed hash, an empty or constant
 * key, or the raw pepper as the key gives another value.
 */
async function feedReference(sb: Sandbox): Promise<{ recordKey: (key: string) => string; record: (values: Record<string, unknown>) => string }> {
  const secret = await sb.sm.send(new GetSecretValueCommand({ SecretId: sb.refs.pepper }));
  const pepper = Buffer.from(secret.SecretString ?? "", "base64");
  expect(pepper.length).toBe(32);
  const key = Buffer.from(hkdfSync("sha256", pepper, Buffer.from("vsp.connector-feed", "utf8"), Buffer.from("vsp.connector-feed.digest.v1", "utf8"), 32));
  const mac = (parts: readonly string[]) => createHmac("sha256", key).update(parts.join("\u0000"), "utf8").digest("hex");
  const scope = [TENANT, PROFILE_ID, "appointments"] as const;
  return {
    recordKey: (k) => mac(["record-key", ...scope, k]),
    record: (values) => mac(["record", ...scope, JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k] ?? null]))]),
  };
}

/** The mapped values of one emulator record, through the profile's own mapping (what the feed digests). */
function mappedValues(sb: Sandbox, wire: Record<string, unknown>): Record<string, unknown> {
  const profile = JSON.parse(readFileSync(join(sb.repoRoot, "connectors", "vendor-emulated.json"), "utf8")) as { mappings: FieldMapping[]; mappingTables?: ConnectorMappingTables };
  const [mapped] = applyMapping(compileMapping("Appointment", profile.mappings, profile.mappingTables), { items: [wire] }, "/items");
  expect(mapped).toBeDefined();
  return mapped!.values as Record<string, unknown>;
}

describe("[FAULT:AUTH_EXPIRY_MID_CALL] session expiry between a session-bound call and the commit, in the composed live gateway", () => {
  it("[FAULT:AUTH_EXPIRY_MID_CALL][FO-17-24.AUTH_EXPIRY_MID_CALL][AUTH-02][OPS-04] the commit after expiry fails closed at the session step (before admission and any provider) while the DynamoDB session row still exists", async () => {
    const seam = SessionExpirySeam.wrap(systemClock, { environment: "ci" });
    const { c } = await bootLive(sb, { clock: seam, env: { VSP_MUTATIONS_ENABLED: "true" } });
    try {
      expect(c.mutationsEnabled).toBe(true);
      const ident = (channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({ integrationId: "it-contact-center", tenantId: TENANT, environment: "sandbox", channel, credentialId: `cred-${channel.replace(/_/g, "-")}`, authMethod: "oauth2_client_credentials" });
      const started = await c.identity.sessions.startCall({
        integration: ident("telephony_control"),
        callId: newId("cal"),
        callerIdHash: null,
        consent: { recording: "GRANTED", automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-l2-v1", capturedAt: seam.now().toISOString(), capturedBy: "studio_flow" },
      });
      // Verified caller state through the production SessionStore (identity.caller is NOT_CONFIGURED in this build).
      const hash = sessionRefHash(started.sessionRef);
      const bound = await c.identity.sessions.store.mutate(hash, (rec, now) => ({
        ...rec,
        lastActivityAt: now.toISOString(),
        actorId: "act_synthCompositionCaller01",
        accountId: "acc_synthCompositionCaller01",
        selectedRole: "client",
        subjectId: "sub_synthCompositionCaller01",
        organizationId: null,
        delegatedAuthority: [],
        permittedScopes: ["appointment:commit_change", "appointment:prepare_change", "appointment:list_options"],
        assurance: "A2",
        authenticatedAt: now.toISOString(),
        verificationMethod: "secure_link_oidc",
        stepUp: null,
        lastChange: "VERIFIED_SECURE_LINK",
      }));
      expect("aborted" in bound).toBe(false);
      const transport = { kind: "mcp" as const, sessionRefHeader: started.sessionRef, interactionIdHeader: null };
      const commit = () =>
        c.pipeline.invoke({ name: "commit_appointment_change", version: null, arguments: { actionId: "act_synthCompositionAction01", digest: "a".repeat(64) }, idempotencyKey: newId("idk") }, ident("mcp_tools"), transport);
      const admissionRefusals = () => counter(c.localMetrics.find("vsp_capability_refusals_total").filter((x) => x.labels.surface === "admission"));
      const guardPortsReached = () => counter(c.localMetrics.find("vsp_capability_not_configured_reached_total"));

      // Control: before the expiry the commit passes the session step and is refused at the NEXT step, admission.
      const atStart = admissionRefusals();
      const before = await commit();
      expect(before).toMatchObject({ status: "POLICY_DENIED", reasonCode: "CAPABILITY_NOT_CONFIGURED" });
      expect(admissionRefusals()).toBe(atStart + 1);

      // Fault: the session's hard expiry passes between the two calls (injected clock, the record untouched).
      seam.jumpPastExpiry(started.expiresAt);
      expect(seam.injections).toBeGreaterThanOrEqual(1);
      const afterExpiry = admissionRefusals();
      const reachedBefore = guardPortsReached();
      const after = await commit();
      expect(after.status).toBe("POLICY_DENIED");
      expect((after as { reasonCode: string }).reasonCode).toMatch(/^SESSION_EXPIRED$/);

      // Postconditions: stopped at the session step (admission never reached, no guard port, so no provider path),
      // durable evidence of the refusal, and the row still stored.
      expect(admissionRefusals()).toBe(afterExpiry);
      expect(guardPortsReached()).toBe(reachedBefore);
      const evidence = after.auditEventId
        ? (await c.db.query<{ action: string; outcome: string; event: { reasonCode?: string | null } }>("select action, outcome, event from audit_outbox where event_id = $1", [after.auditEventId])).rows[0]
        : undefined;
      expect(evidence).toMatchObject({ action: "tool.invoke", event: { reasonCode: "SESSION_EXPIRED" } });
      const dynamo = dynamoClient(sb.l2);
      const item = await dynamo.send(new GetItemCommand({ TableName: sb.tables.sessions, Key: { pk: { S: `ses#${hash}` } }, ConsistentRead: true }));
      dynamo.destroy();
      expect(item.Item, "the session item is still stored (TTL cleanup has not run)").toBeDefined();
      expect(Date.parse(started.expiresAt)).toBeLessThan(seam.now().getTime());
    } finally {
      await c.close();
    }
  });
});

describe("[FAULT:DLQ_FULL] the live worker's connector feed with its dead-letter queue unwritable", () => {
  let pki: TestPki;
  let em: VendorEmulator;
  beforeAll(async () => {
    pki = createPki([API_HOST, AUTH_HOST]);
    em = await new VendorEmulator({ tls: { cert: pki.certPem, key: pki.keyPem }, host: privateInterfaceAddress(), clients: { "client-read": "secret-read-composition-l2", "client-write": "secret-write-composition-l2" }, clientScopes: { "client-read": ["appointments:read"], "client-write": ["appointments:write"] } }).start();
  });
  afterAll(async () => {
    await em?.stop();
    pki?.dispose();
  });

  /** Writes the vendor profile and the feed into the sandbox. */
  async function configureFeed(sb: Sandbox, deadLetterQueueUrl: string): Promise<void> {
    const readRef = await createSecret(sb.sm, "comp-conn-read", { clientId: "client-read", clientSecret: "secret-read-composition-l2" });
    const writeRef = await createSecret(sb.sm, "comp-conn-write", { clientId: "client-write", clientSecret: "secret-write-composition-l2" });
    const port = em.port;
    const profile = emulatorProfile({
      readRef,
      writeRef,
      auth: { tokenUrl: `https://${AUTH_HOST}:${port}/oauth/token` },
      mutate: (p) => ({
        ...p,
        tenantId: TENANT,
        baseUrl: `https://${API_HOST}:${port}/api/v1`,
        documentationUrl: `https://${API_HOST}:${port}/docs`,
        network: { addressClass: "PRIVATE_NETWORK", tlsCaRef: null },
        // A record may arrive without its key: the feed projects what it can and dead-letters the rest.
        mappings: p.mappings.map((m) => (m.targetField === "appointmentId" ? { ...m, requirement: "OPTIONAL" as const } : m)),
      }),
    });
    mkdirSync(join(sb.repoRoot, "connectors"), { recursive: true });
    writeFileSync(join(sb.repoRoot, "connectors", "vendor-emulated.json"), JSON.stringify(profile, null, 2));
    const cfg = sb.config();
    cfg.infrastructure.privateNetworkHosts = [API_HOST, AUTH_HOST];
    cfg.egress.destinations = [
      {
        destinationId: "egr_scheduling_emulated",
        kind: "SYSTEM_OF_RECORD",
        hosts: [`${API_HOST}:${port}`, `${AUTH_HOST}:${port}`],
        allowedClasses: ["INTERNAL", "PHI", "FINANCIAL"],
        coverage: { baaRef: "baa-synthetic-emulator", approvalId: "apr_synthEmulatorApproval1" },
        environments: ["sandbox"],
        adapterKind: "live",
      },
    ];
    (cfg as Record<string, unknown>).connectors = {
      profileDirectory: "connectors",
      feeds: [{ profileId: PROFILE_ID, streamId: "appointments", operationId: "appointments.changes", intervalMs: 60_000, maxPagesPerRun: 10, deadLetterQueueUrl, keyField: "appointmentId", updatedAtField: "updatedAt" }],
    };
    sb.writeConfig(cfg);
  }

  it("[FAULT:DLQ_FULL][FO-17-24.DLQ_FULL][OPS-01][DATA-01] consumption stops, the paging alarm fires and the source checkpoint is kept; nothing is dropped and the feed resumes from the checkpoint once the queue accepts", async () => {
    const dlq = await refusingDeadLetterQueue(sb.sqs, "missing");
    await configureFeed(sb, dlq);
    // Record seq 3 arrives without its key (the vendor omitted it): it must be dead-lettered.
    const keyless = em.records[2] as unknown as { id?: string };
    delete keyless.id;
    const { c } = await bootLive(sb, { unit: "worker", network: { resolve: privateResolver([API_HOST, AUTH_HOST]), tlsCa: [pki.caPem] } });
    try {
      expect(c.activation.state("connectors.runtime")).toBe("CONFIGURED");
      const feeds = composeConnectorFeeds(c);
      expect(feeds).toHaveLength(1);
      const feed = feeds[0]!;
      const loop = new ConnectorFeedLoop(feeds);
      const changesRequests = () => em.received.filter((r) => r.path === "/api/v1/changes");

      // Fault reached: the first page carries the keyless record; its dead-letter write is refused.
      const r1 = await loop.runOnce();
      expect(r1).toMatchObject({ ok: false, reasonCode: "DLQ_WRITE_REFUSED" });
      expect(changesRequests()).toHaveLength(1);
      expect(await feed.checkpoint()).toBeNull();
      const indexed = async () => Number((await c.db.query<{ n: number }>("select count(*)::int as n from connector_feed_index where tenant_id = $1", [TENANT])).rows[0]?.n ?? -1);
      expect(await indexed()).toBe(0);
      const refused = c.localMetrics.find("vsp_connector_feed_dead_letter_refused_total").map((s) => ({ metric: "vsp_connector_feed_dead_letter_refused_total", labels: s.labels, value: s.value }));
      expect(evaluateAlarm(alarmRule("connector-feed-dead-letter-refused"), refused)).toMatchObject({ state: "ALARM", observed: 1 });

      // Still refusing: the next run starts from the same (kept) position and stops again; nothing advances.
      const r2 = await feed.runOnce();
      expect(r2).toMatchObject({ result: "stopped", reasonCode: "DLQ_WRITE_REFUSED", indexed: 0 });
      expect(changesRequests().map((r) => r.query.cursor ?? null)).toEqual([null, null]);
      expect(await feed.checkpoint()).toBeNull();

      // The queue accepts again: the feed resumes from the kept checkpoint; every record is indexed or dead-lettered.
      const name = new URL(dlq).pathname.split("/").pop()!;
      await sb.sqs.send(new CreateQueueCommand({ QueueName: name }));
      const r3 = await feed.runOnce();
      expect(r3).toMatchObject({ result: "caught_up", reasonCode: null, deadLettered: 1, indexed: em.records.length - 1 });
      expect(await indexed()).toBe(em.records.length - 1);
      expect((await feed.checkpoint())?.cursor).toBe(String(em.records.length));
      const msgs = await sb.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      expect(msgs.Messages ?? []).toHaveLength(1);
      // Content-free envelope: schema, tenant, profile, stream, digest and reason only; no record values.
      const body = JSON.parse(msgs.Messages?.[0]?.Body ?? "{}") as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["deadLetteredAt", "profileId", "reasonCode", "recordDigest", "schema", "streamId", "tenantId"]);
      expect(msgs.Messages?.[0]?.Body ?? "").not.toMatch(/apt-|SYNTHETIC|booked|cancelled|completed|2026-11-/);
      // Keyed digests (DATA-01): no index row and no envelope carries the plain SHA-256 of a (low-entropy) record
      // key, so a guessed appointment number cannot be confirmed against them.
      const rows = (await c.db.query<{ d: string }>("select record_key_digest as d from connector_feed_index where tenant_id = $1", [TENANT])).rows.map((x) => x.d);
      expect(rows).toHaveLength(em.records.length - 1);
      const plain = new Set(em.records.map((x) => (x as { id?: string }).id).filter((k): k is string => typeof k === "string").map((k) => createHash("sha256").update(k).digest("hex")));
      expect(plain.size).toBe(em.records.length - 1);
      expect(rows.filter((d) => plain.has(d))).toEqual([]);
      expect(String(body.recordDigest)).toMatch(/^[a-f0-9]{64}$/);
      expect(plain.has(String(body.recordDigest))).toBe(false);
      // Exactly the keyed construction under THIS environment's pepper (independent reference): every index row,
      // and the envelope's record digest over the keyless record's mapped values.
      const ref = await feedReference(sb);
      const keys = em.records.map((x) => (x as { id?: string }).id).filter((k): k is string => typeof k === "string");
      expect([...rows].sort()).toEqual(keys.map((k) => ref.recordKey(k)).sort());
      expect(body.recordDigest).toBe(ref.record(mappedValues(sb, { ...keyless } as Record<string, unknown>)));
    } finally {
      keyless.id = "apt-00003";
      await c.close();
      sb.writeConfig(sb.config());
    }
  });

  it("[FO-17-24.DLQ_FULL][OPS-01] control: with a writable dead-letter queue the keyless record is dead-lettered and the checkpoint advances in the same run", async ({ l2 }) => {
    // A second sandbox (its own database): checkpoints are append-only, the first test's history stays as it is.
    const own = await provisionSandbox(l2);
    onTestFinished(() => own.close());
    const dlq = await createQueue(own.sqs, "vsp-it-comp-feed-dlq");
    await configureFeed(own, dlq);
    const keyless = em.records[4] as unknown as { id?: string };
    delete keyless.id;
    const { c } = await bootLive(own, { unit: "worker", network: { resolve: privateResolver([API_HOST, AUTH_HOST]), tlsCa: [pki.caPem] } });
    try {
      const [feed] = composeConnectorFeeds(c);
      const r = await feed!.runOnce();
      expect(r).toMatchObject({ result: "caught_up", deadLettered: 1, indexed: em.records.length - 1, reasonCode: null });
      expect(counter(c.localMetrics.find("vsp_connector_feed_dead_letter_refused_total"))).toBe(0);
      expect((await feed!.checkpoint())?.cursor).toBe(String(em.records.length));
      // Keyed per environment (DATA-01): this sandbox has its own pepper, and its digests are the keyed
      // construction under that pepper, not under the first sandbox's (the same record key differs between them).
      const ref = await feedReference(own);
      const other = await feedReference(sb);
      const msgs = await own.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      expect(msgs.Messages ?? []).toHaveLength(1);
      const body = JSON.parse(msgs.Messages?.[0]?.Body ?? "{}") as Record<string, unknown>;
      const values = mappedValues(own, { ...keyless } as Record<string, unknown>);
      expect(body.recordDigest).toBe(ref.record(values));
      expect(body.recordDigest).not.toBe(other.record(values));
      const rows = (await c.db.query<{ d: string }>("select record_key_digest as d from connector_feed_index where tenant_id = $1", [TENANT])).rows.map((x) => x.d);
      expect(rows).toContain(ref.recordKey("apt-00001"));
      expect(rows).not.toContain(other.recordKey("apt-00001"));
    } finally {
      keyless.id = "apt-00005";
      await c.close();
    }
  });
});
