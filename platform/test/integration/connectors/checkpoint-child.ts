/**
 * Child process for checkpoints.test.ts (Layer 2, WP-06). An incremental-reader replica: the production
 * ConnectorRuntime (TLS to the emulated vendor, credentials from LocalStack Secrets Manager) feeding the
 * production IncrementalReader, which commits each page's projection and its checkpoint in one PostgreSQL
 * transaction. It stops at a chosen point and waits to be killed:
 *
 *   crash-in-tx        on page VSP_CHILD_CRASH_PAGE the projection rows are written inside the page's
 *                      transaction, then it prints "IN_TX <page>" and never commits (SIGKILL: the connection
 *                      drops, PostgreSQL rolls the transaction back)
 *   crash-after-commit after committing batch VSP_CHILD_CRASH_PAGE (one runOnce(1): a page of records, or an
 *                      empty page whose advanced position is committed on its own) it prints
 *                      "COMMITTED <batch> <cursor>" and idles before reading the next page
 *
 * It prints opaque positions only, never record values. Environment: VSP_CHILD_MODE, VSP_CHILD_CRASH_PAGE,
 * VSP_CHILD_DB_URL, VSP_CHILD_TENANT, VSP_CHILD_SM_ENDPOINT, VSP_CHILD_AWS_KEY, VSP_CHILD_AWS_SECRET,
 * VSP_CHILD_READ_REF, VSP_CHILD_WRITE_REF, VSP_CHILD_EMULATOR_PORT, VSP_CHILD_CA_FILE, VSP_CHILD_TABLE.
 */
import { readFileSync } from "node:fs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ConnectorHttpTransport } from "../../../src/connectors/http/transport.js";
import { admitConnectorProfile } from "../../../src/connectors/profile/validate.js";
import { IncrementalReader, PgConnectorCheckpointStore } from "../../../src/connectors/runtime/checkpoints.js";
import { ConnectorRuntime } from "../../../src/connectors/runtime/connector.js";
import { SecretsManagerSecretResolver } from "../../../src/connectors/secrets/resolver.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import { EgressGuard } from "../../../src/privacy/egress.js";
import { systemClock } from "../../../src/shared/clock.js";
import { API_HOST, AUTH_HOST, emulatorEgressPolicy, emulatorProfile } from "./profiles.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(3);
  }
  return v;
}

const mode = need("VSP_CHILD_MODE");
const crashPage = Number(need("VSP_CHILD_CRASH_PAGE"));
const tenantId = need("VSP_CHILD_TENANT");
const table = need("VSP_CHILD_TABLE");
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error("VSP_CHILD_TABLE invalid");
const port = Number(need("VSP_CHILD_EMULATOR_PORT"));
const db = PgPoolDb.fromConnectionString(need("VSP_CHILD_DB_URL"), 2, { applicationName: "vsp-checkpoint-child", connectionTimeoutMillis: 3000 });
const sm = new SecretsManagerClient({ region: "us-east-1", endpoint: need("VSP_CHILD_SM_ENDPOINT"), credentials: { accessKeyId: need("VSP_CHILD_AWS_KEY"), secretAccessKey: need("VSP_CHILD_AWS_SECRET") } });
const transport = new ConnectorHttpTransport({
  environment: "local",
  egress: new EgressGuard(emulatorEgressPolicy(), { environment: "local" }),
  loopbackRoutes: new Map([
    [API_HOST, { port, tls: true }],
    [AUTH_HOST, { port, tls: true }],
  ]),
  tlsCa: [readFileSync(need("VSP_CHILD_CA_FILE"), "utf8")],
});
const admitted = admitConnectorProfile(emulatorProfile({ readRef: need("VSP_CHILD_READ_REF"), writeRef: need("VSP_CHILD_WRITE_REF") }), "local");
const runtime = new ConnectorRuntime({ admitted, transport, secrets: new SecretsManagerSecretResolver(sm, { clock: systemClock }), clock: systemClock });

let page = 0;
const reader = new IncrementalReader({
  runtime,
  db,
  store: new PgConnectorCheckpointStore(systemClock),
  tenantId,
  streamId: "appointments",
  operationId: "appointments.changes",
  watermarkField: "updatedAt",
  apply: async (tx, records) => {
    page += 1;
    for (const r of records) await tx.query(`insert into ${table} (tenant_id, appointment_id, seq) values ($1, $2, $3)`, [tenantId, r.values.appointmentId, r.values.sequence]);
    if (mode === "crash-in-tx" && page === crashPage) {
      process.stdout.write(`IN_TX ${page}\n`);
      await new Promise<never>(() => undefined);
    }
  },
});

async function main(): Promise<void> {
  let batch = 0;
  for (;;) {
    const r = await reader.runOnce(1);
    process.stdout.write(`PAGE ${page} ${r.checkpoint?.cursor ?? "-"}\n`);
    if (r.completeness === "CAUGHT_UP") break;
    batch += 1;
    if (mode === "crash-after-commit" && batch === crashPage) {
      process.stdout.write(`COMMITTED ${batch} ${r.checkpoint?.cursor ?? "-"}\n`);
      await new Promise<never>(() => undefined);
    }
  }
  process.stdout.write("DONE\n");
  await db.close();
}

main().catch((err: unknown) => {
  process.stdout.write(`ERROR ${(err as { reasonCode?: string; message?: string }).reasonCode ?? (err as Error).message}\n`);
  process.exit(1);
});
