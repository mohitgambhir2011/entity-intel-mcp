import { SourceError } from "../../core/errors.js";
import { normalizeGbCompanyNumber } from "../../core/identifiers.js";
import { makeStatus } from "../../core/types.js";
import type {
  Address,
  EntityStatus,
  LegalForm,
  NormalizedStatus,
  PartialEntity,
  Provenance,
  SearchHit,
} from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type AdapterContext, type SourceAdapter } from "../types.js";

const BASE = "https://api.company-information.service.gov.uk";
const LICENCE = "Open Government Licence v3.0";

interface ChAddress {
  address_line_1?: string;
  address_line_2?: string;
  premises?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

interface ChCompany {
  company_name: string;
  company_number: string;
  company_status?: string;
  company_status_detail?: string;
  type?: string;
  jurisdiction?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  registered_office_address?: ChAddress;
  previous_company_names?: { name: string; effective_from?: string; ceased_on?: string }[];
}

interface ChSearch {
  items?: {
    title: string;
    company_number: string;
    company_status?: string;
    company_type?: string;
    address_snippet?: string;
  }[];
}

const STATUS_MAP: Record<string, NormalizedStatus> = {
  active: "active",
  open: "active",
  registered: "active",
  dissolved: "dissolved",
  closed: "dissolved",
  liquidation: "in_liquidation",
  administration: "in_administration",
  receivership: "insolvent",
  "voluntary-arrangement": "insolvent",
  "insolvency-proceedings": "insolvent",
  "converted-closed": "merged_or_converted",
  removed: "struck_off",
};

export function mapChStatus(status: string | undefined, detail?: string): EntityStatus {
  const text = [status, detail].filter(Boolean).join(" / ");
  // Companies House reports dormancy through the accounts type, not the status; we only claim
  // what the status field says.
  return makeStatus(STATUS_MAP[status ?? ""] ?? "unknown", text);
}

const LEGAL_FORMS: Record<string, LegalForm["normalized"]> = {
  ltd: "limited_company",
  "private-limited-guarant-nsc": "limited_company",
  "private-limited-guarant-nsc-limited-exemption": "limited_company",
  "private-unlimited": "limited_company",
  "private-unlimited-nsc": "limited_company",
  plc: "public_company",
  llp: "llp",
  "limited-partnership": "partnership",
  "scottish-partnership": "partnership",
  "uk-establishment": "branch",
  "oversea-company": "branch",
  "registered-society-non-jurisdictional": "cooperative",
  "industrial-and-provident-society": "cooperative",
};

function mapAddress(a: ChAddress | undefined): Address | undefined {
  if (!a) return undefined;
  const lines = [a.premises, a.address_line_1, a.address_line_2].filter(
    (l): l is string => typeof l === "string" && l !== "",
  );
  const parts = [...lines, a.locality, a.region, a.postal_code, a.country].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (parts.length === 0) return undefined;
  return {
    lines,
    locality: a.locality,
    region: a.region,
    postalCode: a.postal_code,
    country: "GB",
    formatted: parts.join(", "),
  };
}

function authHeader(key: string): Record<string, string> {
  // Companies House uses HTTP Basic with the API key as the username and an empty password.
  return { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` };
}

export function createCompaniesHouseAdapter(apiKey: string | undefined): SourceAdapter {
  const requireKey = (): string => {
    if (!apiKey) {
      throw new SourceError(
        "Companies House is not configured: set COMPANIES_HOUSE_API_KEY",
        "companies_house",
        "auth",
      );
    }
    return apiKey;
  };

  return {
    id: "companies_house",

    supports: (id) => id.scheme === "GB_CRN",

    async lookup(identifier, ctx: AdapterContext): Promise<PartialEntity | undefined> {
      const number = normalizeGbCompanyNumber(identifier.value);
      if (!number) return undefined;
      const key = requireKey();
      const url = `${BASE}/company/${number}`;

      const res = await ctx.cache.getOrFetch(
        `ch:company:${number}`,
        { ttlSeconds: TTL.registryProfile, source: "companies_house", fresh: ctx.fresh },
        async () => {
          const r = await ctx.http.getJson<ChCompany>(url, {
            source: "companies_house",
            headers: authHeader(key),
            allowStatus: [404],
          });
          if (r.status === 404) return null;
          if (
            typeof r.body?.company_number !== "string" ||
            typeof r.body.company_name !== "string"
          ) {
            throw new SourceError(
              "companies_house returned an unexpected response",
              "companies_house",
              "bad_response",
            );
          }
          return r.body;
        },
      );
      const c = res.value;
      if (!c) return undefined;

      const prov: Provenance = {
        source: "companies_house",
        sourceRecordId: c.company_number,
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
        retrievedAt: iso(res.fetchedAt),
        fromCache: res.fromCache,
        licence: LICENCE,
      };

      const names: PartialEntity["names"] = [
        { name: c.company_name, kind: "legal", provenance: [prov] },
      ];
      for (const p of c.previous_company_names ?? []) {
        names.push({
          name: p.name,
          kind: "former",
          validFrom: p.effective_from,
          validTo: p.ceased_on,
          provenance: [prov],
        });
      }

      const addr = mapAddress(c.registered_office_address);
      return {
        source: "companies_house",
        names,
        identifiers: [
          {
            scheme: "GB_CRN",
            value: c.company_number,
            country: "GB",
            status: "active",
            validated: true,
            provenance: [prov],
          },
        ],
        jurisdiction: "GB",
        legalForm: c.type
          ? {
              value: { localName: c.type, normalized: LEGAL_FORMS[c.type] ?? "other" },
              provenance: [prov],
            }
          : undefined,
        status: {
          value: mapChStatus(c.company_status, c.company_status_detail),
          provenance: [prov],
        },
        incorporationDate: c.date_of_creation
          ? { value: c.date_of_creation, provenance: [prov] }
          : undefined,
        dissolutionDate: c.date_of_cessation
          ? { value: c.date_of_cessation, provenance: [prov] }
          : undefined,
        registeredAddress: addr ? { value: addr, provenance: [prov] } : undefined,
        notes: [],
      };
    },

    async search(query, ctx, limit = 10): Promise<SearchHit[]> {
      const q = query.trim();
      if (q.length < 2) return [];
      const key = requireKey();
      const url = `${BASE}/search/companies?q=${encodeURIComponent(q)}&items_per_page=${limit}`;
      const res = await ctx.cache.getOrFetch(
        `ch:search:${q.toLowerCase()}:${limit}`,
        { ttlSeconds: TTL.search, source: "companies_house", fresh: ctx.fresh },
        async () =>
          (
            await ctx.http.getJson<ChSearch>(url, {
              source: "companies_house",
              headers: authHeader(key),
            })
          ).body,
      );
      const prov: Provenance = {
        source: "companies_house",
        sourceRecordId: "search",
        retrievedAt: iso(res.fetchedAt),
        fromCache: res.fromCache,
        licence: LICENCE,
      };
      return (res.value.items ?? []).map((item) => ({
        source: "companies_house" as const,
        name: item.title,
        identifier: {
          scheme: "GB_CRN" as const,
          value: item.company_number,
          country: "GB",
          validated: true,
          provenance: [prov],
        },
        jurisdiction: "GB",
        status: mapChStatus(item.company_status),
        address: item.address_snippet,
      }));
    },
  };
}
