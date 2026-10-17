import { SourceError } from "../../core/errors.js";
import {
  formatNoOrgnr,
  isValidLei,
  normalizeFiBusinessId,
  normalizeGbCompanyNumber,
  normalizeNoOrgnr,
} from "../../core/identifiers.js";
import { makeStatus } from "../../core/types.js";
import type {
  Address,
  IdentifierScheme,
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

/**
 * Registration authorities whose `registeredAs` value we can turn into a local identifier, and the
 * other way round (to find the LEI of a local number). The formats are what GLEIF actually stores:
 * Norwegian numbers with spaces ("923 609 016"), Finnish ones with the hyphen ("0112038-9").
 */
interface RegistryRule {
  ra: string;
  scheme: IdentifierScheme;
  country: string;
  /** Local number from GLEIF's registeredAs, or undefined if it is not a valid one. */
  parse(registeredAs: string): string | undefined;
  /** The spellings GLEIF may use for a local number, most likely first. */
  spellings(value: string): string[];
}

const REGISTRIES: RegistryRule[] = [
  {
    ra: "RA000585", // Companies House
    scheme: "GB_CRN",
    country: "GB",
    parse: normalizeGbCompanyNumber,
    spellings: (v) => [v],
  },
  {
    ra: "RA000472", // Enhetsregisteret
    scheme: "NO_ORGNR",
    country: "NO",
    parse: normalizeNoOrgnr,
    spellings: (v) => [formatNoOrgnr(v), v],
  },
  {
    ra: "RA000188", // Finnish trade register (PRH)
    scheme: "FI_YTUNNUS",
    country: "FI",
    parse: normalizeFiBusinessId,
    spellings: (v) => [v],
  },
];

const ruleFor = (ra: string | null | undefined): RegistryRule | undefined =>
  REGISTRIES.find((r) => r.ra === ra);

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

/**
 * GLEIF only distinguishes ACTIVE from INACTIVE (and NULL). INACTIVE can mean dissolved or simply
 * no longer operating, so it is not mapped to an "ended" status: we do not over-claim.
 */
export function mapGleifStatus(entityStatus: string | undefined): EntityStatus {
  const text = entityStatus ?? "";
  return makeStatus(text.toUpperCase() === "ACTIVE" ? "active" : "unknown", text);
}

/** A response without a `data` member is an error body, not an empty result: never cache it. */
function checkedBody(body: GleifResponse | null | undefined): GleifResponse {
  if (!body || typeof body !== "object" || body.data === undefined || body.data === null) {
    throw new SourceError("gleif returned an unexpected response", "gleif", "bad_response");
  }
  return body;
}

/** Records that have the fields we rely on; anything malformed is skipped rather than crashing. */
function recordsOf(body: GleifResponse): GleifRecord[] {
  const list = Array.isArray(body.data) ? body.data : [body.data];
  return list.filter(
    (r): r is GleifRecord =>
      typeof r?.attributes?.lei === "string" && typeof r.attributes.entity === "object",
  );
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
  const rule = ruleFor(e.registeredAt?.id);
  const local = rule && e.registeredAs ? rule.parse(e.registeredAs) : undefined;
  if (rule && local) {
    identifiers.push({
      scheme: rule.scheme,
      value: local,
      country: rule.country,
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

/**
 * Reverse crosswalk: find the LEI for a local registration number. GLEIF cannot filter on the
 * registration authority and the number together, so we filter on the number (in each spelling
 * GLEIF may use) and check the authority ourselves.
 */
async function findLeiByRegistration(
  rule: RegistryRule,
  value: string,
  ctx: AdapterContext,
): Promise<string | undefined> {
  // The spellings are asked at the same time: most companies have no LEI, and a miss would
  // otherwise cost one round trip per spelling.
  const attempts = await Promise.allSettled(
    rule.spellings(value).map(async (spelling) => {
      const url = `${BASE}/lei-records?filter[entity.registeredAs]=${encodeURIComponent(spelling)}&page[size]=5`;
      const res = await ctx.cache.getOrFetch(
        `gleif:byreg:${rule.scheme}:${spelling}`,
        { ttlSeconds: TTL.gleif, source: "gleif", fresh: ctx.fresh },
        async () =>
          checkedBody(
            (await ctx.http.getJson<GleifResponse>(url, { source: "gleif", headers: HEADERS }))
              .body,
          ),
      );
      return recordsOf(res.value).find((r) => {
        const e = r.attributes.entity;
        return (
          e.registeredAt?.id === rule.ra && e.registeredAs && rule.parse(e.registeredAs) === value
        );
      });
    }),
  );
  for (const a of attempts) {
    if (a.status === "fulfilled" && a.value) return a.value.attributes.lei;
  }
  // No spelling matched. If one of them failed, "no LEI" is not a safe conclusion: surface it.
  const failed = attempts.find((a) => a.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return undefined;
}

export const gleifAdapter: SourceAdapter = {
  id: "gleif",

  supports: (id) => id.scheme === "LEI",

  crosswalks: REGISTRIES.map((rule) => ({
    from: rule.scheme,
    to: "LEI" as const,
    async find(identifier: Identifier, ctx: AdapterContext) {
      const lei = await findLeiByRegistration(rule, identifier.value, ctx);
      return lei
        ? { scheme: "LEI" as const, value: lei, validated: true, provenance: [] }
        : undefined;
    },
  })),

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
        return r.status === 404 ? null : checkedBody(r.body);
      },
    );
    if (!res.value) return undefined;
    const rec = recordsOf(res.value)[0];
    if (!rec) throw new SourceError("gleif returned an empty record", "gleif", "bad_response");
    return mapRecord(rec, {
      source: "gleif",
      sourceRecordId: rec.attributes.lei,
      sourceUrl: url,
      retrievedAt: iso(res.fetchedAt),
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
        checkedBody(
          (await ctx.http.getJson<GleifResponse>(url, { source: "gleif", headers: HEADERS })).body,
        ),
    );
    const records = recordsOf(res.value);
    const prov: Provenance = {
      source: "gleif",
      sourceRecordId: "search",
      retrievedAt: iso(res.fetchedAt),
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
