/**
 * Consent-driven recording and processing control on the media path (WP-11; FO-03-44, FO-10-46, FO-15 DATA-03).
 *
 * The recorder (LiveKit egress) and the in-process taps (the retained transcript and the analysis feed) run only
 * while the call's consent permits them (permittedTaps: GRANTED or NOT_REQUIRED, unexpired; UNKNOWN is not
 * consent; the transcript and analysis taps are recording-dependent). A decline or revocation closes the in-process
 * taps at the next frame boundary (the gate is checked per frame, synchronously, before any network round trip)
 * and asks the egress API to stop the recorder; the readout keeps the recorder STOPPING (running) until the egress
 * API itself reports nothing of ours running, so the call is never reported unrecorded while a tap still runs.
 *
 * Consent with an expiry stops permitting at that instant: the per-frame gate re-checks the earliest expiry of
 * what it currently permits and closes the taps at the first frame past it, and every reconciliation re-enforces the
 * consent at `now` (so the recorder stops within one reconciliation tick even when no frame arrives).
 *
 * The readout (MediaProcessingState) is what the media path actually does. `reconcile()` compares it with the
 * egress API's own list for the room, whether or not this worker records (an observe-only egress client when
 * recording is disabled): a recorder of ours still running without consent beyond the drain bound, a recorder
 * nobody here started, a recorder the media plane refused or lost, or an egress API that cannot be read while ours
 * may run (or for longer than `unobservedBoundMs` at all) is a mismatch, reported to the gateway, which routes the call
 * to a person. A call is never reported unrecorded on the strength of not having looked.
 *
 * The readout lists the recorders this worker started (`recorderRefs`); the gateway keeps them per binding. After an
 * owner loss the new owner adopts exactly the recorders the gateway names for the call's earlier bindings (the bind
 * answer's `adoptableRecorders`), and only while the egress API lists them running as track egress writing to the egress
 * service's own storage under the call's path. A recorder that merely names the call's path (anyone holding the
 * media-plane secret or a roomRecord grant can start one, with an upload target of its own) is foreign: a mismatch,
 * and a person (DATA-03, T-FO-11-03).
 */
import { MEDIA_PROCESSING_STATE_SCHEMA_VERSION, MediaProcessingState, RUNNING_TAP_PHASES, permittedTaps, unconsentedTaps } from "@vsp/platform/src/protocol/call-binding.js";
import type { MediaConsentDimension, ProcessingConsent, ProcessingDirective, ProcessingMismatch, TapPhase, TapState } from "@vsp/platform/src/protocol/call-binding.js";
import type { ObservedEgress, RecorderTarget } from "./egress.js";

/** The egress API's own list of the room's recorders (read-only). */
export interface EgressObserver {
  observe(roomName: string): Promise<ObservedEgress[]>;
}

export interface CallRecorder extends EgressObserver {
  start(target: RecorderTarget): Promise<string[]>;
  stop(roomName: string, egressId: string): Promise<void>;
}

/** An in-process consumer of caller audio (transcript store, analysis feed). Frames reach it only through the gate. */
export interface TapSink {
  write(frame: Int16Array, sampleRate: number): void;
  close(): void;
}

export interface ProcessingIdentity {
  tenantId: string;
  interactionId: string;
  bindingId: string;
  sessionGeneration: number;
}

export interface ProcessingControllerOptions {
  roomName: string;
  /** The recorder this worker starts and stops; null when recording is disabled for the deployment. */
  recorder: CallRecorder | null;
  /** Observe-only egress client, used when there is no recorder (the room's recorders are checked either way). */
  observer?: EgressObserver | null;
  /** How long the egress API may stay unreadable before an idle readout is flagged RECORDER_STATE_UNKNOWN (default 15 s). */
  unobservedBoundMs?: number;
  sinks?: { transcription?: TapSink; analysis?: TapSink };
  now?: () => Date;
  /** How long a recorder may drain after a decline before the readout flags it (default 5 s). */
  drainBoundMs?: number;
  /** Every readout change (published to the room and reported to the gateway by the call). */
  onChange?: (state: MediaProcessingState) => void;
  /** A mismatch appeared: the call goes to a person. */
  onMismatch?: (mismatch: ProcessingMismatch, state: MediaProcessingState) => void;
  /** The adoption after an owner loss settled: the earlier owner's recorders taken over (empty when none was). */
  onAdopted?: (egressIds: readonly string[]) => void;
}

type TapName = "recording" | "transcription" | "analysis";
type GatedTap = "transcription" | "analysis";

const ALL_TAPS: readonly TapName[] = ["recording", "transcription", "analysis"];

export class ProcessingController {
  private ids: ProcessingIdentity | null = null;
  private directive: ProcessingDirective | null = null;
  private readonly localDeclines = new Set<MediaConsentDimension>();
  private readonly taps: Record<TapName, { phase: TapPhase; ref: string | null; changedAt: Date }>;
  private egressIds: string[] = [];
  private tracks: Record<string, string> = {};
  private mismatch: ProcessingMismatch | null = null;
  private stoppingSince: number | null = null;
  private suspended = false;
  private adopting = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly drainBoundMs: number;
  private readonly unobservedBoundMs: number;
  private unobservedSince: number | null = null;
  /** Earliest instant at which a consent the gates currently permit expires (null: none expires). */
  private expiryAtMs: number | null = null;

  constructor(private readonly o: ProcessingControllerOptions) {
    this.now = o.now ?? (() => new Date());
    this.drainBoundMs = o.drainBoundMs ?? 5_000;
    this.unobservedBoundMs = o.unobservedBoundMs ?? 15_000;
    const at = this.now();
    this.taps = { recording: { phase: "OFF", ref: null, changedAt: at }, transcription: { phase: "OFF", ref: null, changedAt: at }, analysis: { phase: "OFF", ref: null, changedAt: at } };
  }

  /**
   * The binding the readout belongs to (after a bind, a re-bind or a generation change). On the first bind of this
   * runtime the recorders an earlier owner of the call started (crashed or superseded) are adopted before anything
   * new starts, so a recovery neither duplicates the recorder nor mistakes the call's own recorder for a foreign one.
   * Only the recorders the gateway names (`adoptable`, from the bind answer) are adopted, and only while the egress API
   * lists them running as track egress to the egress service's own storage under the call's path; any other running
   * recorder stays foreign.
   */
  bindTo(ids: ProcessingIdentity, adoptable: readonly string[] = []): void {
    const first = this.ids === null || this.ids.interactionId !== ids.interactionId;
    this.ids = { ...ids };
    if (!first || !this.o.recorder || adoptable.length === 0) {
      this.emit();
      this.enforce();
      return;
    }
    this.adopting = true;
    void this.enqueue(async () => {
      try {
        const prefix = `calls/${ids.interactionId}/`;
        const running = (await (this.o.recorder as CallRecorder).observe(this.o.roomName)).filter((e) => e.running && adoptable.includes(e.egressId) && e.defaultStorage && e.filepath?.startsWith(prefix));
        if (running.length > 0) {
          this.egressIds = running.map((e) => e.egressId);
          this.set("recording", "ON", this.egressIds[0] ?? null);
        }
        this.o.onAdopted?.(running.map((e) => e.egressId));
      } catch {
        // Unknown: the reconciliation flags it if a recorder of ours may be running.
      } finally {
        this.adopting = false;
      }
      // Still inside the queue: whatever enforce() queues next runs after the adoption.
      this.emit();
      this.enforce();
    });
  }

  /** Track sids of the parties to record, once both are published. */
  setTracks(tracks: Record<string, string>): void {
    this.tracks = { ...tracks };
    this.enforce();
  }

  /** A directive from the gateway; ignored when older than the one held (a late answer never re-enables a tap). */
  apply(d: ProcessingDirective): void {
    if (this.directive && d.consentVersion < this.directive.consentVersion) return;
    this.directive = d;
    this.enforce();
    // The readout states the consent it follows: a new directive is published even when no tap changed.
    this.emit();
  }

  /**
   * The caller declined or revoked a dimension on the media path. Takes effect before any network round trip:
   * the in-process taps close at the next frame and the recorder stop is requested; the decline stays in force for
   * the call even if a later directive still carries the earlier grant.
   */
  declineLocal(dimension: MediaConsentDimension): void {
    this.localDeclines.add(dimension);
    this.enforce();
    this.emit();
  }

  /** Stops every recorder and tap (binding lost, call ended, worker shutting down); nothing restarts afterwards. */
  suspend(): Promise<void> {
    this.suspended = true;
    this.enforce();
    return this.settled();
  }

  /** Caller audio for the in-process taps; a closed gate drops the frame here, at the frame boundary. */
  feed(frame: Int16Array, sampleRate: number): void {
    // A consent that expired since the last frame closes its gates before this frame is written (DATA-03).
    if (this.expiryAtMs !== null && this.now().getTime() >= this.expiryAtMs) this.enforce();
    for (const tap of ["transcription", "analysis"] as const) {
      if (this.taps[tap].phase === "ON") this.o.sinks?.[tap]?.write(frame, sampleRate);
    }
  }

  /** Resolves when every queued recorder operation, including any queued while waiting, has finished. */
  async settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }

  consent(): { consentVersion: number; recording: ProcessingConsent; transcriptionAiProcessing: ProcessingConsent } | null {
    const d = this.directive;
    if (!d) return null;
    const declined = (c: ProcessingConsent, dim: MediaConsentDimension): ProcessingConsent => (this.localDeclines.has(dim) ? { ...c, value: "DECLINED" } : c);
    return { consentVersion: d.consentVersion, recording: declined(d.recording, "recording"), transcriptionAiProcessing: declined(d.transcriptionAiProcessing, "transcriptionAiProcessing") };
  }

  /** The current readout; null until the call is bound and has a directive. */
  readout(): MediaProcessingState | null {
    const ids = this.ids;
    const consent = this.consent();
    if (!ids || !consent || !this.directive) return null;
    const at = this.now();
    const tap = (t: TapName): TapState => ({ phase: this.taps[t].phase, active: RUNNING_TAP_PHASES.includes(this.taps[t].phase), ref: this.taps[t].ref, changedAt: this.taps[t].changedAt.toISOString() });
    const shape = { recording: tap("recording"), transcription: tap("transcription"), analysis: tap("analysis") };
    // The readout is honest about a contradiction it can see itself (a running tap the consent does not permit).
    const own = unconsentedTaps(shape, consent, at);
    const mismatch = this.mismatch ?? (own.includes("recording") ? "RECORDING_WITHOUT_CONSENT" : own.length > 0 ? "TAP_WITHOUT_CONSENT" : null);
    const changedAt = new Date(Math.max(...ALL_TAPS.map((t) => this.taps[t].changedAt.getTime())));
    return MediaProcessingState.parse({
      schemaVersion: MEDIA_PROCESSING_STATE_SCHEMA_VERSION,
      tenantId: ids.tenantId,
      interactionId: ids.interactionId,
      sessionGeneration: ids.sessionGeneration,
      occurredAt: at.toISOString(),
      bindingId: ids.bindingId,
      ...shape,
      consent,
      disclosureTemplateId: this.directive.disclosureTemplateId,
      mismatch,
      recorderRefs: this.egressIds.slice(0, 8),
      changedAt: changedAt.toISOString(),
    });
  }

  /**
   * Checks the readout against the egress API's own list for the room and settles a draining recorder. Returns the
   * readout after the check (null before the call is bound).
   */
  reconcile(): Promise<MediaProcessingState | null> {
    // Consent at `now` first: an expiry passed while no frame arrived stops the recorder and the taps here.
    this.enforce();
    return this.enqueue(async () => {
      const observer: EgressObserver | null = this.o.recorder ?? this.o.observer ?? null;
      if (!observer) return;
      const rec = this.taps.recording;
      let observed: ObservedEgress[];
      try {
        observed = await observer.observe(this.o.roomName);
        this.unobservedSince = null;
      } catch {
        // Ours may be running and nobody can say: that is a mismatch, never "unrecorded". With nothing of ours
        // running, a brief outage of the egress API is tolerated up to the bound.
        const now = this.now().getTime();
        this.unobservedSince ??= now;
        if (rec.phase !== "OFF" || now - this.unobservedSince > this.unobservedBoundMs) this.flag("RECORDER_STATE_UNKNOWN");
        return;
      }
      const running = observed.filter((e) => e.running);
      const ours = running.filter((e) => this.egressIds.includes(e.egressId));
      const foreign = running.filter((e) => !this.egressIds.includes(e.egressId));
      if (foreign.length > 0) this.flag("FOREIGN_RECORDER_ACTIVE");
      if (rec.phase === "STOPPING") {
        if (ours.length === 0) {
          this.egressIds = [];
          this.stoppingSince = null;
          this.set("recording", "OFF", rec.ref);
        } else {
          // Ask again and settle from the egress API's own answer. A drain past its bound is a consent violation only
          // when the consent does not permit recording (a decline, a revocation, an expiry); a recorder stopped for a
          // person (suspended under consent that permits it) stays STOPPING, honestly running, until it ends.
          await this.stopNow();
          if (this.taps.recording.phase === "STOPPING" && this.stoppingSince !== null && this.now().getTime() - this.stoppingSince > this.drainBoundMs && !this.consentPermitsRecording()) this.flag("RECORDING_WITHOUT_CONSENT");
        }
      } else if (rec.phase === "ON" && ours.length < this.egressIds.length) {
        // The media plane ended a recorder the disclosure says runs.
        this.set("recording", "FAILED", rec.ref);
        this.flag("RECORDING_REFUSED_BY_MEDIA_PLANE");
      }
    }).then(() => this.readout());
  }

  /* ---------------------------------------------------------------------------------------------------------- */

  /** Whether the consent itself (local declines included, the suspension not) permits the recorder at `now`. */
  private consentPermitsRecording(): boolean {
    const consent = this.consent();
    return consent !== null && permittedTaps(consent, this.now()).recording;
  }

  private permitted(): Record<TapName, boolean> {
    const consent = this.consent();
    if (!consent || this.suspended) return { recording: false, transcription: false, analysis: false };
    return permittedTaps(consent, this.now());
  }

  /** Brings every tap in line with the consent: synchronous for the in-process gates, queued for the recorder. */
  private enforce(): void {
    const permitted = this.permitted();
    this.expiryAtMs = this.earliestExpiry(permitted);
    let changed = false;
    for (const tap of ["transcription", "analysis"] as GatedTap[]) {
      const sink = this.o.sinks?.[tap];
      const phase = this.taps[tap].phase;
      if (phase === "ON" && !permitted[tap]) {
        this.taps[tap] = { phase: "OFF", ref: null, changedAt: this.now() };
        sink?.close();
        changed = true;
      } else if (phase === "OFF" && permitted[tap] && sink && this.ids) {
        this.taps[tap] = { phase: "ON", ref: null, changedAt: this.now() };
        changed = true;
      }
    }
    if (changed) this.emit();
    const rec = this.taps.recording.phase;
    if (!permitted.recording && (rec === "STARTING" || rec === "ON")) this.stopRecorder();
    else if (permitted.recording && rec === "OFF" && this.canRecord()) this.startRecorder();
  }

  /** The earliest expiry among the consent dimensions that currently permit something. */
  private earliestExpiry(permitted: Record<TapName, boolean>): number | null {
    const consent = this.consent();
    if (!consent || !(permitted.recording || permitted.transcription || permitted.analysis)) return null;
    const at = [consent.recording.expiresAt, permitted.transcription || permitted.analysis ? consent.transcriptionAiProcessing.expiresAt : null]
      .filter((x): x is string => x !== null)
      .map((x) => Date.parse(x));
    return at.length > 0 ? Math.min(...at) : null;
  }

  private canRecord(): boolean {
    return this.o.recorder !== null && this.ids !== null && !this.adopting && this.tracks.caller !== undefined && this.mismatch === null;
  }

  private startRecorder(): void {
    const ids = this.ids as ProcessingIdentity;
    this.set("recording", "STARTING", null);
    void this.enqueue(async () => {
      const recorder = this.o.recorder as CallRecorder;
      if (!this.permitted().recording) {
        // Withdrawn before the request left: nothing was started.
        this.set("recording", "OFF", null);
        return;
      }
      try {
        this.egressIds = await recorder.start({ roomName: this.o.roomName, pathPrefix: `calls/${ids.interactionId}/${ids.bindingId}`, tracks: this.tracks });
      } catch {
        // The disclosure says the call is recorded and the media plane did not start the recorder (RecorderError).
        this.set("recording", "FAILED", null);
        this.flag("RECORDING_REFUSED_BY_MEDIA_PLANE");
        return;
      }
      this.set("recording", "ON", this.egressIds[0] ?? null);
      // Consent may have been withdrawn while the start was in flight.
      if (!this.permitted().recording) this.stopNow();
    });
  }

  private stopRecorder(): void {
    if (this.taps.recording.phase === "ON") {
      void this.enqueue(async () => this.stopNow());
      this.set("recording", "STOPPING", this.taps.recording.ref);
      this.stoppingSince = this.now().getTime();
    }
    // STARTING: the start task sees the withdrawn consent and stops right after the egress exists.
  }

  private async stopNow(): Promise<void> {
    const recorder = this.o.recorder as CallRecorder;
    if (this.taps.recording.phase !== "STOPPING") {
      this.set("recording", "STOPPING", this.taps.recording.ref);
      this.stoppingSince = this.now().getTime();
    }
    const results = await Promise.allSettled(this.egressIds.map((id) => recorder.stop(this.o.roomName, id)));
    if (results.some((r) => r.status === "rejected")) return; // stays STOPPING; reconcile retries and flags past the bound
    // OFF only once the egress API itself reports nothing of ours running.
    let observed: ObservedEgress[];
    try {
      observed = await recorder.observe(this.o.roomName);
    } catch {
      return;
    }
    if (!observed.some((e) => e.running && this.egressIds.includes(e.egressId))) {
      this.egressIds = [];
      this.stoppingSince = null;
      this.set("recording", "OFF", this.taps.recording.ref);
    }
  }

  private set(tap: TapName, phase: TapPhase, ref: string | null): void {
    const cur = this.taps[tap];
    if (cur.phase === phase && cur.ref === ref) return;
    this.taps[tap] = { phase, ref, changedAt: this.now() };
    this.emit();
  }

  private flag(m: ProcessingMismatch): void {
    if (this.mismatch !== null) return;
    this.mismatch = m;
    const state = this.readout();
    this.emit();
    if (state) this.o.onMismatch?.(m, state);
  }

  private emit(): void {
    const s = this.readout();
    if (s) this.o.onChange?.(s);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return this.chain;
  }
}
