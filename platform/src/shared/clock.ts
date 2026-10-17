/** Injectable clock so expiry, deadlines and TTL behaviour are deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: number;
  constructor(start: string | Date = "2026-10-17T15:00:00.000Z") {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current += ms;
  }
  advanceSeconds(s: number): void {
    this.advanceMs(s * 1000);
  }
  set(to: string | Date): void {
    this.current = new Date(to).getTime();
  }
}

/** ISO-8601 UTC with millisecond precision and a trailing Z. */
export const iso = (d: Date): string => d.toISOString();
export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
