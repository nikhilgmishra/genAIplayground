/**
 * Worker side of the CallBinding (WP-11; FO-05-16, FO-10-46; AUTH-03, AUTH-04).
 *
 * Holds the server-issued claim and processing directive for one call, renews the binding by heartbeat, follows the
 * session generation the gateway reports, and declares the binding lost the moment the gateway refuses the claim (a
 * newer owner, a stale generation, an ended or revoked call) or the binding's expiry passes without a successful
 * renewal. A lost binding means: stop speaking, stop every tap, never resume the old generation (the recovery policy
 * decides between a re-bind and a person). Every claim field is copied from the gateway's answers; the worker never
 * constructs or edits one (AUTH-03).
 *
 * The binding's requests (heartbeat, lifecycle, consent decision, processing report) are sent one at a time, in
 * order, each with the claim as it stands when it is sent, and every answer is applied before the next request
 * leaves; a processing readout is built only when its request leaves. So the gateway can tell a worker that has not
 * yet been told a consent change from one that ignores it (DATA-03, CallBindingService.reportProcessing).
 */
import type { MediaBindRequest, MediaBindResponse, MediaBindingClaim, MediaConsentDimension, MediaConsentDecisionResponse, MediaLifecycleEventKind, MediaLifecycleResponse, MediaParticipantRole, MediaProcessingReportResponse, MediaProcessingState, ProcessingDirective } from "@vsp/platform/src/protocol/call-binding.js";
import { GatewayRefusedError } from "./client.js";
import type { MediaGatewayClient } from "./client.js";

/**
 * PERSON_REQUESTED / WITH_PERSON: a person was requested for the room (owed, or accepted) by anyone (this runtime,
 * another runtime, the supervisor): the AI no longer holds the call (SAFE-02, FO-10-46).
 */
export type BindingLossReason = "SUPERSEDED" | "GENERATION_STALE" | "FENCING_TOKEN_STALE" | "ENDED" | "REVOKED" | "SESSION_INVALID" | "EXPIRED_UNREACHABLE" | "PERSON_REQUESTED" | "WITH_PERSON" | "REFUSED";

export interface BindingLoss {
  reason: BindingLossReason;
  reasonCode: string;
}

export interface BindingEvents {
  /** A directive with a consent version not lower than the one held (a late answer never re-enables a tap). */
  onDirective(directive: ProcessingDirective): void;
  /** The session generation advanced: speech and confirmations of the old generation are void. */
  onGeneration(previous: number, next: number): void;
  /** Ownership lost: stop speaking and processing now; never resume this generation. */
  onLost(loss: BindingLoss): void;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const LOSS_BY_CODE: Record<string, BindingLossReason> = {
  BINDING_SUPERSEDED: "SUPERSEDED",
  BINDING_GENERATION_STALE: "GENERATION_STALE",
  BINDING_FENCING_TOKEN_STALE: "FENCING_TOKEN_STALE",
  BINDING_NOT_ACTIVE: "ENDED",
  BINDING_CALL_ENDED: "ENDED",
  BINDING_REVOKED: "REVOKED",
  BINDING_SESSION_INVALID: "SESSION_INVALID",
  BINDING_EXPIRED: "EXPIRED_UNREACHABLE",
  BINDING_PERSON_REQUESTED: "PERSON_REQUESTED",
  BINDING_WITH_PERSON: "WITH_PERSON",
};

export class BindingManager {
  private current: MediaBindResponse["binding"] | null = null;
  private heldClaim: MediaBindingClaim | null = null;
  private heldDirective: ProcessingDirective | null = null;
  private expiresAtMs = 0;
  private timer: unknown = null;
  private lost: BindingLoss | null = null;
  private beating = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: MediaGatewayClient,
    private readonly events: BindingEvents,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = systemTimers,
  ) {}

  /** Issues (or re-issues after an owner loss) the binding; starts the heartbeat. Throws the gateway's refusal. */
  async bind(req: MediaBindRequest): Promise<MediaBindResponse> {
    const r = await this.client.bind(req);
    this.current = r.binding;
    this.heldClaim = r.claim;
    this.expiresAtMs = Date.parse(r.binding.expiresAt);
    this.lost = null;
    this.applyDirective(r.directive);
    this.stopHeartbeat();
    this.timer = this.timers.setInterval(() => void this.heartbeat(), r.heartbeatIntervalSeconds * 1000);
    return r;
  }

  claim(): MediaBindingClaim | null {
    return this.lost ? null : this.heldClaim;
  }

  binding(): MediaBindResponse["binding"] | null {
    return this.current;
  }

  directive(): ProcessingDirective | null {
    return this.heldDirective;
  }

  loss(): BindingLoss | null {
    return this.lost;
  }

  /** One renewal; exposed for the worker's shutdown path and for tests. */
  async heartbeat(): Promise<void> {
    if (!this.claim() || this.beating) return;
    this.beating = true;
    try {
      await this.serial(async () => {
        const claim = this.claim();
        if (!claim) return;
        try {
          const r = await this.client.heartbeat(claim);
          if (this.lost) return;
          this.expiresAtMs = Date.parse(r.expiresAt);
          this.setGeneration(r.sessionGeneration);
          this.applyDirective(r.directive);
        } catch (err) {
          if (err instanceof GatewayRefusedError && err.status === 409) this.declareLost(err.reasonCode);
          else if (err instanceof GatewayRefusedError && (err.status === 401 || err.status === 403)) this.declareLost(err.reasonCode, "REFUSED");
          else if (this.now() >= this.expiresAtMs) this.declareLost("BINDING_EXPIRED");
        }
      });
    } finally {
      this.beating = false;
    }
  }

  async lifecycle(kind: MediaLifecycleEventKind, participantRole: MediaParticipantRole | null): Promise<MediaLifecycleResponse> {
    return this.serial(async () => {
      const claim = this.requireClaim();
      try {
        const r = await this.client.lifecycle({ claim, event: { kind, participantRole, occurredAt: new Date(this.now()).toISOString() } });
        // The answer's claim is the gateway's (same binding and fencing token); the generation never moves back.
        if (!this.lost && r.claim.bindingId === claim.bindingId && r.claim.fencingToken === claim.fencingToken) this.setGeneration(r.claim.sessionGeneration);
        if (r.state === "ENDED") this.stopHeartbeat();
        return r;
      } catch (err) {
        if (err instanceof GatewayRefusedError && err.status === 409) this.declareLost(err.reasonCode);
        throw err;
      }
    });
  }

  /** The caller declined or revoked a processing dimension on the media path. */
  async decline(dimension: MediaConsentDimension, decision: "DECLINED" | "REVOKED", capturedVia: "dtmf_menu" | "speech_intent"): Promise<MediaConsentDecisionResponse> {
    return this.serial(async () => {
      const claim = this.requireClaim();
      try {
        const r = await this.client.consentDecision({ claim, dimension, decision, capturedVia, occurredAt: new Date(this.now()).toISOString() });
        this.applyDirective(r.directive);
        return r;
      } catch (err) {
        if (err instanceof GatewayRefusedError && err.status === 409) this.declareLost(err.reasonCode);
        throw err;
      }
    });
  }

  /**
   * Reports the processing readout, built when the request leaves (after every earlier answer was applied); the
   * answer's directive is applied at once. Null when there is no readout to report.
   */
  async report(build: () => MediaProcessingState | null): Promise<MediaProcessingReportResponse | null> {
    return this.serial(async () => {
      const claim = this.requireClaim();
      const state = build();
      if (!state) return null;
      try {
        const r = await this.client.reportProcessing(claim, state);
        if (!this.lost) this.applyDirective(r.directive);
        return r;
      } catch (err) {
        if (err instanceof GatewayRefusedError && err.status === 409) this.declareLost(err.reasonCode);
        throw err;
      }
    });
  }

  stop(): void {
    this.stopHeartbeat();
  }

  /** One binding request at a time, in order (a failed one never blocks the next). */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireClaim(): MediaBindingClaim {
    const c = this.claim();
    if (!c) throw new GatewayRefusedError(409, this.lost?.reasonCode ?? "BINDING_NOT_HELD");
    return c;
  }

  private setGeneration(next: number): void {
    const held = this.heldClaim;
    if (!held || next === held.sessionGeneration) return;
    if (next < held.sessionGeneration) return; // an older answer never moves the generation back
    const previous = held.sessionGeneration;
    this.heldClaim = { ...held, sessionGeneration: next };
    if (this.current) this.current = { ...this.current, sessionGeneration: next };
    this.events.onGeneration(previous, next);
  }

  private applyDirective(d: ProcessingDirective): void {
    if (this.heldDirective && d.consentVersion < this.heldDirective.consentVersion) return;
    this.heldDirective = d;
    this.events.onDirective(d);
  }

  private declareLost(reasonCode: string, reason?: BindingLossReason): void {
    if (this.lost) return;
    this.lost = { reason: reason ?? LOSS_BY_CODE[reasonCode] ?? "REFUSED", reasonCode };
    this.stopHeartbeat();
    this.events.onLost(this.lost);
  }

  private stopHeartbeat(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
