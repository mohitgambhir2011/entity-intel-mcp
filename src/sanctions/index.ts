import { SourceError } from "../core/errors.js";
import { TTL, type Cache } from "../infra/cache.js";
import type { HttpClient } from "../infra/http.js";
import { listDefinitions, type ListDefinition } from "./lists.js";
import { ListIndex } from "./matching.js";
import type { ListSnapshot, SanctionsListId } from "./types.js";

export { ListIndex } from "./matching.js";
export type { Thresholds, ScreenSubject } from "./matching.js";
export * from "./types.js";

export interface SanctionsDeps {
  http: HttpClient;
  cache: Cache;
  now: () => number;
  /** Replacement for the EU download URL (EIM_EU_SANCTIONS_URL). */
  euUrl?: string;
  /** Test hook: lowers the "list looks truncated" floor so small fixtures load. */
  minEntries?: number;
}

export interface LoadedList {
  list: SanctionsListId;
  index: ListIndex;
  versionDate?: string;
  fetchedAt: string;
  entries: number;
  /** True when this call did not download: served from memory or the local cache. */
  fromCache: boolean;
}

export interface ListStatus {
  list: SanctionsListId;
  label: string;
  state: "loaded" | "loading" | "not_loaded" | "error";
  versionDate?: string;
  fetchedAt?: string;
  entries?: number;
  error?: string;
}

const MAX_DOWNLOAD_BYTES = 150_000_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * Owns the three sanctions lists: downloads them (once per day, D7), caches the parsed snapshot in
 * the shared cache, and keeps a searchable in-memory index. Concurrent callers share one load; a
 * failed load is never cached and is retried on the next call.
 */
export class SanctionsIndex {
  private readonly defs: ListDefinition[];
  private readonly loaded = new Map<SanctionsListId, LoadedList>();
  private readonly pending = new Map<SanctionsListId, Promise<LoadedList>>();
  private readonly errors = new Map<SanctionsListId, string>();

  constructor(private readonly deps: SanctionsDeps) {
    this.defs = listDefinitions({ euUrl: deps.euUrl });
  }

  get lists(): SanctionsListId[] {
    return this.defs.map((d) => d.id);
  }

  /** Returns the list, loading it if needed. Throws `SourceError` when it cannot be loaded. */
  async get(list: SanctionsListId, opts: { fresh?: boolean } = {}): Promise<LoadedList> {
    const have = this.loaded.get(list);
    // Age is measured from when the list was downloaded, not from when it was indexed, so a list
    // preloaded from a nearly-expired cache entry is not served for another full day.
    const age = have ? this.deps.now() - Date.parse(have.fetchedAt) : Infinity;
    if (have && !opts.fresh && age < TTL.sanctions * 1000) return { ...have, fromCache: true };

    let p = opts.fresh ? undefined : this.pending.get(list);
    if (!p) {
      const mine: Promise<LoadedList> = this.load(list, opts.fresh === true).finally(() => {
        // Only remove our own entry: a newer fresh load may have replaced it.
        if (this.pending.get(list) === mine) this.pending.delete(list);
      });
      p = mine;
      this.pending.set(list, mine);
    }
    return p;
  }

  /**
   * At startup: indexes any list that is already in the local cache (no network, so starting the
   * server never downloads 100 MB). Lists not cached are downloaded on first use.
   */
  warmFromCache(): void {
    for (const list of this.lists) {
      this.load(list, false, true).catch(() => {
        // Not cached or unreadable: the first screening will download it. Nothing to report.
      });
    }
  }

  status(): ListStatus[] {
    return this.defs.map((d) => {
      const have = this.loaded.get(d.id);
      const base = { list: d.id, label: d.label };
      if (have) {
        return {
          ...base,
          state: "loaded" as const,
          versionDate: have.versionDate,
          fetchedAt: have.fetchedAt,
          entries: have.entries,
        };
      }
      if (this.pending.has(d.id)) return { ...base, state: "loading" as const };
      const error = this.errors.get(d.id);
      return error
        ? { ...base, state: "error" as const, error }
        : { ...base, state: "not_loaded" as const };
    });
  }

  private async load(
    list: SanctionsListId,
    fresh: boolean,
    cacheOnly = false,
  ): Promise<LoadedList> {
    const def = this.defs.find((d) => d.id === list);
    if (!def) throw new SourceError(`Unknown sanctions list ${list}`, list, "bad_response");
    const source = list.toLowerCase();
    try {
      const res = await this.deps.cache.getOrFetch<ListSnapshot>(
        `sanctions:${list}`,
        { ttlSeconds: TTL.sanctions, source, fresh },
        async () => {
          if (cacheOnly) throw new SourceError(`${list} is not cached`, source, "unavailable");
          const r = await this.deps.http.getText(def.url, {
            source,
            maxBytes: MAX_DOWNLOAD_BYTES,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            allowRedirectHosts: def.redirectHosts,
          });
          const parsed = parseOrThrow(def, r.body, source);
          // Never below 1, so an empty list can not be accepted even through the test seam.
          const floor = Math.max(1, this.deps.minEntries ?? def.minEntries);
          if (parsed.entries.length < floor) {
            // A truncated or restructured file must not become "the list": screening against it
            // would silently report no matches.
            throw new SourceError(
              `${list} list looks incomplete (${parsed.entries.length} entries)`,
              source,
              "bad_response",
            );
          }
          return {
            list,
            versionDate: parsed.versionDate ?? dateFromHeader(r.headers.get("last-modified")),
            fetchedAt: new Date(this.deps.now()).toISOString(),
            entries: parsed.entries,
          };
        },
      );
      const snap = res.value;
      const loaded: LoadedList = {
        list,
        index: new ListIndex(list, snap.entries),
        versionDate: snap.versionDate,
        fetchedAt: snap.fetchedAt,
        entries: snap.entries.length,
        fromCache: res.fromCache,
      };
      this.loaded.set(list, loaded);
      this.errors.delete(list);
      return loaded;
    } catch (err) {
      if (cacheOnly) throw err; // a preload miss is not a failure worth remembering
      this.errors.set(list, err instanceof SourceError ? err.message : `${list}: unexpected error`);
      throw err;
    }
  }
}

/** A list that does not parse is a source problem (format change, bad download), not a bug here. */
function parseOrThrow(
  def: ListDefinition,
  body: string,
  source: string,
): ReturnType<ListDefinition["parse"]> {
  try {
    return def.parse(body);
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(`${def.id} list could not be parsed`, source, "bad_response");
  }
}

/** Date (YYYY-MM-DD) from an HTTP Last-Modified header, if it parses. */
function dateFromHeader(value: string | null): string | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
