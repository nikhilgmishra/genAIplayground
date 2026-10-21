/**
 * Transfer events webhook (TC-09) with the real TransferCoordinator: an early progress event is held
 * by the coordinator and answered 200 {accepted: true, decision: "deferred"} (ADR-0017), so the sender
 * is not asked to redeliver an event the platform keeps. LOCAL FIXTURE HMAC scheme (not a vendor
 * protocol), LOCAL FIXTURE transfer store and telephony, SYNTHETIC calls; fastify.inject (no sockets).
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { DestinationConfig } from "../../config/ports.js";
import { CALLS, DESTINATIONS, TENANT_ID } from "../../fixtures/synthetic-world.js";
import type { Environment, HandoffPackage } from "../../protocol/index.js";
import { FakeClock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import { MemoryTransferStore, TransferCoordinator } from "../../workflows/transfer.js";
import { MemoryAuditWriterFixture, TelephonyControlFixture } from "../../workflows/workflow-test-fixtures.js";
import type { IntegrationAuthenticator } from "../auth.js";
import { buildOpenApiDocument } from "../openapi.js";
import { registerRoutes } from "./route.js";
import { TransferEventResponse, fixtureWebhookSignature, webhookRoutes } from "./webhook-routes.js";

const START = "2026-10-18T09:00:00.000Z";
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** The webhook route has no bearer channel; the authenticator is never consulted. */
const noAuthenticator = {
  kind: "local_fixture",
  authenticate: async () => {
    throw new Error("not used by the webhook route");
  },
} as unknown as IntegrationAuthenticator;

async function setup(environment: Environment = "local") {
  const clock = new FakeClock(START);
  const store = new MemoryTransferStore();
  const telephony = new TelephonyControlFixture();
  const destinations: DestinationConfig[] = DESTINATIONS.map((d) => ({ ...d, fallbackDestinationIds: [...d.fallbackDestinationIds], languages: [...d.languages] }));
  const transfers = new TransferCoordinator({
    store,
    telephony,
    destinations,
    clock,
    audit: new MemoryAuditWriterFixture(),
    config: { environment: "local", updateTemplateIds: { STANDARD: "transfer.update.standard", SAFETY: "transfer.update.safety" }, attemptTimeoutMs: { STANDARD: 60_000, SAFETY: 30_000 }, maxStandardContinuityAttempts: 2 },
  });
  app = Fastify();
  registerRoutes(app, webhookRoutes({ environment, clock, transfers }), { authenticator: noAuthenticator, logger: { warn: () => undefined }, rateLimit: null });
  await app.ready();
  const handoff: HandoffPackage = {
    handoffId: newId("hof"),
    tenantId: TENANT_ID,
    callId: CALLS.primary.callId,
    sessionGeneration: 1,
    reason: "CALLER_REQUESTED_HUMAN",
    destinationId: "dst_support_general",
    statedIssue: "other",
    issueSummary: "Template-assembled synthetic summary.",
    assurance: "A0",
    assuranceLimits: [],
    authorizedSubjectRef: null,
    consent: { recording: "UNKNOWN", automatedProcessing: "UNKNOWN", disclosureTemplateVersion: null, capturedAt: null, capturedBy: "none" },
    actionReceiptIds: [],
    pendingActionIds: [],
    unresolvedTasks: [],
    supportReference: null,
    language: "en",
    accommodations: [],
    safetyRoutingReason: null,
    clinicalStatementsIncluded: false,
    verificationAssertion: null,
    createdAt: START,
  };
  const journey = environment === "local" ? await transfers.requestTransfer(handoff) : null;
  const send = async (body: Record<string, unknown>) => {
    const ts = Math.floor(clock.now().getTime() / 1000);
    clock.advanceMs(1000); // a fresh signature per delivery (exact replays are refused)
    const res = await (app as FastifyInstance).inject({
      method: "POST",
      url: "/v1/webhooks/transfer-events",
      headers: { "content-type": "application/json", "x-vsp-fixture-timestamp": String(ts), "x-vsp-fixture-signature": fixtureWebhookSignature(ts, body) },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  return { clock, store, telephony, transfers, journey, send };
}

describe("transfer events webhook with out-of-order delivery (ADR-0017)", () => {
  it("[TB-09][TB-07][SAFE-04][ACT-02] an early progress event is answered 200 accepted/deferred, changes nothing, and is applied after its predecessor; its redelivery is then a duplicate", async () => {
    const { store, telephony, journey, send } = await setup();
    const transferId = journey?.currentTransferId as string;
    const ev = (event: string, n: number) => ({ transferId, event, eventId: `td-evt-hook-${n}` });

    const early = await send(ev("CALLER_CONFIRMED_CONNECTED", 4));
    expect(early).toEqual({ status: 200, body: { accepted: true, decision: "deferred" } });
    const held = await store.findByTransferId(transferId);
    expect(held?.attempts[0]?.history.map((h) => h.state)).toEqual(["REQUESTED"]);
    expect(held?.connectedAt).toBeNull();
    // A redelivery while it is held is still deferred (one held entry).
    expect((await send(ev("CALLER_CONFIRMED_CONNECTED", 4))).body).toEqual({ accepted: true, decision: "deferred" });
    expect((await store.findByTransferId(transferId))?.deferredEvents).toHaveLength(1);

    expect((await send(ev("RECEIVER_ACCEPTED", 2))).body).toEqual({ accepted: true, decision: "applied" });
    expect((await store.findByTransferId(transferId))?.connectedAt).toBeNull();
    expect((await send(ev("BRIDGED", 3))).body).toEqual({ accepted: true, decision: "applied" });
    const connected = await store.findByTransferId(transferId);
    expect(connected?.status).toBe("CONNECTED");
    expect(connected?.attempts[0]?.history.map((h) => [h.state, h.source])).toEqual([
      ["REQUESTED", "coordinator"],
      ["RECEIVER_ACCEPTED", "webhook.local_fixture"],
      ["BRIDGED", "webhook.local_fixture"],
      ["CALLER_CONFIRMED_CONNECTED", "webhook.local_fixture"],
    ]);
    expect((await send(ev("CALLER_CONFIRMED_CONNECTED", 4))).body).toEqual({ accepted: true, decision: "duplicate" });
    // An event that can never apply is still rejected (accepted false).
    expect((await send(ev("RECEIVER_UNAVAILABLE", 9))).body).toEqual({ accepted: false, decision: "rejected" });
    expect(telephony.dials).toHaveLength(1);
    expect(telephony.updates).toHaveLength(0);
  });

  it("[TB-09][SPEC-8.webhook] outside local/ci the route still refuses with 403 WEBHOOK_AUTH_UNVERIFIED before reading the event", async () => {
    const { send } = await setup("sandbox");
    const refused = await send({ transferId: newId("xfr"), event: "BRIDGED", eventId: "td-evt-hook-1" });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { reasonCode: "WEBHOOK_AUTH_UNVERIFIED" } });
  });

  it("[TB-09][SPEC-8.webhook] the response contract (and the generated OpenAPI document) declares the deferred decision", () => {
    expect(TransferEventResponse.safeParse({ accepted: true, decision: "deferred" }).success).toBe(true);
    const doc = buildOpenApiDocument() as { paths: Record<string, { post: { responses: Record<string, { content: { "application/json": { schema: unknown } } }> } }> };
    const schema = JSON.stringify(doc.paths["/v1/webhooks/transfer-events"]?.post.responses["200"]?.content["application/json"].schema);
    expect(schema).toContain('"deferred"');
  });
});
