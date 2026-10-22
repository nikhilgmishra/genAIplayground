/** Recovery policy (media/src/recovery) [FO-05-16][FO-19-10][FO-22-16][SAFE-02][AUTH-03]. */
import { describe, expect, it } from "vitest";
import type { MediaBindResponse } from "@vsp/platform/src/protocol/call-binding.js";
import { GatewayRefusedError, GatewayUnavailableError } from "../src/binding/client.js";
import { bindWithRecovery, decideOnLoss, requestHumanWithRetry } from "../src/recovery/policy.js";

const REQ = { roomName: "call-synth-room", jobRef: "AJ_synthJob0001", workerInstanceRef: "media-worker-a1", agentIdentity: "agent-AJ_synthJob0001", adapter: "controlled_cascade_runtime" as const };
const BOUND = { issue: "REBOUND_AFTER_OWNER_LOSS" } as unknown as MediaBindResponse;

function clockAndSleeper() {
  let now = 0;
  const slept: number[] = [];
  return { now: () => now, sleeper: { sleep: async (ms: number) => void (slept.push(ms), (now += ms)) }, slept };
}

describe("decideOnLoss [AUTH-03][SAFE-02]", () => {
  it("another owner or an ended call: leave; a stale generation or an unreachable gateway: re-bind; anything else: a person", () => {
    expect(decideOnLoss({ reason: "SUPERSEDED", reasonCode: "BINDING_SUPERSEDED" }).kind).toBe("LEAVE");
    expect(decideOnLoss({ reason: "FENCING_TOKEN_STALE", reasonCode: "BINDING_FENCING_TOKEN_STALE" }).kind).toBe("LEAVE");
    expect(decideOnLoss({ reason: "ENDED", reasonCode: "BINDING_CALL_ENDED" }).kind).toBe("LEAVE");
    expect(decideOnLoss({ reason: "GENERATION_STALE", reasonCode: "BINDING_GENERATION_STALE" }).kind).toBe("REBIND");
    expect(decideOnLoss({ reason: "EXPIRED_UNREACHABLE", reasonCode: "BINDING_EXPIRED" }).kind).toBe("REBIND");
    for (const reason of ["REVOKED", "SESSION_INVALID", "REFUSED"] as const) expect(decideOnLoss({ reason, reasonCode: "X_Y_Z" })).toMatchObject({ kind: "HUMAN", reason: "BINDING_UNAVAILABLE" });
    // A person requested for the room by anyone: owed, ask for it again; accepted, stay silent with the person.
    expect(decideOnLoss({ reason: "PERSON_REQUESTED", reasonCode: "BINDING_PERSON_REQUESTED" })).toEqual({ kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: "BINDING_PERSON_REQUESTED" });
    expect(decideOnLoss({ reason: "WITH_PERSON", reasonCode: "BINDING_WITH_PERSON" })).toEqual({ kind: "WITH_PERSON", reasonCode: "BINDING_WITH_PERSON" });
  });
});

describe("bindWithRecovery [FO-19-10][FO-22-16]", () => {
  it("[FO-19-10] keeps asking while the previous owner is live, then binds (a worker restart re-binds once the old owner is gone)", async () => {
    const t = clockAndSleeper();
    let calls = 0;
    const out = await bindWithRecovery(async () => {
      if (++calls < 4) throw new GatewayRefusedError(409, "BINDING_OWNER_ACTIVE");
      return BOUND;
    }, REQ, { now: t.now, sleeper: t.sleeper, deadlineMs: 10_000 });
    expect(out).toMatchObject({ kind: "BOUND", attempts: 4 });
    expect(t.slept).toEqual([250, 500, 1_000]);
  });

  it("[SAFE-02] a refusal that cannot change goes to a person at once; an ended call leaves; past the deadline a person", async () => {
    const t = clockAndSleeper();
    expect(await bindWithRecovery(async () => Promise.reject(new GatewayRefusedError(403, "MEDIA_JOB_PARTICIPANT_MISMATCH")), REQ, { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: "MEDIA_JOB_PARTICIPANT_MISMATCH", attempts: 1 });
    // The media plane lists a just-dispatched job a moment later: asked again, then bound.
    let n = 0;
    expect(await bindWithRecovery(async () => (++n < 3 ? Promise.reject(new GatewayRefusedError(403, "MEDIA_JOB_NOT_DISPATCHED")) : BOUND), REQ, { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "BOUND", attempts: 3 });
    expect(await bindWithRecovery(async () => Promise.reject(new GatewayRefusedError(409, "BINDING_CALL_ENDED")), REQ, { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "LEAVE", reasonCode: "BINDING_CALL_ENDED" });
    // The caller left while no runtime held the call: nothing to recover, leave.
    expect(await bindWithRecovery(async () => Promise.reject(new GatewayRefusedError(409, "BINDING_CALLER_GONE")), REQ, { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "LEAVE", reasonCode: "BINDING_CALLER_GONE" });
    // Another room carrying this call's carrier reference is never retried into the call: a person.
    expect(await bindWithRecovery(async () => Promise.reject(new GatewayRefusedError(409, "BINDING_ROOM_MISMATCH")), REQ, { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "HUMAN", reasonCode: "BINDING_ROOM_MISMATCH", attempts: 1 });
    const t2 = clockAndSleeper();
    const out = await bindWithRecovery(async () => Promise.reject(new GatewayUnavailableError("GATEWAY_UNREACHABLE", false)), REQ, { now: t2.now, sleeper: t2.sleeper, deadlineMs: 5_000 });
    expect(out).toMatchObject({ kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: "GATEWAY_UNREACHABLE" });
    expect(t2.now()).toBeLessThanOrEqual(5_000);
  });

  it("[SAFE-02][FO-10-46] a live owner still holds the call at the deadline (BINDING_OWNER_ACTIVE to the end): the extra job leaves instead of sending the caller to a person; any other last refusal at the deadline is a person", async () => {
    const t = clockAndSleeper();
    const out = await bindWithRecovery(async () => Promise.reject(new GatewayRefusedError(409, "BINDING_OWNER_ACTIVE")), REQ, { now: t.now, sleeper: t.sleeper, deadlineMs: 5_000 });
    expect(out).toMatchObject({ kind: "LEAVE", reasonCode: "BINDING_OWNER_ACTIVE" });
    expect(t.now()).toBeLessThanOrEqual(5_000);
    const t2 = clockAndSleeper();
    let n = 0;
    // The owner left the room meanwhile, then the gateway was briefly unavailable: the last refusal decides.
    const mixed = await bindWithRecovery(async () => Promise.reject(++n < 3 ? new GatewayRefusedError(409, "BINDING_OWNER_ACTIVE") : new GatewayRefusedError(409, "BINDING_CONCURRENT_UPDATE")), REQ, { now: t2.now, sleeper: t2.sleeper, deadlineMs: 5_000 });
    expect(mixed).toMatchObject({ kind: "HUMAN", reason: "RECOVERY_FAILED", reasonCode: "BINDING_CONCURRENT_UPDATE" });
  });

  it("stops when the call is over", async () => {
    let cancelled = false;
    const t = clockAndSleeper();
    const out = await bindWithRecovery(async () => {
      cancelled = true;
      throw new GatewayRefusedError(409, "BINDING_OWNER_ACTIVE");
    }, REQ, { now: t.now, sleeper: t.sleeper, cancelled: () => cancelled });
    expect(out).toMatchObject({ kind: "LEAVE", reasonCode: "RECOVERY_CANCELLED" });
  });
});

describe("requestHumanWithRetry [SAFE-02]", () => {
  const answer = { accepted: true, destinationId: "dst_support_general", handoffId: "hnd_synthHandoff000001", speechTemplateId: "human.offer", reasonCode: "HANDOFF_REQUESTED" };
  it("retries a transport failure, takes the first accepted answer; a 4xx refusal is final and NOT_ROUTED", async () => {
    const t = clockAndSleeper();
    let n = 0;
    expect(await requestHumanWithRetry(async () => (++n < 3 ? Promise.reject(new GatewayUnavailableError("GATEWAY_UNREACHABLE", false)) : answer), { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "ROUTED", attempts: 3 });
    expect(await requestHumanWithRetry(async () => Promise.reject(new GatewayRefusedError(401, "RUNTIME_CREDENTIAL_INVALID")), { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "NOT_ROUTED", reasonCode: "RUNTIME_CREDENTIAL_INVALID", attempts: 1 });
    expect(await requestHumanWithRetry(async () => Promise.reject(new GatewayRefusedError(400, "INVALID_REQUEST_BODY")), { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "NOT_ROUTED", reasonCode: "INVALID_REQUEST_BODY" });
  });

  it("[SAFE-02] an answer that did not accept the handoff is asked again until the deadline; never ROUTED without an accepted answer", async () => {
    const t = clockAndSleeper();
    let n = 0;
    const refused = { ...answer, accepted: false, handoffId: null, reasonCode: "HANDOFF_REQUEST_FAILED" };
    expect(await requestHumanWithRetry(async () => (++n < 3 ? refused : answer), { now: t.now, sleeper: t.sleeper })).toMatchObject({ kind: "ROUTED", attempts: 3 });
    const t2 = clockAndSleeper();
    const out = await requestHumanWithRetry(async () => refused, { now: t2.now, sleeper: t2.sleeper, deadlineMs: 5_000 });
    expect(out).toMatchObject({ kind: "NOT_ROUTED", reasonCode: "HANDOFF_REQUEST_FAILED", response: refused });
    expect(t2.now()).toBeLessThanOrEqual(5_000);
  });
});
