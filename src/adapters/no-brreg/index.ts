import { SourceError } from "../../core/errors.js";
import { normalizeNoOrgnr } from "../../core/identifiers.js";
import type { OfficersResult } from "../../core/people.js";
import type { Provenance, SearchHit } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type SourceAdapter } from "../types.js";
import {
  BASE,
  LICENCE,
  mapNoAddress,
  mapNoEntity,
  mapNoRoles,
  mapNoStatus,
  type BrEntity,
  type BrRoles,
} from "./map.js";

const SOURCE = "brreg_no";
const searchUrl = (q: string, limit: number): string =>
  `${BASE}/enheter?navn=${encodeURIComponent(q)}&size=${limit}`;

interface BrSearch {
  _embedded?: { enheter?: BrEntity[] };
}

function provenance(
  orgnr: string,
  path: string,
  fetchedAt: number,
  fromCache: boolean,
): Provenance {
  return {
    source: SOURCE,
    sourceRecordId: orgnr,
    sourceUrl: `${BASE}/enheter/${orgnr}${path}`,
    retrievedAt: iso(fetchedAt),
    fromCache,
    licence: LICENCE,
  };
}

/**
 * Norway: Enhetsregisteret (Bronnoysund Register Centre). Free, no key. Identity, name search and
 * roles (board, CEO, auditor, signatories). Beneficial owners are not public in Norway.
 */
export const norwayAdapter: SourceAdapter = {
  id: SOURCE,
  country: "NO",

  supports: (id) => id.scheme === "NO_ORGNR",

  restrictions: {
    controllers: {
      reason: "restricted_access",
      detail:
        "Norway does not publish beneficial owners openly (access is limited to those with a " +
        "legitimate interest), so ownership can not be traced for Norwegian companies",
    },
  },

  async lookup(identifier, ctx) {
    const orgnr = normalizeNoOrgnr(identifier.value);
    if (!orgnr) return undefined;
    const res = await ctx.cache.getOrFetch<BrEntity | null>(
      `no:enhet:${orgnr}`,
      { ttlSeconds: TTL.registryProfile, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<BrEntity>(`${BASE}/enheter/${orgnr}`, {
          source: SOURCE,
          allowStatus: [404, 410],
        });
        if (r.status === 404) return null;
        // 410 Gone: the unit was deleted from the register (the body, if any, may still name it).
        // Not observed live yet (UNVERIFIED), so it is handled without trusting the body.
        if (r.status === 410) {
          return { ...(r.body ?? {}), organisasjonsnummer: orgnr, deleted: true };
        }
        // The answer must be about the unit we asked for: its number becomes the entity's id.
        const returned =
          typeof r.body?.organisasjonsnummer === "string"
            ? normalizeNoOrgnr(r.body.organisasjonsnummer)
            : undefined;
        if (!r.body || returned !== orgnr) {
          throw new SourceError(
            `${SOURCE} returned an unexpected response`,
            SOURCE,
            "bad_response",
          );
        }
        return r.body;
      },
    );
    if (!res.value) return undefined;
    return mapNoEntity(res.value, provenance(orgnr, "", res.fetchedAt, res.fromCache));
  },

  async search(query, ctx, limit = 10): Promise<SearchHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const res = await ctx.cache.getOrFetch<BrSearch>(
      `no:search:${q.toLowerCase()}:${limit}`,
      { ttlSeconds: TTL.search, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<BrSearch>(searchUrl(q, limit), { source: SOURCE });
        // An empty result has no _embedded member; an error body has neither it nor a page.
        if (!r.body || typeof r.body !== "object" || (!r.body._embedded && !("page" in r.body))) {
          throw new SourceError(
            `${SOURCE} returned an unexpected response`,
            SOURCE,
            "bad_response",
          );
        }
        return r.body;
      },
    );
    const prov = provenance("search", "", res.fetchedAt, res.fromCache);
    const hits: SearchHit[] = [];
    for (const e of res.value._embedded?.enheter ?? []) {
      const orgnr = e.organisasjonsnummer ? normalizeNoOrgnr(e.organisasjonsnummer) : undefined;
      if (!orgnr || !e.navn) continue;
      hits.push({
        source: SOURCE,
        name: e.navn,
        identifier: {
          scheme: "NO_ORGNR",
          value: orgnr,
          country: "NO",
          validated: true,
          provenance: [prov],
        },
        jurisdiction: "NO",
        status: mapNoStatus(e),
        address: mapNoAddress(e.forretningsadresse ?? e.postadresse)?.formatted,
      });
    }
    return hits;
  },

  async officers(identifier, ctx): Promise<OfficersResult | undefined> {
    const orgnr = normalizeNoOrgnr(identifier.value);
    if (!orgnr) return undefined;
    const res = await ctx.cache.getOrFetch<BrRoles | null>(
      `no:roller:${orgnr}`,
      { ttlSeconds: TTL.registryProfile, source: SOURCE, personal: true, fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<BrRoles>(`${BASE}/enheter/${orgnr}/roller`, {
          source: SOURCE,
          allowStatus: [404, 410],
        });
        if (r.status === 404 || r.status === 410) return null;
        if (!r.body || !Array.isArray(r.body.rollegrupper)) {
          throw new SourceError(
            `${SOURCE} returned an unexpected roles response`,
            SOURCE,
            "bad_response",
          );
        }
        return r.body;
      },
    );
    if (!res.value) return undefined;
    const { officers, unreadable } = mapNoRoles(res.value);
    const active = officers.filter((o) => o.active).length;
    return {
      officers,
      // Roles we could not read still count: the list is then flagged incomplete, never "all".
      total: officers.length + unreadable,
      activeCount: active,
      resignedCount: officers.length - active,
      truncated: unreadable > 0,
      provenance: provenance(orgnr, "/roller", res.fetchedAt, res.fromCache),
    };
  },
};
