/**
 * Layer 2 (WP-07; FO-21-10, SAFE-02, SAFE-03, SAFE-04, OPS-01): the routing tools of the composed live gateway
 * when no route can be reached.
 *
 * In this build telephony is a NOT_CONFIGURED guard port in every live environment (contact_center.talkdesk:
 * no live Talkdesk transfer adapter, WP-28), so every dial the TransferCoordinator attempts is refused. The
 * composed gateway (buildLiveContainer, sandbox, over PostgreSQL 16 with the live PgTransferStore, DynamoDB
 * Local sessions, ElasticMQ and LocalStack KMS) must then answer request_safety_route and
 * request_human_transfer with ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE and no transfer id, so the contact-centre
 * flow takes its independent Studio route, instead of TRANSFER_REQUESTED for a transfer that is not in flight
 * (the canned-success defect of the WP-07 round-2 security review). What still happens: the routes are never
 * gated (SAFE-02: mutations fenced, no verification), every dial attempt reached the guard port (counted, the
 * capability-guard-port-reached alarm fires), the journey is stored awaiting the sweep's retry, and the safety
 * route still records its content-free safety evidence (safety_events, SAFE-HANDOFF-07).
 *
 * Test plumbing, labelled: tool calls go through the composed pipeline with the contact centre's integration
 * identity (inbound JWT authentication is covered by inbound-auth.test.ts); the call is started through the
 * production session service.
 */
import { afterAll, beforeAll, describe, expect } from "vitest";
import { alarmRule, evaluateAlarm } from "../../../src/observability/alarms.js";
import { ensurePolicyBundle } from "../../../src/policy/ensure-bundle.js";
import type { IntegrationIdentity } from "../../../src/protocol/index.js";
import { newId } from "../../../src/shared/ids.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { SUBSTRATE, TENANT, bootLive, provisionSandbox } from "./support.js";
import type { Sandbox } from "./support.js";

const it = layer2([...SUBSTRATE]);

let sb: Sandbox;
beforeAll(async () => {
  ensurePolicyBundle();
  sb = await provisionSandbox(layer2Context(SUBSTRATE));
});
afterAll(async () => {
  await sb?.close();
});

const ident = (channel: IntegrationIdentity["channel"]): IntegrationIdentity => ({ integrationId: "it-contact-center", tenantId: TENANT, environment: "sandbox", channel, credentialId: `cred-${channel.replace(/_/g, "-")}`, authMethod: "oauth2_client_credentials" });
const consent = () => ({ recording: "GRANTED" as const, automatedProcessing: "GRANTED" as const, disclosureTemplateVersion: "disclosure-l2-v1", capturedAt: new Date().toISOString(), capturedBy: "studio_flow" as const });

type Result = { status: string; reasonCode: string | null; data: { handoff: { status: string; transferId: string | null; destinationPurpose: string } } | null; speech: { templateId: string } | null };

describe("routing tools over the NOT_CONFIGURED telephony guard port [FO-21-10][SAFE-04]", () => {
  it("[FO-21-10][SAFE-02][SAFE-03][SAFE-04][OPS-01] adversarial: with every dial refused, request_safety_route and request_human_transfer report ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE with no transfer id; the safety evidence is still recorded and the guard port pages", async () => {
    const { c } = await bootLive(sb);
    try {
      expect(c.mutationsEnabled).toBe(false);
      expect(c.activation.state("contact_center.talkdesk")).toBe("NOT_CONFIGURED");
      expect(c.activation.state("handoff.transfer")).toBe("NOT_CONFIGURED");
      const reached = () => c.localMetrics.find("vsp_capability_not_configured_reached_total").filter((s) => s.labels.capability === "contact_center.talkdesk").reduce((n, s) => n + s.value, 0);
      const before = reached();

      // The safety route: a caller in crisis on a started call (A0 session; SAFE-02: no verification needed).
      const safetyCallId = newId("cal");
      const safetyCall = await c.identity.sessions.startCall({ integration: ident("telephony_control"), callId: safetyCallId, callerIdHash: null, consent: consent() });
      const safety = (await c.pipeline.invoke(
        { name: "request_safety_route", version: null, arguments: { signalSource: "EXPLICIT_PHRASE", concernSubject: "SELF", language: "en" }, idempotencyKey: newId("idk") },
        ident("mcp_tools"),
        { kind: "mcp", sessionRefHeader: safetyCall.sessionRef, interactionIdHeader: null },
      )) as unknown as Result;
      expect(safety.status).toBe("SUCCESS");
      expect(safety.data?.handoff).toEqual({ status: "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE", transferId: null, destinationPurpose: "SAFETY_PRIORITY" });
      // Outside local/ci no unapproved template renders: the pipeline's speech gate replaces the tool's DRAFT prompt
      // with the safe explanation (never "connecting you with a person right now").
      expect(safety.speech?.templateId).toBe("fallback.safe_explanation");
      // The prompt the composed safety tool itself chose follows the status it reports: the Studio safety route
      // prompt, not the acknowledgment (the composed tool module, executed on another started call).
      const tool = c.business.tools.find((t) => t.definition.name === "request_safety_route");
      if (!tool) throw new Error("request_safety_route missing from the composed business module");
      const direct = await c.identity.sessions.startCall({ integration: ident("telephony_control"), callId: newId("cal"), callerIdHash: null, consent: consent() });
      const auth = await c.identity.sessions.resolve(direct.sessionRef, ident("mcp_tools"));
      const args = { signalSource: "EXPLICIT_PHRASE", concernSubject: "SELF", language: "en" };
      const chosen = (await tool.execute(
        {
          auth,
          request: { name: "request_safety_route", version: null, arguments: args, idempotencyKey: newId("idk") },
          decision: { decisionId: newId("pdc"), allow: true, reasonCodes: ["ALLOW_SAFETY_ROUTE"], fieldMask: [], obligations: [], policyVersion: c.policy.policyVersion, evaluatedAt: new Date().toISOString() },
          now: new Date(),
        } as never,
        tool.input.parse(args) as never,
      )) as unknown as { status: string; data: { handoff: { status: string } }; speech: { templateId: string } | null };
      expect(chosen.data.handoff.status).toBe("ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE");
      expect(chosen.speech?.templateId).toBe("safety.studio_route");
      expect(c.templates.get("safety.studio_route", "en-US")?.text).not.toMatch(/connect/i);
      const journeys = await c.transfers.journeysForCall(TENANT, safetyCallId);
      expect(journeys.map((j) => ({ priority: j.priority, status: j.status, awaitingRetry: j.awaitingRetry, connectedAt: j.connectedAt }))).toEqual([{ priority: "SAFETY", status: "ROUTING", awaitingRetry: true, connectedAt: null }]);
      // Every dial of the route plan reached the guard port; nothing was connected or claimed.
      expect(reached() - before).toBeGreaterThanOrEqual(journeys[0]?.routePlan.length ?? 1);
      const evidence = await sb.idb.db.tx(async (tx) => (await tx.query<{ phase: string }>("select phase from safety_events where call_id = $1", [safetyCallId])).rows, { role: "owner" });
      expect(evidence.length).toBeGreaterThan(0);

      // The human route on another call: same honesty, and the caller is not told "connecting you now".
      const humanCall = await c.identity.sessions.startCall({ integration: ident("telephony_control"), callId: newId("cal"), callerIdHash: null, consent: consent() });
      const human = (await c.pipeline.invoke(
        { name: "request_human_transfer", version: null, arguments: { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] }, idempotencyKey: newId("idk") },
        ident("mcp_tools"),
        { kind: "mcp", sessionRefHeader: humanCall.sessionRef, interactionIdHeader: null },
      )) as unknown as Result;
      expect(human.status).toBe("SUCCESS");
      expect(human.data?.handoff).toMatchObject({ status: "ROUTE_UNAVAILABLE_USE_STUDIO_ROUTE", transferId: null, destinationPurpose: "STANDARD_SUPPORT" });
      expect(human.speech?.templateId).not.toBe("transfer.in_progress");
      const stored = await sb.idb.db.tx(async (tx) => (await tx.query<{ n: number }>("select count(*)::int as n from transfer_journeys where tenant_id = $1", [TENANT])).rows[0]?.n ?? 0, { role: "owner" });
      expect(stored).toBeGreaterThanOrEqual(2);

      const samples = c.localMetrics.find("vsp_capability_not_configured_reached_total").map((s) => ({ metric: s.name, labels: s.labels, value: s.value }));
      expect(evaluateAlarm(alarmRule("capability-guard-port-reached"), samples)).toMatchObject({ state: "ALARM" });
    } finally {
      await c.close();
    }
  });
});
