/**
 * Trusted carrier lookup against the self-hosted media plane (WP-11; FO-05-16, FO-03-17; BindingSource
 * `trusted_server_lookup`).
 *
 * The gateway asks livekit-server's own server API (Twirp over HTTP: RoomService and AgentDispatchService, as
 * documented for the pinned server) instead of trusting anything the media worker says:
 *   - the room exists, with its server-assigned id (unique per room instance);
 *   - the job the worker names was dispatched in that room and is assigned to the agent participant the worker
 *     names (AgentDispatch job state: participant identity, never empty), and that participant is in the room as an
 *     AGENT;
 *   - the room's active SIP parties, earliest joined first, each with the media plane's own SIP call id attribute
 *     (never the caller number, which LiveKit also carries in an attribute, in the participant identity and in some
 *     room names; identities are returned only as SHA-256 digests).
 * Which party names the call, and whether that agrees with what the call was pinned to, is the binding service's
 * decision (service.ts): these attributes are writable by any holder of the media-plane API secret.
 *
 * Requests go through the injected egress-classified transport (platform/src/connectors/http, bound by the
 * composition root, which this module may not import) with a short-lived server API token signed by the pinned
 * livekit-server-sdk AccessToken (no network in the SDK is used). Payloads are parsed with the SDK's protocol
 * message classes. Every failure is reason coded: AccessDeniedError when the media plane does not confirm (a room is
 * "not found" only on livekit's own Twirp not_found answer or an empty room listing), and DependencyError when it
 * cannot be asked (never a guess, never a cached answer).
 */
import { createHash } from "node:crypto";
import { AccessToken, AgentDispatch, ParticipantInfo, Room } from "livekit-server-sdk";
import type { Classification } from "../../protocol/common.js";
import { CarrierInteractionRef } from "../../protocol/call-binding.js";
import { AccessDeniedError, DependencyError, ValidationError } from "../../shared/errors.js";
import type { CarrierInteractionLookup, CarrierLookupInput, MediaRoomFacts, SipParty } from "./ports.js";

/** The subset of ConnectorHttpTransport.send this lookup uses (structural: the module may not import connectors). */
export interface MediaPlaneHttp {
  send(req: {
    method: "POST";
    url: URL;
    headers: Readonly<Record<string, string>>;
    body: string;
    policy: { allowedHosts: readonly string[]; addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK"; dataClass: Classification };
    sideEffect: boolean;
    timeoutMs: number;
    dependency: string;
  }): Promise<{ status: number; body: Buffer }>;
}

export interface LiveKitLookupConfig {
  /** Server API origin of livekit-server (https in deployed environments; the transport enforces it). */
  apiUrl: string;
  /** API key id the server API token names (not a secret). */
  apiKey: string;
  addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  timeoutMs?: number;
}

/** SIP participant attributes set by livekit-sip (pinned v1.18.0; verified in the Layer-2 media suite). */
export const SIP_CALL_ID_ATTRIBUTE = "sip.callID";
export const SIP_TRUNK_ATTRIBUTE = "sip.trunkID";

const ROUTE_REF = /^[A-Za-z0-9_:./-]{3,128}$/;
const KIND_AGENT = 4;
const KIND_SIP = 3;
const STATE_DISCONNECTED = 3;

/** The Twirp error code of an error response body (`{"code":"not_found","msg":...}`), or null when it is not one. */
function twirpCode(body: Buffer): string | null {
  if (body.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    const code = parsed !== null && typeof parsed === "object" ? (parsed as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** Digest of a media-plane participant identity (a livekit-sip identity can carry the caller number). */
export const partyDigestOf = (identity: string): string => createHash("sha256").update(`party|${identity}`, "utf8").digest("hex");

/** livekit-server's Twirp server API as the supervisor uses it (LiveKitCarrierLookup implements it). */
export interface MediaPlaneApi {
  call(service: string, method: string, body: Record<string, unknown>, roomName: string, sideEffect?: boolean): Promise<unknown>;
}

export class LiveKitCarrierLookup implements CarrierInteractionLookup, MediaPlaneApi {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: LiveKitLookupConfig,
    private readonly http: MediaPlaneHttp,
    /** API secret, resolved by the composition root from the secret store (opaque here, never logged). */
    private readonly apiSecret: () => Promise<string>,
  ) {
    let base: URL;
    try {
      base = new URL(config.apiUrl);
    } catch {
      throw new ValidationError("LIVEKIT_API_URL_INVALID");
    }
    if (base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) throw new ValidationError("LIVEKIT_API_URL_INVALID");
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(config.apiKey)) throw new ValidationError("LIVEKIT_API_KEY_ID_INVALID");
    this.base = base;
    this.timeoutMs = config.timeoutMs ?? 3_000;
  }

  async verify(input: CarrierLookupInput): Promise<MediaRoomFacts & { presentAgents: readonly string[] }> {
    const { room, participants } = await this.roomAndParticipants(input.roomName);
    const dispatches = await this.call("AgentDispatchService", "ListDispatch", { room: input.roomName }, input.roomName);
    // livekit-server's Twirp JSON uses the proto field names (agent_dispatches); protobuf JSON readers accept both.
    const d = dispatches as { agentDispatches?: unknown; agent_dispatches?: unknown } | null;
    const listed = d?.agentDispatches ?? d?.agent_dispatches;
    const list = Array.isArray(listed) ? (listed as unknown[]) : [];
    const jobs = list.flatMap((raw) => {
      try {
        return AgentDispatch.fromJson(raw as never, { ignoreUnknownFields: true }).state?.jobs ?? [];
      } catch {
        throw new DependencyError("LIVEKIT_RESPONSE_INVALID", "FAILED", true);
      }
    });
    const job = jobs.find((j) => j.id === input.jobRef);
    if (!job) throw new AccessDeniedError("MEDIA_JOB_NOT_DISPATCHED");
    if (job.room?.name && job.room.name !== input.roomName) throw new AccessDeniedError("MEDIA_JOB_ROOM_MISMATCH");
    // A job the media plane has not assigned to a participant yet is not anyone's: the worker asks again shortly.
    const jobIdentity = job.state?.participantIdentity ?? "";
    if (jobIdentity === "") throw new AccessDeniedError("MEDIA_JOB_NOT_ASSIGNED");
    if (jobIdentity !== input.agentIdentity) throw new AccessDeniedError("MEDIA_JOB_PARTICIPANT_MISMATCH");
    const presentAgents = participants.filter((p) => Number(p.kind) === KIND_AGENT && Number(p.state) !== STATE_DISCONNECTED).map((p) => p.identity);
    if (!presentAgents.includes(input.agentIdentity)) throw new AccessDeniedError("MEDIA_AGENT_NOT_IN_ROOM");
    return { ...this.factsOf(room, participants), presentAgents };
  }

  async describeRoom(input: { tenantId: string; roomName: string }): Promise<MediaRoomFacts> {
    const { room, participants } = await this.roomAndParticipants(input.roomName);
    return this.factsOf(room, participants);
  }

  private async roomAndParticipants(roomName: string): Promise<{ room: Room; participants: ParticipantInfo[] }> {
    const rooms = await this.call("RoomService", "ListRooms", { names: [roomName] }, roomName);
    const roomRaw = (Array.isArray((rooms as { rooms?: unknown }).rooms) ? (rooms as { rooms: unknown[] }).rooms : []).map((r) => this.parse(() => Room.fromJson(r as never, { ignoreUnknownFields: true })));
    const room = roomRaw.find((r) => r.name === roomName);
    if (!room || !room.sid) throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
    const listed = await this.call("RoomService", "ListParticipants", { room: roomName }, roomName);
    const participants = (Array.isArray((listed as { participants?: unknown }).participants) ? (listed as { participants: unknown[] }).participants : []).map((p) =>
      this.parse(() => ParticipantInfo.fromJson(p as never, { ignoreUnknownFields: true })),
    );
    return { room, participants };
  }

  /** The room's server id and its active SIP parties (earliest joined first); identities only as digests, never the caller number. */
  private factsOf(room: Room, participants: ParticipantInfo[]): MediaRoomFacts {
    const sid = CarrierInteractionRef.safeParse(room.sid);
    if (!sid.success) throw new DependencyError("LIVEKIT_ROOM_SID_INVALID", "FAILED", false);
    const sipParties: SipParty[] = participants
      .filter((p) => Number(p.kind) === KIND_SIP && Number(p.state) !== STATE_DISCONNECTED)
      .map((p) => {
        const callId = CarrierInteractionRef.safeParse(p.attributes[SIP_CALL_ID_ATTRIBUTE] ?? "");
        const trunk = p.attributes[SIP_TRUNK_ATTRIBUTE] ?? "";
        const joinedAtMs = Number(p.joinedAtMs) > 0 ? Number(p.joinedAtMs) : Number(p.joinedAt) * 1000;
        return {
          partyDigest: partyDigestOf(p.identity),
          interactionRef: callId.success ? callId.data : null,
          routeRef: trunk && ROUTE_REF.test(`sip-trunk:${trunk}`) ? `sip-trunk:${trunk}` : null,
          joinedAtMs: Number.isFinite(joinedAtMs) ? joinedAtMs : 0,
        };
      })
      .sort((a, b) => a.joinedAtMs - b.joinedAtMs);
    return { roomSid: sid.data, sipParties };
  }

  private parse<T>(fn: () => T): T {
    try {
      return fn();
    } catch {
      throw new DependencyError("LIVEKIT_RESPONSE_INVALID", "FAILED", true);
    }
  }

  /** One Twirp call with a 60-second server API token scoped to the room (`roomName` "" for the room listing). */
  async call(service: string, method: string, body: Record<string, unknown>, roomName: string, sideEffect = false): Promise<unknown> {
    let secret: string;
    try {
      secret = await this.apiSecret();
    } catch {
      throw new DependencyError("LIVEKIT_API_SECRET_UNAVAILABLE", "NOT_STARTED", true);
    }
    const token = new AccessToken(this.config.apiKey, secret, { ttl: 60 });
    token.addGrant({ roomList: true, roomAdmin: true, room: roomName });
    const jwt = await token.toJwt();
    const url = new URL(`/twirp/livekit.${service}/${method}`, this.base);
    let res: { status: number; body: Buffer };
    try {
      res = await this.http.send({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        // Opaque media-plane identifiers only; the room name can carry a caller number, which the media plane
        // already holds (INTERNAL, private network).
        policy: { allowedHosts: [this.base.hostname], addressClass: this.config.addressClass, dataClass: "INTERNAL" },
        sideEffect,
        timeoutMs: this.timeoutMs,
        dependency: "media_plane",
      });
    } catch (err) {
      if (err instanceof AccessDeniedError) throw new DependencyError("LIVEKIT_EGRESS_REFUSED", "NOT_STARTED", false);
      throw new DependencyError("LIVEKIT_API_UNAVAILABLE", "FAILED", true);
    }
    // Only livekit's own answer is a positive "not found": a Twirp error body with code not_found. Any other 404 (a
    // proxy or load balancer in front of the server, a Twirp bad_route) says nothing about the room: the media plane
    // could not be asked, so the session-less routes still go ahead (SAFE-02).
    if (res.status === 404) {
      if (twirpCode(res.body) === "not_found") throw new AccessDeniedError("MEDIA_ROOM_NOT_FOUND");
      throw new DependencyError("LIVEKIT_API_NOT_FOUND_UNCONFIRMED", "FAILED", true);
    }
    if (res.status === 401 || res.status === 403) throw new DependencyError("LIVEKIT_API_UNAUTHORIZED", "FAILED", false);
    if (res.status < 200 || res.status >= 300) throw new DependencyError("LIVEKIT_API_FAILED", "FAILED", true);
    try {
      return JSON.parse(res.body.toString("utf8")) as unknown;
    } catch {
      throw new DependencyError("LIVEKIT_RESPONSE_INVALID", "FAILED", true);
    }
  }
}
