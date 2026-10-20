/**
 * Child process for route-audit-crash.test.ts (Layer 2, WP-04). A runtime replica that records emergency
 * and human route evidence through the production DurableDeferredAuditQueue while the audit store refuses
 * the append, prints what it journaled, then waits to be killed (SIGKILL: a crash; SIGTERM: a graceful stop
 * that seals the queue). It never prints payloads, only opaque ids.
 *
 * Environment (set by the test): VSP_CHILD_MODE journal | detached-route, VSP_CHILD_DB_URL (application login),
 * VSP_CHILD_TENANT, VSP_CHILD_EVENTS (journal mode, 1..20), optional VSP_CHILD_DYNAMO_ENDPOINT /
 * VSP_CHILD_DYNAMO_TABLE / VSP_CHILD_AWS_KEY / VSP_CHILD_AWS_SECRET for the independent DynamoDB journal.
 *
 *  journal         appendOrDefer N route events (handoff.safety_requested); prints "JOURNALED <json>" each.
 *  detached-route  the detached safety-route path stopped before its audit append: a safety_events row written
 *                  with audit_status AUDIT_UNAVAILABLE and an OPEN route_audit_intent; prints "ROUTE_STARTED <json>".
 * Then prints "READY" and idles until signalled.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoRouteAuditJournal, DurableDeferredAuditQueue } from "../../../src/audit/journal.js";
import { PgRouteAuditIntents } from "../../../src/audit/route-reconciler.js";
import { buildAuditInput } from "../../../src/audit/build-input.js";
import { PgAuditWriter } from "../../../src/audit/writer.js";
import { PgPoolDb } from "../../../src/db/pg.js";
import { iso, systemClock } from "../../../src/shared/clock.js";
import { newId } from "../../../src/shared/ids.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(3);
  }
  return v;
}

const mode = need("VSP_CHILD_MODE");
const tenantId = need("VSP_CHILD_TENANT");
const db = PgPoolDb.fromConnectionString(need("VSP_CHILD_DB_URL"), 2, { applicationName: "vsp-route-audit-child", connectionTimeoutMillis: 3000 });
const writer = new PgAuditWriter({ db, clock: systemClock, stream: "gateway.route-child" });
const endpoint = process.env.VSP_CHILD_DYNAMO_ENDPOINT;
const independent = endpoint
  ? DynamoRouteAuditJournal.fromClient(
      new DynamoDBClient({ region: "us-east-1", endpoint, credentials: { accessKeyId: need("VSP_CHILD_AWS_KEY"), secretAccessKey: need("VSP_CHILD_AWS_SECRET") }, maxAttempts: 2 }),
      need("VSP_CHILD_DYNAMO_TABLE"),
    )
  : null;
const queue = new DurableDeferredAuditQueue({ db, writer, clock: systemClock, tenants: [tenantId], independent, maxInlineDrain: 0 });

process.on("SIGTERM", () => {
  // Graceful drain: durable deferrals survive the process; nothing new is held in memory after this.
  queue.seal();
  void db.close().finally(() => process.exit(0));
});

async function journal(): Promise<void> {
  const n = Number(process.env.VSP_CHILD_EVENTS ?? "1");
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("VSP_CHILD_EVENTS out of range");
  for (let i = 0; i < n; i++) {
    const callId = newId("call");
    const input = buildAuditInput(
      { tenantId, correlationId: newId("hnd"), sourceComponent: "gateway", action: "handoff.safety_requested", outcome: "PENDING", callId, reasonCode: "SAFETY_SIGNAL_VALIDATED" },
      systemClock,
    );
    const r = await queue.appendOrDefer(input, "gateway.route-child");
    process.stdout.write(`JOURNALED ${JSON.stringify({ correlationId: input.correlationId, callId, written: r.written, deferred: r.deferred, journal: r.journal ?? null, deferralId: r.deferralId ?? null, reasonCode: r.reasonCode })}\n`);
  }
}

async function detachedRoute(): Promise<void> {
  const callId = newId("call");
  const incidentId = newId("sin");
  const correlationId = newId("hnd");
  const at = iso(systemClock.now());
  await new PgRouteAuditIntents({ db, clock: systemClock }).open({ tenantId, routeKind: "SAFETY_ROUTE", correlationId, callId, safetyIncidentId: incidentId, deadlineSeconds: 30 });
  // SafetyEventRecorder's outage fallback: the route row is written, its audit event is not.
  await db.tx(
    (tx) =>
      tx.query(
        `insert into safety_events (event_id, incident_id, tenant_id, call_id, session_generation, phase, signal_sources, rule_ids,
           clinical_categories, strongest_strength, any_third_party, any_historical, any_negated, route, destination_id, reason_code, locale,
           locale_supported, after_hours, detected_at, route_initiated_at, latency_ms, target_ms, within_target, audit_event_id, audit_status, recorded_at)
         values ($1, $2, $3, $4, 0, 'ROUTE_INITIATED', array['EXPLICIT_PHRASE'], array['safety.rule.synthetic'], array[]::text[], 'CREDIBLE', false, false, false,
           'SAFETY_PRIORITY_HUMAN', 'dst_safety_priority', 'SAFETY_SIGNAL_VALIDATED', 'en-US', true, false, $5::timestamptz,
           $5::timestamptz, 0, 2000, true, null, 'AUDIT_UNAVAILABLE', $5::timestamptz)`,
        [newId("sev"), incidentId, tenantId, callId, at],
      ),
    { role: "app_runtime", rls: { tenantId } },
  );
  process.stdout.write(`ROUTE_STARTED ${JSON.stringify({ callId, incidentId, correlationId })}\n`);
}

try {
  if (mode === "journal") await journal();
  else if (mode === "detached-route") await detachedRoute();
  else throw new Error(`unknown mode ${mode}`);
  process.stdout.write("READY\n");
  setInterval(() => undefined, 60_000);
} catch (err) {
  process.stderr.write(`child failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
