/**
 * Injected-clock session-expiry seam on the live identity path (WP-05; injection point of
 * [FAULT:AUTH_EXPIRY_MID_CALL], whose Layer-2 run belongs to WP-07, and of [FAULT:AUTH_EXPIRY_IDLE]).
 *
 * The seam is a Clock: the composition passes it to TrustedSessionService (and the verification service)
 * instead of the system clock, so session readers see "later" without any change to the session record or
 * to the store. That is exactly the fault: the record still exists (DynamoDB TTL cleanup has not run), only
 * time has moved past `expiresAt` (hard expiry) or past `lastActivityAt + privilegeIdleTimeoutSeconds`
 * (idle expiry). Every reader must then refuse the session in application logic (AUTH-04).
 *
 *   const seam = SessionExpirySeam.wrap(systemClock, { environment: "ci" });
 *   const sessions = new TrustedSessionService({ kv, clock: seam, config });
 *   ... prepare an action with the live session ...
 *   seam.jumpPastExpiry(ctx.expiresAt);        // AUTH_EXPIRY_MID_CALL: hard expiry between prepare and commit
 *   seam.jumpPastIdle(ctx, config);            // AUTH_EXPIRY_IDLE: idle limit while the caller is silent
 *   seam.reset();
 *
 * Fault seams never run in a deployed environment: construction outside local/ci is refused
 * (ConfigurationRejectedError), the same rule as every other fault injector (OPS-04).
 */
import type { AuthContext, Environment } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import type { SessionConfig } from "./config.js";

export class SessionExpirySeam implements Clock {
  private offsetMs = 0;
  /** Number of jumps applied (fault reach evidence). */
  injections = 0;

  private constructor(private readonly base: Clock) {}

  static wrap(base: Clock, opts: { environment: Environment }): SessionExpirySeam {
    if (opts.environment !== "local" && opts.environment !== "ci") throw new ConfigurationRejectedError(["SESSION_EXPIRY_SEAM_OUTSIDE_OFFLINE@identity.clock"]);
    return new SessionExpirySeam(base);
  }

  now(): Date {
    return new Date(this.base.now().getTime() + this.offsetMs);
  }

  /** Current injected offset (ms) on top of the base clock. */
  get offset(): number {
    return this.offsetMs;
  }

  /** Moves the seam's time forward by `ms` (never backwards: time regression is not a fault this seam models). */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("SESSION_EXPIRY_SEAM_ADVANCE_INVALID");
    this.offsetMs += ms;
    this.injections += 1;
  }

  /** Hard expiry: the next reader's now() is `marginMs` after the session's expiresAt. */
  jumpPastExpiry(expiresAt: string, marginMs = 1_000): void {
    const target = Date.parse(expiresAt);
    if (!Number.isFinite(target)) throw new RangeError("SESSION_EXPIRY_SEAM_TARGET_INVALID");
    const delta = target + marginMs - this.now().getTime();
    if (delta > 0) this.advance(delta);
    else this.injections += 1;
  }

  /**
   * Idle expiry: moves past the idle limit counted from now (the latest possible activity), so the next
   * use of a verified session is refused SESSION_IDLE_EXPIRED while the record still exists.
   */
  jumpPastIdle(_ctx: Pick<AuthContext, "sessionRef">, cfg: Pick<SessionConfig, "privilegeIdleTimeoutSeconds">, marginMs = 1_000): void {
    this.advance(cfg.privilegeIdleTimeoutSeconds * 1000 + marginMs);
  }

  reset(): void {
    this.offsetMs = 0;
  }
}
