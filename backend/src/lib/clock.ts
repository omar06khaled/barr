/** Injected clock so timers (2-min / 15-min escalation, missed doses...) are testable. */
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now() { return new Date(this.t); }
  set(d: Date) { this.t = new Date(d); }
  advanceMs(ms: number) { this.t = new Date(this.t.getTime() + ms); }
  advanceMin(m: number) { this.advanceMs(m * 60_000); }
}
