/**
 * LiveKitCarrierLookup over a labelled unit fake of the egress transport that answers the livekit-server Twirp JSON
 * shapes (WP-11; FO-05-16). The real server answers these requests in the Layer-2 media suite.
 */
import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";
import { LiveKitCarrierLookup, partyDigestOf } from "./livekit-lookup.js";
import type { MediaPlaneHttp } from "./livekit-lookup.js";

const KEY = "lkkey_synthUnit01";
const SECRET = "lksecret_synthOnlyForUnitTests0123456789";

/** LOCAL FIXTURE (unit fake): replies keyed by Twirp method; records each request's path and token grants. */
class TwirpFake implements MediaPlaneHttp {
  readonly seen: { path: string; body: unknown; grants: Record<string, unknown> }[] = [];
  constructor(private readonly replies: Record<string, { status: number; body: unknown }>) {}
  async send(req: Parameters<MediaPlaneHttp["send"]>[0]) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const claims = await new TokenVerifier(KEY, SECRET).verify(token);
    this.seen.push({ path: req.url.pathname, body: JSON.parse(req.body), grants: (claims.video ?? {}) as Record<string, unknown> });
    const method = req.url.pathname.split("/").pop() ?? "";
    const reply = this.replies[method] ?? { status: 404, body: { code: "not_found" } };
    // A string body is sent as it is (a proxy's HTML page); anything else as JSON (livekit's Twirp answers).
    return { status: reply.status, body: Buffer.from(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)) };
  }
}

const room = { sid: "RM_synthRoom0001", name: "call-synth-room" };
const agent = { sid: "PA_synthAgent01", identity: "agent-AJ_synthJob0001", kind: "AGENT", state: "ACTIVE", attributes: {} };
const sipCaller = { sid: "PA_synthSip0001", identity: "sip_+15550100", kind: "SIP", state: "ACTIVE", joinedAtMs: "1792000001000", attributes: { "sip.callID": "SCL_synthSipCall01", "sip.trunkID": "ST_synthTrunk01", "sip.phoneNumber": "+15550100" } };
const dispatches = { agentDispatches: [{ id: "AD_synthDispatch1", agentName: "vsp-media", room: "call-synth-room", state: { jobs: [{ id: "AJ_synthJob0001", room: { name: "call-synth-room" }, state: { participantIdentity: "agent-AJ_synthJob0001" } }] } }] };

const make = (replies: Record<string, { status: number; body: unknown }>) => {
  const http = new TwirpFake(replies);
  return { http, lookup: new LiveKitCarrierLookup({ apiUrl: "https://livekit.vsp.test", apiKey: KEY, addressClass: "PRIVATE_NETWORK" }, http, async () => SECRET) };
};
const input = { tenantId: "tnt_synthTenantMedia0001", roomName: "call-synth-room", jobRef: "AJ_synthJob0001", agentIdentity: "agent-AJ_synthJob0001" };
const refusal = async (p: Promise<unknown>) => p.then(() => "NOT_REFUSED", (e: { reasonCode?: string }) => e.reasonCode ?? "UNKNOWN");

describe("LiveKitCarrierLookup [FO-05-16][AUTH-03]", () => {
  it("[FO-05-16] a SIP call: the room's server id and its SIP party (call id, trunk route, identity only as a digest, never the caller number); the job is held by the named agent", async () => {
    const { lookup, http } = make({ ListRooms: { status: 200, body: { rooms: [room] } }, ListParticipants: { status: 200, body: { participants: [agent, sipCaller] } }, ListDispatch: { status: 200, body: dispatches } });
    const c = await lookup.verify(input);
    expect(c).toEqual({
      roomSid: "RM_synthRoom0001",
      sipParties: [{ partyDigest: partyDigestOf("sip_+15550100"), interactionRef: "SCL_synthSipCall01", routeRef: "sip-trunk:ST_synthTrunk01", joinedAtMs: 1_792_000_001_000 }],
      presentAgents: ["agent-AJ_synthJob0001"],
    });
    expect(JSON.stringify(c)).not.toContain("5550100");
    expect(http.seen.map((s) => s.path)).toEqual(["/twirp/livekit.RoomService/ListRooms", "/twirp/livekit.RoomService/ListParticipants", "/twirp/livekit.AgentDispatchService/ListDispatch"]);
    // Short-lived server API token scoped to the one room.
    expect(http.seen[1]?.grants).toMatchObject({ roomAdmin: true, room: "call-synth-room" });
  });

  it("[FO-05-16] livekit-server answers with the proto field names (agent_dispatches, participant_identity): read the same way", async () => {
    const snake = { agent_dispatches: [{ id: "AD_synthDispatch1", agent_name: "vsp-media", room: "call-synth-room", state: { jobs: [{ id: "AJ_synthJob0001", room: { name: "call-synth-room" }, state: { participant_identity: "agent-AJ_synthJob0001" } }] } }] };
    const { lookup } = make({ ListRooms: { status: 200, body: { rooms: [room] } }, ListParticipants: { status: 200, body: { participants: [agent, { ...sipCaller, joinedAtMs: undefined, joined_at_ms: "1792000001000" }] } }, ListDispatch: { status: 200, body: snake } });
    expect(await lookup.verify(input)).toMatchObject({ roomSid: "RM_synthRoom0001", sipParties: [{ interactionRef: "SCL_synthSipCall01", joinedAtMs: 1_792_000_001_000 }] });
    expect(await refusal(lookup.verify({ ...input, agentIdentity: "agent-impostor" }))).toBe("MEDIA_JOB_PARTICIPANT_MISMATCH");
  });

  it("[FO-05-16] a WebRTC call has no SIP party: the room's server id is what names it", async () => {
    const { lookup } = make({ ListRooms: { status: 200, body: { rooms: [room] } }, ListParticipants: { status: 200, body: { participants: [agent, { identity: "caller-web", kind: "STANDARD", state: "ACTIVE" }] } }, ListDispatch: { status: 200, body: dispatches } });
    expect(await lookup.verify(input)).toMatchObject({ roomSid: "RM_synthRoom0001", sipParties: [] });
  });

  it("[FO-05-16] several SIP parties are listed earliest joined first; disconnected ones are not parties; a missing call id stays missing", async () => {
    const leg = { ...sipCaller, sid: "PA_synthSip0002", identity: "sip_synthLeg", joinedAtMs: "1792000009000", attributes: { "sip.callID": "SCL_synthSipLeg001" } };
    const gone = { ...sipCaller, sid: "PA_synthSip0003", identity: "sip_synthGone", state: "DISCONNECTED", joinedAtMs: "1792000000000" };
    const noId = { ...sipCaller, sid: "PA_synthSip0004", identity: "sip_synthNoId", joinedAtMs: "1792000005000", attributes: { "sip.phoneNumber": "+15550101" } };
    const { lookup } = make({ ListRooms: { status: 200, body: { rooms: [room] } }, ListParticipants: { status: 200, body: { participants: [leg, agent, gone, noId, sipCaller] } }, ListDispatch: { status: 200, body: dispatches } });
    const facts = await lookup.describeRoom({ tenantId: input.tenantId, roomName: input.roomName });
    expect(facts.sipParties.map((p) => p.interactionRef)).toEqual(["SCL_synthSipCall01", null, "SCL_synthSipLeg001"]);
    expect(JSON.stringify(facts)).not.toMatch(/5550101|sip_synth/);
  });

  it("[AUTH-03] adversarial: an undispatched job, an unassigned job, a job held by another participant, an absent agent and an unknown room are refused", async () => {
    const base = { ListRooms: { status: 200, body: { rooms: [room] } }, ListParticipants: { status: 200, body: { participants: [agent, sipCaller] } }, ListDispatch: { status: 200, body: dispatches } };
    expect(await refusal(make(base).lookup.verify({ ...input, jobRef: "AJ_synthJobOther" }))).toBe("MEDIA_JOB_NOT_DISPATCHED");
    expect(await refusal(make(base).lookup.verify({ ...input, agentIdentity: "agent-impostor" }))).toBe("MEDIA_JOB_PARTICIPANT_MISMATCH");
    // A job the media plane has not assigned to any participant yet belongs to nobody (the worker asks again).
    const unassigned = { agentDispatches: [{ id: "AD_synthDispatch1", agentName: "vsp-media", room: "call-synth-room", state: { jobs: [{ id: "AJ_synthJob0001", room: { name: "call-synth-room" }, state: { participantIdentity: "" } }] } }] };
    expect(await refusal(make({ ...base, ListDispatch: { status: 200, body: unassigned } }).lookup.verify(input))).toBe("MEDIA_JOB_NOT_ASSIGNED");
    expect(await refusal(make({ ...base, ListParticipants: { status: 200, body: { participants: [sipCaller] } } }).lookup.verify(input))).toBe("MEDIA_AGENT_NOT_IN_ROOM");
    expect(await refusal(make({ ...base, ListRooms: { status: 200, body: { rooms: [] } } }).lookup.verify(input))).toBe("MEDIA_ROOM_NOT_FOUND");
  });

  it("[SAFE-02] only livekit's own Twirp not_found is 'room not found': a bare 404 (a proxy or load balancer page, a Twirp bad_route) is a dependency failure, so the session-less routes still go ahead", async () => {
    const base = { ListRooms: { status: 200, body: { rooms: [room] } }, ListDispatch: { status: 200, body: dispatches } };
    // livekit's answer for a room that is gone (ListParticipants of a deleted room).
    expect(await refusal(make({ ...base, ListParticipants: { status: 404, body: { code: "not_found", msg: "requested room does not exist" } } }).lookup.describeRoom(input))).toBe("MEDIA_ROOM_NOT_FOUND");
    const proxied = await make({ ...base, ListParticipants: { status: 404, body: "<html><body>404 Not Found</body></html>" } }).lookup.describeRoom(input).catch((e: unknown) => e);
    expect(proxied).toMatchObject({ reasonCode: "LIVEKIT_API_NOT_FOUND_UNCONFIRMED" });
    expect((proxied as Error).constructor.name).toBe("DependencyError");
    expect(await refusal(make({ ListRooms: { status: 404, body: { code: "bad_route", msg: "no handler for path" } } }).lookup.describeRoom(input))).toBe("LIVEKIT_API_NOT_FOUND_UNCONFIRMED");
    expect(await refusal(make({ ListRooms: { status: 404, body: "" } }).lookup.verify(input))).toBe("LIVEKIT_API_NOT_FOUND_UNCONFIRMED");
  });

  it("failure injection: an unavailable or unauthorised media-plane API is a dependency failure, never a guess", async () => {
    expect(await refusal(make({ ListRooms: { status: 503, body: {} } }).lookup.verify(input))).toBe("LIVEKIT_API_FAILED");
    expect(await refusal(make({ ListRooms: { status: 401, body: {} } }).lookup.verify(input))).toBe("LIVEKIT_API_UNAUTHORIZED");
    const broken = new LiveKitCarrierLookup({ apiUrl: "https://livekit.vsp.test", apiKey: KEY, addressClass: "PRIVATE_NETWORK" }, { send: async () => Promise.reject(new Error("ECONNRESET")) }, async () => SECRET);
    expect(await refusal(broken.verify(input))).toBe("LIVEKIT_API_UNAVAILABLE");
    expect(() => new LiveKitCarrierLookup({ apiUrl: "https://user:pw@livekit.vsp.test", apiKey: KEY, addressClass: "PRIVATE_NETWORK" }, new TwirpFake({}), async () => SECRET)).toThrow();
  });
});
