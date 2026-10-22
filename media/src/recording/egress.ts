/**
 * Call recorder over the LiveKit egress API (WP-11; FO-03-44, FO-10-46; DATA-03).
 *
 * One TrackEgress per recorded party track (the caller's audio and the runtime's own output), written by the
 * egress service as Ogg/Opus files to the storage its own configuration names (the worker never holds a storage
 * credential; deploy/local/livekit/README.md). The worker asks for the files under an opaque path built from the
 * interaction and binding ids, never the room name (which can carry a caller number). Requests go through the
 * egress-classified transport with a short-lived server API token carrying the `roomRecord` grant for the room.
 *
 * `observe()` reads the egress API's own list for the room, so a readout can be checked against what the media
 * plane actually runs, independently of what the worker believes it started.
 */
import { AccessToken, DirectFileOutput, EgressInfo, EgressStatus, TrackEgressRequest } from "livekit-server-sdk";
import type { MediaTransport } from "../binding/client.js";

export interface LiveKitApiCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface EgressRecorderOptions {
  /** livekit-server HTTP origin (Twirp); https in AWS, a local emulator route maps the name to the loopback interface. */
  apiUrl: string;
  transport: MediaTransport;
  credentials: () => Promise<LiveKitApiCredentials>;
  addressClass: "PUBLIC_INTERNET" | "PRIVATE_NETWORK";
  timeoutMs?: number;
}

export interface RecorderTarget {
  roomName: string;
  /** Opaque path prefix for the files: `calls/<interactionId>/<bindingId>`. */
  pathPrefix: string;
  /** Track sids to record, keyed by party ("caller", "runtime"). */
  tracks: Readonly<Record<string, string>>;
}

export interface ObservedEgress {
  egressId: string;
  trackId: string | null;
  /** The file path the egress was asked to write (`calls/<interactionId>/<bindingId>/...`), when it is a file egress. */
  filepath: string | null;
  /** STARTING, ACTIVE or ENDING: the egress may still be writing. */
  running: boolean;
  status: string;
  /**
   * A track egress writing a file to the egress service's own configured storage (no upload target of its own in the
   * request). A request can carry its own S3, GCS, Azure or OSS target: such a recorder sends the call elsewhere and is
   * never adopted as the call's own (T-FO-11-03).
   */
  defaultStorage: boolean;
}

/** The media plane refused or could not start/stop a recorder; `retryable` follows the transport classification. */
export class RecorderError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly retryable: boolean,
  ) {
    super(reasonCode);
    this.name = "RecorderError";
  }
}

const RUNNING = new Set<EgressStatus>([EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE, EgressStatus.EGRESS_ENDING]);
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export class LiveKitEgressRecorder {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(private readonly o: EgressRecorderOptions) {
    const base = new URL(o.apiUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) {
      throw new Error("LIVEKIT_API_URL_INVALID");
    }
    this.base = base;
    this.timeoutMs = o.timeoutMs ?? 4_000;
  }

  /** Starts one TrackEgress per party track; on a refusal the ones already started are stopped again. */
  async start(target: RecorderTarget): Promise<string[]> {
    const parts = target.pathPrefix.split("/");
    if (parts.length < 2 || !parts.every((p) => SAFE_SEGMENT.test(p))) throw new RecorderError("RECORDER_PATH_INVALID", false);
    const started: string[] = [];
    try {
      for (const [party, trackId] of Object.entries(target.tracks)) {
        if (!SAFE_SEGMENT.test(party)) throw new RecorderError("RECORDER_PATH_INVALID", false);
        const req = new TrackEgressRequest({
          roomName: target.roomName,
          trackId,
          output: { case: "file", value: new DirectFileOutput({ filepath: `${target.pathPrefix}/${party}-{time}.ogg`, disableManifest: true }) },
        });
        const info = EgressInfo.fromJson((await this.call("StartTrackEgress", req.toJson() as Record<string, unknown>, target.roomName)) as never, { ignoreUnknownFields: true });
        if (!info.egressId) throw new RecorderError("RECORDER_RESPONSE_INVALID", true);
        started.push(info.egressId);
        if (info.status === EgressStatus.EGRESS_FAILED || info.status === EgressStatus.EGRESS_ABORTED) throw new RecorderError("RECORDER_START_FAILED", true);
      }
      return started;
    } catch (err) {
      await Promise.allSettled(started.map((id) => this.stop(target.roomName, id)));
      throw err instanceof RecorderError ? err : new RecorderError("RECORDER_START_FAILED", true);
    }
  }

  /** Requests the stop; an egress that already ended is not an error. */
  async stop(roomName: string, egressId: string): Promise<void> {
    try {
      await this.call("StopEgress", { egressId }, roomName);
    } catch (err) {
      // The egress API answers a failed_precondition when the egress has already ended.
      if (err instanceof RecorderError && err.reasonCode === "RECORDER_ALREADY_ENDED") return;
      throw err;
    }
  }

  /** Every egress the media plane holds for the room, as the egress API reports it. */
  async observe(roomName: string): Promise<ObservedEgress[]> {
    const data = (await this.call("ListEgress", { roomName }, roomName)) as { items?: unknown[] } | null;
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map((raw) => {
      const info = EgressInfo.fromJson(raw as never, { ignoreUnknownFields: true });
      const track = info.request.case === "track" ? info.request.value : null;
      const file = track && track.output.case === "file" ? track.output.value : null;
      const filepath = file ? file.filepath : null;
      return { egressId: info.egressId, trackId: track?.trackId ?? null, filepath, running: RUNNING.has(info.status), status: EgressStatus[info.status] ?? "UNKNOWN", defaultStorage: file !== null && file.output.case === undefined };
    });
  }

  private async call(method: string, body: Record<string, unknown>, roomName: string): Promise<unknown> {
    let creds: LiveKitApiCredentials;
    try {
      creds = await this.o.credentials();
    } catch {
      throw new RecorderError("RECORDER_CREDENTIAL_UNAVAILABLE", true);
    }
    const token = new AccessToken(creds.apiKey, creds.apiSecret, { ttl: 60 });
    token.addGrant({ roomRecord: true, room: roomName });
    let res: { status: number; body: Buffer };
    try {
      res = await this.o.transport.send({
        method: "POST",
        url: new URL(`/twirp/livekit.Egress/${method}`, this.base),
        headers: { authorization: `Bearer ${await token.toJwt()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        policy: { allowedHosts: [this.base.hostname], addressClass: this.o.addressClass, dataClass: "INTERNAL" },
        sideEffect: method !== "ListEgress",
        timeoutMs: this.timeoutMs,
        dependency: "media_plane",
      });
    } catch {
      throw new RecorderError("RECORDER_API_UNAVAILABLE", true);
    }
    let json: unknown;
    try {
      json = res.body.length > 0 ? JSON.parse(res.body.toString("utf8")) : null;
    } catch {
      throw new RecorderError("RECORDER_RESPONSE_INVALID", true);
    }
    if (res.status >= 200 && res.status < 300) return json;
    const code = (json as { code?: unknown } | null)?.code;
    if (res.status === 412 || code === "failed_precondition") throw new RecorderError("RECORDER_ALREADY_ENDED", false);
    if (res.status === 401 || res.status === 403) throw new RecorderError("RECORDER_UNAUTHORIZED", false);
    if (res.status === 404) throw new RecorderError("RECORDER_TARGET_NOT_FOUND", false);
    if (res.status === 503 || code === "unavailable" || code === "resource_exhausted") throw new RecorderError("RECORDER_UNAVAILABLE", true);
    throw new RecorderError(res.status >= 500 ? "RECORDER_API_FAILED" : "RECORDER_REQUEST_REFUSED", res.status >= 500);
  }
}
