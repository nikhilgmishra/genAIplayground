/**
 * Child process for crash.test.ts (Layer 2, WP-23; FO-06-75, ACT-02, ACT-03): a platform replica that composes the
 * production domain adapters of the parent's tenant (the same admitted profiles and bindings, TLS transport,
 * Secrets Manager resolver) and commits one confirmed action through the production LedgerActionService. The
 * parent arms COMMIT_THEN_DELAY at the reference business API, waits until the system's effect log shows the
 * effect (the system committed), and SIGKILLs this process while the response is held: a crash after commit,
 * before the ledger recorded anything. Opaque ids only on stdout.
 *
 * Environment: VSP_CHILD_SPEC (AdapterSpec JSON), VSP_CHILD_SECRETS_ENDPOINT, VSP_CHILD_DB_URL, VSP_CHILD_CTX
 * (AuthContext JSON), VSP_CHILD_ACTION_ID, VSP_CHILD_DIGEST, VSP_CHILD_PORT ("domain" | "legacy").
 */
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PgPoolDb } from "../../../src/db/pg.js";
import { withConnectorMetrics } from "../../../src/observability/catalog/connectors.js";
import { DEFAULT_METRIC_CATALOGUE, InMemoryMetrics } from "../../../src/observability/metrics.js";
import type { AuthContext } from "../../../src/protocol/index.js";
import { systemClock } from "../../../src/shared/clock.js";
import { REGION } from "../_harness/clients.js";
import { localEnv } from "../_harness/env.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import { allowDecision, composeAdapters } from "./support.js";
import type { AdapterSpec } from "./support.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(3);
  }
  return v;
}

const env = localEnv();
const sm = new SecretsManagerClient({ region: REGION, endpoint: need("VSP_CHILD_SECRETS_ENDPOINT"), credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey } });
const metrics = new InMemoryMetrics({ catalogue: withConnectorMetrics(DEFAULT_METRIC_CATALOGUE) });
const { adapters } = composeAdapters(JSON.parse(need("VSP_CHILD_SPEC")) as AdapterSpec, sm, systemClock, metrics);
const provider = need("VSP_CHILD_PORT") === "legacy" ? adapters.legacyScheduling : adapters.commitPort;
if (!provider) {
  process.stderr.write("port not composed\n");
  process.exit(4);
}
const db = PgPoolDb.fromConnectionString(need("VSP_CHILD_DB_URL"), 2, { applicationName: "vsp-domain-crash-child" });
const replica = ledgerReplica(db, systemClock, "domain-crash-child");

try {
  const ctx = JSON.parse(need("VSP_CHILD_CTX")) as AuthContext;
  process.stdout.write("COMMITTING\n");
  await replica.service.commit(ctx, { actionId: need("VSP_CHILD_ACTION_ID"), digest: need("VSP_CHILD_DIGEST") }, { reauthorize: async () => allowDecision(), provider });
  process.stdout.write("UNEXPECTED_RETURN\n");
  process.exit(5);
} catch (err) {
  process.stderr.write(`child failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
