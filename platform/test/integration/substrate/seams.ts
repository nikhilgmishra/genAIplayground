/**
 * Fault-injection SEAMS built by WP-04 for Layer-2 runs owned by later packages (docs/followon/work-packages.yaml
 * WP-04 faultInjectionPoints). Each seam produces its fault through the real emulator or engine; its own local
 * proof is in seams.test.ts, and the owning package's [FAULT:<id>] test drives it:
 *
 *   AUTH_EXPIRY_IDLE / AUTH_EXPIRY_MID_CALL (WP-05 / WP-07)  dynamoSessionSeam: the production session service over
 *       a fresh DynamoDB Local table with an injectable clock; advancing the clock expires a live session whose
 *       item DynamoDB still holds (TTL is never the gate).
 *   CONCURRENT_SAME_ACCOUNT / CRASH_AFTER_COMMIT (WP-25)      contention-harness.ts: the two-connection race and the
 *       worker-kill helpers.
 *   DLQ_FULL (WP-07)                                          refusingDeadLetterQueue: an ElasticMQ dead-letter queue
 *       that refuses the write (deleted, or a message over the maximum size).
 *   LOCAL_PERSISTENCE_FAILURE (WP-15)                         readOnlyDatabase (postgres:16 default_transaction_read_only)
 *       and throwawayPostgres (a separate postgres:16 container the test may stop; the shared service is never stopped).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CreateTableCommand, DynamoDBClient, UpdateTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { CreateQueueCommand, DeleteQueueCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { TrustedSessionService } from "../../../src/identity/session-service.js";
import { sessionConfig } from "../../../src/identity/config.js";
import { DynamoKvStore } from "../../../src/identity/kv/dynamo-kv-store.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import { FakeClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import type { IntegrationIdentity } from "../../../src/protocol/index.js";
import { awsQueueUrl, dynamoClient, postgresUrl, uniqueName } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";
import type { AuroraLikeDb } from "./support.js";

/** Creates the session/lease KV table (contract of infra/terraform/modules/dynamodb_sessions): hash key pk, TTL attribute ttl. */
export async function createKvTable(client: DynamoDBClient, name = uniqueName("vsp-it-kv")): Promise<string> {
  await client.send(new CreateTableCommand({ TableName: name, AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], BillingMode: "PAY_PER_REQUEST" }));
  await client.send(new UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }));
  return name;
}

/** Creates the independent route-audit journal table: pk (S) + sk (S). */
export async function createJournalTable(client: DynamoDBClient, name = uniqueName("vsp-it-raj")): Promise<string> {
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  return name;
}

export interface SessionSeam {
  sessions: TrustedSessionService;
  kv: DynamoKvStore;
  table: string;
  clock: FakeClock;
  dynamo: DynamoDBClient;
  telephony: IntegrationIdentity;
  mcp: IntegrationIdentity;
  tenantId: string;
}

/** AUTH_EXPIRY_IDLE / AUTH_EXPIRY_MID_CALL seam: production session service, DynamoDB Local, injectable clock. */
export async function dynamoSessionSeam(l2: Layer2Context, ttlSeconds = 300): Promise<SessionSeam> {
  const dynamo = dynamoClient(l2);
  const table = await createKvTable(dynamo);
  const kv = DynamoKvStore.fromClient(dynamo, table);
  const tenantId = newId("tnt");
  const clock = new FakeClock(new Date());
  const sessions = new TrustedSessionService({
    kv,
    clock,
    config: sessionConfig({ tenantId, environment: "ci", policyVersion: "policy-2026-10-19.1", sessionTtlSeconds: ttlSeconds }),
  });
  const ident = (channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({
    integrationId: "it-contact-center",
    tenantId,
    environment: "ci",
    channel,
    credentialId: `cred-${channel.replace(/_/g, "-")}`,
    authMethod: "oauth2_client_credentials",
  });
  return { sessions, kv, table, clock, dynamo, telephony: ident("telephony_control"), mcp: ident("mcp_tools"), tenantId };
}

/** A message body over the SQS maximum message size (1 MiB since 2025): refused by SQS and by ElasticMQ. */
export const OVERSIZE_MESSAGE_BYTES = 1_048_577;

/**
 * DLQ_FULL seam: a dead-letter queue that refuses the write. "missing": the queue was deleted (QueueDoesNotExist);
 * "oversize": an existing queue receives a message over the maximum size (send OVERSIZE_MESSAGE_BYTES).
 * ElasticMQ 1.7.1 does not store or enforce a per-queue MaximumMessageSize attribute (fidelity finding,
 * docs/adr/proposed/WP-04-durable-substrate.md), so the size refusal uses the global limit, which it enforces.
 */
export async function refusingDeadLetterQueue(sqs: SQSClient, mode: "missing" | "oversize"): Promise<string> {
  const name = uniqueName("vsp-it-dlq-refusing");
  await sqs.send(new CreateQueueCommand({ QueueName: name }));
  const url = awsQueueUrl(name);
  if (mode === "missing") await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  return url;
}

/**
 * LOCAL_PERSISTENCE_FAILURE seam (read-only form): every NEW session of the database becomes read-only
 * (default_transaction_read_only), as on a failed-over reader or a storage in read-only mode; writes fail with
 * SQLSTATE 25006. Returns the undo function. Existing pooled connections keep their setting: open a new pool.
 */
export async function readOnlyDatabase(l2: Layer2Context, adb: Pick<AuroraLikeDb, "name">): Promise<() => Promise<void>> {
  const admin = PgPoolDb.fromConnectionString(postgresUrl(l2), 1);
  try {
    await admin.exec(`alter database ${adb.name} set default_transaction_read_only = on`);
  } finally {
    await admin.close();
  }
  return async () => {
    const a = PgPoolDb.fromConnectionString(postgresUrl(l2), 1);
    try {
      await a.exec(`alter database ${adb.name} reset default_transaction_read_only`);
    } finally {
      await a.close();
    }
  };
}

/** The pinned image of the shared postgres service (deploy/local/services/core.compose.yaml). */
export const POSTGRES_IMAGE = "pgvector/pgvector:0.8.7-pg16-trixie@sha256:40d828eda66737aaacb934387a337babf1455ebd56e9bdd13fc08e211257c972";

export interface ThrowawayPostgres {
  url: string;
  container: string;
  stop(): void;
  remove(): void;
}

/**
 * LOCAL_PERSISTENCE_FAILURE seam (stopped form): a separate postgres:16 container owned by the calling test
 * (never the shared service), published on an ephemeral loopback port. `stop` makes it unreachable.
 */
export async function throwawayPostgres(): Promise<ThrowawayPostgres> {
  const container = `vsp-it-pg-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const run = spawnSync("docker", ["run", "-d", "--rm", "--name", container, "--label", "io.vsp.test=substrate-seam", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_USER=vsp", "-p", "127.0.0.1::5432", POSTGRES_IMAGE], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`THROWAWAY_POSTGRES_START_FAILED: ${run.stderr.trim().slice(0, 300)}`);
  const port = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split(":").pop();
  const url = `postgres://vsp:${password}@127.0.0.1:${port}/vsp`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = PgPoolDb.fromConnectionString(url, 1, { connectionTimeoutMillis: 1000 });
    try {
      await probe.query("select 1");
      await probe.close();
      break;
    } catch {
      await probe.close().catch(() => undefined);
      if (Date.now() > deadline) throw new Error("THROWAWAY_POSTGRES_NOT_READY");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    url,
    container,
    stop: () => void spawnSync("docker", ["stop", "-t", "1", container]),
    remove: () => void spawnSync("docker", ["rm", "-f", container]),
  };
}
