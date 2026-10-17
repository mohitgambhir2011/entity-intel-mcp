import type { Storage } from "./storage/index.js";

export interface CacheResult<T> {
  value: T;
  fromCache: boolean;
  fetchedAt: number;
}

export interface CacheOptions {
  /** Time to live in seconds. */
  ttlSeconds: number;
  source: string;
  /** Officer / beneficial-owner data: capped to the personal-data retention TTL (D11). */
  personal?: boolean;
  /** Bypass the cache and refresh (the `fresh` option, D7). */
  fresh?: boolean;
}

export class Cache {
  constructor(
    private readonly storage: Storage,
    private readonly personalTtlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns cached JSON if still within TTL, otherwise calls `fetcher` and stores the result.
   * Expired rows are never served: if the fetcher fails the error propagates (D28), so stale data
   * can't pass as fresh.
   */
  async getOrFetch<T>(
    key: string,
    opts: CacheOptions,
    fetcher: () => Promise<T>,
  ): Promise<CacheResult<T>> {
    const now = this.now();
    if (!opts.fresh) {
      const hit = this.storage.getCache(key);
      if (hit && hit.expiresAt > now) {
        return { value: JSON.parse(hit.value) as T, fromCache: true, fetchedAt: hit.fetchedAt };
      }
    }
    const value = await fetcher();
    const ttl = opts.personal
      ? Math.min(opts.ttlSeconds, this.personalTtlSeconds)
      : opts.ttlSeconds;
    this.storage.putCache({
      key,
      value: JSON.stringify(value),
      fetchedAt: now,
      expiresAt: now + ttl * 1000,
      source: opts.source,
      personal: opts.personal === true,
    });
    return { value, fromCache: false, fetchedAt: now };
  }
}

/** Default TTLs in seconds (D7). Overridable later via EIM_CACHE_TTL_*. */
export const TTL = {
  registryProfile: 60 * 60,
  search: 15 * 60,
  gleif: 6 * 60 * 60,
  vies: 24 * 60 * 60,
} as const;
