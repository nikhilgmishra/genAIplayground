/**
 * Transfer lifecycle events webhook (TB-07, TB-09; spec section 8: "Validate
 * inbound webhook authentication using the vendor's documented mechanism ...
 * Never invent a signature protocol and assume the sender implements it").
 *
 * Talkdesk's webhook authentication mechanism is UNKNOWN (TB-09). Therefore:
 *  - local / ci: enabled with a clearly labelled LOCAL FIXTURE HMAC scheme
 *    (HMAC-SHA256 over `<timestamp>.<canonical JSON body>` with a synthetic,
 *    non-secret key, a bounded timestamp window and replay protection). This is
 *    OUR fixture scheme for offline tests; it is NOT Talkdesk's and no sender is
 *    assumed to implement it;
 *  - every other environment: the route refuses with WEBHOOK_AUTH_UNVERIFIED
 *    before reading the event. Transfer outcomes stay OUTCOME_UNKNOWN and humans
 *    reconcile until a documented mechanism exists.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Environment } from "../../protocol/index.js";
import { canonicalJson } from "../../shared/canonical.js";
import type { Clock } from "../../shared/clock.js";
import { ConfigurationRejectedError } from "../../shared/errors.js";
import type { TransferCoordinator } from "../../workflows/transfer.js";
import { TransferEventName } from "../../workflows/transfer.js";
import { ErrorBody, defineRoute } from "./route.js";
import type { RouteDef } from "./route.js";

export const WEBHOOK_FIXTURE_BADGE = "LOCAL FIXTURE — synthetic HMAC webhook scheme (not a vendor protocol), local/ci only";
/** Synthetic, labelled, non-secret key for the LOCAL FIXTURE scheme. */
export const LOCAL_FIXTURE_WEBHOOK_HMAC_KEY = "local-fixture-transfer-webhook-hmac-NOT-A-SECRET-0001";
export const WEBHOOK_TIMESTAMP_HEADER = "x-vsp-fixture-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "x-vsp-fixture-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const TransferEventBody = z.strictObject({
  transferId: z.string().regex(/^xfr_[A-Za-z0-9_-]{16,64}$/),
  event: TransferEventName,
  eventId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
  packageAcknowledged: z.boolean().optional(),
});
export const TransferEventResponse = z.strictObject({ accepted: z.boolean(), decision: z.enum(["applied", "acknowledged", "duplicate", "rejected"]) });

/** Computes the LOCAL FIXTURE signature (tests and the local demo). */
export function fixtureWebhookSignature(timestampSeconds: number, body: unknown, key: string = LOCAL_FIXTURE_WEBHOOK_HMAC_KEY): string {
  return `sha256=${createHmac("sha256", key).update(`${timestampSeconds}.${canonicalJson(body)}`).digest("hex")}`;
}

export interface WebhookRouteDeps {
  environment: Environment;
  clock: Clock;
  transfers: TransferCoordinator;
  /** Override for tests; only honoured in local/ci. */
  fixtureKey?: string;
}

export function webhookRoutes(d: WebhookRouteDeps): RouteDef<unknown, unknown>[] {
  const enabled = d.environment === "local" || d.environment === "ci";
  if (!enabled && d.fixtureKey) throw new ConfigurationRejectedError(["WEBHOOK_FIXTURE_KEY_OUTSIDE_LOCAL_CI@gateway.webhook"]);
  const key = d.fixtureKey ?? LOCAL_FIXTURE_WEBHOOK_HMAC_KEY;
  const seen = new Map<string, number>();
  const remember = (sig: string, nowS: number) => {
    seen.set(sig, nowS);
    for (const [k, at] of seen) if (nowS - at > WEBHOOK_TOLERANCE_SECONDS * 2) seen.delete(k);
    while (seen.size > 10_000) {
      const first = seen.keys().next().value;
      if (first === undefined) break;
      seen.delete(first);
    }
  };

  return [
    defineRoute({
      operationId: "webhooks.transferEvents",
      ref: "TC-09",
      method: "POST",
      path: "/v1/webhooks/transfer-events",
      channel: null,
      summary:
        "Transfer lifecycle events (receiver accepted, bridged, caller connected). Enabled ONLY in local/ci with a labelled LOCAL FIXTURE HMAC scheme; refused elsewhere with WEBHOOK_AUTH_UNVERIFIED until Talkdesk documents webhook authentication (TB-09).",
      tags: ["webhooks"],
      headers: [
        { name: "X-VSP-Fixture-Timestamp", required: true, description: "LOCAL FIXTURE scheme only: epoch seconds." },
        { name: "X-VSP-Fixture-Signature", required: true, description: "LOCAL FIXTURE scheme only: sha256=<hex HMAC-SHA256 over '<timestamp>.<canonical JSON body>'>." },
      ],
      // Parsed after authentication: the body is read only once the signature verifies.
      body: z.unknown() as z.ZodType<unknown>,
      responses: {
        200: { description: "Event processed (idempotent; duplicates ignored)", schema: TransferEventResponse },
        400: { description: "Strict schema violation", schema: ErrorBody },
        401: { description: "Signature missing, invalid, stale or replayed", schema: ErrorBody },
        403: { description: "WEBHOOK_AUTH_UNVERIFIED: no documented vendor mechanism (TB-09)", schema: ErrorBody },
        404: { description: "Unknown transfer", schema: ErrorBody },
      },
      handler: async (ctx) => {
        const err = (status: number, reasonCode: string) => ({ status, body: { error: { reasonCode, requestId: ctx.requestId } } });
        if (!enabled) return err(403, "WEBHOOK_AUTH_UNVERIFIED");
        const ts = Number(ctx.header(WEBHOOK_TIMESTAMP_HEADER));
        const sig = ctx.header(WEBHOOK_SIGNATURE_HEADER) ?? "";
        const nowS = Math.floor(d.clock.now().getTime() / 1000);
        if (!Number.isInteger(ts) || Math.abs(nowS - ts) > WEBHOOK_TOLERANCE_SECONDS) return err(401, "WEBHOOK_TIMESTAMP_INVALID");
        if (!/^sha256=[a-f0-9]{64}$/.test(sig)) return err(401, "WEBHOOK_SIGNATURE_MISSING");
        let expected: string;
        try {
          expected = fixtureWebhookSignature(ts, ctx.body, key);
        } catch {
          return err(400, "INVALID_REQUEST_BODY");
        }
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return err(401, "WEBHOOK_SIGNATURE_INVALID");
        if (seen.has(sig)) return err(401, "WEBHOOK_REPLAYED");
        const body = TransferEventBody.safeParse(ctx.body);
        if (!body.success) return err(400, "INVALID_REQUEST_BODY");
        remember(sig, nowS);
        try {
          const r = await d.transfers.applyEvent({ transferId: body.data.transferId, event: body.data.event, eventId: body.data.eventId, source: "webhook.local_fixture", ...(body.data.packageAcknowledged !== undefined ? { packageAcknowledged: body.data.packageAcknowledged } : {}) });
          return { status: 200, body: { accepted: r.decision.kind !== "rejected", decision: r.decision.kind } };
        } catch (e) {
          const code = (e as { reasonCode?: unknown }).reasonCode;
          if (code === "TRANSFER_NOT_FOUND") return err(404, "TRANSFER_NOT_FOUND");
          throw e;
        }
      },
    }),
  ] as RouteDef<unknown, unknown>[];
}
