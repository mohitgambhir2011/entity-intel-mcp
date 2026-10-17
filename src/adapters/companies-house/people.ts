import { SourceError } from "../../core/errors.js";
import { normalizeGbCompanyNumber } from "../../core/identifiers.js";
import { ownEntry } from "../../core/tables.js";
import {
  displayPersonName,
  type BirthDate,
  type ControlNatures,
  type Controller,
  type ControllersResult,
  type Officer,
  type OfficerRole,
  type OfficersResult,
} from "../../core/people.js";
import type { Identifier, Provenance } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type AdapterContext } from "../types.js";
import { BASE, LICENCE, mapAddress, type ChAddress } from "./shared.js";

const SOURCE = "companies_house";

/** What is cached: the data without provenance, which describes *this* fetch, not the stored one. */
type Cached<T> = Omit<T, "provenance">;

function provenance(
  number: string,
  path: string,
  fetchedAt: number,
  fromCache: boolean,
): Provenance {
  return {
    source: "companies_house",
    sourceRecordId: number,
    sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${number}/${path}`,
    retrievedAt: iso(fetchedAt),
    fromCache,
    licence: LICENCE,
  };
}
const PAGE_SIZE = 100;
/** Hard stop on paging: 500 officers is far beyond any real company; flagged as truncated. */
const MAX_PAGES = 5;

// ---------------------------------------------------------------- raw shapes (only what we read)

interface ChIdentification {
  registration_number?: string;
  legal_form?: string;
  legal_authority?: string;
  place_registered?: string;
  country_registered?: string;
  identification_type?: string;
}

interface ChDob {
  year?: number;
  month?: number;
  day?: number;
}

interface ChOfficer {
  name?: string;
  officer_role?: string;
  appointed_on?: string;
  resigned_on?: string;
  date_of_birth?: ChDob;
  nationality?: string;
  country_of_residence?: string;
  occupation?: string;
  address?: ChAddress;
  identification?: ChIdentification;
}

interface ChOfficerList {
  items?: ChOfficer[];
  total_results?: number;
  active_count?: number;
  resigned_count?: number;
}

interface ChPsc {
  kind?: string;
  name?: string;
  notified_on?: string;
  ceased_on?: string;
  ceased?: boolean;
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: ChDob;
  address?: ChAddress;
  natures_of_control?: string[];
  identification?: ChIdentification;
  name_elements?: { forename?: string; middle_name?: string; surname?: string };
}

interface ChPscList {
  items?: ChPsc[];
  total_results?: number;
  active_count?: number;
  ceased_count?: number;
  links?: { exemptions?: string };
}

interface ChStatementList {
  items?: { statement?: string }[];
}

interface ChExemptions {
  exemptions?: Record<string, { items?: { exempt_from?: string; exempt_to?: string }[] }>;
}

// ---------------------------------------------------------------- pure mapping (unit-tested)

export function officerRole(code: string | undefined): OfficerRole {
  const c = (code ?? "").toLowerCase();
  if (c.includes("secretary")) return "secretary";
  if (c.includes("director")) return "director";
  if (c.includes("llp")) return "llp_member";
  if (c.includes("manager") || c.includes("managing-officer")) return "manager";
  return "other";
}

function birth(d: ChDob | undefined): BirthDate | undefined {
  if (!d || (d.year === undefined && d.month === undefined)) return undefined;
  return { year: d.year, month: d.month, day: d.day };
}

/** A UK registration number on a corporate officer / controller we can follow in this registry. */
function ukIdentifier(id: ChIdentification | undefined): Identifier | undefined {
  if (!id?.registration_number) return undefined;
  const authority = `${id.legal_authority ?? ""} ${id.place_registered ?? ""}`.toLowerCase();
  const isUk =
    id.identification_type === "uk-limited-company" ||
    /companies house|united kingdom|england|scotland|wales|northern ireland/.test(authority);
  if (!isUk) return undefined;
  const number = normalizeGbCompanyNumber(id.registration_number);
  return number
    ? { scheme: "GB_CRN", value: number, country: "GB", validated: false, provenance: [] }
    : undefined;
}

export function mapOfficer(o: ChOfficer): Officer {
  const name = (o.name ?? "").trim();
  const corporate = Boolean(o.identification) || /^corporate-/.test(o.officer_role ?? "");
  return {
    kind: corporate ? "corporate" : "person",
    name,
    displayName: corporate ? name : displayPersonName(name),
    role: officerRole(o.officer_role),
    sourceRole: o.officer_role ?? "",
    appointedOn: o.appointed_on,
    resignedOn: o.resigned_on,
    active: !o.resigned_on,
    birth: birth(o.date_of_birth),
    nationality: o.nationality,
    countryOfResidence: o.country_of_residence,
    occupation: o.occupation,
    address: mapAddress(o.address),
    corporateIdentifier: corporate ? ukIdentifier(o.identification) : undefined,
  };
}

/** "ownership-of-shares-25-to-50-percent" -> min 25, max 50; "more-than-25-percent" -> 25..100. */
export function parseNatures(codes: string[]): ControlNatures {
  const out: ControlNatures = { codes: [...codes] };
  for (const code of codes) {
    const band =
      /^(ownership-of-shares|ownership-of-voting-rights|voting-rights)-(\d+)-to-(\d+)-percent/.exec(
        code,
      );
    const more =
      /^(ownership-of-shares|ownership-of-voting-rights|voting-rights)-more-than-(\d+)-percent/.exec(
        code,
      );
    const [kind, min, max] = band
      ? [band[1]!, Number(band[2]), Number(band[3])]
      : more
        ? [more[1]!, Number(more[2]), 100]
        : [undefined, 0, 0];
    // A controller can hold several natures of one kind (e.g. directly and as a trustee): keep the
    // widest range they cover so control is never understated.
    if (kind === "ownership-of-shares") {
      out.sharesMin = Math.min(out.sharesMin ?? min, min);
      out.sharesMax = Math.max(out.sharesMax ?? max, max);
    } else if (kind) {
      out.votingMin = Math.min(out.votingMin ?? min, min);
      out.votingMax = Math.max(out.votingMax ?? max, max);
    }
    if (code.includes("appoint-and-remove-directors") || code.includes("appoint-or-remove")) {
      out.appointsDirectors = true;
    }
    if (code.includes("significant-influence-or-control")) out.significantInfluence = true;
  }
  return out;
}

/** Prefer the structured name (no title); fall back to stripping honorifics from the full name. */
function personName(p: ChPsc, full: string): string {
  const e = p.name_elements;
  const built = [e?.forename, e?.middle_name, e?.surname].filter(Boolean).join(" ").trim();
  return built || displayPersonName(full);
}

function controllerKind(kind: string | undefined): Controller["kind"] {
  if (kind?.startsWith("corporate-entity")) return "corporate";
  if (kind?.startsWith("legal-person")) return "legal_person";
  return "person";
}

export function mapController(p: ChPsc): Controller {
  const kind = controllerKind(p.kind);
  const redacted = (p.kind ?? "").startsWith("super-secure") || !p.name;
  const name = p.name?.trim();
  const reg = p.identification;
  return {
    kind,
    name: redacted ? undefined : name,
    displayName: redacted ? undefined : kind === "person" ? personName(p, name!) : name,
    redacted: redacted || undefined,
    natures: parseNatures(p.natures_of_control ?? []),
    notifiedOn: p.notified_on,
    ceasedOn: p.ceased_on,
    active: !p.ceased && !p.ceased_on,
    birth: birth(p.date_of_birth),
    nationality: p.nationality,
    countryOfResidence: p.country_of_residence,
    address: mapAddress(p.address),
    registration: reg
      ? {
          number: reg.registration_number,
          legalForm: reg.legal_form,
          countryRegistered: reg.country_registered,
          placeRegistered: reg.place_registered,
          legalAuthority: reg.legal_authority,
        }
      : undefined,
    corporateIdentifier: kind === "corporate" ? ukIdentifier(reg) : undefined,
  };
}

const EXEMPTION_TEXT: [RegExp, string][] = [
  [
    /regulated_market|regulated-market/,
    "exempt from PSC reporting: shares traded on a regulated market",
  ],
  [
    /disclosure_transparency|disclosure-transparency/,
    "subject to the Disclosure and Transparency Rules (chapter 5)",
  ],
  [/eea|uk_regulated/, "exempt from PSC reporting: shares traded on a regulated market"],
];

const STATEMENT_TEXT: Record<string, string> = {
  "no-individual-or-entity-with-signficant-control":
    "The company states it has no person or entity with significant control",
  "no-individual-or-entity-with-significant-control":
    "The company states it has no person or entity with significant control",
  "steps-to-find-psc-not-yet-completed":
    "The company has not yet completed the steps to find its controllers",
  "psc-details-not-confirmed": "The company has not confirmed its controllers' details",
  "psc-has-failed-to-confirm-changed-details": "A controller has failed to confirm changed details",
  "restrictions-notice-issued-to-psc": "A restrictions notice has been issued to a controller",
  "super-secure-persons-with-significant-control": "Details of a controller are protected",
};

/** The code of a PSC exemption in force on `today` (YYYY-MM-DD), if any: expired ones do not count. */
export function currentPscExemption(
  body: ChExemptions | null | undefined,
  today: string,
): string | undefined {
  for (const [code, value] of Object.entries(body?.exemptions ?? {})) {
    if (!code.startsWith("psc_exempt")) continue;
    const inForce = (value.items ?? []).some(
      (i) => (!i.exempt_from || i.exempt_from <= today) && (!i.exempt_to || i.exempt_to >= today),
    );
    if (inForce) return code;
  }
  return undefined;
}

export function describeExemption(code: string): string {
  return EXEMPTION_TEXT.find(([re]) => re.test(code))?.[1] ?? `exempt from PSC reporting (${code})`;
}

export function describeStatement(code: string): string {
  return ownEntry(STATEMENT_TEXT, code) ?? `PSC statement: ${code}`;
}

// ---------------------------------------------------------------- fetching

export async function fetchOfficers(
  ctx: AdapterContext,
  headers: Record<string, string>,
  number: string,
): Promise<OfficersResult | undefined> {
  const res = await ctx.cache.getOrFetch(
    `ch:officers:${number}`,
    { ttlSeconds: TTL.registryProfile, source: SOURCE, personal: true, fresh: ctx.fresh },
    async (): Promise<Cached<OfficersResult> | null> => {
      const items: ChOfficer[] = [];
      let total = 0;
      let active = 0;
      let resigned = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${BASE}/company/${number}/officers?items_per_page=${PAGE_SIZE}&start_index=${page * PAGE_SIZE}`;
        const r = await ctx.http.getJson<ChOfficerList>(url, {
          source: SOURCE,
          headers,
          allowStatus: [404],
        });
        if (r.status === 404) {
          if (page === 0) return null;
          break;
        }
        if (!r.body || !Array.isArray(r.body.items)) {
          throw new SourceError(
            `${SOURCE} returned an unexpected officers response`,
            SOURCE,
            "bad_response",
          );
        }
        items.push(...r.body.items);
        total = r.body.total_results ?? items.length;
        active = r.body.active_count ?? active;
        resigned = r.body.resigned_count ?? resigned;
        if (items.length >= total || r.body.items.length === 0) break;
      }
      return {
        officers: items.map(mapOfficer),
        total,
        activeCount: active,
        resignedCount: resigned,
        truncated: items.length < total,
      };
    },
  );
  return res.value
    ? { ...res.value, provenance: provenance(number, "officers", res.fetchedAt, res.fromCache) }
    : undefined;
}

export async function fetchControllers(
  ctx: AdapterContext,
  headers: Record<string, string>,
  number: string,
): Promise<ControllersResult | undefined> {
  const res = await ctx.cache.getOrFetch(
    `ch:psc:${number}`,
    { ttlSeconds: TTL.registryProfile, source: SOURCE, personal: true, fresh: ctx.fresh },
    async (): Promise<Cached<ControllersResult> | null> => {
      const items: ChPsc[] = [];
      let total = 0;
      let active = 0;
      let ceased = 0;
      let exemptionsLink = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${BASE}/company/${number}/persons-with-significant-control?items_per_page=${PAGE_SIZE}&start_index=${page * PAGE_SIZE}`;
        const r = await ctx.http.getJson<ChPscList>(url, {
          source: SOURCE,
          headers,
          allowStatus: [404],
        });
        if (r.status === 404) {
          if (page === 0) return null;
          break;
        }
        if (!r.body || !Array.isArray(r.body.items)) {
          throw new SourceError(
            `${SOURCE} returned an unexpected PSC response`,
            SOURCE,
            "bad_response",
          );
        }
        items.push(...r.body.items);
        total = r.body.total_results ?? items.length;
        active = r.body.active_count ?? active;
        ceased = r.body.ceased_count ?? ceased;
        exemptionsLink ||= Boolean(r.body.links?.exemptions);
        if (items.length >= total || r.body.items.length === 0) break;
      }

      const controllers = items.map(mapController);
      const result: Cached<ControllersResult> = {
        controllers,
        total,
        activeCount: active,
        ceasedCount: ceased,
        statements: [],
        truncated: items.length < total,
      };

      // No active controllers: say why, so "none" is never confused with "not published".
      if (controllers.every((c) => !c.active)) {
        if (exemptionsLink) {
          const ex = await ctx.http.getJson<ChExemptions>(`${BASE}/company/${number}/exemptions`, {
            source: SOURCE,
            headers,
            allowStatus: [404],
          });
          const code = currentPscExemption(
            ex.body,
            (ctx.now?.() ?? new Date()).toISOString().slice(0, 10),
          );
          if (code) result.exemption = { code, description: describeExemption(code) };
        }
        if (!result.exemption) {
          const st = await ctx.http.getJson<ChStatementList>(
            `${BASE}/company/${number}/persons-with-significant-control-statements`,
            { source: SOURCE, headers, allowStatus: [404] },
          );
          result.statements = (st.body?.items ?? [])
            .map((s) => s.statement)
            .filter((s): s is string => typeof s === "string")
            .map((code) => ({ code, description: describeStatement(code) }));
        }
      }
      return result;
    },
  );
  return res.value
    ? {
        ...res.value,
        provenance: provenance(
          number,
          "persons-with-significant-control",
          res.fetchedAt,
          res.fromCache,
        ),
      }
    : undefined;
}
