/**
 * Layer-2 support for the ingress suite (WP-04): the production inbound inbox composed over real protocols.
 * postgres:16 provisioned as on Aurora (substrate/support.ts), the payload key from LocalStack KMS
 * (KmsEnvelopeCipher), source credentials from LocalStack Secrets Manager (SecretsManagerCredentialResolver,
 * AWSCURRENT / AWSPREVIOUS / AWSPENDING, promotions recorded in PgCredentialPromotionLedger), the production
 * router, verifier, inbox, processor and replay
 * service, served by the production Fastify plugin on a real socket. SYNTHETIC events and keys only.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CreateKeyCommand } from "@aws-sdk/client-kms";
import { CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import type { Db, Queryable, QueryResult, TxOptions } from "../../../src/db/types.js";
import { ingressPlugin } from "../../../src/gateway/http/webhook-routes.js";
import { KmsEnvelopeCipher } from "../../../src/ingress/cipher.js";
import { InboundContractRegistry } from "../../../src/ingress/contracts.js";
import type { InboundContract } from "../../../src/ingress/contracts.js";
import { PgCredentialPromotionLedger, SecretsManagerCredentialResolver } from "../../../src/ingress/credentials.js";
import { ACCEPT_LOCK_NAMESPACE, PgInbox } from "../../../src/ingress/inbox.js";
import { InboxProcessor } from "../../../src/ingress/processor.js";
import type { InboxHandler } from "../../../src/ingress/processor.js";
import { SourceProfileRegistry } from "../../../src/ingress/profile.js";
import { IngressRouter } from "../../../src/ingress/router.js";
import { InboundVerifier } from "../../../src/ingress/verifiers.js";
import { createMemoryLogger } from "../../../src/observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../../../src/observability/metrics.js";
import { withSubstrateMetrics } from "../../../src/observability/catalog/substrate.js";
import type { Clock } from "../../../src/shared/clock.js";
import { iso } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";
import { kmsClient, secretsClient, uniqueName } from "../_harness/clients.js";
import type { Layer2Context } from "../_harness/layer2.js";

export const Receipt = z.strictObject({
  id: z.string(),
  type: z.literal("message.delivered"),
  occurredAt: z.string(),
  version: z.string().regex(/^[0-9]{1,20}$/),
  entity: z.string(),
  status: z.enum(["DELIVERED", "FAILED"]),
});
export const contracts = (extra: readonly InboundContract[] = []) => new InboundContractRegistry([{ contractId: "delivery.receipt", version: "1", schema: Receipt }, ...extra]);

export const HMAC_SOURCE = "receipts.synthetic";
export const MTLS_SOURCE = "partner.mtls";

/** A source profile (the documented mechanism of a SYNTHETIC vendor) for one tenant. */
export function profile(tenantId: string, sourceId: string, verifier: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId,
    tenantId,
    family: "delivery_receipt",
    vendor: "Synthetic Vendor",
    documentationUrl: "https://docs.example.invalid/webhooks",
    verifier,
    envelope: { idField: "id", typeField: "type", occurredAtField: "occurredAt", versionField: "version", entityField: "entity" },
    contracts: { "message.delivered": { contractId: "delivery.receipt", version: "1" } },
    maxBodyBytes: 4096,
    rawRetentionDays: 30,
    processing: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 },
    rotationOverlapSeconds: 3600,
    acceptPendingCredential: false,
    ...extra,
  };
}

export const hmacVerifier = (credentials: string) => ({
  kind: "hmac_header",
  algorithm: "sha256",
  signatureHeader: "x-synthetic-signature",
  encoding: "hex",
  prefix: "sha256=",
  signedPayload: "timestamp.body",
  timestampHeader: "x-synthetic-timestamp",
  toleranceSeconds: 300,
  credentials,
});

/** A Secrets Manager secret holding an HMAC key ({"key": base64}); returns its ARN and the key bytes. */
export async function hmacSecret(l2: Layer2Context): Promise<{ arn: string; key: Buffer }> {
  const key = randomBytes(32);
  const r = await secretsClient(l2).send(new CreateSecretCommand({ Name: uniqueName("vsp-it/ingress/hmac"), SecretString: JSON.stringify({ key: key.toString("base64") }) }));
  return { arn: r.ARN ?? "", key };
}

/** Rotates the secret: the new value becomes AWSCURRENT, the old one AWSPREVIOUS (or stages it as AWSPENDING). */
export async function rotate(l2: Layer2Context, arn: string, material: Record<string, string>, stage: "AWSCURRENT" | "AWSPENDING" = "AWSCURRENT"): Promise<string> {
  const r = await secretsClient(l2).send(new PutSecretValueCommand({ SecretId: arn, SecretString: JSON.stringify(material), ...(stage === "AWSPENDING" ? { VersionStages: ["AWSPENDING"] } : {}) }));
  return r.VersionId ?? "";
}

export async function kmsInboxKey(l2: Layer2Context): Promise<string> {
  const k = await kmsClient(l2).send(new CreateKeyCommand({ KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT", Description: "SYNTHETIC inbox payload key (Layer 2)" }));
  return k.KeyMetadata?.Arn ?? "";
}

export const receipt = (clock: Clock, over: Partial<Record<string, string>> = {}) =>
  Buffer.from(JSON.stringify({ id: newId("evt"), type: "message.delivered", occurredAt: iso(clock.now()), version: "1", entity: "msg_synthetic0001", status: "DELIVERED", ...over }));

export function signHeaders(body: Buffer, key: Buffer, clock: Clock): Record<string, string> {
  const ts = Math.floor(clock.now().getTime() / 1000);
  const sig = createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${ts}.`), body])).digest("hex");
  return { "x-synthetic-signature": `sha256=${sig}`, "x-synthetic-timestamp": String(ts), "content-type": "application/json" };
}

export interface IngressStack {
  router: IngressRouter;
  inbox: PgInbox;
  registry: SourceProfileRegistry;
  cipher: KmsEnvelopeCipher;
  credentials: SecretsManagerCredentialResolver;
  metrics: InMemoryMetrics;
  records: ReturnType<typeof createMemoryLogger>["records"];
  processor(db: Db, handlers: Readonly<Record<string, InboxHandler>>, clock?: Clock, leaseSeconds?: number): InboxProcessor;
}

export function ingressStack(l2: Layer2Context, db: Db, clock: Clock, kmsKeyArn: string, profiles: Record<string, unknown>[], extraContracts: readonly InboundContract[] = []): IngressStack {
  const { logger, records } = createMemoryLogger();
  const metrics = new InMemoryMetrics({ catalogue: withSubstrateMetrics(createMetricCatalogue()) });
  const registry = new SourceProfileRegistry(profiles);
  const cipher = new KmsEnvelopeCipher(kmsClient(l2), kmsKeyArn);
  const credentials = new SecretsManagerCredentialResolver({ client: secretsClient(l2), clock, promotions: new PgCredentialPromotionLedger({ db }), cacheTtlMs: 0 });
  const audit = new PgAuditWriter({ db, clock, stream: "gateway.ingress-it" });
  const inbox = new PgInbox({ db, cipher, audit, clock, logger, metrics });
  const tenants = [...new Set(profiles.map((p) => String(p.tenantId)))];
  const router = new IngressRouter({ profiles: registry, contracts: contracts(extraContracts), verifier: new InboundVerifier({ credentials, clock }), inbox, clock, logger, metrics });
  return {
    router,
    inbox,
    registry,
    cipher,
    credentials,
    metrics,
    records,
    processor: (pdb, handlers, pclock = clock, leaseSeconds = 60) => new InboxProcessor({ db: pdb, cipher, profiles: registry, contracts: contracts(extraContracts), handlers, clock: pclock, tenants, leaseSeconds, random: () => 0.5, logger, metrics }),
  };
}

/**
 * The production Fastify plugin on a real socket (HTTP, or HTTPS requesting client certificates): loopback by
 * default, or `host` (the Docker bridge gateway, for a sender running in a container).
 */
export async function serve(router: IngressRouter, tls?: { key: Buffer; cert: Buffer; ca: Buffer }, host = "127.0.0.1"): Promise<{ app: FastifyInstance; url: string; port: number }> {
  const app = tls ? fastify({ https: { key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true, rejectUnauthorized: false } }) : fastify();
  await ingressPlugin(app, { router, socketClientCertificates: tls !== undefined });
  await app.listen({ host, port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `${tls ? "https" : "http"}://${host}:${port}`, port };
}

/** How a two-replica accept race met at the barrier (see acceptRaceBarrier). */
export type AcceptRaceOutcome = "LOCK_WAIT_OBSERVED" | "BOTH_ARRIVED" | "TIMEOUT";

export interface AcceptRaceBarrier {
  /** The Db handle a replica's PgInbox uses: every statement passes through unchanged; the pause is added after one. */
  wrap(db: Db): Db;
  /** null until the first transaction reached the barrier and the pause ended. */
  outcome(): AcceptRaceOutcome | null;
  /** Transactions that reached the barrier. */
  arrivals(): number;
}

/** PgInbox.accept's in-transaction duplicate check (after the per-event accept lock). */
const DUPLICATE_CHECK = /^\s*select inbox_id, payload_digest, status from inbound_events\b/;

/**
 * Layer-2 SEAM (test only) for a DETERMINISTIC accept race between two replicas (FO-07-18, DUPLICATE_WEBHOOK). Each
 * replica's PgInbox gets a wrapped Db; the FIRST transaction that completes the in-transaction duplicate check pauses
 * there, still uncommitted, until the other replica's transaction either
 *  - is observed in pg_locks waiting for the per-event accept lock (namespace ACCEPT_LOCK_NAMESPACE) of THIS
 *    database: the lock serializes the two (LOCK_WAIT_OBSERVED), or
 *  - reaches the same point too: both checked for a row before either inserted, nothing serialized them
 *    (BOTH_ARRIVED);
 * and only then lets the first one go on. Every later arrival passes straight through. Bounded by `maxWaitMs`
 * (TIMEOUT): a test asserts the outcome, so a race that never happened cannot pass silently. It observes the
 * production statements and pauses; it changes nothing they do.
 */
export function acceptRaceBarrier(observer: Db, maxWaitMs = 15_000): AcceptRaceBarrier {
  let arrivals = 0;
  let outcome: AcceptRaceOutcome | null = null;
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  const settle = (o: AcceptRaceOutcome) => {
    if (outcome === null) outcome = o;
    release();
  };
  const arrive = async (): Promise<void> => {
    arrivals += 1;
    if (arrivals > 1) {
      settle("BOTH_ARRIVED");
      return;
    }
    const deadline = Date.now() + maxWaitMs;
    while (outcome === null) {
      const waiting = await observer.query<{ n: number }>(
        `select count(*)::int as n from pg_locks l
          where l.locktype = 'advisory' and not l.granted and l.classid = $1::int::oid
            and l.database = (select d.oid from pg_database d where d.datname = current_database())`,
        [ACCEPT_LOCK_NAMESPACE],
      );
      if ((waiting.rows[0]?.n ?? 0) > 0) settle("LOCK_WAIT_OBSERVED");
      else if (Date.now() > deadline) settle("TIMEOUT");
      else await Promise.race([released, new Promise((r) => setTimeout(r, 20))]);
    }
    await released;
  };
  return {
    wrap(db: Db): Db {
      return {
        engine: db.engine,
        query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => db.query<T>(sql, params),
        exec: (sql: string) => db.exec(sql),
        close: () => db.close(),
        tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
          return db.tx(
            (tx) =>
              fn({
                async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
                  const r = await tx.query<R>(sql, params);
                  if (DUPLICATE_CHECK.test(sql)) await arrive();
                  return r;
                },
                exec: (sql: string) => tx.exec(sql),
              }),
            opts,
          );
        },
      };
    },
    outcome: () => outcome,
    arrivals: () => arrivals,
  };
}
