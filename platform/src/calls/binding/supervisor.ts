/**
 * Media-plane supervisor: recovery of calls whose runtime is gone (WP-11; FO-19-10, FO-22-16, FO-10-09; SAFE-02).
 *
 * livekit-server (pinned v1.13.9, observed in the Layer-2 media suite) does not move a room job to another worker
 * when the worker that held it dies: it only tries to terminate the dead job. Recovery is therefore the platform's
 * job. Each sweep reads the media plane's own state (RoomService, AgentDispatchService) and, for every room this
 * runtime was dispatched to (a dispatch naming the agent):
 *   - a caller is still connected and no agent participant holding one of the room's jobs is connected: first the
 *     room's person request is read (CallBindingService.personStateOfRoom). A caller still owed a person (a runtime
 *     asked and the handoff was not accepted, then the runtime left) is routed to a person on this and every later sweep
 *     until the handoff is accepted, and the AI is NOT re-dispatched; a caller already with a person is left alone
 *     (never re-dispatched). Otherwise, when the latest dispatch or job of the room is older than the grace period,
 *     the room is dispatched again (CreateDispatch with the same metadata). The new job binds through the gateway,
 *     which re-binds the call with a new session generation and fencing token and voids the lost owner's pending
 *     actions (CallBindingService.bind), and refuses the bind itself when a person is owed or on the call. A person
 *     request that cannot be read (binding store outage, an item that does not parse) is UNKNOWN: the room is never
 *     re-dispatched on a guess, and its orphan clock runs, so the caller is routed to a person at the deadline below;
 *   - the room is still without a stable runtime `humanAfterMs` after it was first seen orphaned: route the caller to
 *     a person through the session-less human route (SAFE-02). A failed attempt is retried on every later sweep; the
 *     room counts as routed only once the route succeeded. The orphan clock is cleared only after an owner held the
 *     room for `stableOwnerMs`, so a runtime that joins and gives up again (a worker whose own human route was refused
 *     leaves the room, MediaCall) never postpones the person indefinitely;
 *   - a room whose caller was seen and is gone: the call is ended at the control plane (`endCall`, binding ENDED,
 *     pending actions void, session ended), in case no lifecycle report reached the gateway (worker down or gateway
 *     unreachable at the hang-up).
 * Each sweep examines at most `maxRooms` rooms, rotating through the room list so every room is examined within
 * ceil(rooms / maxRooms) sweeps. The supervisor never claims a binding itself and never speaks.
 *
 * Runs as one loop per deployment (the composition owner, WP-17, schedules `sweep()` and elects the single runner);
 * its state (when a room was first seen orphaned, whether its caller was seen) is in memory, so a restart of the loop
 * only delays the human route by up to `humanAfterMs` and leaves an unreported hang-up to the binding's own expiry. A
 * person owed or accepted is durable (the room's person request), so a restart never loses it.
 */
import { AgentDispatch, ParticipantInfo, Room } from "livekit-server-sdk";
import type { Logger } from "../../observability/ports.js";
import { silentLogger } from "../../observability/logger.js";
import type { MediaPlaneApi } from "./livekit-lookup.js";

export interface MediaPlaneSupervisorConfig {
  /** The explicit-dispatch agent name of the conversation runtime. */
  agentName: string;
  /** How long a fresh dispatch or job has to join before the room counts as orphaned (default 15 s). */
  redispatchGraceMs?: number;
  /** How long an orphaned room waits for a runtime before the caller is routed to a person (default 60 s). */
  humanAfterMs?: number;
  /** How long an owner must hold the room before its orphan clock is cleared (default `humanAfterMs`). */
  stableOwnerMs?: number;
  /** Rooms examined per sweep (default 500); the window rotates through the room list. */
  maxRooms?: number;
}

export interface MediaPlaneSupervisorDeps {
  api: MediaPlaneApi;
  now: () => number;
  /** The session-less human route for a room (media-routes.ts `supervisorHumanRoute`); throws when it did not happen. */
  routeToHuman: (roomName: string) => Promise<void>;
  /** Ends the room's call at the control plane after its caller left (CallBindingService.endRoom). */
  endCall?: (roomName: string) => Promise<unknown>;
  /**
   * The room's person request (media-routes.ts `supervisorPersonState`): OUTSTANDING (a person is owed: route, never
   * re-dispatch), WITH_PERSON (leave it with the person, never re-dispatch) or NONE.
   */
  personState: (room: { name: string; sid: string }) => Promise<"NONE" | "OUTSTANDING" | "WITH_PERSON">;
  logger?: Logger;
}

/**
 * PERSON_STATE_UNKNOWN: the room is orphaned and its person request cannot be read; nothing is re-dispatched and the
 * caller is routed to a person once the room has been orphaned for `humanAfterMs` (SAFE-02).
 */
export type SweepOutcome = "OWNED" | "WAITING" | "REDISPATCHED" | "HUMAN_ROUTED" | "WITH_PERSON" | "PERSON_STATE_UNKNOWN" | "NO_CALLER" | "CALL_ENDED" | "FAILED";

export interface SweepResult {
  roomName: string;
  outcome: SweepOutcome;
}

const KIND_STANDARD = 0;
const KIND_SIP = 3;
const KIND_AGENT = 4;
const STATE_DISCONNECTED = 3;

const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const reasonOf = (err: unknown): string => {
  const code = (err as { reasonCode?: unknown } | null)?.reasonCode;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "PERSON_STATE_UNAVAILABLE";
};
const nsToMs = (v: bigint | undefined): number => (v ? Number(v / 1_000_000n) : 0);

interface RoomState {
  orphanSince: number | null;
  ownedSince: number | null;
  routed: boolean;
  callerSeen: boolean;
  ended: boolean;
}

export class MediaPlaneSupervisor {
  private readonly rooms = new Map<string, RoomState>();
  private cursor = 0;
  private readonly graceMs: number;
  private readonly humanAfterMs: number;
  private readonly stableOwnerMs: number;
  private readonly maxRooms: number;
  private readonly logger: Logger;

  constructor(
    private readonly config: MediaPlaneSupervisorConfig,
    private readonly d: MediaPlaneSupervisorDeps,
  ) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(config.agentName)) throw new Error("SUPERVISOR_AGENT_NAME_INVALID");
    this.graceMs = config.redispatchGraceMs ?? 15_000;
    this.humanAfterMs = config.humanAfterMs ?? 60_000;
    if (this.humanAfterMs <= this.graceMs) throw new Error("SUPERVISOR_HUMAN_DEADLINE_INVALID");
    this.stableOwnerMs = config.stableOwnerMs ?? this.humanAfterMs;
    this.maxRooms = config.maxRooms ?? 500;
    if (!Number.isInteger(this.maxRooms) || this.maxRooms < 1) throw new Error("SUPERVISOR_MAX_ROOMS_INVALID");
    this.logger = d.logger ?? silentLogger;
  }

  async sweep(): Promise<SweepResult[]> {
    const listed = (await this.d.api.call("RoomService", "ListRooms", {}, "")) as { rooms?: unknown } | null;
    const all = array(listed?.rooms)
      .map((r) => Room.fromJson(r as never, { ignoreUnknownFields: true }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // A rotating window: rooms beyond `maxRooms` are examined on the following sweeps, never skipped for good.
    const start = all.length > 0 ? this.cursor % all.length : 0;
    const window = all.length <= this.maxRooms ? all : [...all.slice(start), ...all.slice(0, start)].slice(0, this.maxRooms);
    this.cursor = all.length <= this.maxRooms ? 0 : (start + this.maxRooms) % all.length;
    const out: SweepResult[] = [];
    for (const room of window) {
      try {
        const outcome = await this.examine(room.name, room.sid);
        if (outcome) out.push({ roomName: room.name, outcome });
      } catch {
        out.push({ roomName: room.name, outcome: "FAILED" });
      }
    }
    // Forget rooms that no longer exist.
    const names = new Set(all.map((r) => r.name));
    for (const name of [...this.rooms.keys()]) if (!names.has(name)) this.rooms.delete(name);
    return out;
  }

  private state(roomName: string): RoomState {
    let st = this.rooms.get(roomName);
    if (!st) {
      st = { orphanSince: null, ownedSince: null, routed: false, callerSeen: false, ended: false };
      this.rooms.set(roomName, st);
    }
    return st;
  }

  private async examine(roomName: string, roomSid: string): Promise<SweepOutcome | null> {
    const dispatchesRaw = (await this.d.api.call("AgentDispatchService", "ListDispatch", { room: roomName }, roomName)) as { agentDispatches?: unknown; agent_dispatches?: unknown } | null;
    const ours = array(dispatchesRaw?.agentDispatches ?? dispatchesRaw?.agent_dispatches)
      .map((d) => AgentDispatch.fromJson(d as never, { ignoreUnknownFields: true }))
      .filter((d) => d.agentName === this.config.agentName);
    if (ours.length === 0) return null; // not a room of this runtime
    const st = this.state(roomName);
    const participants = array(((await this.d.api.call("RoomService", "ListParticipants", { room: roomName }, roomName)) as { participants?: unknown } | null)?.participants).map((p) =>
      ParticipantInfo.fromJson(p as never, { ignoreUnknownFields: true }),
    );
    const active = participants.filter((p) => Number(p.state) !== STATE_DISCONNECTED);
    const callers = active.filter((p) => Number(p.kind) === KIND_STANDARD || Number(p.kind) === KIND_SIP);
    const now = this.d.now();
    if (callers.length === 0) {
      st.orphanSince = null;
      st.ownedSince = null;
      if (!st.callerSeen || st.ended || !this.d.endCall) return "NO_CALLER";
      // The caller was here and is gone: end the call at the control plane (idempotent; retried on failure).
      await this.d.endCall(roomName);
      st.ended = true;
      this.logger.info("calls.supervisor.call_ended", { reasonCode: "CALLER_LEFT_ROOM" });
      return "CALL_ENDED";
    }
    st.callerSeen = true;
    const jobs = ours.flatMap((d) => d.state?.jobs ?? []);
    const jobIdentities = new Set(jobs.map((j) => j.state?.participantIdentity ?? "").filter((x) => x !== ""));
    const owned = active.some((p) => Number(p.kind) === KIND_AGENT && jobIdentities.has(p.identity));
    if (owned) {
      st.ownedSince ??= now;
      if (now - st.ownedSince >= this.stableOwnerMs) {
        st.orphanSince = null;
        st.routed = false;
      }
      return "OWNED";
    }
    st.ownedSince = null;
    // A person owed or on the call is never handed back to the AI: route the owed person (every sweep until the
    // handoff is accepted), leave a caller who is with a person alone (SAFE-02, FO-10-46). A person request that cannot
    // be read (store outage, an item that does not parse) is UNKNOWN: never a reason to re-dispatch the AI on a guess,
    // and never a reason to withhold the person: the orphan clock runs and the caller is routed at the deadline.
    let person: "NONE" | "OUTSTANDING" | "WITH_PERSON" | "UNKNOWN";
    try {
      person = await this.d.personState({ name: roomName, sid: roomSid });
    } catch (err) {
      person = "UNKNOWN";
      this.logger.warn("calls.supervisor.person_state_unavailable", { reasonCode: reasonOf(err) });
    }
    if (person === "WITH_PERSON") return "WITH_PERSON";
    if (person === "OUTSTANDING") {
      await this.d.routeToHuman(roomName);
      st.routed = true;
      this.logger.warn("calls.supervisor.human_routed", { reasonCode: "PERSON_OWED" });
      return "HUMAN_ROUTED";
    }
    const latest = Math.max(...ours.map((d) => nsToMs(d.state?.createdAt)), ...jobs.map((j) => nsToMs(j.state?.startedAt)));
    st.orphanSince ??= now;
    if (now - st.orphanSince >= this.humanAfterMs) {
      // Routed once per orphan period: with the person request unreadable the router cannot tell an accepted handoff
      // from none, so a second route would be a second handoff for the room.
      if (st.routed) return person === "UNKNOWN" ? "PERSON_STATE_UNKNOWN" : "WAITING";
      // Marked routed only once the route happened: a failure is retried on the next sweep (SAFE-02).
      await this.d.routeToHuman(roomName);
      st.routed = true;
      this.logger.warn("calls.supervisor.human_routed", { reasonCode: person === "UNKNOWN" ? "PERSON_STATE_UNAVAILABLE" : "RECOVERY_FAILED" });
      return "HUMAN_ROUTED";
    }
    // Never re-dispatched while it is unknown whether a person is owed or on the call.
    if (person === "UNKNOWN") return "PERSON_STATE_UNKNOWN";
    if (now - latest < this.graceMs) return "WAITING";
    const newest = [...ours].sort((a, b) => nsToMs(b.state?.createdAt) - nsToMs(a.state?.createdAt))[0];
    await this.d.api.call("AgentDispatchService", "CreateDispatch", { room: roomName, agentName: this.config.agentName, metadata: newest?.metadata ?? "" }, roomName, true);
    this.logger.warn("calls.supervisor.redispatched", { reasonCode: "RUNTIME_OWNER_LOST" });
    return "REDISPATCHED";
  }
}
