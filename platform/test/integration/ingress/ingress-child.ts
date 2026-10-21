/**
 * Child process for crash.test.ts (Layer 2, WP-04): ONE ingress replica — the production IngressRouter, verifier,
 * PgInbox (postgres:16), KMS envelope cipher (LocalStack KMS), Secrets Manager credentials and the Fastify
 * ingressPlugin on a loopback socket — that the test kills with SIGKILL at a precise point of an accept:
 *
 *  VSP_CHILD_CRASH=after_commit   the inbox transaction (row + audit event) has COMMITTED and the HTTP response
 *                                 has not been written: prints "COMMITTED" and holds the response until killed;
 *  VSP_CHILD_CRASH=before_commit  the inbound_events row was inserted inside the transaction, which has NOT
 *                                 committed: prints "INSERTED_UNCOMMITTED" and holds the transaction until killed.
 *
 * The hold is a test seam around the Db handle given to PgInbox (it observes the production statements and
 * pauses; it changes nothing). The process death is real, so the database sees the connection drop.
 * Prints "LISTENING <port>" once it serves. Never prints payloads or secrets.
 *
 * Environment: VSP_CHILD_DB_URL (application login), VSP_CHILD_TENANT, VSP_CHILD_SECRET_ARN, VSP_CHILD_KMS_KEY,
 * VSP_CHILD_LOCALSTACK (endpoint URL), VSP_CHILD_AWS_KEY, VSP_CHILD_AWS_SECRET, VSP_CHILD_CRASH.
 */
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import fastify from "fastify";
import type { AddressInfo } from "node:net";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import type { Db, Queryable, QueryResult, TxOptions } from "../../../src/db/types.js";
import { ingressPlugin } from "../../../src/gateway/http/webhook-routes.js";
import { KmsEnvelopeCipher } from "../../../src/ingress/cipher.js";
import { PgCredentialPromotionLedger, SecretsManagerCredentialResolver } from "../../../src/ingress/credentials.js";
import { PgInbox } from "../../../src/ingress/inbox.js";
import { SourceProfileRegistry } from "../../../src/ingress/profile.js";
import { IngressRouter } from "../../../src/ingress/router.js";
import { InboundVerifier } from "../../../src/ingress/verifiers.js";
import { systemClock } from "../../../src/shared/clock.js";
import { HMAC_SOURCE, contracts, hmacVerifier, profile } from "./support.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(3);
  }
  return v;
}

const mode = need("VSP_CHILD_CRASH");
if (mode !== "after_commit" && mode !== "before_commit") {
  process.stderr.write("VSP_CHILD_CRASH must be after_commit or before_commit\n");
  process.exit(3);
}
const tenantId = need("VSP_CHILD_TENANT");
const endpoint = need("VSP_CHILD_LOCALSTACK");
const credentials = { accessKeyId: need("VSP_CHILD_AWS_KEY"), secretAccessKey: need("VSP_CHILD_AWS_SECRET") };
const db = PgPoolDb.fromConnectionString(need("VSP_CHILD_DB_URL"), 3, { applicationName: "vsp-ingress-child", connectionTimeoutMillis: 3000 });

const forever = () => new Promise<never>(() => undefined);
const INSERT_EVENT = /^\s*insert\s+into\s+inbound_events\b/i;

/** Test seam: observes the inbox's statements and holds at the requested crash point. */
const held: Db = {
  engine: db.engine,
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => db.query<T>(sql, params),
  exec: (sql: string) => db.exec(sql),
  close: () => db.close(),
  async tx<T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions): Promise<T> {
    let inserted = false;
    const result = await db.tx(async (tx) => {
      const q: Queryable = {
        async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
          const r = await tx.query<R>(sql, params);
          if (INSERT_EVENT.test(sql)) {
            inserted = true;
            if (mode === "before_commit") {
              process.stdout.write("INSERTED_UNCOMMITTED\n");
              await forever();
            }
          }
          return r;
        },
        exec: (sql: string) => tx.exec(sql),
      };
      return fn(q);
    }, opts);
    if (inserted && mode === "after_commit") {
      process.stdout.write("COMMITTED\n");
      await forever();
    }
    return result;
  },
};

const clock = systemClock;
const registry = new SourceProfileRegistry([profile(tenantId, HMAC_SOURCE, hmacVerifier(need("VSP_CHILD_SECRET_ARN")))]);
const resolver = new SecretsManagerCredentialResolver({
  client: new SecretsManagerClient({ region: "us-east-1", endpoint, credentials }),
  clock,
  promotions: new PgCredentialPromotionLedger({ db }),
  cacheTtlMs: 0,
});
const inbox = new PgInbox({ db: held, cipher: new KmsEnvelopeCipher(new KMSClient({ region: "us-east-1", endpoint, credentials }), need("VSP_CHILD_KMS_KEY")), audit: new PgAuditWriter({ db: held, clock, stream: "gateway.ingress-child" }), clock });
const router = new IngressRouter({ profiles: registry, contracts: contracts(), verifier: new InboundVerifier({ credentials: resolver, clock }), inbox, clock });

const app = fastify();
await ingressPlugin(app, { router });
await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`LISTENING ${(app.server.address() as AddressInfo).port}\n`);
