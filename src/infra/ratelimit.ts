import { SourceError } from "../core/errors.js";

export interface RateLimitRule {
  /** Maximum requests per window. */
  max: number;
  windowMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Sliding-window limiter, one instance per host. Waits for a slot up to `maxWaitMs`; beyond that
 * it fails fast so a tool call never hangs for minutes.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly rule: RateLimitRule,
    private readonly source: string,
    private readonly clock: Clock = systemClock,
    private readonly maxWaitMs = 30_000,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      while (this.stamps.length > 0 && now - this.stamps[0]! >= this.rule.windowMs) {
        this.stamps.shift();
      }
      if (this.stamps.length < this.rule.max) {
        this.stamps.push(now);
        return;
      }
      const wait = this.stamps[0]! + this.rule.windowMs - now;
      if (wait > this.maxWaitMs) {
        throw new SourceError(
          `Local rate limit reached for ${this.source}; next slot in ${Math.ceil(wait / 1000)}s`,
          this.source,
          "rate_limited",
        );
      }
      await this.clock.sleep(wait);
    }
  }

  /** Called when the server says we are limited (HTTP 429): hold all slots until the window passes. */
  penalise(retryAfterMs: number): void {
    const until = this.clock.now() + retryAfterMs - this.rule.windowMs;
    while (this.stamps.length < this.rule.max) this.stamps.push(until);
  }
}
