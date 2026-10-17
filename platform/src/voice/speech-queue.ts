/**
 * Speech segment queue (spec section 11; ACT-05).
 *
 * - Accepts only results issued by TemplateResponseGate in this process
 *   (unforgeable registry check): a protected segment that has not passed the
 *   gate is refused (PROTECTED_SEGMENT_NOT_GATED), and so is any other
 *   un-gated text — dependency free text is never spoken.
 * - Every segment carries the turn id and session generation of its gate
 *   result; enqueue and dequeue both re-check that the turn is still current.
 * - Barge-in stops playback of the current segment and drops every queued
 *   segment of the session; stale segments are also dropped on dequeue.
 * - Validation happens before the first audible segment: a gated utterance is
 *   split into segments only after the whole utterance passed the gate.
 *
 * LOCAL FIXTURE (in-process). Whether the vendor speech path offers an
 * equivalent before-speech guarantee is UNKNOWN (TB-04).
 */
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { ResponseClass } from "../protocol/index.js";
import { newId } from "../shared/ids.js";
import { FALLBACK_TEMPLATE_ID, PROTECTED_RESPONSE_CLASSES, isGateApproved, isGateFallback } from "./gate.js";
import type { TurnTracker } from "./ports.js";

export interface SpeechSegment {
  readonly segmentId: string;
  readonly sessionRef: string;
  readonly turnId: string;
  readonly sessionGeneration: number;
  readonly templateId: string;
  readonly responseClass: ResponseClass;
  readonly protectedClass: boolean;
  readonly text: string;
  readonly index: number;
  readonly count: number;
  readonly localUnapprovedBadge: boolean;
  readonly acknowledgmentOnly: boolean;
}

export type EnqueueResult = { accepted: true; segmentIds: string[] } | { accepted: false; reasonCode: string };

export interface BargeInResult {
  invalidatedTurnId: string | null;
  droppedSegments: number;
  /** A segment was playing: the audio layer must stop it now. */
  stopPlayback: boolean;
}

export interface SpeechQueueOptions {
  turns: TurnTracker;
  logger?: Logger;
  metrics?: Metrics;
  maxQueuedPerSession?: number;
}

const NO_SPLIT_BEFORE = /^(dr|mr|mrs|ms|sr|sra|srta|jr|st|[a-z])$/i;

/** Splits an utterance into sentence segments without breaking after abbreviations or single letters ("p. m."). */
export function splitSegments(utterance: string): string[] {
  const words = utterance.split(" ");
  const out: string[] = [];
  let current: string[] = [];
  for (const w of words) {
    current.push(w);
    const m = /^(.*?)([.?!])$/.exec(w);
    if (m && !NO_SPLIT_BEFORE.test(m[1] ?? "")) {
      out.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) out.push(current.join(" "));
  return out.filter((s) => s.trim().length > 0);
}

export class SpeechQueue {
  readonly kind = "local_fixture" as const;
  private readonly turns: TurnTracker;
  private readonly logger: Logger;
  private readonly metrics: Metrics | null;
  private readonly maxQueued: number;
  private readonly queues = new Map<string, SpeechSegment[]>();
  private readonly playing = new Map<string, SpeechSegment>();
  private staleDropped = 0;

  constructor(opts: SpeechQueueOptions) {
    this.turns = opts.turns;
    this.logger = (opts.logger ?? silentLogger).child({ component: "speech_queue" });
    this.metrics = opts.metrics ?? null;
    this.maxQueued = opts.maxQueuedPerSession ?? 32;
  }

  enqueue(item: unknown): EnqueueResult {
    let base: Omit<SpeechSegment, "segmentId" | "text" | "index" | "count">;
    let utterance: string;
    if (isGateApproved(item)) {
      base = {
        sessionRef: item.sessionRef,
        turnId: item.turnId,
        sessionGeneration: item.sessionGeneration,
        templateId: item.templateId,
        responseClass: item.responseClass,
        protectedClass: item.protectedClass,
        localUnapprovedBadge: item.localUnapprovedBadge,
        acknowledgmentOnly: item.acknowledgmentOnly,
      };
      utterance = item.utterance;
    } else if (isGateFallback(item) && item.sessionRef && item.turnId && item.sessionGeneration !== null) {
      base = {
        sessionRef: item.sessionRef,
        turnId: item.turnId,
        sessionGeneration: item.sessionGeneration,
        templateId: FALLBACK_TEMPLATE_ID,
        responseClass: "GENERIC_STATUS",
        protectedClass: false,
        localUnapprovedBadge: item.localUnapprovedBadge,
        acknowledgmentOnly: false,
      };
      utterance = item.fallbackUtterance;
    } else {
      const cls = (item as { responseClass?: unknown } | null)?.responseClass;
      const reasonCode = typeof cls === "string" && PROTECTED_RESPONSE_CLASSES.has(cls as ResponseClass) ? "PROTECTED_SEGMENT_NOT_GATED" : "SEGMENT_NOT_GATED";
      this.logger.warn("voice.queue.refused", { reasonCode });
      return { accepted: false, reasonCode };
    }
    if (!this.turns.isCurrent(base.sessionRef, base.turnId, base.sessionGeneration)) {
      this.staleDropped += 1;
      return { accepted: false, reasonCode: "STALE_TURN" };
    }
    const parts = splitSegments(utterance);
    const q = this.queues.get(base.sessionRef) ?? [];
    if (q.length + parts.length > this.maxQueued) return { accepted: false, reasonCode: "SPEECH_QUEUE_FULL" };
    const segments = parts.map((text, index) => Object.freeze({ ...base, segmentId: newId("seg"), text, index, count: parts.length }));
    q.push(...segments);
    this.queues.set(base.sessionRef, q);
    return { accepted: true, segmentIds: segments.map((s) => s.segmentId) };
  }

  /** Next segment to play, dropping anything whose turn is no longer current. */
  next(sessionRef: string): SpeechSegment | null {
    const q = this.queues.get(sessionRef);
    while (q && q.length > 0) {
      const seg = q.shift();
      if (!seg) break;
      if (this.turns.isCurrent(seg.sessionRef, seg.turnId, seg.sessionGeneration)) {
        this.playing.set(sessionRef, seg);
        return seg;
      }
      this.staleDropped += 1;
    }
    this.playing.delete(sessionRef);
    return null;
  }

  completePlayback(sessionRef: string, segmentId: string): void {
    if (this.playing.get(sessionRef)?.segmentId === segmentId) this.playing.delete(sessionRef);
  }

  /** Caller interrupted: invalidate the turn, stop current audio and drop every queued segment. */
  bargeIn(sessionRef: string): BargeInResult {
    const invalidatedTurnId = this.turns.bargeIn(sessionRef);
    const dropped = this.queues.get(sessionRef)?.length ?? 0;
    this.queues.delete(sessionRef);
    const stopPlayback = this.playing.has(sessionRef);
    this.playing.delete(sessionRef);
    this.staleDropped += dropped;
    try {
      this.metrics?.increment("vsp_interruptions_total", { kind: "barge_in" });
    } catch {
      // Metrics never interfere with stopping speech.
    }
    return { invalidatedTurnId, droppedSegments: dropped, stopPlayback };
  }

  pending(sessionRef: string): number {
    return this.queues.get(sessionRef)?.length ?? 0;
  }

  get staleSegmentsDropped(): number {
    return this.staleDropped;
  }

  endSession(sessionRef: string): void {
    this.queues.delete(sessionRef);
    this.playing.delete(sessionRef);
  }
}
