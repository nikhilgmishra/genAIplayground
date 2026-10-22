/**
 * One call owned by the conversation runtime (WP-11; FO-10-01, FO-10-02, FO-10-09, FO-10-18, FO-10-46, FO-05-16,
 * FO-03-44; AUTH-03, DATA-03, SAFE-02).
 *
 * Joins the room's media (the caller's audio in, one output track out), obtains the CallBinding from the gateway
 * (bound to the carrier interaction and the session generation, re-bound with a new generation after an owner loss),
 * keeps it alive, reports every party change, hold, transfer leg and hang-up to the gateway (which updates the
 * session and voids pending actions) and fences speech locally at the same moment. Lifecycle reports are delivered
 * in order and retried until the gateway acknowledges them or the binding is lost; a signal seen before the call is
 * bound waits for the binding. Until a party change is acknowledged no speech is played (the previous party's
 * privileges must not carry over); one that cannot be reported within `lifecycleDeadlineMs` fails safe: no speech, a
 * person. A hang-up that cannot be reported still ends the job (the media-plane supervisor ends the call at the
 * control plane when it sees the caller gone). Recording and the processing taps follow the consent directive
 * (recording/controller.ts), re-read on every reconciliation tick; DTMF digits drive the navigation menu.
 * When the call cannot be bound, or the binding is lost and cannot be recovered, the caller is routed to a person
 * through the session-less human route (SAFE-02); the safety route is always reachable the same way. A person that
 * could not be requested is never a reason to stay: the runtime leaves the room, so the supervisor's orphan handling
 * routes the caller through its platform-internal path (the gateway recorded the request, so the supervisor routes
 * the person instead of re-dispatching the AI).
 *
 * Once a person or the safety route is requested, the call never returns to an AI turn: speech is held and every
 * recorder and tap is suspended; a bind still in flight is cancelled and an answer that arrives anyway is not used.
 * The same holds when the person was requested by someone else (the supervisor, another runtime): the gateway refuses
 * this runtime's next heartbeat and flags its lifecycle and processing answers, and the runtime suspends (owed: it
 * asks for the person again; accepted: it stays silent, WITH_PERSON). A job refused because a live owner holds the
 * call (BINDING_OWNER_ACTIVE until the bind deadline) leaves the room instead of sending the caller to a person.
 * A runtime the gateway refuses because the caller is with a person (BINDING_WITH_PERSON, after a crash of the
 * runtime that routed the caller) stays in the room the same way, silent and suspended, until the caller hangs up;
 * one refused because a person is owed or because the caller's consent sends them to a person asks for the person. A
 * directive that sends the caller to a person (AI processing declined, or recording declined where the tenant's
 * alternative is a person) routes the call to a person too. A runtime refused into a person route settles the
 * recorders the lost owner left: it stops the ones the gateway names and flags any recorder the consent does not
 * permit, on every reconciliation tick while it stays (recording/settlement.ts).
 */
import type { MediaBindRequest, MediaConsentDimension, MediaHumanRouteReason, MediaProcessingState, MediaRouteResponse, MediaSafetyRouteRequest, ProcessingDirective, RuntimeAdapter } from "@vsp/platform/src/protocol/call-binding.js";
import type { Logger } from "@vsp/platform/src/observability/ports.js";
import { BindingManager, systemTimers } from "../binding/manager.js";
import type { BindingLoss, Timers } from "../binding/manager.js";
import type { MediaGatewayClient } from "../binding/client.js";
import { GatewayRefusedError, GatewayUnavailableError } from "../binding/client.js";
import { CallParties } from "../lifecycle/parties.js";
import type { LifecycleSignal } from "../lifecycle/parties.js";
import { DtmfMenu } from "../playback/dtmf-menu.js";
import type { DtmfMenuConfig, MenuAction } from "../playback/dtmf-menu.js";
import { PlaybackEngine } from "../playback/engine.js";
import { ProcessingController } from "../recording/controller.js";
import type { CallRecorder, EgressObserver, TapSink } from "../recording/controller.js";
import { RECORDING_REFUSED_FAULT, armedFaultSeams } from "../recording/refusal-seam.js";
import { RecorderSettlement } from "../recording/settlement.js";
import type { FaultSeamPolicy } from "../recording/refusal-seam.js";
import { bindWithRecovery, decideOnLoss, realSleeper, requestHumanWithRetry } from "../recovery/policy.js";
import type { Sleeper } from "../recovery/policy.js";
import type { OutputTrack, RoomPort } from "./room.js";

export const PROCESSING_ATTRIBUTE = "vsp.mediaProcessing";
export const MEDIA_HEALTH_ATTRIBUTE = "vsp.mediaHealth";

export interface MediaCallConfig {
  workerInstanceRef: string;
  adapter: RuntimeAdapter;
  language: string;
  sampleRate: number;
  comfortNoiseDbfs: number;
  dtmfMenu: DtmfMenuConfig;
  bindDeadlineMs: number;
  humanDeadlineMs: number;
  reconcileIntervalMs: number;
  faultSeams: FaultSeamPolicy;
  /** Rate the call slows to on "slower" (0.6..1). */
  slowerRate: number;
  /** How long one lifecycle report is retried before the call fails safe (default 10 s). */
  lifecycleDeadlineMs?: number;
}

export interface MediaCallJob {
  jobRef: string;
  agentIdentity: string;
  /** The participant the job was dispatched for, when the dispatch names one. */
  expectedCaller: string | null;
  metadata: string | undefined;
}

export interface MediaCallDeps {
  room: RoomPort;
  gateway: Pick<MediaGatewayClient, "bind" | "heartbeat" | "lifecycle" | "consentDecision" | "reportProcessing" | "humanRoute" | "safetyRoute" | "recorders">;
  recorder: CallRecorder | null;
  /** Observe-only egress client: the room's recorders are checked even when this worker records nothing (DATA-03). */
  egressObserver?: EgressObserver | null;
  sinks?: { transcription?: TapSink; analysis?: TapSink };
  logger: Logger;
  now?: () => number;
  timers?: Timers;
  sleeper?: Sleeper;
}

export type CallPhase = "STARTING" | "BOUND" | "HUMAN_ROUTED" | "ENDED";

export interface CallOutcome {
  phase: CallPhase;
  reasonCode: string;
}

const FRAME_MS = 10;

type ReportOutcome = "ACKED" | "NOT_ACKED" | "LOST";

/** The directive's consent sends the caller to a person: AI processing declined, or recording declined where the alternative is a person. */
export function consentRequiresPerson(d: ProcessingDirective): boolean {
  return d.transcriptionAiProcessing.value === "DECLINED" || (d.recording.value === "DECLINED" && d.recordingDeclinedRoute === "HUMAN");
}

const isPartyChange = (s: LifecycleSignal): boolean => s.kind === "PARTICIPANT_JOINED" || s.kind === "PARTICIPANT_LEFT";
const isTerminal = (s: LifecycleSignal): boolean => s.kind === "CALLER_HUNG_UP" || s.kind === "MEDIA_DISCONNECTED";
/** Signals whose loss leaves the control plane believing in a call state that no longer holds (fail safe when unreported). */
const isFencing = (s: LifecycleSignal): boolean => isPartyChange(s) || s.kind === "HOLD_STARTED" || s.kind === "TRANSFER_LEG_STARTED";

export class MediaCall {
  private readonly parties: CallParties;
  private readonly manager: BindingManager;
  private readonly playback: PlaybackEngine;
  private readonly controller: ProcessingController;
  private readonly menu: DtmfMenu;
  private readonly now: () => number;
  private output: OutputTrack | null = null;
  private phase: CallPhase = "STARTING";
  private endReason = "CALL_ACTIVE";
  private unsubscribe: (() => void) | null = null;
  private reconcileTimer: unknown = null;
  private humanRequested = false;
  private safetyRequested = false;
  private declining = false;
  private readonly timers: Timers;
  private readonly pendingSignals: LifecycleSignal[] = [];
  private draining = false;
  private reporting = false;
  private resolveDone!: (o: CallOutcome) => void;
  readonly done: Promise<CallOutcome>;
  private health = { inboundFrames: 0, inboundPeak: 0, outboundFrames: 0 };
  private healthTimer: unknown = null;
  private readonly attributes: Record<string, string> = {};
  private attributesDirty = false;
  private attributesFlush: Promise<void> | null = null;
  private settlement: RecorderSettlement | null = null;
  private settlementTimer: unknown = null;

  constructor(
    private readonly d: MediaCallDeps,
    private readonly job: MediaCallJob,
    private readonly c: MediaCallConfig,
  ) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? systemTimers;
    this.done = new Promise((r) => (this.resolveDone = r));
    this.parties = new CallParties(job.expectedCaller);
    this.menu = new DtmfMenu(c.dtmfMenu);
    this.playback = new PlaybackEngine({ sampleRate: c.sampleRate, comfortNoiseDbfs: c.comfortNoiseDbfs });
    // Nothing speaks before the gateway has bound the call and set the generation.
    this.playback.hold("UNBOUND");
    this.controller = new ProcessingController({
      roomName: d.room.name,
      recorder: d.recorder,
      observer: d.egressObserver ?? null,
      sinks: d.sinks,
      now: () => new Date(this.now()),
      onChange: (s) => this.onProcessingChange(s),
      onMismatch: (m) => {
        d.logger.warn("media.processing.mismatch", { reasonCode: m });
        void this.routeToHuman("PROCESSING_MISMATCH");
      },
      // Content-free: how many of the call's named recorders this runtime took over after an owner loss.
      onAdopted: (ids) => d.logger.info("media.recording.adopted", { count: ids.length }),
    });
    this.manager = new BindingManager(
      { bind: (r) => d.gateway.bind(r), heartbeat: (cl) => d.gateway.heartbeat(cl), lifecycle: (r) => d.gateway.lifecycle(r), consentDecision: (r) => d.gateway.consentDecision(r), reportProcessing: (cl, s) => d.gateway.reportProcessing(cl, s) } as MediaGatewayClient,
      {
        onDirective: (directive) => {
          this.controller.apply(directive);
          this.followConsent(directive);
        },
        onGeneration: (_prev, next) => this.onGeneration(next),
        onLost: (loss) => void this.onLost(loss),
      },
      this.now,
      this.timers,
    );
  }

  currentPhase(): CallPhase {
    return this.phase;
  }

  playbackEngine(): PlaybackEngine {
    return this.playback;
  }

  processing(): ProcessingController {
    return this.controller;
  }

  binding(): BindingManager {
    return this.manager;
  }

  /** The settlement of an earlier owner's recorders, when this runtime was refused into a person route (else null). */
  recorderSettlement(): RecorderSettlement | null {
    return this.settlement;
  }

  /** Joins the call's media and takes ownership; resolves once the call is bound, routed or over. */
  async start(): Promise<void> {
    const room = this.d.room;
    this.parties.seed(room.remoteParticipants());
    this.unsubscribe = room.on({
      participantJoined: (p) => this.signal(this.parties.joined(p)),
      participantLeft: (p) => this.signal(this.parties.left(p)),
      attributesChanged: (p) => this.signal(this.parties.attributesChanged(p)),
      audioMuted: (identity, muted) => this.signal(this.parties.callerAudioMuted(identity, muted)),
      audioSubscribed: (identity, trackSid, frames) => void this.consumeAudio(identity, trackSid, frames),
      dtmf: (identity, digit) => this.onDigit(identity, digit),
      disconnected: () => this.signal(this.parties.mediaDisconnected()),
    });
    this.output = await room.publishOutput(this.c.sampleRate, (this.c.sampleRate * FRAME_MS) / 1000);
    void this.pump(this.output);
    this.healthTimer = this.timers.setInterval(() => void this.publishHealth(), 1_000);
    if (this.parties.isEnded()) return this.finish("CALLER_HUNG_UP");
    await this.acquire(false);
    if (this.phase === "BOUND" && armedFaultSeams(this.c.faultSeams, this.job.metadata).has(RECORDING_REFUSED_FAULT)) {
      // RECORDING_REFUSED injection point: the caller declines recording at the consent step (call start).
      this.d.logger.info("media.fault.injected", { reasonCode: RECORDING_REFUSED_FAULT });
      await this.decline("recording", "dtmf_menu");
    }
  }

  /**
   * A person for the call (the caller asked, a processing mismatch, a binding that cannot be held). Speech and every
   * recorder and tap stop first. When the person could not be requested by the deadline (the route refused or
   * unreachable, or never accepted) the runtime leaves the room: a runtime that stays would make the media-plane
   * supervisor see the call as owned, and nobody would route the caller (SAFE-02).
   */
  async routeToHuman(reason: MediaHumanRouteReason): Promise<MediaRouteResponse | null> {
    if (this.humanRequested || this.phase === "ENDED") return null;
    this.humanRequested = true;
    this.playback.hold("HUMAN_ROUTE");
    await this.controller.suspend();
    this.manager.stop();
    const out = await requestHumanWithRetry(() => this.d.gateway.humanRoute({ roomName: this.d.room.name, reason, language: this.c.language }), { deadlineMs: this.c.humanDeadlineMs, now: this.now, sleeper: this.d.sleeper });
    this.d.logger.info("media.human_route", { reasonCode: reason, outcome: out.kind, accepted: out.kind === "ROUTED" });
    if ((this.phase as CallPhase) === "ENDED") return out.kind === "ROUTED" ? out.response : null;
    if (out.kind !== "ROUTED") {
      // The safety route reached the caller meanwhile: the call is with the safety destination, not abandoned.
      if ((this.phase as CallPhase) === "HUMAN_ROUTED") return null;
      this.d.logger.warn("media.human_route.not_routed", { reasonCode: out.reasonCode, action: "LEAVE_ROOM" });
      await this.finish("HUMAN_ROUTE_UNAVAILABLE");
      return null;
    }
    this.phase = "HUMAN_ROUTED";
    void this.drainSignals(); // a hang-up that arrived meanwhile ends the job
    return out.response;
  }

  /**
   * The safety route: needs no binding, session or model (SAFE-02), and outranks a person already being requested.
   * The AI stops speaking and every recorder and tap stops first; the request is retried until the route is accepted
   * or the deadline passes. Accepted, the call is with the safety destination (HUMAN_ROUTED: silent, suspended, never
   * back to an AI turn). Never accepted, the runtime leaves the room: the gateway recorded the safety request, and the
   * supervisor retries it for the room.
   */
  async routeToSafety(signals: MediaSafetyRouteRequest["signals"], locale: string): Promise<MediaRouteResponse | null> {
    if (this.safetyRequested || this.phase === "ENDED") return null;
    this.safetyRequested = true;
    this.humanRequested = true;
    this.playback.hold("HUMAN_ROUTE");
    this.manager.stop();
    await this.controller.suspend();
    const out = await requestHumanWithRetry(() => this.d.gateway.safetyRoute({ roomName: this.d.room.name, signals, locale }), { deadlineMs: this.c.humanDeadlineMs, now: this.now, sleeper: this.d.sleeper });
    this.d.logger.info("media.safety_route", { outcome: out.kind, accepted: out.kind === "ROUTED" });
    if ((this.phase as CallPhase) === "ENDED") return out.kind === "ROUTED" ? out.response : null;
    if (out.kind !== "ROUTED") {
      this.d.logger.warn("media.safety_route.not_routed", { reasonCode: out.reasonCode, action: "LEAVE_ROOM" });
      await this.finish("SAFETY_ROUTE_UNAVAILABLE");
      return out.response;
    }
    this.phase = "HUMAN_ROUTED";
    void this.drainSignals();
    return out.response;
  }

  /** The caller declined or revoked a processing dimension (DTMF menu or a recognised spoken intent). */
  async decline(dimension: MediaConsentDimension, via: "dtmf_menu" | "speech_intent"): Promise<void> {
    // Local first: the taps close at the next frame before any network round trip (DATA-03).
    this.controller.declineLocal(dimension);
    let routeToHuman: boolean;
    // The decline answers whether a person is the alternative; the directive it carries does not route on its own.
    this.declining = true;
    try {
      const r = await this.manager.decline(dimension, "DECLINED", via);
      routeToHuman = r.routeToHuman;
      this.d.logger.info("media.consent.declined", { kind: dimension, reasonCode: r.reasonCode });
    } catch (err) {
      this.d.logger.warn("media.consent.decline_unconfirmed", { kind: dimension, reasonCode: err instanceof GatewayRefusedError || err instanceof GatewayUnavailableError ? err.reasonCode : "GATEWAY_CLIENT_FAILED" });
      // The decline holds locally; without the gateway's answer the alternative is a person.
      routeToHuman = true;
    } finally {
      this.declining = false;
    }
    await this.controller.reconcile();
    if (routeToHuman) await this.routeToHuman("CONSENT_DECLINED_ALTERNATIVE");
  }

  /**
   * A directive whose consent sends the caller to a person (AI processing declined: the runtime cannot converse; or
   * recording declined where the tenant's alternative is a person) routes the bound call to a person (DATA-03).
   */
  private followConsent(d: ProcessingDirective): void {
    if (this.declining || this.humanRequested || this.phase !== "BOUND") return;
    if (consentRequiresPerson(d)) void this.routeToHuman("CONSENT_DECLINED_ALTERNATIVE");
  }

  async stop(reasonCode: string): Promise<void> {
    await this.finish(reasonCode);
  }

  /* ---------------------------------------------------------------------------------------------------------- */

  private async acquire(rebind: boolean): Promise<void> {
    const req: MediaBindRequest = { roomName: this.d.room.name, jobRef: this.job.jobRef, workerInstanceRef: this.c.workerInstanceRef, agentIdentity: this.job.agentIdentity, adapter: this.c.adapter };
    // A person requested meanwhile (the caller pressed 0 while the bind was retried) cancels the bind for good.
    const out = await bindWithRecovery((r) => this.manager.bind(r), req, { deadlineMs: this.c.bindDeadlineMs, now: this.now, sleeper: this.d.sleeper, cancelled: () => this.phase === "ENDED" || this.parties.isEnded() || this.humanRequested });
    if (this.humanRequested || this.phase === "ENDED") {
      // Never back out of HUMAN_ROUTED or ENDED: a binding issued anyway is left to expire (no heartbeat, no timers);
      // a hang-up meanwhile is the human route's to handle (drainSignals).
      this.manager.stop();
      return;
    }
    if (out.kind === "BOUND") {
      const b = out.response.binding;
      this.d.logger.info(rebind ? "media.binding.rebound" : "media.binding.bound", { outcome: out.response.issue, sessionGeneration: b.sessionGeneration, attempts: out.attempts });
      // Speech is fenced to the generation the gateway issued; only then may the runtime speak.
      this.playback.advance(b.sessionGeneration);
      this.playback.release("UNBOUND");
      // The recorders an earlier owner of this call reported are the only ones adopted (DATA-03, T-FO-11-03).
      this.controller.bindTo({ tenantId: b.tenantId, interactionId: b.interactionId, bindingId: b.bindingId, sessionGeneration: b.sessionGeneration }, out.response.adoptableRecorders);
      this.phase = "BOUND";
      this.reconcileTimer ??= this.timers.setInterval(() => void this.reconcileAndReport(), this.c.reconcileIntervalMs);
      // Lifecycle signals that arrived before (or during) the bind are reported now, in order.
      void this.drainSignals();
      // A caller whose consent sends them to a person is routed now (never an AI turn first).
      this.followConsent(out.response.directive);
      return;
    }
    this.d.logger.warn("media.binding.unavailable", { outcome: out.kind, reasonCode: out.reasonCode, attempts: out.attempts });
    if (out.kind === "LEAVE") return this.finish(out.reasonCode);
    // Refused into a person route: the lost owner's recorders are settled while this runtime stays (DATA-03).
    this.settleRecorders();
    if (out.kind === "WITH_PERSON") return this.withPerson();
    await this.routeToHuman(out.reason);
  }

  /**
   * An answer that routes the call to a person: the room already has a person on the call (BINDING_WITH_PERSON: stay
   * silent and suspended), a person owed for the room (BINDING_PERSON_REQUESTED: ask for it again, the gateway retries
   * the recorded request), or this answer's own reason (a processing mismatch, a lifecycle fail-safe).
   */
  private async followPersonFlag(reasonCode: string, otherwise: MediaHumanRouteReason): Promise<void> {
    if (reasonCode === "BINDING_WITH_PERSON") return this.withPerson();
    await this.routeToHuman(reasonCode === "BINDING_PERSON_REQUESTED" ? "RECOVERY_FAILED" : otherwise);
  }

  /**
   * The caller is with a person already (this runtime replaced one that routed the caller, then crashed; or a person
   * was accepted for the room while this runtime held it): stay in the room silent and suspended, never an AI turn,
   * until the caller hangs up (FO-10-46, SAFE-02).
   */
  private async withPerson(): Promise<void> {
    if (this.phase === "ENDED" || this.phase === "HUMAN_ROUTED") return;
    this.humanRequested = true;
    this.playback.hold("HUMAN_ROUTE");
    this.manager.stop();
    await this.controller.suspend();
    if ((this.phase as CallPhase) === "ENDED") return;
    this.phase = "HUMAN_ROUTED";
    this.d.logger.info("media.binding.with_person", { reasonCode: "BINDING_WITH_PERSON" });
    void this.drainSignals();
  }

  /**
   * Starts the settlement of the call's recorders for a runtime that holds no binding (recording/settlement.ts): the
   * named recorders an earlier owner left running are stopped and a recorder the consent does not permit is flagged to
   * the gateway, on every reconciliation tick until the job ends (DATA-03, FO-10-46, T-FO-11-03).
   */
  private settleRecorders(): void {
    if (this.settlement || this.phase === "ENDED" || this.manager.claim() !== null) return;
    if (!this.d.recorder && !this.d.egressObserver) return;
    const settlement = new RecorderSettlement({
      roomName: this.d.room.name,
      recorder: this.d.recorder,
      observer: this.d.egressObserver ?? null,
      check: (mismatch) => this.d.gateway.recorders({ roomName: this.d.room.name, jobRef: this.job.jobRef, agentIdentity: this.job.agentIdentity, mismatch }),
      logger: this.d.logger,
      now: () => new Date(this.now()),
    });
    this.settlement = settlement;
    void settlement.tick();
    this.settlementTimer = this.timers.setInterval(() => void settlement.tick(), this.c.reconcileIntervalMs);
  }

  private onGeneration(next: number): void {
    // Speech and confirmations prepared under the older generation are void from this frame on (FO-10-09).
    this.playback.advance(next);
    const b = this.manager.binding();
    if (b) this.controller.bindTo({ tenantId: b.tenantId, interactionId: b.interactionId, bindingId: b.bindingId, sessionGeneration: next });
  }

  private async onLost(loss: BindingLoss): Promise<void> {
    this.playback.hold("UNBOUND");
    // With a person requested the binding no longer matters (it is left to expire); only the call's end does.
    if (this.humanRequested || this.phase === "ENDED") {
      if (loss.reason === "ENDED") await this.finish(loss.reasonCode);
      return;
    }
    const action = decideOnLoss(loss);
    this.d.logger.warn("media.binding.lost", { reason: loss.reason, reasonCode: loss.reasonCode, action: action.kind });
    // A person accepted for the room (by anyone): the AI no longer holds the call; silent and suspended (FO-10-46).
    if (action.kind === "WITH_PERSON") return this.withPerson();
    if (action.kind === "LEAVE") {
      // Another owner holds the call (or it ended): stop every tap without touching the new owner's recorder.
      return this.finish(action.reasonCode, { leaveRecorder: loss.reason !== "ENDED" });
    }
    await this.controller.suspend();
    if (action.kind === "REBIND") {
      this.phase = "STARTING";
      await this.acquire(true);
      return;
    }
    await this.routeToHuman(action.reason);
  }

  private signal(s: LifecycleSignal | null): void {
    if (!s) return;
    // Content-free trace of the lifecycle path (the kind only), so a hang-up that was never reported can be diagnosed.
    this.d.logger.info("media.lifecycle.signal", { kind: s.kind, phase: this.phase });
    // Speech is fenced the moment the media plane reports the change; the gateway voids pending actions.
    switch (s.kind) {
      case "HOLD_STARTED":
        this.playback.hold("HOLD");
        break;
      case "HOLD_ENDED":
        this.playback.release("HOLD");
        break;
      case "TRANSFER_LEG_STARTED":
        this.playback.hold("TRANSFER_LEG");
        break;
      case "TRANSFER_LEG_ENDED":
        this.playback.release("TRANSFER_LEG");
        break;
      case "PARTICIPANT_JOINED":
      case "PARTICIPANT_LEFT":
        // Released only once the gateway acknowledged the change (new generation): the previous party's speech and
        // privileges never reach the new one.
        this.playback.hold("PARTY_CHANGE");
        break;
      case "CALLER_HUNG_UP":
      case "MEDIA_DISCONNECTED":
        this.playback.hold("ENDING");
        break;
    }
    this.pendingSignals.push(s);
    void this.drainSignals();
  }

  /** Reports the queued lifecycle signals in order; a signal waits for the binding when there is none yet. */
  private async drainSignals(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingSignals.length > 0 && this.phase !== "ENDED") {
        const s = this.pendingSignals[0] as LifecycleSignal;
        if (this.phase !== "BOUND" || this.humanRequested) {
          // Nothing can be reported without a binding. With a person on the call, a terminal signal ends the job (the
          // supervisor ends the call at the control plane); while (re-)binding every signal waits for the binding (a
          // hang-up cancels the bind loop, which then leaves).
          const terminal = this.pendingSignals.find(isTerminal);
          if (this.phase === "HUMAN_ROUTED" && terminal) {
            this.pendingSignals.length = 0;
            await this.finish(terminal.kind === "CALLER_HUNG_UP" ? "CALLER_HUNG_UP" : "MEDIA_DISCONNECTED");
          }
          return;
        }
        const outcome = await this.report(s);
        if (outcome === "LOST") return; // the loss handler re-binds (the queue is kept), leaves or routes to a person
        this.pendingSignals.shift();
        if (isTerminal(s)) {
          this.pendingSignals.length = 0;
          await this.finish(s.kind === "CALLER_HUNG_UP" ? "CALLER_HUNG_UP" : "MEDIA_DISCONNECTED");
          return;
        }
        if (outcome === "NOT_ACKED" && isFencing(s)) {
          // The control plane does not know: the old generation's privileges and pending actions may still hold
          // there. Fail safe: no speech (the hold stays), a person.
          this.d.logger.warn("media.lifecycle.fail_safe", { kind: s.kind, action: "HUMAN_ROUTE" });
          await this.routeToHuman("BINDING_UNAVAILABLE");
          return;
        }
        if (isPartyChange(s) && !this.pendingSignals.some(isPartyChange)) this.playback.release("PARTY_CHANGE");
      }
    } finally {
      this.draining = false;
    }
  }

  /** One lifecycle report, retried (transport failures, 5xx, 429) until acknowledged, the binding is lost or the deadline passes. */
  private async report(s: LifecycleSignal): Promise<ReportOutcome> {
    const sleeper = this.d.sleeper ?? realSleeper;
    const deadline = this.now() + (this.c.lifecycleDeadlineMs ?? 10_000);
    let delay = 250;
    for (let attempt = 1; ; attempt++) {
      if (this.manager.claim() === null) return "LOST";
      let code: string;
      try {
        const r = await this.manager.lifecycle(s.kind, s.role);
        this.d.logger.info("media.lifecycle", { kind: s.kind, reasonCode: r.reasonCode, invalidatedActions: r.invalidatedActions, attempts: attempt });
        if (r.routeToHuman) void this.followPersonFlag(r.reasonCode, "BINDING_UNAVAILABLE");
        return "ACKED";
      } catch (err) {
        if (err instanceof GatewayRefusedError && err.status === 409) return "LOST";
        code = err instanceof GatewayRefusedError || err instanceof GatewayUnavailableError ? err.reasonCode : "GATEWAY_CLIENT_FAILED";
        if (err instanceof GatewayRefusedError && err.status !== 429) {
          // A refusal that asking again cannot change.
          this.d.logger.warn("media.lifecycle.unreported", { kind: s.kind, reasonCode: code, attempts: attempt });
          return "NOT_ACKED";
        }
      }
      if (this.now() + delay > deadline) {
        this.d.logger.warn("media.lifecycle.unreported", { kind: s.kind, reasonCode: code, attempts: attempt });
        return "NOT_ACKED";
      }
      await sleeper.sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  private onDigit(identity: string, digit: string): void {
    // Only the caller drives the menu; the digit itself is never logged, transcribed or recorded (AUTH-06).
    if (!this.parties.isCaller(identity)) return;
    const action = this.menu.onDigit(digit);
    if (action) void this.onMenu(action);
  }

  private async onMenu(action: MenuAction): Promise<void> {
    this.d.logger.info("media.menu", { action });
    switch (action) {
      case "REQUEST_HUMAN":
        await this.routeToHuman("CALLER_REQUESTED_HUMAN");
        return;
      case "REPEAT":
        this.playback.repeat();
        return;
      case "SLOWER":
        this.playback.setRate(this.c.slowerRate);
        return;
      case "NORMAL_SPEED":
        this.playback.setRate(1);
        return;
      case "DECLINE_RECORDING":
        await this.decline("recording", "dtmf_menu");
        return;
      case "DECLINE_AI_PROCESSING":
        await this.decline("transcriptionAiProcessing", "dtmf_menu");
        return;
    }
  }

  private async consumeAudio(identity: string, trackSid: string, frames: AsyncIterable<Int16Array>): Promise<void> {
    if (this.parties.isCaller(identity)) {
      const out = this.output;
      this.controller.setTracks(out ? { caller: trackSid, runtime: out.trackSid } : { caller: trackSid });
    }
    for await (const frame of frames) {
      if (this.phase === "ENDED") break;
      if (!this.parties.isCaller(identity)) continue;
      this.health.inboundFrames++;
      let peak = 0;
      for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i] as number));
      this.health.inboundPeak = Math.max(this.health.inboundPeak, peak);
      this.controller.feed(frame, this.c.sampleRate);
    }
  }

  private async pump(out: OutputTrack): Promise<void> {
    const samples = (this.c.sampleRate * FRAME_MS) / 1000;
    while (this.phase !== "ENDED") {
      try {
        await out.capture(this.playback.pull(samples));
        this.health.outboundFrames++;
      } catch {
        break;
      }
    }
  }

  private async publishHealth(): Promise<void> {
    if (this.phase === "ENDED") return;
    const peakDbfs = this.health.inboundPeak > 0 ? Math.round(20 * Math.log10(this.health.inboundPeak / 32768)) : -120;
    // Content-free media health: frame counts and the caller's peak level, for one-way-audio detection.
    this.publishAttributes({ [MEDIA_HEALTH_ATTRIBUTE]: JSON.stringify({ phase: this.phase, inboundFrames: this.health.inboundFrames, inboundPeakDbfs: peakDbfs, outboundFrames: this.health.outboundFrames }) });
  }

  private onProcessingChange(s: MediaProcessingState): void {
    this.publishAttributes({ [PROCESSING_ATTRIBUTE]: JSON.stringify(s) });
  }

  /**
   * The runtime's own participant attributes, published one update at a time and always complete (every key with its
   * latest value), so a failed or reordered update is repaired by the next one; a failure is retried on the next
   * health tick.
   */
  private publishAttributes(patch: Record<string, string>): void {
    Object.assign(this.attributes, patch);
    this.attributesDirty = true;
    if (this.attributesFlush) return;
    this.attributesFlush = (async () => {
      while (this.attributesDirty) {
        this.attributesDirty = false;
        try {
          await this.d.room.setAttributes({ ...this.attributes });
        } catch {
          this.attributesDirty = true;
          break;
        }
      }
    })().finally(() => {
      this.attributesFlush = null;
    });
  }

  /**
   * One reconciliation tick: the readout is checked against the egress API and reported to the gateway, whose answer
   * carries the current directive (a consent change recorded in the control plane reaches the recorder and the taps
   * within one tick, DATA-03) and its verdict (a mismatch routes the call to a person).
   */
  private async reconcileAndReport(): Promise<void> {
    if (this.phase === "ENDED" || this.reporting) return;
    this.reporting = true;
    try {
      // Reconciled in every phase, so a recorder drained after a suspension (a person on the call) is read back as
      // OFF from the egress API itself; only a bound call reports to the gateway.
      await this.controller.reconcile();
      // A mismatch found by this reconciliation is still reported while the person is being requested (the gateway
      // records it); once the call is with a person (or re-binding) nothing is reported.
      if (this.phase !== "BOUND") return;
      const r = await this.manager.report(() => this.controller.readout());
      if (r?.routeToHuman) await this.followPersonFlag(r.reasonCode, "PROCESSING_MISMATCH");
    } catch {
      // Reported again on the next tick; a refused claim is a binding loss the manager has already declared.
    } finally {
      this.reporting = false;
    }
  }

  private async finish(reasonCode: string, o: { leaveRecorder?: boolean } = {}): Promise<void> {
    if (this.phase === "ENDED") return;
    this.phase = "ENDED";
    this.endReason = reasonCode;
    this.playback.hold("ENDING");
    this.manager.stop();
    if (this.reconcileTimer !== null) this.timers.clearInterval(this.reconcileTimer);
    if (this.healthTimer !== null) this.timers.clearInterval(this.healthTimer);
    if (this.settlementTimer !== null) this.timers.clearInterval(this.settlementTimer);
    // A superseded owner leaves the recorder to the new owner (it holds its own egress); otherwise stop it.
    if (!o.leaveRecorder) await this.controller.suspend().catch(() => undefined);
    this.unsubscribe?.();
    await this.output?.close().catch(() => undefined);
    // The job leaves the room (the Agents job then ends): a caller left alone is the supervisor's to recover or route.
    await this.d.room.disconnect().catch(() => undefined);
    this.d.logger.info("media.call.ended", { reasonCode });
    this.resolveDone({ phase: "ENDED", reasonCode: this.endReason });
  }
}
