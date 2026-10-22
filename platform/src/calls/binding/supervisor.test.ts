/**
 * MediaPlaneSupervisor over a labelled unit fake of livekit-server's Twirp API (WP-11; FO-19-10, FO-22-16, SAFE-02).
 * The Layer-2 media suite runs it against the real server (platform/test/integration/media/worker.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { MediaPlaneApi } from "./livekit-lookup.js";
import { MediaPlaneSupervisor } from "./supervisor.js";

const AGENT = "vsp-media";
const T0 = 1_792_000_000_000;
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);

/** LOCAL FIXTURE (unit fake): rooms, participants and dispatches as livekit-server answers them (proto field names). */
class PlaneFake implements MediaPlaneApi {
  readonly created: Record<string, unknown>[] = [];
  rooms: string[] = ["room-a"];
  participants: Record<string, { identity: string; kind: string; state: string }[]> = {};
  dispatches: Record<string, unknown[]> = {};
  async call(service: string, method: string, body: Record<string, unknown>, _room: string, sideEffect = false) {
    if (method === "ListRooms") return { rooms: this.rooms.map((name, i) => ({ sid: `RM_synthRoom000${i}`, name })) };
    if (method === "ListParticipants") return { participants: this.participants[String(body.room)] ?? [] };
    if (method === "ListDispatch") return { agent_dispatches: this.dispatches[String(body.room)] ?? [] };
    if (method === "CreateDispatch" && service === "AgentDispatchService" && sideEffect) {
      this.created.push(body);
      return { id: "AD_synthNewDispatch" };
    }
    throw new Error(`unexpected ${service}/${method}`);
  }
}

function setup(o: { now?: number; maxRooms?: number; failRoutes?: number; endCall?: boolean } = {}) {
  let now = o.now ?? T0 + 60_000;
  const api = new PlaneFake();
  const routed: string[] = [];
  const ended: string[] = [];
  /** The rooms' person requests as the gateway records them (LOCAL FIXTURE); a successful route accepts an owed one. */
  const persons = new Map<string, "NONE" | "OUTSTANDING" | "WITH_PERSON">();
  const asked: string[] = [];
  let failures = o.failRoutes ?? 0;
  const routeToHuman = async (r: string) => {
    if (failures > 0) {
      failures--;
      throw new Error("HANDOFF_STORE_UNAVAILABLE");
    }
    routed.push(r);
    persons.set(r, "WITH_PERSON");
  };
  const personState = async (room: { name: string; sid: string }) => {
    asked.push(`${room.name}:${room.sid}`);
    return persons.get(room.name) ?? "NONE";
  };
  const sup = new MediaPlaneSupervisor(
    { agentName: AGENT, redispatchGraceMs: 15_000, humanAfterMs: 45_000, ...(o.maxRooms ? { maxRooms: o.maxRooms } : {}) },
    { api, now: () => now, routeToHuman, personState, ...(o.endCall ? { endCall: async (r: string) => void ended.push(r) } : {}) },
  );
  api.dispatches["room-a"] = [{ id: "AD_synthDispatch01", agent_name: AGENT, room: "room-a", metadata: '{"x":1}', state: { created_at: ns(T0), jobs: [{ id: "AJ_synthJob0001", state: { status: "JS_RUNNING", started_at: ns(T0 + 500), participant_identity: "agent-AJ_synthJob0001" } }] } }];
  api.participants["room-a"] = [{ identity: "caller-1", kind: "STANDARD", state: "ACTIVE" }, { identity: "agent-AJ_synthJob0001", kind: "AGENT", state: "ACTIVE" }];
  return { sup, api, routed, ended, persons, asked, tick: (ms: number) => (now += ms) };
}

describe("MediaPlaneSupervisor [FO-19-10][FO-22-16][SAFE-02]", () => {
  it("a room held by the agent of one of its jobs is OWNED; rooms never dispatched to this runtime are ignored", async () => {
    const s = setup();
    s.api.rooms.push("room-foreign");
    s.api.participants["room-foreign"] = [{ identity: "caller-9", kind: "SIP", state: "ACTIVE" }];
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "OWNED" }]);
    expect(s.api.created).toEqual([]);
  });

  it("[FO-19-10] the owner's agent gone with the caller still there: re-dispatched once with the same agent name and metadata, then WAITING for the new job", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "STANDARD", state: "ACTIVE" }];
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "REDISPATCHED" }]);
    expect(s.api.created).toEqual([{ room: "room-a", agentName: AGENT, metadata: '{"x":1}' }]);
    // The new dispatch is fresh: the next sweep waits for it instead of dispatching again.
    s.api.dispatches["room-a"]?.push({ id: "AD_synthNewDispatch", agent_name: AGENT, room: "room-a", metadata: '{"x":1}', state: { created_at: ns(T0 + 60_000), jobs: [] } });
    s.tick(5_000);
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "WAITING" }]);
    expect(s.api.created).toHaveLength(1);
    // The new job's agent joined: OWNED again, the orphan clock is cleared.
    s.api.participants["room-a"]?.push({ identity: "agent-AJ_synthJob0002", kind: "AGENT", state: "ACTIVE" });
    (s.api.dispatches["room-a"]?.[1] as { state: { jobs: unknown[] } }).state.jobs.push({ id: "AJ_synthJob0002", state: { status: "JS_RUNNING", participant_identity: "agent-AJ_synthJob0002" } });
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "OWNED" }]);
  });

  it("adversarial: an agent participant that holds none of the room's jobs does not count as the owner", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "STANDARD", state: "ACTIVE" }, { identity: "agent-impostor", kind: "AGENT", state: "ACTIVE" }];
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "REDISPATCHED" }]);
  });

  it("a fresh dispatch is given its grace period; a call whose caller left is not recovered", async () => {
    const s = setup({ now: T0 + 3_000 });
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "STANDARD", state: "ACTIVE" }];
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "WAITING" }]);
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "STANDARD", state: "DISCONNECTED" }];
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "NO_CALLER" }]);
    expect(s.api.created).toEqual([]);
  });

  it("[SAFE-02] still without a runtime after the deadline: the caller is routed to a person, once (the room is then with a person: never re-dispatched)", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    await s.sup.sweep();
    s.tick(46_000);
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "HUMAN_ROUTED" }]);
    expect(s.routed).toEqual(["room-a"]);
    s.tick(5_000);
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "WITH_PERSON" }]);
    expect(s.routed).toEqual(["room-a"]);
    expect(s.api.created).toHaveLength(1);
  });

  it("failure injection: a media-plane error on one room is reported FAILED and the sweep goes on", async () => {
    const s = setup();
    s.api.rooms.push("room-b");
    const original = s.api.call.bind(s.api);
    s.api.call = async (svc, m, body, room, se) => (body.room === "room-b" ? Promise.reject(new Error("LIVEKIT_API_UNAVAILABLE")) : original(svc, m, body, room, se));
    expect(await s.sup.sweep()).toEqual([
      { roomName: "room-a", outcome: "OWNED" },
      { roomName: "room-b", outcome: "FAILED" },
    ]);
    expect(() => new MediaPlaneSupervisor({ agentName: AGENT, redispatchGraceMs: 20_000, humanAfterMs: 10_000 }, { api: s.api, now: Date.now, routeToHuman: async () => undefined, personState: async () => "NONE" as const })).toThrow();
  });

  it("[SAFE-02] failure injection: a failed human route is retried on the next sweep and counts as routed only once it succeeded", async () => {
    const s = setup({ failRoutes: 2 });
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    await s.sup.sweep();
    s.tick(46_000);
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(...(await s.sup.sweep()).map((r) => r.outcome));
      s.tick(2_000);
    }
    expect(outcomes).toEqual(["FAILED", "FAILED", "HUMAN_ROUTED", "WITH_PERSON"]);
    expect(s.routed).toEqual(["room-a"]);
  });

  it("[SAFE-02] a runtime that joins and gives up again does not postpone the person: the orphan clock survives an owner that did not stay", async () => {
    const s = setup();
    const owner = { identity: "agent-AJ_synthJob0001", kind: "AGENT", state: "ACTIVE" };
    const caller = { identity: "caller-1", kind: "SIP", state: "ACTIVE" };
    s.api.participants["room-a"] = [caller];
    expect((await s.sup.sweep())[0]?.outcome).toBe("REDISPATCHED");
    // The re-dispatched runtime joins briefly (its own human route was refused, so it leaves the room again).
    for (let i = 0; i < 4; i++) {
      s.tick(10_000);
      s.api.participants["room-a"] = i % 2 === 0 ? [caller, owner] : [caller];
      await s.sup.sweep();
    }
    s.tick(10_000);
    s.api.participants["room-a"] = [caller];
    expect(await s.sup.sweep()).toEqual([{ roomName: "room-a", outcome: "HUMAN_ROUTED" }]);
    expect(s.routed).toEqual(["room-a"]);
  });

  it("an owner that holds the room for the stable period clears the orphan clock: a later loss starts a new deadline", async () => {
    const s = setup();
    const owner = { identity: "agent-AJ_synthJob0001", kind: "AGENT", state: "ACTIVE" };
    const caller = { identity: "caller-1", kind: "SIP", state: "ACTIVE" };
    s.api.participants["room-a"] = [caller];
    await s.sup.sweep();
    s.tick(20_000);
    s.api.participants["room-a"] = [caller, owner];
    await s.sup.sweep();
    s.tick(46_000);
    expect((await s.sup.sweep())[0]?.outcome).toBe("OWNED");
    s.api.participants["room-a"] = [caller];
    s.tick(1_000);
    expect((await s.sup.sweep())[0]?.outcome).not.toBe("HUMAN_ROUTED");
    expect(s.routed).toEqual([]);
  });

  it("[FO-10-09] a room whose caller was seen and left: the call is ended at the control plane once; a room never seen with a caller is not", async () => {
    const s = setup({ endCall: true });
    s.api.rooms.push("room-b");
    s.api.dispatches["room-b"] = s.api.dispatches["room-a"] ?? [];
    s.api.participants["room-b"] = [];
    expect((await s.sup.sweep()).map((r) => r.outcome)).toEqual(["OWNED", "NO_CALLER"]);
    s.api.participants["room-a"] = [{ identity: "agent-AJ_synthJob0001", kind: "AGENT", state: "ACTIVE" }];
    expect((await s.sup.sweep()).map((r) => r.outcome)).toEqual(["CALL_ENDED", "NO_CALLER"]);
    expect((await s.sup.sweep()).map((r) => r.outcome)).toEqual(["NO_CALLER", "NO_CALLER"]);
    expect(s.ended).toEqual(["room-a"]);
  });

  it("[SAFE-02][FO-10-46] a caller still owed a person (the runtime asked, the handoff failed, the runtime left): routed on this and every sweep until accepted, and the AI is never re-dispatched", async () => {
    const s = setup({ failRoutes: 2 });
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    s.persons.set("room-a", "OUTSTANDING");
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(...(await s.sup.sweep()).map((r) => r.outcome));
      s.tick(20_000); // well past the re-dispatch grace and the human deadline
    }
    expect(outcomes).toEqual(["FAILED", "FAILED", "HUMAN_ROUTED", "WITH_PERSON", "WITH_PERSON"]);
    expect(s.routed).toEqual(["room-a"]);
    expect(s.api.created).toEqual([]);
    // The check names the room by its server id (the room's request is keyed by it).
    expect(s.asked[0]).toBe("room-a:RM_synthRoom0000");
  });

  it("[SAFE-02][FO-10-46] a caller already with a person is left alone: no re-dispatch of the AI and no second person, however long the room stays without a runtime", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    s.persons.set("room-a", "WITH_PERSON");
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(...(await s.sup.sweep()).map((r) => r.outcome));
      s.tick(30_000);
    }
    expect(outcomes).toEqual(["WITH_PERSON", "WITH_PERSON", "WITH_PERSON", "WITH_PERSON"]);
    expect(s.api.created).toEqual([]);
    expect(s.routed).toEqual([]);
  });

  it("[SAFE-02] failure injection: the person request cannot be read: never re-dispatched on a guess, and the caller is routed to a person once the room has been orphaned past the deadline (once, not on every sweep)", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    let now = T0 + 60_000;
    const routed: string[] = [];
    const sup = new MediaPlaneSupervisor(
      { agentName: AGENT, redispatchGraceMs: 15_000, humanAfterMs: 45_000 },
      { api: s.api, now: () => now, routeToHuman: async (r) => void routed.push(r), personState: async () => Promise.reject(Object.assign(new Error("store"), { reasonCode: "DYNAMODB_UNAVAILABLE" })) },
    );
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) {
      outcomes.push(...(await sup.sweep()).map((r) => r.outcome));
      now += 5_000;
    }
    // 0..40 s orphaned: unknown (no re-dispatch); 45 s: routed; afterwards: no second person for the room.
    expect(outcomes).toEqual([...Array<string>(9).fill("PERSON_STATE_UNKNOWN"), "HUMAN_ROUTED", "PERSON_STATE_UNKNOWN", "PERSON_STATE_UNKNOWN"]);
    expect(routed).toEqual(["room-a"]);
    expect(s.api.created).toEqual([]);
  });

  it("failure injection: the person request is readable again after a brief outage: the room is re-dispatched then (the outage only delayed it)", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    let down = true;
    const sup = new MediaPlaneSupervisor(
      { agentName: AGENT, redispatchGraceMs: 15_000, humanAfterMs: 45_000 },
      { api: s.api, now: () => T0 + 60_000, routeToHuman: async () => undefined, personState: async () => (down ? Promise.reject(new Error("DYNAMODB_UNAVAILABLE")) : "NONE") },
    );
    expect(await sup.sweep()).toEqual([{ roomName: "room-a", outcome: "PERSON_STATE_UNKNOWN" }]);
    expect(s.api.created).toEqual([]);
    down = false;
    expect(await sup.sweep()).toEqual([{ roomName: "room-a", outcome: "REDISPATCHED" }]);
  });

  it("[SAFE-02] failure injection: a person route that fails while the person request is unreadable is retried on the next sweep", async () => {
    const s = setup();
    s.api.participants["room-a"] = [{ identity: "caller-1", kind: "SIP", state: "ACTIVE" }];
    let now = T0 + 60_000;
    let failures = 2;
    const routed: string[] = [];
    const sup = new MediaPlaneSupervisor(
      { agentName: AGENT, redispatchGraceMs: 15_000, humanAfterMs: 45_000 },
      {
        api: s.api,
        now: () => now,
        routeToHuman: async (r) => {
          if (failures-- > 0) throw new Error("HANDOFF_STORE_UNAVAILABLE");
          routed.push(r);
        },
        personState: async () => Promise.reject(new Error("DYNAMODB_UNAVAILABLE")),
      },
    );
    await sup.sweep();
    now += 46_000;
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(...(await sup.sweep()).map((r) => r.outcome));
      now += 2_000;
    }
    expect(outcomes).toEqual(["FAILED", "FAILED", "HUMAN_ROUTED", "PERSON_STATE_UNKNOWN"]);
    expect(routed).toEqual(["room-a"]);
    expect(s.api.created).toEqual([]);
  });

  it("more rooms than one sweep examines: the window rotates so every room is examined", async () => {
    const s = setup({ maxRooms: 2 });
    s.api.rooms = ["room-a", "room-b", "room-c", "room-d", "room-e"];
    for (const r of s.api.rooms) {
      s.api.dispatches[r] = s.api.dispatches["room-a"] ?? [];
      s.api.participants[r] = s.api.participants["room-a"] ?? [];
    }
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) for (const r of await s.sup.sweep()) seen.add(r.roomName);
    expect([...seen].sort()).toEqual(["room-a", "room-b", "room-c", "room-d", "room-e"]);
  });
});
