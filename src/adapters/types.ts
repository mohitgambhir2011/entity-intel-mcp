import type { ControllersResult, OfficersResult } from "../core/people.js";
import type { Cache } from "../infra/cache.js";
import type { HttpClient } from "../infra/http.js";
import type {
  Identifier,
  IdentifierScheme,
  PartialEntity,
  SearchHit,
  SourceId,
} from "../core/types.js";

export interface AdapterContext {
  http: HttpClient;
  cache: Cache;
  /** Bypass the cache for this call (D7). */
  fresh?: boolean;
  /** Injected clock so tests are deterministic. */
  now?: () => Date;
}

/** Translates one identifier scheme into another (e.g. UK company number -> LEI). */
export interface Crosswalk {
  from: IdentifierScheme;
  to: IdentifierScheme;
  /** Returns undefined when the source knows no counterpart. */
  find(identifier: Identifier, ctx: AdapterContext): Promise<Identifier | undefined>;
}

export interface SourceAdapter {
  readonly id: SourceId;
  /** Can this adapter look up this identifier? */
  supports(identifier: Identifier): boolean;
  /** Returns undefined when the source has no such record. Throws SourceError on source failures. */
  lookup(identifier: Identifier, ctx: AdapterContext): Promise<PartialEntity | undefined>;
  /** Optional identifier translations this source can provide. */
  readonly crosswalks?: Crosswalk[];
  /** Optional: officers of the company this identifier names. undefined = no such company. */
  officers?(identifier: Identifier, ctx: AdapterContext): Promise<OfficersResult | undefined>;
  /** Optional: persons / entities with significant control (beneficial owners). */
  controllers?(identifier: Identifier, ctx: AdapterContext): Promise<ControllersResult | undefined>;
  /** Optional name search. */
  search?(query: string, ctx: AdapterContext, limit?: number): Promise<SearchHit[]>;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
