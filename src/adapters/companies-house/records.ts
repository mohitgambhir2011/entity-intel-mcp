import { SourceError } from "../../core/errors.js";
import type {
  Charge,
  ChargesResult,
  FilingItem,
  FilingsResult,
  InsolvencyCase,
  InsolvencyResult,
} from "../../core/records.js";
import { TTL } from "../../infra/cache.js";
import type { AdapterContext, FilingsQuery } from "../types.js";
import { BASE, provenance, type Cached } from "./shared.js";

const SOURCE = "companies_house";
const PAGE_SIZE = 100;
/** Charges are fetched up to this many pages; more is flagged as truncated. */
const MAX_PAGES = 5;
/** Long particulars are cut: they can run to pages. */
const MAX_PARTICULARS = 300;
const DOCUMENT_HOST = "https://document-api.company-information.service.gov.uk/";

// ---------------------------------------------------------------- raw shapes (only what we read)

interface ChFiling {
  transaction_id?: string;
  date?: string;
  category?: string;
  type?: string;
  description?: string;
  action_date?: string;
  paper_filed?: boolean;
  pages?: number;
  links?: { document_metadata?: string };
}

interface ChFilingList {
  items?: ChFiling[];
  total_count?: number;
}

interface ChCharge {
  charge_number?: number;
  status?: string;
  created_on?: string;
  delivered_on?: string;
  satisfied_on?: string;
  classification?: { description?: string };
  particulars?: { description?: string };
  persons_entitled?: { name?: string }[];
}

interface ChChargeList {
  items?: ChCharge[];
  total_count?: number;
  unfiltered_count?: number;
  satisfied_count?: number;
  part_satisfied_count?: number;
}

interface ChInsolvency {
  cases?: {
    number?: number | string;
    type?: string;
    dates?: { type?: string; date?: string }[];
    practitioners?: {
      name?: string;
      role?: string;
      appointed_on?: string;
      ceased_to_act_on?: string;
    }[];
  }[];
  status?: string[];
}

// ---------------------------------------------------------------- mapping

export function mapFiling(f: ChFiling): FilingItem | undefined {
  if (!f.transaction_id || !f.date) return undefined;
  const link = f.links?.document_metadata;
  return {
    transactionId: f.transaction_id,
    date: f.date,
    category: f.category ?? "unknown",
    type: f.type ?? "unknown",
    description: f.description ?? "",
    actionDate: f.action_date,
    paperFiled: f.paper_filed === true,
    pages: typeof f.pages === "number" ? f.pages : undefined,
    // Only the registry's own document API is passed on, never an arbitrary link.
    documentUrl: typeof link === "string" && link.startsWith(DOCUMENT_HOST) ? link : undefined,
  };
}

export function mapCharge(c: ChCharge): Charge {
  const particulars = c.particulars?.description;
  return {
    number: c.charge_number,
    status: c.status ?? "unknown",
    createdOn: c.created_on,
    deliveredOn: c.delivered_on,
    satisfiedOn: c.satisfied_on,
    classification: c.classification?.description,
    particulars:
      particulars && particulars.length > MAX_PARTICULARS
        ? `${particulars.slice(0, MAX_PARTICULARS)}...`
        : particulars,
    personsEntitled: (c.persons_entitled ?? [])
      .map((p) => p.name)
      .filter((n): n is string => typeof n === "string" && n !== ""),
  };
}

export function mapInsolvencyCase(c: NonNullable<ChInsolvency["cases"]>[number]): InsolvencyCase {
  return {
    // The register sends the case number as a string, older records as a number.
    number: c.number === undefined ? undefined : String(c.number),
    type: c.type ?? "unknown",
    dates: (c.dates ?? [])
      .filter((d) => d.date)
      .map((d) => ({ type: d.type ?? "unknown", date: d.date! })),
    practitioners: (c.practitioners ?? [])
      .filter((p) => p.name)
      .map((p) => ({
        name: p.name!,
        role: p.role,
        appointedOn: p.appointed_on,
        ceasedToActOn: p.ceased_to_act_on,
      })),
  };
}

// ---------------------------------------------------------------- fetching

export async function fetchFilings(
  ctx: AdapterContext,
  headers: Record<string, string>,
  number: string,
  q: FilingsQuery,
): Promise<FilingsResult | undefined> {
  const limit = Math.min(Math.max(q.limit, 1), PAGE_SIZE);
  const offset = Math.max(q.offset, 0);
  const category = q.category?.trim() || undefined;
  const res = await ctx.cache.getOrFetch(
    `ch:filings:${number}:${category ?? "*"}:${limit}:${offset}`,
    { ttlSeconds: TTL.registryProfile, source: SOURCE, fresh: ctx.fresh },
    async (): Promise<Cached<FilingsResult> | null> => {
      const cat = category ? `&category=${encodeURIComponent(category)}` : "";
      const r = await ctx.http.getJson<ChFilingList>(
        `${BASE}/company/${number}/filing-history?items_per_page=${limit}&start_index=${offset}${cat}`,
        { source: SOURCE, headers, allowStatus: [404] },
      );
      if (r.status === 404) return null;
      if (!r.body || !Array.isArray(r.body.items)) {
        throw new SourceError(
          `${SOURCE} returned an unexpected filing history response`,
          SOURCE,
          "bad_response",
        );
      }
      const items = r.body.items.map(mapFiling).filter((i): i is FilingItem => i !== undefined);
      const count = r.body.total_count;
      return { items, total: typeof count === "number" ? count : items.length, offset };
    },
  );
  return res.value
    ? {
        ...res.value,
        provenance: provenance(number, "filing-history", res.fetchedAt, res.fromCache),
      }
    : undefined;
}

export async function fetchCharges(
  ctx: AdapterContext,
  headers: Record<string, string>,
  number: string,
): Promise<ChargesResult | undefined> {
  const res = await ctx.cache.getOrFetch(
    `ch:charges:${number}`,
    // Persons entitled can be individuals (private lenders): cached as personal data.
    { ttlSeconds: TTL.registryProfile, source: SOURCE, personal: true, fresh: ctx.fresh },
    async (): Promise<Cached<ChargesResult> | null> => {
      const items: ChCharge[] = [];
      let total = 0;
      let satisfied = 0;
      let part = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await ctx.http.getJson<ChChargeList>(
          `${BASE}/company/${number}/charges?items_per_page=${PAGE_SIZE}&start_index=${page * PAGE_SIZE}`,
          { source: SOURCE, headers, allowStatus: [404] },
        );
        if (r.status === 404) {
          // Companies without charges answer 200 with an empty list, so a 404 is not "none":
          // it is reported as an unknown record rather than as a negative fact (D28).
          if (page === 0) return null;
          break;
        }
        if (!r.body || !Array.isArray(r.body.items)) {
          throw new SourceError(
            `${SOURCE} returned an unexpected charges response`,
            SOURCE,
            "bad_response",
          );
        }
        items.push(...r.body.items);
        total = Math.max(total, r.body.unfiltered_count ?? r.body.total_count ?? 0);
        satisfied = r.body.satisfied_count ?? satisfied;
        part = r.body.part_satisfied_count ?? part;
        if (items.length >= total || r.body.items.length === 0) break;
      }
      total ||= items.length;
      return {
        charges: items.map(mapCharge),
        total,
        // A part-satisfied charge still secures something: it counts as outstanding.
        outstanding: Math.max(0, total - satisfied),
        satisfied,
        partSatisfied: part,
        truncated: items.length < total,
      };
    },
  );
  return res.value
    ? { ...res.value, provenance: provenance(number, "charges", res.fetchedAt, res.fromCache) }
    : undefined;
}

export async function fetchInsolvency(
  ctx: AdapterContext,
  headers: Record<string, string>,
  number: string,
): Promise<InsolvencyResult> {
  const res = await ctx.cache.getOrFetch<Cached<InsolvencyResult>>(
    `ch:insolvency:${number}`,
    // Practitioners are named individuals: cached as personal data.
    { ttlSeconds: TTL.registryProfile, source: SOURCE, personal: true, fresh: ctx.fresh },
    async (): Promise<Cached<InsolvencyResult>> => {
      const r = await ctx.http.getJson<ChInsolvency>(`${BASE}/company/${number}/insolvency`, {
        source: SOURCE,
        headers,
        allowStatus: [404],
      });
      // Companies House answers 404 for a company that has no insolvency record.
      if (r.status === 404) return { cases: [], statusFlags: [] };
      if (!r.body || typeof r.body !== "object" || !Array.isArray(r.body.cases ?? [])) {
        throw new SourceError(
          `${SOURCE} returned an unexpected insolvency response`,
          SOURCE,
          "bad_response",
        );
      }
      return {
        cases: (r.body.cases ?? []).map(mapInsolvencyCase),
        statusFlags: (r.body.status ?? []).filter((s): s is string => typeof s === "string"),
      };
    },
  );
  return {
    ...res.value,
    provenance: provenance(number, "insolvency", res.fetchedAt, res.fromCache),
  };
}
