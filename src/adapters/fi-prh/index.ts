import { SourceError } from "../../core/errors.js";
import {
  finnishVatFromBusinessId,
  normalizeFiBusinessId,
  parseVat,
} from "../../core/identifiers.js";
import type { Identifier, Provenance, SearchHit } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type SourceAdapter } from "../types.js";
import {
  BASE,
  LICENCE,
  mapFiAddress,
  mapFiEntity,
  mapFiNames,
  mapFiStatus,
  type PrhCompany,
  type PrhResponse,
} from "./map.js";

const SOURCE = "prh_fi";

function provenance(id: string, fetchedAt: number, fromCache: boolean): Provenance {
  return {
    source: SOURCE,
    sourceRecordId: id,
    sourceUrl: `${BASE}/companies?businessId=${id}`,
    retrievedAt: iso(fetchedAt),
    fromCache,
    licence: LICENCE,
  };
}

/** The company's canonical business ID, or undefined if the record carries none we can read. */
const idOf = (c: PrhCompany): string | undefined =>
  c.businessId?.value ? normalizeFiBusinessId(c.businessId.value) : undefined;

/** PRH answers 200 with `companies: []` for anything it does not know, so shape is the only check. */
function checked(body: PrhResponse | null | undefined): PrhResponse {
  if (!body || typeof body !== "object" || !Array.isArray(body.companies)) {
    throw new SourceError(`${SOURCE} returned an unexpected response`, SOURCE, "bad_response");
  }
  return body;
}

/**
 * Finland: PRH / YTJ open data v3 (Finnish Patent and Registration Office). Free, no key. Identity
 * and name search. The open API publishes no board members or beneficial owners.
 */
export const finlandAdapter: SourceAdapter = {
  id: SOURCE,
  country: "FI",

  supports: (id) => id.scheme === "FI_YTUNNUS",

  restrictions: {
    officers: {
      reason: "not_published_by_source",
      detail:
        "The PRH open data API does not include board members or other officers (they are in " +
        "the trade register extract, which is not open data)",
    },
    controllers: {
      reason: "restricted_access",
      detail:
        "Finland's beneficial-owner register is not open to the public, so ownership can not " +
        "be traced for Finnish companies",
    },
  },

  crosswalks: [
    {
      // A Finnish VAT number is "FI" + the business ID without its hyphen: no lookup needed.
      from: "VAT",
      to: "FI_YTUNNUS",
      async find(identifier): Promise<Identifier | undefined> {
        const vat = parseVat(identifier.value);
        const id = vat?.country === "FI" ? normalizeFiBusinessId(vat.number) : undefined;
        return id
          ? { scheme: "FI_YTUNNUS", value: id, country: "FI", validated: true, provenance: [] }
          : undefined;
      },
    },
    {
      from: "FI_YTUNNUS",
      to: "VAT",
      async find(identifier): Promise<Identifier | undefined> {
        const id = normalizeFiBusinessId(identifier.value);
        return id
          ? {
              scheme: "VAT",
              value: finnishVatFromBusinessId(id),
              country: "FI",
              validated: false,
              provenance: [],
            }
          : undefined;
      },
    },
  ],

  async lookup(identifier, ctx) {
    const id = normalizeFiBusinessId(identifier.value);
    if (!id) return undefined;
    const res = await ctx.cache.getOrFetch<PrhResponse>(
      `fi:company:${id}`,
      { ttlSeconds: TTL.registryProfile, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<PrhResponse>(
          `${BASE}/companies?businessId=${encodeURIComponent(id)}`,
          { source: SOURCE },
        );
        const body = checked(r.body);
        // An empty list means "not found"; a list without the company we asked for is a wrong
        // answer, not a negative one, and its business ID would become the entity's id.
        if (body.companies!.length > 0 && !body.companies!.some((c) => idOf(c) === id)) {
          throw new SourceError(`${SOURCE} returned an unexpected company`, SOURCE, "bad_response");
        }
        return body;
      },
    );
    const company = res.value.companies?.find((c) => idOf(c) === id);
    if (!company) return undefined;
    return mapFiEntity(company, provenance(id, res.fetchedAt, res.fromCache));
  },

  async search(query, ctx, limit = 10): Promise<SearchHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const res = await ctx.cache.getOrFetch<PrhResponse>(
      `fi:search:${q.toLowerCase()}:${limit}`,
      { ttlSeconds: TTL.search, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<PrhResponse>(
          `${BASE}/companies?name=${encodeURIComponent(q)}&maxResults=${limit}`,
          { source: SOURCE },
        );
        return checked(r.body);
      },
    );
    const prov = provenance("search", res.fetchedAt, res.fromCache);
    const hits: SearchHit[] = [];
    for (const c of res.value.companies ?? []) {
      const id = idOf(c);
      const name = mapFiNames(c, prov).find((n) => n.kind === "legal")?.name;
      if (!id || !name) continue;
      hits.push({
        source: SOURCE,
        name,
        identifier: {
          scheme: "FI_YTUNNUS",
          value: id,
          country: "FI",
          validated: true,
          provenance: [prov],
        },
        jurisdiction: "FI",
        status: mapFiStatus(c),
        address: mapFiAddress(c)?.formatted,
      });
    }
    return hits;
  },
};
