/**
 * The recorders of a call this runtime does not hold (WP-11; DATA-03, FO-10-46, T-FO-11-03).
 *
 * A runtime refused into a person route after the call's owner was lost (BINDING_CONSENT_REQUIRES_PERSON,
 * BINDING_PERSON_REQUESTED, BINDING_WITH_PERSON) holds no binding, so its ProcessingController has nothing to
 * reconcile; the lost owner may have left recorders running (its stop never reached the media plane before it died),
 * and nothing else in the room watches them. While such a runtime stays in the room, every tick:
 *   1. asks the gateway (until it answered once) for the call's recorders, the ones the call's owners reported as
 *      their own, and the consent they answer to (the media route checks the job as for a bind; nothing is issued);
 *   2. reads the egress API's own list for the room;
 *   3. asks the egress API to stop every named recorder that still runs: the AI runtime no longer holds the call, as
 *      when a bound runtime suspends for a person (an observe-only runtime cannot stop; it flags instead);
 *   4. flags a recorder running that the consent does not permit at `now` (no consent shown, i.e. no call or no
 *      session, permits nothing: UNKNOWN is not consent): a named one still running past the drain bound after its
 *      stop was asked (RECORDING_WITHOUT_CONSENT), any other one (FOREIGN_RECORDER_ACTIVE, never stopped here: it is
 *      not the call's). The flag is reported to the gateway, which records and audits it, and logged.
 * A recorder running under consent that permits recording is left alone. A tick that cannot read the egress API or
 * reach the gateway is retried on the next one.
 */
import { permittedTaps } from "@vsp/platform/src/protocol/call-binding.js";
import type { MediaRecorderCheckResponse, ProcessingMismatch } from "@vsp/platform/src/protocol/call-binding.js";
import type { Logger } from "@vsp/platform/src/observability/ports.js";
import type { CallRecorder, EgressObserver } from "./controller.js";

export interface RecorderSettlementOptions {
  roomName: string;
  /** The deployment's recorder (it can stop egress), or null when the runtime may only observe. */
  recorder: CallRecorder | null;
  observer: EgressObserver | null;
  /** The gateway's recorder check for this runtime's job (MediaGatewayClient.recorders); `mismatch` reports a flag. */
  check: (mismatch: ProcessingMismatch | null) => Promise<MediaRecorderCheckResponse>;
  logger: Logger;
  now?: () => Date;
  /** How long a named recorder may drain after its stop was asked before it is flagged (default 5 s). */
  drainBoundMs?: number;
}

export interface SettlementView {
  /** The gateway answered (the call's recorders and consent are known). */
  answered: boolean;
  /** Named recorders the egress API listed running at the last tick. */
  namedRunning: string[];
  /** Recorders whose stop this runtime asked for. */
  stopsAsked: string[];
  flag: ProcessingMismatch | null;
  /** The flag reached the gateway. */
  reported: boolean;
}

export class RecorderSettlement {
  private answer: MediaRecorderCheckResponse | null = null;
  private readonly stopAskedAt = new Map<string, number>();
  private namedRunning: string[] = [];
  private flag: ProcessingMismatch | null = null;
  private reported = false;
  private ticking = false;
  private readonly now: () => Date;
  private readonly drainBoundMs: number;

  constructor(private readonly o: RecorderSettlementOptions) {
    this.now = o.now ?? (() => new Date());
    this.drainBoundMs = o.drainBoundMs ?? 5_000;
  }

  view(): SettlementView {
    return { answered: this.answer !== null, namedRunning: [...this.namedRunning], stopsAsked: [...this.stopAskedAt.keys()], flag: this.flag, reported: this.reported };
  }

  /** One settlement pass (concurrent calls collapse into the one running). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pass();
    } finally {
      this.ticking = false;
    }
  }

  private async pass(): Promise<void> {
    if (!this.answer) {
      try {
        this.answer = await this.o.check(null);
      } catch {
        this.o.logger.warn("media.recording.settlement_unconfirmed", { reasonCode: "RECORDER_CHECK_UNAVAILABLE" });
        return;
      }
    }
    const observer: EgressObserver | null = this.o.recorder ?? this.o.observer;
    if (!observer) return;
    let running: string[];
    try {
      running = (await observer.observe(this.o.roomName)).filter((e) => e.running).map((e) => e.egressId);
    } catch {
      this.o.logger.warn("media.recording.settlement_unobserved", { reasonCode: "RECORDER_STATE_UNKNOWN" });
      return;
    }
    const named = new Set(this.answer.recorders);
    this.namedRunning = running.filter((id) => named.has(id));
    const at = this.now().getTime();
    if (this.o.recorder) {
      for (const id of this.namedRunning) {
        if (!this.stopAskedAt.has(id)) this.stopAskedAt.set(id, at);
        try {
          await this.o.recorder.stop(this.o.roomName, id);
        } catch {
          // Asked again on the next tick; the drain bound decides when it becomes a flag.
        }
      }
    }
    const directive = this.answer.directive;
    const permitted = directive !== null && permittedTaps(directive, this.now()).recording;
    if (!permitted) {
      const overdue = this.namedRunning.some((id) => !this.o.recorder || at - (this.stopAskedAt.get(id) ?? at) > this.drainBoundMs);
      const foreign = running.some((id) => !named.has(id));
      if (this.flag === null && (overdue || foreign)) {
        this.flag = overdue ? "RECORDING_WITHOUT_CONSENT" : "FOREIGN_RECORDER_ACTIVE";
        this.o.logger.warn("media.processing.mismatch", { reasonCode: this.flag, action: "recorder_settlement" });
      }
    }
    if (this.flag !== null && !this.reported) {
      try {
        const answer = await this.o.check(this.flag);
        this.answer = answer;
        this.reported = true;
      } catch {
        // Reported again on the next tick.
      }
    }
  }
}
