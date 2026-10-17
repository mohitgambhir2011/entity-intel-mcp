import { SourceError } from "../../core/errors.js";
import { isValidLei } from "../../core/identifiers.js";
import { makeStatus } from "../../core/types.js";
import type {
  Address,
  EntityStatus,
  Identifier,
  PartialEntity,
  Provenance,
  SearchHit,
} from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type AdapterContext, type SourceAdapter } from "../types.js";

const BASE = "https://api.gleif.org/api/v1";
const HEADERS = { accept: "application/vnd.api+json" };

/** Registration authority codes whose `registeredAs` value we can turn into a local identifier. */
const RA_GB_COMPANIES_HOUSE = "RA000585";

interface GleifAddress {
  addressLines?: string[] | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  postalCode?: string | null;
}

interface GleifRecord {
  id?: string;
  attributes: {
    lei: string;
    entity: {
      legalName?: { name?: string };
      legalAddress?: GleifAddress;
      headquartersAddress?: GleifAddress;
      jurisdiction?: string | null;
      legalForm?: { id?: string | null; other?: string | null };
      registeredAt?: { id?: string | null };
      registeredAs?: string | null;
      status?: string;
      creationDate?: string | null;
      otherNames?: { name: string; type?: string }[];
    };
    registration?: { status?: string; nextRenewalDate?: string | null };
  };
}

interface GleifResponse {
  data: GleifRecord | GleifRecord[];
}

export function mapGleifStatus(entityStatus: string | undefined): EntityStatus {
  const text = entityStatus ?? "";
  switch (text.toUpperCase()) {
    case "ACTIVE":
      return makeStatus("active", text);
    case "INACTIVE":
      // GLEIF "INACTIVE" can mean dissolved or simply not operating; do not over-claim.
      return makeStatus("unknown", text);
    case "NULL":
    case "":
      return makeStatus("unknown", text);
    default:
      return makeStatus("unknown", text);
  }
}

function mapAddress(a: GleifAddress | undefined): Address | undefined {
  if (!a) return undefined;
  const lines = (a.addressLines ?? []).filter(Boolean);
  const parts = [...lines, a.city, a.postalCode, a.country].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (parts.length === 0) return undefined;
  return {
    lines,
    locality: a.city ?? undefined,
    region: a.region ?? undefined,
    postalCode: a.postalCode ?? undefined,
    country: a.country ?? undefined,
    formatted: parts.join(", "),
  };
}

function mapRecord(rec: GleifRecord, prov: Provenance): PartialEntity {
  const { attributes: a } = rec;
  const e = a.entity;
  const identifiers: Identifier[] = [
    {
      scheme: "LEI",
      value: a.lei,
      country: e.jurisdiction ?? undefined,
      status: mapLeiStatus(a.registration?.status),
      validated: isValidLei(a.lei),
      provenance: [prov],
    },
  ];
  if (e.registeredAt?.id === RA_GB_COMPANIES_HOUSE && e.registeredAs) {
    identifiers.push({
      scheme: "GB_CRN",
      value: e.registeredAs,
      country: "GB",
      validated: false,
      provenance: [prov],
    });
  }

  const names: PartialEntity["names"] = [];
  if (e.legalName?.name) names.push({ name: e.legalName.name, kind: "legal", provenance: [prov] });
  for (const o of e.otherNames ?? []) {
    names.push({ name: o.name, kind: "other", provenance: [prov] });
  }

  const notes: string[] = [];
  if (a.registration?.status && a.registration.status !== "ISSUED") {
    notes.push(`LEI registration status is ${a.registration.status}`);
  }

  const legal = mapAddress(e.legalAddress);
  const hq = mapAddress(e.headquartersAddress);
  return {
    source: "gleif",
    names,
    identifiers,
    jurisdiction: e.jurisdiction ?? undefined,
    legalForm: e.legalForm?.id
      ? {
          value: { code: e.legalForm.id, localName: e.legalForm.other ?? e.legalForm.id },
          provenance: [prov],
        }
      : undefined,
    status: { value: mapGleifStatus(e.status), provenance: [prov] },
    incorporationDate: e.creationDate
      ? { value: e.creationDate.slice(0, 10), provenance: [prov] }
      : undefined,
    registeredAddress: legal ? { value: legal, provenance: [prov] } : undefined,
    headquartersAddress: hq ? { value: hq, provenance: [prov] } : undefined,
    notes,
  };
}

function mapLeiStatus(s: string | undefined): Identifier["status"] {
  switch (s) {
    case "ISSUED":
      return "active";
    case "LAPSED":
      return "lapsed";
    case "RETIRED":
    case "MERGED":
    case "ANNULLED":
      return "retired";
    default:
      return "unknown";
  }
}

export const gleifAdapter: SourceAdapter = {
  id: "gleif",

  supports: (id) => id.scheme === "LEI",

  async lookup(identifier, ctx) {
    const lei = identifier.value.toUpperCase();
    if (!isValidLei(lei)) return undefined;
    const url = `${BASE}/lei-records/${lei}`;
    const res = await ctx.cache.getOrFetch(
      `gleif:lei:${lei}`,
      { ttlSeconds: TTL.gleif, source: "gleif", fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<GleifResponse>(url, {
          source: "gleif",
          headers: HEADERS,
          allowStatus: [404],
        });
        return r.status === 404 ? null : r.body;
      },
    );
    if (!res.value) return undefined;
    const rec = Array.isArray(res.value.data) ? res.value.data[0] : res.value.data;
    if (!rec) throw new SourceError("gleif returned an empty record", "gleif", "bad_response");
    return mapRecord(rec, {
      source: "gleif",
      sourceRecordId: rec.attributes.lei,
      sourceUrl: url,
      retrievedAt: iso(ctx, res.fetchedAt),
      fromCache: res.fromCache,
    });
  },

  async search(query, ctx: AdapterContext, limit = 10): Promise<SearchHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const url = `${BASE}/lei-records?filter[entity.legalName]=${encodeURIComponent(q)}&page[size]=${limit}`;
    const res = await ctx.cache.getOrFetch(
      `gleif:search:${q.toLowerCase()}:${limit}`,
      { ttlSeconds: TTL.search, source: "gleif", fresh: ctx.fresh },
      async () =>
        (await ctx.http.getJson<GleifResponse>(url, { source: "gleif", headers: HEADERS })).body,
    );
    const records = Array.isArray(res.value.data) ? res.value.data : [res.value.data];
    const prov: Provenance = {
      source: "gleif",
      sourceRecordId: "search",
      retrievedAt: iso(ctx, res.fetchedAt),
      fromCache: res.fromCache,
    };
    return records.map((rec) => {
      const e = rec.attributes.entity;
      const addr = mapAddress(e.legalAddress);
      return {
        source: "gleif" as const,
        name: e.legalName?.name ?? "(unnamed)",
        identifier: {
          scheme: "LEI" as const,
          value: rec.attributes.lei,
          country: e.jurisdiction ?? undefined,
          status: mapLeiStatus(rec.attributes.registration?.status),
          validated: isValidLei(rec.attributes.lei),
          provenance: [prov],
        },
        jurisdiction: e.jurisdiction ?? undefined,
        status: mapGleifStatus(e.status),
        address: addr?.formatted,
      };
    });
  },
};
