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
  /** Set by penalise(): no request may start before this time. */
  private blockedUntil = 0;

  constructor(
    private readonly rule: RateLimitRule,
    private readonly source: string,
    private readonly clock: Clock = systemClock,
    private readonly maxWaitMs = 30_000,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      if (now < this.blockedUntil) {
        await this.waitOrFail(this.blockedUntil - now);
        continue;
      }
      while (this.stamps.length > 0 && now - this.stamps[0]! >= this.rule.windowMs) {
        this.stamps.shift();
      }
      if (this.stamps.length < this.rule.max) {
        this.stamps.push(now);
        return;
      }
      await this.waitOrFail(this.stamps[0]! + this.rule.windowMs - now);
    }
  }

  private async waitOrFail(waitMs: number): Promise<void> {
    if (waitMs > this.maxWaitMs) {
      throw new SourceError(
        `Local rate limit reached for ${this.source}; next slot in ${Math.ceil(waitMs / 1000)}s`,
        this.source,
        "rate_limited",
      );
    }
    await this.clock.sleep(waitMs);
  }

  /** Called when the server says we are limited (HTTP 429): hold every request until then. */
  penalise(retryAfterMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + retryAfterMs);
  }
}
