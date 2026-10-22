/**
 * Recovery of the media path (WP-11; FO-05-16, FO-10-46, FO-19-10, FO-22-16; AUTH-03, SAFE-02).
 *
 * When a worker crashes, LiveKit dispatches the room's job again (to this worker after a restart, or another one).
 * The new job asks the gateway for the binding: when the previous owner is gone (it left the room, or its binding
 * expired without a heartbeat) the gateway re-binds the call with a NEW session generation and fencing token, voids
 * the old owner's pending actions, and every request still carrying the old claim is refused (409). While the
 * previous owner is still present and live the gateway refuses (BINDING_OWNER_ACTIVE) and the new job keeps asking
 * until a bounded deadline; still refused then, the owner is live and serving the caller, so the extra job leaves (a
 * room left without a runtime is the supervisor's). If the call cannot be re-bound for any other reason it goes to a
 * person through the session-less human route (SAFE-02), never back to an AI turn on a stale generation.
 *
 * Mid-call, a lost binding is decided here too: another owner took over (leave quietly), the call ended (leave), a
 * stale generation (re-bind, the same owner is answered idempotently with the current claim), a person requested for
 * the room by anyone (owed: ask for the person again; accepted: stay silent and suspended, WITH_PERSON), or the
 * binding cannot be held (revoked, session invalid, gateway unreachable past expiry, credential refused): a person.
 *
 * A person who could not be requested (the route refused or unreachable, or the handoff not accepted, until the
 * deadline) is never a reason to stay in the room: the runtime leaves, so the media-plane supervisor sees the caller
 * without a runtime and routes the caller itself through its platform-internal path (MediaCall.routeToHuman). The
 * gateway records every request for a person before it attempts the handoff, so the supervisor routes an owed person
 * instead of re-dispatching the AI, and a re-dispatched runtime is refused the binding: BINDING_PERSON_REQUESTED (it
 * asks for the person again), BINDING_CONSENT_REQUIRES_PERSON (the caller declined what the AI needs), or
 * BINDING_WITH_PERSON (the caller is with a person: the runtime stays silent and suspended, WITH_PERSON).
 */
import type { MediaBindRequest, MediaBindResponse, MediaHumanRouteReason, MediaRouteResponse } from "@vsp/platform/src/protocol/call-binding.js";
import { GatewayRefusedError, GatewayUnavailableError } from "../binding/client.js";
import type { BindingLoss } from "../binding/manager.js";

export type LossAction = { kind: "LEAVE"; reasonCode: string } | { kind: "REBIND"; reasonCode: string } | { kind: "HUMAN"; reason: MediaHumanRouteReason; reasonCode: string } | { kind: "WITH_PERSON"; reasonCode: string };

/** What the runtime does when the gateway says it no longer holds the call. */
export function decideOnLoss(loss: BindingLoss): LossAction {
  switch (loss.reason) {
    case "SUPERSEDED":
    case "FENCING_TOKEN_STALE":
      return { kind: "LEAVE", reasonCode: loss.reasonCode };
    case "ENDED":
      return { kind: "LEAVE", reasonCode: loss.reasonCode };
    case "GENERATION_STALE":
    case "EXPIRED_UNREACHABLE":
      return { kind: "REBIND", reasonCode: loss.reasonCode };
    case "PERSON_REQUESTED":
      // A person is owed for the room (requested by anyone): ask for it again; the gateway retries the recorded request.
      return { kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: loss.reasonCode };
    case "WITH_PERSON":
      return { kind: "WITH_PERSON", reasonCode: loss.reasonCode };
    case "REVOKED":
    case "SESSION_INVALID":
    case "REFUSED":
      return { kind: "HUMAN", reason: "BINDING_UNAVAILABLE", reasonCode: loss.reasonCode };
  }
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const realSleeper: Sleeper = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface RecoveryOptions {
  /** Total time a job keeps asking for the binding before the call goes to a person (default 45 s). */
  deadlineMs?: number;
  /** First retry delay; doubles up to `maxDelayMs` (defaults 250 ms and 2 s). */
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleeper?: Sleeper;
  /** Stops the loop early (the caller hung up, the job is shutting down). */
  cancelled?: () => boolean;
}

export type BindOutcome =
  | { kind: "BOUND"; response: MediaBindResponse; attempts: number }
  | { kind: "LEAVE"; reasonCode: string; attempts: number }
  | { kind: "HUMAN"; reason: MediaHumanRouteReason; reasonCode: string; attempts: number }
  | { kind: "WITH_PERSON"; reasonCode: string; attempts: number };

/** Refusals after which asking again cannot succeed. */
const FINAL_LEAVE = new Set(["BINDING_CALL_ENDED", "BINDING_CALLER_GONE"]);
/** Refusals that send the caller to a person (never back to an AI turn), with the reason the runtime gives. */
const FINAL_HUMAN: Readonly<Record<string, MediaHumanRouteReason>> = { BINDING_PERSON_REQUESTED: "RECOVERY_FAILED", BINDING_CONSENT_REQUIRES_PERSON: "CONSENT_DECLINED_ALTERNATIVE" };
// MEDIA_AGENT_NOT_IN_ROOM, MEDIA_JOB_NOT_DISPATCHED and MEDIA_JOB_NOT_ASSIGNED: livekit-server lists the agent
// participant and the job's assigned participant in the dispatch state shortly after the job process joined
// (observed locally: the first bind right after connect can precede both); asking again within the deadline is safe
// because the gateway checks again every time.
const RETRY_REFUSALS = new Set(["BINDING_OWNER_ACTIVE", "BINDING_CONCURRENT_UPDATE", "RATE_LIMITED", "MEDIA_AGENT_NOT_IN_ROOM", "MEDIA_JOB_NOT_DISPATCHED", "MEDIA_JOB_NOT_ASSIGNED"]);

/**
 * Asks for the binding until it is issued, a final refusal arrives, or the deadline passes. Retries only what can
 * change with time (a live previous owner, a gateway or dependency that is briefly unavailable, a rate limit).
 */
export async function bindWithRecovery(bind: (req: MediaBindRequest) => Promise<MediaBindResponse>, req: MediaBindRequest, o: RecoveryOptions = {}): Promise<BindOutcome> {
  const now = o.now ?? Date.now;
  const sleeper = o.sleeper ?? realSleeper;
  const deadline = now() + (o.deadlineMs ?? 45_000);
  let delay = o.initialDelayMs ?? 250;
  const maxDelay = o.maxDelayMs ?? 2_000;
  let attempts = 0;
  let lastCode: string;
  for (;;) {
    if (o.cancelled?.()) return { kind: "LEAVE", reasonCode: "RECOVERY_CANCELLED", attempts };
    attempts++;
    try {
      return { kind: "BOUND", response: await bind(req), attempts };
    } catch (err) {
      if (err instanceof GatewayRefusedError) {
        lastCode = err.reasonCode;
        if (FINAL_LEAVE.has(err.reasonCode)) return { kind: "LEAVE", reasonCode: err.reasonCode, attempts };
        if (err.reasonCode === "BINDING_WITH_PERSON") return { kind: "WITH_PERSON", reasonCode: err.reasonCode, attempts };
        const human = FINAL_HUMAN[err.reasonCode];
        if (human) return { kind: "HUMAN", reason: human, reasonCode: err.reasonCode, attempts };
        if (!RETRY_REFUSALS.has(err.reasonCode) && err.status !== 429) return { kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: err.reasonCode, attempts };
      } else if (err instanceof GatewayUnavailableError) {
        lastCode = err.reasonCode;
      } else {
        lastCode = "BINDING_CLIENT_FAILED";
      }
    }
    if (now() + delay > deadline) {
      // A live owner still holds the call (present in the room and renewing): this job is the extra one (a duplicate
      // dispatch). It leaves rather than send a caller the AI is serving to a person; an owner that renews without
      // being in the room is not "active" (the gateway re-binds over it), and a room left without a runtime is the
      // supervisor's to recover or route (SAFE-02).
      if (lastCode === "BINDING_OWNER_ACTIVE") return { kind: "LEAVE", reasonCode: lastCode, attempts };
      return { kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: lastCode, attempts };
    }
    await sleeper.sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

export type HumanRouteOutcome =
  | { kind: "ROUTED"; response: MediaRouteResponse; attempts: number }
  | { kind: "NOT_ROUTED"; response: MediaRouteResponse | null; reasonCode: string; attempts: number };

/**
 * Requests a person (or the safety route) for the call through a session-less route (SAFE-02: needs no binding,
 * session or model). Retries transport failures, rate limits and answers that did not accept the handoff (a failing handoff store
 * can recover) until the deadline; a refusal of the request itself (4xx other than 429, after the client's own retry
 * with a fresh credential) is final. NOT_ROUTED means no person was requested: the caller must not stay with a
 * runtime that gave up (the call leaves the room so the supervisor routes it).
 */
export async function requestHumanWithRetry(route: () => Promise<MediaRouteResponse>, o: RecoveryOptions = {}): Promise<HumanRouteOutcome> {
  const now = o.now ?? Date.now;
  const sleeper = o.sleeper ?? realSleeper;
  const deadline = now() + (o.deadlineMs ?? 30_000);
  let delay = o.initialDelayMs ?? 250;
  const maxDelay = o.maxDelayMs ?? 2_000;
  let attempts = 0;
  let lastCode: string;
  let last: MediaRouteResponse | null = null;
  for (;;) {
    if (o.cancelled?.()) return { kind: "NOT_ROUTED", response: last, reasonCode: "RECOVERY_CANCELLED", attempts };
    attempts++;
    try {
      const response = await route();
      if (response.accepted) return { kind: "ROUTED", response, attempts };
      last = response;
      lastCode = response.reasonCode;
    } catch (err) {
      lastCode = err instanceof GatewayRefusedError || err instanceof GatewayUnavailableError ? err.reasonCode : "HUMAN_ROUTE_CLIENT_FAILED";
      // 4xx other than a rate limit will not change by asking again.
      if (err instanceof GatewayRefusedError && err.status !== 429) return { kind: "NOT_ROUTED", response: last, reasonCode: lastCode, attempts };
    }
    if (now() + delay > deadline) return { kind: "NOT_ROUTED", response: last, reasonCode: lastCode, attempts };
    await sleeper.sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}
