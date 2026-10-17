import type { Cache } from "../infra/cache.js";
import type { HttpClient } from "../infra/http.js";
import type { Identifier, PartialEntity, SearchHit, SourceId } from "../core/types.js";

export interface AdapterContext {
  http: HttpClient;
  cache: Cache;
  /** Bypass the cache for this call (D7). */
  fresh?: boolean;
  /** Injected clock so tests are deterministic. */
  now?: () => Date;
}

export interface SourceAdapter {
  readonly id: SourceId;
  /** Can this adapter look up this identifier? */
  supports(identifier: Identifier): boolean;
  /** Returns undefined when the source has no such record. Throws SourceError on source failures. */
  lookup(identifier: Identifier, ctx: AdapterContext): Promise<PartialEntity | undefined>;
  /** Optional name search. */
  search?(query: string, ctx: AdapterContext, limit?: number): Promise<SearchHit[]>;
}

export function iso(ctx: AdapterContext, ms: number): string {
  return new Date(ms).toISOString();
}
