import { SourceError } from "../../core/errors.js";
import { normalizeFrn } from "../../core/identifiers.js";
import type { RegulatoryResult } from "../../core/regulatory.js";
import type { PartialEntity, Provenance } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type AdapterContext, type RegulatoryQuery, type SourceAdapter } from "../types.js";
import {
  BASE,
  LICENCE,
  crnOf,
  isoDate,
  mapPermissions,
  mapRegulators,
  mapRequirements,
  outcomeOf,
  type FcaEnvelope,
  type FcaFirm,
  type FcaSearchHit,
} from "./map.js";

const SOURCE = "fca";
/** The register pages its lists (20 permissions per page); this many pages are read. */
const MAX_PAGES = 5;
/** Name search candidates examined when looking for a firm by its Companies House number. */
const MAX_CANDIDATES = 5;
const MAX_NAMES = 3;

type Cached<T> = Omit<T, "provenance" | "matchedBy">;

function provenance(frn: string, fetchedAt: number, fromCache: boolean): Provenance {
  return {
    source: SOURCE,
    sourceRecordId: frn,
    sourceUrl: `https://register.fca.org.uk/s/firm?id=${frn}`,
    retrievedAt: iso(fetchedAt),
    fromCache,
    licence: LICENCE,
  };
}

/**
 * The FCA Financial Services Register (regulatory status of UK firms). Needs a free account
 * (FCA_AUTH_EMAIL, FCA_AUTH_KEY). The register cannot be searched by Companies House number, so a
 * company is found by name and accepted only when the firm's own record carries the same
 * Companies House number.
 */
export function createFcaAdapter(
  email: string | undefined,
  key: string | undefined,
): SourceAdapter {
  const headers = (): Record<string, string> => {
    if (!email || !key) {
      throw new SourceError(
        "The FCA Register is not configured: set FCA_AUTH_EMAIL and FCA_AUTH_KEY",
        SOURCE,
        "auth",
      );
    }
    return { "X-Auth-Email": email, "X-Auth-Key": key, "Content-Type": "application/json" };
  };

  /** One call; the envelope is checked here so a caller only sees an answer or "nothing found". */
  async function call<T>(
    path: string,
    ctx: AdapterContext,
  ): Promise<{ found: boolean; env: FcaEnvelope<T> }> {
    const r = await ctx.http.getJson<FcaEnvelope<T>>(`${BASE}${path}`, {
      source: SOURCE,
      headers: headers(),
    });
    const outcome = outcomeOf(r.body);
    if (outcome === "error") {
      throw new SourceError(`${SOURCE} returned an unexpected response`, SOURCE, "bad_response");
    }
    return { found: outcome === "ok", env: r.body };
  }

  /** All pages of a list endpoint (each page's `Data` as returned), up to MAX_PAGES. */
  async function pages<T>(
    path: string,
    ctx: AdapterContext,
  ): Promise<{ data: T[]; total: number; truncated: boolean }> {
    const data: T[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { found, env } = await call<T>(page === 1 ? path : `${path}?pgnp=${page}`, ctx);
      if (!found || env.Data == null) break;
      data.push(env.Data);
      const count = Number(env.ResultInfo?.total_count);
      if (Number.isFinite(count)) total = count;
      if (!env.ResultInfo?.Next) return { data, total, truncated: false };
    }
    return { data, total, truncated: true };
  }

  async function firmRecord(frn: string, ctx: AdapterContext) {
    return ctx.cache.getOrFetch<FcaFirm | null>(
      `fca:firm:${frn}`,
      { ttlSeconds: TTL.registryProfile, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const { found, env } = await call<FcaFirm[]>(`/Firm/${frn}`, ctx);
        const firm = found && Array.isArray(env.Data) ? env.Data[0] : undefined;
        if (!found) return null;
        // The record must be the firm we asked for: its number becomes the entity's identifier.
        if (!firm || normalizeFrn(String(firm.FRN ?? "")) !== frn) {
          throw new SourceError(`${SOURCE} returned an unexpected firm`, SOURCE, "bad_response");
        }
        return firm;
      },
    );
  }

  async function searchFirms(q: string, ctx: AdapterContext) {
    return ctx.cache.getOrFetch<FcaSearchHit[]>(
      `fca:search:${q.toLowerCase()}`,
      { ttlSeconds: TTL.search, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const { found, env } = await call<FcaSearchHit[]>(
          `/Search?q=${encodeURIComponent(q)}&type=firm`,
          ctx,
        );
        return found && Array.isArray(env.Data) ? env.Data : [];
      },
    );
  }

  /** The firm whose own record states this Companies House number, found by name. */
  async function findByCrn(
    crn: string,
    names: string[],
    ctx: AdapterContext,
  ): Promise<string | undefined> {
    const tried = new Set<string>();
    for (const name of names) {
      const q = name.trim();
      if (q.length < 2 || tried.has(q.toLowerCase()) || tried.size >= MAX_NAMES) continue;
      tried.add(q.toLowerCase());
      const hits = (await searchFirms(q, ctx)).value.filter(
        (h) => h["Type of business or Individual"] === "Firm",
      );
      // A current authorisation beats a lapsed one that carries the same company number.
      const ranked = [...hits].sort(
        (a, b) => Number(b.Status === "Authorised") - Number(a.Status === "Authorised"),
      );
      const candidates = ranked
        .slice(0, MAX_CANDIDATES)
        .map((h) => normalizeFrn(String(h["Reference Number"] ?? "")))
        .filter((f): f is string => f !== undefined);
      const firms = await Promise.all(candidates.map((f) => firmRecord(f, ctx)));
      const at = firms.findIndex((r) => r.value && crnOf(r.value) === crn);
      if (at >= 0) return candidates[at];
    }
    return undefined;
  }

  async function assemble(frn: string, ctx: AdapterContext) {
    return ctx.cache.getOrFetch<Cached<RegulatoryResult> | null>(
      `fca:regulatory:${frn}`,
      { ttlSeconds: TTL.registryProfile, source: SOURCE, fresh: ctx.fresh },
      async () => {
        const firm = (await firmRecord(frn, ctx)).value;
        if (!firm) return null;
        // The firm record's own status field only says "See full details": the authorisation
        // status is in the search result.
        const hit = (await searchFirms(frn, ctx)).value.find(
          (h) => normalizeFrn(String(h["Reference Number"] ?? "")) === frn,
        );
        if (!hit?.Status) {
          throw new SourceError(
            `${SOURCE} returned no status for the firm`,
            SOURCE,
            "bad_response",
          );
        }
        const [perms, regs, reqs] = await Promise.all([
          pages<Record<string, unknown>>(`/Firm/${frn}/Permissions`, ctx),
          pages<unknown[]>(`/Firm/${frn}/Regulators`, ctx),
          pages<unknown[]>(`/Firm/${frn}/Requirements`, ctx),
        ]);
        const permissions = perms.data.flatMap((d) => mapPermissions(d));
        const mapped = reqs.data.map((d) => mapRequirements(d));
        const requirements = mapped.flatMap((m) => m.items);
        const unreadable = mapped.reduce((n, m) => n + m.unreadable, 0);
        return {
          frn,
          name: firm["Organisation Name"] ?? "",
          status: hit.Status,
          statusEffectiveFrom: isoDate(firm["Status Effective Date"]),
          businessType: firm["Business Type"] || undefined,
          clientMoneyPermission: firm["Client Money Permission"] || undefined,
          mlrsStatus: firm["MLRs Status"] || undefined,
          regulators: regs.data.flatMap((d) => mapRegulators(d)),
          permissions,
          permissionsTotal: perms.total || permissions.length,
          requirements,
          requirementsTotal: reqs.total || requirements.length,
          truncated: perms.truncated || reqs.truncated || regs.truncated || unreadable > 0,
        };
      },
    );
  }

  return {
    id: SOURCE,
    country: "GB",

    supports: (id) => id.scheme === "FCA_FRN",

    covers: (capability, id) =>
      capability === "regulatory" && (id.scheme === "FCA_FRN" || id.scheme === "GB_CRN"),

    async lookup(identifier, ctx): Promise<PartialEntity | undefined> {
      const frn = normalizeFrn(identifier.value);
      if (!frn) return undefined;
      const res = await firmRecord(frn, ctx);
      const firm = res.value;
      const name = firm?.["Organisation Name"]?.trim();
      if (!firm || !name) return undefined;
      const prov = provenance(frn, res.fetchedAt, res.fromCache);
      const crn = crnOf(firm);
      return {
        source: SOURCE,
        names: [{ name, kind: "legal", provenance: [prov] }],
        identifiers: [
          { scheme: "FCA_FRN", value: frn, country: "GB", validated: true, provenance: [prov] },
          ...(crn
            ? [
                {
                  scheme: "GB_CRN" as const,
                  value: crn,
                  country: "GB",
                  validated: false,
                  provenance: [prov],
                },
              ]
            : []),
        ],
        jurisdiction: "GB",
        // Authorisation status is not company status: it is reported by get_regulatory_status.
        notes: [],
      };
    },

    async regulatory(company: RegulatoryQuery, ctx): Promise<RegulatoryResult | undefined> {
      const given = company.identifiers.find((i) => i.scheme === "FCA_FRN");
      const crnId = company.identifiers.find((i) => i.scheme === "GB_CRN");
      let frn = given ? normalizeFrn(given.value) : undefined;
      const matchedBy = frn ? "frn" : "companies_house_number";
      if (!frn && crnId) frn = await findByCrn(crnId.value, company.names, ctx);
      if (!frn) return undefined;
      const res = await assemble(frn, ctx);
      if (!res.value) return undefined;
      return {
        ...res.value,
        matchedBy,
        provenance: provenance(frn, res.fetchedAt, res.fromCache),
      };
    },
  };
}
