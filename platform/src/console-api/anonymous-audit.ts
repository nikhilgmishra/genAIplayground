/**
 * Bound on the audit events that ANONYMOUS requests can cause (WP-05; STRIDE D row T-FO-05-13 of
 * docs/security/threats/proposed/WP-05-threats.md; OPS-01).
 *
 * The console's sign-in exchange is unauthenticated: a client can start a login transaction and post a
 * syntactically valid exchange (a wrong PKCE verifier, a garbage code the IdP refuses) without ever signing
 * in at the IdP. Writing one append-only audit event per such refusal would let anyone grow the audit log
 * without bound. Refusals that no verified identity stands behind therefore pass through this budget:
 *
 *   - per (action, reason code), at most `eventsPerWindow` audit events per `windowSeconds` per process;
 *   - every further refusal in the window is counted (and logged once per window), not written;
 *   - the next event that IS written for that key carries the number of refusals suppressed before it as the
 *     evidence pointer `kv://console-anonymous-audit/suppressed/<n>` (the budget's window state; the audit
 *     pointer grammar of audit/schema.ts), so the audit log keeps the volume, bounded in size.
 *
 * The audit volume is then at most (distinct keys) x eventsPerWindow per window per instance, whatever the
 * request rate. Refusals with a verified actor (an IdP-authenticated sign-in refused for MFA or groups) are
 * attributed to that actor and are not budgeted here (each needs a real IdP sign-in). The edge rate limit in
 * front of the console (composition) is the first line; this is the backend's own bound.
 */
import type { Clock } from "../shared/clock.js";

export interface AnonymousAuditBudgetOptions {
  /** Window length (default 60 s). */
  windowSeconds: number;
  /** Audit events written per key and window (default 1). */
  eventsPerWindow: number;
  /** Distinct keys tracked (default 256; the oldest window is dropped beyond it). */
  maxKeys: number;
}

export const DEFAULT_ANONYMOUS_AUDIT_BUDGET: AnonymousAuditBudgetOptions = { windowSeconds: 60, eventsPerWindow: 1, maxKeys: 256 };

export type AnonymousAuditAdmission = { write: true; suppressedBefore: number } | { write: false; firstSuppressedInWindow: boolean };

interface Window {
  startedAt: number;
  written: number;
  /** Refusals suppressed since the last written event (carried across windows until one is written). */
  suppressed: number;
  suppressedInWindow: number;
}

export class AnonymousAuditBudget {
  private readonly opts: AnonymousAuditBudgetOptions;
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly clock: Clock,
    opts: Partial<AnonymousAuditBudgetOptions> = {},
  ) {
    this.opts = { ...DEFAULT_ANONYMOUS_AUDIT_BUDGET, ...opts };
    if (!Number.isInteger(this.opts.windowSeconds) || this.opts.windowSeconds < 1 || this.opts.windowSeconds > 3_600) throw new RangeError("ANONYMOUS_AUDIT_WINDOW_INVALID");
    if (!Number.isInteger(this.opts.eventsPerWindow) || this.opts.eventsPerWindow < 1 || this.opts.eventsPerWindow > 1_000) throw new RangeError("ANONYMOUS_AUDIT_EVENTS_INVALID");
    if (!Number.isInteger(this.opts.maxKeys) || this.opts.maxKeys < 1 || this.opts.maxKeys > 10_000) throw new RangeError("ANONYMOUS_AUDIT_KEYS_INVALID");
  }

  /** Decides whether the anonymous refusal identified by (action, reasonCode) is written to the audit log now. */
  admit(action: string, reasonCode: string): AnonymousAuditAdmission {
    const key = `${action}\u0000${reasonCode}`;
    const now = this.clock.now().getTime();
    let w = this.windows.get(key);
    if (!w || now - w.startedAt >= this.opts.windowSeconds * 1000 || now < w.startedAt) {
      w = { startedAt: now, written: 0, suppressed: w?.suppressed ?? 0, suppressedInWindow: 0 };
      this.windows.delete(key);
      this.windows.set(key, w);
      if (this.windows.size > this.opts.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
    }
    if (w.written < this.opts.eventsPerWindow) {
      w.written += 1;
      const suppressedBefore = w.suppressed;
      w.suppressed = 0;
      return { write: true, suppressedBefore };
    }
    w.suppressed += 1;
    w.suppressedInWindow += 1;
    return { write: false, firstSuppressedInWindow: w.suppressedInWindow === 1 };
  }
}

/** Evidence pointer carrying the suppressed count on the next written event (none when nothing was suppressed). */
export const suppressedEvidence = (n: number): string[] => (n > 0 ? [`kv://console-anonymous-audit/suppressed/${Math.min(n, 999_999)}`] : []);
