import { SourceError } from "../../core/errors.js";
import { normalizeIeCro } from "../../core/identifiers.js";
import type { Provenance, SearchHit } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type AdapterContext, type SourceAdapter } from "../types.js";
import {
  BASE,
  LICENCE,
  mapCroAddress,
  mapCroEntity,
  mapCroStatus,
  searchTerms,
  type CkanPackage,
  type CkanResponse,
  type CkanSearch,
  type CroRecord,
} from "./map.js";

const SOURCE = "cro_ie";
/** The dataset is looked up by name so a republished resource does not break the adapter. */
const DATASET = "companies";
const RESOURCE_TTL = 6 * 60 * 60;

function provenance(id: string, fetchedAt: number, fromCache: boolean): Provenance {
  return {
    source: SOURCE,
    sourceRecordId: id,
    sourceUrl: `https://opendata.cro.ie/dataset/${DATASET}`,
    retrievedAt: iso(fetchedAt),
    fromCache,
    licence: LICENCE,
  };
}

const bad = (what: string): SourceError =>
  new SourceError(`${SOURCE} returned an unexpected ${what} response`, SOURCE, "bad_response");

/** CKAN answers { success: true, result } or { success: false, error }. */
function result<T>(body: CkanResponse<T> | null | undefined, what: string): T {
  if (!body || typeof body !== "object" || body.success !== true || !body.result) throw bad(what);
  return body.result;
}

/**
 * Ireland: Companies Registration Office open data (CKAN datastore, CC BY 4.0, no key, updated
 * daily). Identity, status and name search of all companies, current and dissolved. Officers need
 * the CRO web services (a separate key, not built); beneficial owners are closed to the public.
 */
export const irelandAdapter: SourceAdapter = {
  id: SOURCE,
  country: "IE",

  supports: (id) => id.scheme === "IE_CRO",

  restrictions: {
    controllers: {
      reason: "restricted_access",
      detail:
        "Ireland's beneficial ownership register is closed to the public since the 2022 CJEU " +
        "ruling (access is limited to those with a legitimate interest), so ownership can not be " +
        "traced for Irish companies",
    },
  },

  async lookup(identifier, ctx) {
    const number = normalizeIeCro(identifier.value);
    if (!number) return undefined;
    const res = await ctx.cache.getOrFetch<CroRecord | null>(
      `ie:company:${number}`,
      { ttlSeconds: TTL.registryProfile, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const rid = await resourceId(ctx);
        const r = await ctx.http.getJson<CkanResponse<CkanSearch>>(
          `${BASE}/datastore_search?resource_id=${rid}&filters=${encodeURIComponent(
            JSON.stringify({ company_num: Number(number) }),
          )}&limit=2`,
          { source: SOURCE },
        );
        const records = result(r.body, "company").records;
        if (!Array.isArray(records)) throw bad("company");
        if (records.length === 0) return null;
        // The row must be the company we asked for: its number becomes the entity's id.
        const row = records.find((x) => normalizeIeCro(String(x.company_num ?? "")) === number);
        if (!row) throw bad("company");
        return row;
      },
    );
    if (!res.value) return undefined;
    return mapCroEntity(res.value, number, provenance(number, res.fetchedAt, res.fromCache));
  },

  async search(query, ctx, limit = 10): Promise<SearchHit[]> {
    const q = searchTerms(query);
    if (q.length < 2) return [];
    const res = await ctx.cache.getOrFetch<CroRecord[]>(
      `ie:search:${q.toLowerCase()}:${limit}`,
      { ttlSeconds: TTL.search, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const rid = await resourceId(ctx);
        const r = await ctx.http.getJson<CkanResponse<CkanSearch>>(
          `${BASE}/datastore_search?resource_id=${rid}&q=${encodeURIComponent(
            JSON.stringify({ company_name: q }),
          )}&limit=${limit}`,
          { source: SOURCE },
        );
        const records = result(r.body, "search").records;
        if (!Array.isArray(records)) throw bad("search");
        return records;
      },
    );
    const prov = provenance("search", res.fetchedAt, res.fromCache);
    const hits: SearchHit[] = [];
    for (const rec of res.value) {
      const number = normalizeIeCro(String(rec.company_num ?? ""));
      const name = rec.company_name?.trim();
      if (!number || !name) continue;
      hits.push({
        source: SOURCE,
        name,
        identifier: {
          scheme: "IE_CRO",
          value: number,
          country: "IE",
          validated: false,
          provenance: [prov],
        },
        jurisdiction: "IE",
        status: mapCroStatus(rec),
        address: mapCroAddress(rec)?.formatted,
      });
    }
    return hits;
  },
};

/** The datastore resource of the company records, found through the dataset (cached). */
async function resourceId(ctx: AdapterContext): Promise<string> {
  const res = await ctx.cache.getOrFetch<string>(
    `ie:resource`,
    { ttlSeconds: RESOURCE_TTL, source: SOURCE, fresh: ctx.fresh },
    async () => {
      const r = await ctx.http.getJson<CkanResponse<CkanPackage>>(
        `${BASE}/package_show?id=${DATASET}`,
        { source: SOURCE },
      );
      const found = result(r.body, "dataset").resources?.find(
        (x) => x.datastore_active === true && typeof x.id === "string",
      );
      // The id goes into a URL: only a UUID is accepted.
      if (!found?.id || !/^[0-9a-f-]{36}$/.test(found.id)) throw bad("dataset");
      return found.id;
    },
  );
  return res.value;
}
