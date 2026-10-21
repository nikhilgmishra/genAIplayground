/**
 * Mandatory data of every live environment (sandbox, staging, production; FO-19-06, OPS-04): the substrate a
 * live composition cannot start without. Missing mandatory data refuses the environment (blocking), unlike a
 * missing tenant input of one capability (live-adapters.ts): PostgreSQL (never PGlite) by a real secret
 * reference, the DynamoDB session table (never memory sessions), audit on with the Object Lock sink, and
 * KMS-backed assertion signing (never the local development key).
 */
import { LIVE_RULE_SETS, isPlaceholder, refRule } from "./types.js";
import type { GuardRule } from "./types.js";

export const mandatoryDataRule: GuardRule = {
  id: "mandatory-data",
  file: "mandatory.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, v }) {
    if (config.database.engine === "pglite") v.add("DATABASE_ENGINE_PGLITE", "database.engine");
    refRule(config.database.connectionRef, "database.connectionRef", "DATABASE_CONNECTION_REF", v);
    if (config.sessionStore.kind === "memory") v.add("SESSION_STORE_MEMORY", "sessionStore.kind");
    else if (!config.sessionStore.tableName) v.add("SESSION_STORE_TABLE_MISSING", "sessionStore.tableName");
    else if (isPlaceholder(config.sessionStore.tableName)) v.add("SESSION_STORE_TABLE_PLACEHOLDER", "sessionStore.tableName");
    if (config.audit.sink === "local_fixture") v.add("AUDIT_SINK_LOCAL_FIXTURE", "audit.sink");
    if (!config.audit.enabled) v.add("AUDIT_DISABLED", "audit.enabled");
    if (config.signing.localDevKey) v.add("SIGNING_LOCAL_DEV_KEY", "signing.localDevKey");
    refRule(config.signing.assertionKeyRef, "signing.assertionKeyRef", "SIGNING_KEY_REF", v);
  },
};
