/**
 * Turn and session-generation tracking (spec section 11).
 *
 * Segments, tool results and approvals are tagged with a turn id and the
 * session generation. Only the current, non-invalidated turn of the current
 * generation is "current"; barge-in invalidates the current turn so late
 * results and queued segments cannot speak into a different state.
 *
 * LOCAL FIXTURE: state lives in this process. In the Talkdesk-native path the
 * vendor owns the audio pipeline and the before-speech guarantee is UNKNOWN
 * (TB-04); in the fallback speech runtime (ADR-0006) this logic would run next
 * to the media layer with per-call affinity.
 */
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { SessionInvalidError } from "../shared/errors.js";
import { newTurnId } from "../shared/ids.js";
import type { TurnTracker } from "./ports.js";

interface SessionTurnState {
  generation: number;
  turnId: string | null;
  invalidated: boolean;
}

export type TurnInvalidationListener = (sessionRef: string, turnId: string, cause: "BARGE_IN" | "NEW_TURN" | "GENERATION_CHANGED" | "SESSION_ENDED") => void;

export interface InMemoryTurnTrackerOptions {
  /** Bound on tracked sessions; evicted sessions fail closed (nothing is current). */
  maxSessions?: number;
  /** Injectable for deterministic tests. */
  newTurnId?: () => string;
  logger?: Logger;
}

const SESSION_REF_RE = /^[A-Za-z0-9_-]{8,128}$/;

export class InMemoryTurnTracker implements TurnTracker {
  readonly kind = "local_fixture" as const;
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly listeners = new Set<TurnInvalidationListener>();
  private readonly maxSessions: number;
  private readonly mintTurnId: () => string;
  private readonly logger: Logger;

  constructor(opts: InMemoryTurnTrackerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 50_000;
    this.mintTurnId = opts.newTurnId ?? newTurnId;
    this.logger = (opts.logger ?? silentLogger).child({ component: "turn_tracker" });
  }

  beginTurn(sessionRef: string, generation: number): string {
    if (!SESSION_REF_RE.test(sessionRef)) throw new SessionInvalidError("SESSION_REF_INVALID");
    if (!Number.isInteger(generation) || generation < 1) throw new SessionInvalidError("SESSION_GENERATION_INVALID");
    const prior = this.sessions.get(sessionRef);
    if (prior && generation < prior.generation) throw new SessionInvalidError("STALE_GENERATION");
    if (prior?.turnId && !prior.invalidated) {
      this.notify(sessionRef, prior.turnId, generation > prior.generation ? "GENERATION_CHANGED" : "NEW_TURN");
    }
    const turnId = this.mintTurnId();
    this.sessions.delete(sessionRef);
    this.sessions.set(sessionRef, { generation, turnId, invalidated: false });
    this.evict();
    return turnId;
  }

  bargeIn(sessionRef: string): string | null {
    const s = this.sessions.get(sessionRef);
    if (!s || !s.turnId || s.invalidated) return null;
    s.invalidated = true;
    this.logger.info("voice.turn.barge_in", { turnId: s.turnId });
    this.notify(sessionRef, s.turnId, "BARGE_IN");
    return s.turnId;
  }

  isCurrent(sessionRef: string, turnId: string, generation: number): boolean {
    const s = this.sessions.get(sessionRef);
    return s !== undefined && !s.invalidated && s.turnId !== null && s.turnId === turnId && s.generation === generation;
  }

  currentGeneration(sessionRef: string): number | null {
    return this.sessions.get(sessionRef)?.generation ?? null;
  }

  endSession(sessionRef: string): void {
    const s = this.sessions.get(sessionRef);
    if (s?.turnId && !s.invalidated) this.notify(sessionRef, s.turnId, "SESSION_ENDED");
    this.sessions.delete(sessionRef);
  }

  onInvalidate(listener: TurnInvalidationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(sessionRef: string, turnId: string, cause: Parameters<TurnInvalidationListener>[2]): void {
    for (const l of this.listeners) {
      try {
        l(sessionRef, turnId, cause);
      } catch {
        this.logger.warn("voice.turn.listener_failed", { reasonCode: "TURN_LISTENER_FAILED" });
      }
    }
  }

  private evict(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
