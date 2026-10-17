import type { ControllersResult, OfficersResult, UnavailableReason } from "../core/people.js";
import type { RegulatoryResult } from "../core/regulatory.js";
import type { ChargesResult, FilingsResult, InsolvencyResult } from "../core/records.js";
import type { Cache } from "../infra/cache.js";
import type { HttpClient } from "../infra/http.js";
import type {
  Identifier,
  IdentifierScheme,
  PartialEntity,
  SearchHit,
  SourceId,
} from "../core/types.js";

/** The data families an adapter can provide beyond identity. */
export type Capability =
  "officers" | "controllers" | "filings" | "charges" | "insolvency" | "regulatory";

/** What is known about a company when looking for it on a regulator's register. */
export interface RegulatoryQuery {
  identifiers: Identifier[];
  /** Legal, former and trading names, best first. */
  names: string[];
}

export interface FilingsQuery {
  category?: string;
  limit: number;
  offset: number;
}

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
  /**
   * ISO country whose register this adapter reads. Absent for adapters that span countries (GLEIF,
   * VIES). Lets a country-filtered search skip the registers of other countries.
   */
  readonly country?: string;
  /** Can this adapter look up this identifier? */
  supports(identifier: Identifier): boolean;
  /** Returns undefined when the source has no such record. Throws SourceError on source failures. */
  lookup(identifier: Identifier, ctx: AdapterContext): Promise<PartialEntity | undefined>;
  /**
   * Families this source's country will not provide, and why (for example Norway does not publish
   * beneficial owners). Lets the tools say "restricted" instead of "not yet supported".
   */
  readonly restrictions?: Partial<
    Record<Capability, { reason: UnavailableReason; detail: string }>
  >;
  /** Optional identifier translations this source can provide. */
  readonly crosswalks?: Crosswalk[];
  /** Optional: officers of the company this identifier names. undefined = no such company. */
  officers?(identifier: Identifier, ctx: AdapterContext): Promise<OfficersResult | undefined>;
  /** Optional: persons / entities with significant control (beneficial owners). */
  controllers?(identifier: Identifier, ctx: AdapterContext): Promise<ControllersResult | undefined>;
  /** Optional: one page of the filing history, optionally limited to a registry category. */
  filings?(
    identifier: Identifier,
    query: FilingsQuery,
    ctx: AdapterContext,
  ): Promise<FilingsResult | undefined>;
  /** Optional: charges (mortgages, security) registered against the company. */
  charges?(identifier: Identifier, ctx: AdapterContext): Promise<ChargesResult | undefined>;
  /** Optional: insolvency cases and practitioners. undefined = no such company. */
  insolvency?(identifier: Identifier, ctx: AdapterContext): Promise<InsolvencyResult | undefined>;
  /**
   * Optional: can this adapter provide `capability` for a company known by this identifier? Used
   * when the family is reached through a different identifier than the one it looks up (the FCA
   * Register is found from a Companies House number). Defaults to `supports`.
   */
  covers?(capability: Capability, identifier: Identifier): boolean;
  /** Optional: the firm on a regulator's register for this company. undefined = none found. */
  regulatory?(company: RegulatoryQuery, ctx: AdapterContext): Promise<RegulatoryResult | undefined>;
  /** Optional name search. */
  search?(query: string, ctx: AdapterContext, limit?: number): Promise<SearchHit[]>;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
