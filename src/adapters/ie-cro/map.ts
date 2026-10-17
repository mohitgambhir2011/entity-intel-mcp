import { ownEntry } from "../../core/tables.js";
import { makeStatus } from "../../core/types.js";
import type {
  Address,
  EntityStatus,
  Identifier,
  LegalForm,
  PartialEntity,
  Provenance,
} from "../../core/types.js";

export const LICENCE = "Creative Commons Attribution 4.0 (Companies Registration Office, Ireland)";
export const BASE = "https://opendata.cro.ie/api/3/action";

// ---------------------------------------------------------------- raw shapes (only what we read)

/** One row of the CRO "Company Records" dataset. */
export interface CroRecord {
  company_num?: number | string;
  company_name?: string;
  company_status?: string;
  company_type?: string;
  company_reg_date?: string | null;
  comp_dissolved_date?: string | null;
  company_status_date?: string | null;
  company_address_1?: string | null;
  company_address_2?: string | null;
  company_address_3?: string | null;
  company_address_4?: string | null;
  eircode?: string | null;
}

/** CKAN wraps every answer as { success, result } or { success: false, error }. */
export interface CkanResponse<T> {
  success?: boolean;
  result?: T;
}

export interface CkanSearch {
  records?: CroRecord[];
  total?: number;
}

export interface CkanPackage {
  resources?: { id?: string; format?: string; datastore_active?: boolean }[];
}

// ---------------------------------------------------------------- search

/** Trailing legal-form words: the register stores "LIMITED", people type "Ltd". */
const FORM_WORDS = new Set(["ltd", "limited", "plc", "dac", "clg", "ulc", "teo", "teoranta", "uc"]);

/**
 * The words to search for. The register's full-text search needs every word to be present, so
 * punctuation is dropped ("O'Brien" is stored as O and BRIEN) and a trailing legal form such as
 * "Ltd" is left out. Falls back to all the words if nothing else is left.
 */
export function searchTerms(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const kept = [...words];
  while (kept.length > 1 && FORM_WORDS.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();
  return kept.join(" ");
}

// ---------------------------------------------------------------- status

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Status wording of the register (the codes differ for the same wording, so the wording is used).
 * "Strike Off Listed" is a warning notice, not yet a strike-off, and has no status of its own, so it
 * is `unknown` with the wording kept and a note on the entity.
 */
const STATUS: Record<string, Parameters<typeof makeStatus>[0]> = {
  normal: "active",
  liquidation: "in_liquidation",
  "liquidation (uk)": "in_liquidation",
  "liquidation stayed": "in_liquidation",
  administration: "in_administration",
  "administration (uk)": "in_administration",
  examinership: "in_administration",
  "struck off": "struck_off",
  dissolved: "dissolved",
  "dissolved-20 years": "dissolved",
  ceased: "dissolved",
  "ceased irl": "dissolved",
  "de-registered icav": "dissolved",
  "de-registered investment company": "dissolved",
  "dissolved postmerger": "merged_or_converted",
  "dissolved by divis": "merged_or_converted",
  "deleted cb merger": "merged_or_converted",
  "deleted cb conversion": "merged_or_converted",
  "deleted per se merge": "merged_or_converted",
  "deleted as per se tr": "merged_or_converted",
  "conv. to indprovsoc": "merged_or_converted",
};

export function mapCroStatus(r: CroRecord): EntityStatus {
  const text = (r.company_status ?? "").trim();
  return makeStatus(ownEntry(STATUS, norm(text)) ?? "unknown", text);
}

// ---------------------------------------------------------------- legal form

/** By the register's wording; anything not recognised is "other" with the wording kept. */
export function mapCroLegalForm(r: CroRecord): LegalForm | undefined {
  const name = r.company_type?.trim();
  if (!name) return undefined;
  const t = name.toLowerCase();
  let normalized: LegalForm["normalized"] = "other";
  if (/external company|foreign body corporate/.test(t)) normalized = "branch";
  else if (/\bplc\b|^public (limited|unlimited)|^public$/.test(t)) normalized = "public_company";
  else if (
    /^(ltd|dac|clg)\b|private.*limited|single member|limited by/.test(t) &&
    !/unlimited/.test(t)
  ) {
    normalized = "limited_company";
  }
  return { localName: name, normalized };
}

// ---------------------------------------------------------------- entity

/** Dates arrive as "1998-01-29T00:00:00". */
const day = (v: string | null | undefined): string | undefined =>
  v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;

export function mapCroAddress(r: CroRecord): Address | undefined {
  const lines = [r.company_address_1, r.company_address_2, r.company_address_3, r.company_address_4]
    .map((l) => l?.trim())
    .filter((l): l is string => Boolean(l));
  const eircode = r.eircode?.trim() || undefined;
  const parts = [...lines, eircode].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return undefined;
  return {
    lines,
    postalCode: eircode,
    country: "IE",
    formatted: [...parts, "Ireland"].join(", "),
  };
}

export function mapCroEntity(
  r: CroRecord,
  number: string,
  prov: Provenance,
): PartialEntity | undefined {
  const name = r.company_name?.trim();
  if (!name) return undefined;
  const identifier: Identifier = {
    scheme: "IE_CRO",
    value: number,
    country: "IE",
    validated: false,
    provenance: [prov],
  };
  const status = mapCroStatus(r);
  const form = mapCroLegalForm(r);
  const address = mapCroAddress(r);
  const registered = day(r.company_reg_date);
  const dissolved = day(r.comp_dissolved_date);
  return {
    source: "cro_ie",
    names: [{ name, kind: "legal", provenance: [prov] }],
    identifiers: [identifier],
    jurisdiction: "IE",
    legalForm: form ? { value: form, provenance: [prov] } : undefined,
    status: { value: status, provenance: [prov] },
    incorporationDate: registered ? { value: registered, provenance: [prov] } : undefined,
    dissolutionDate: dissolved ? { value: dissolved, provenance: [prov] } : undefined,
    registeredAddress: address ? { value: address, provenance: [prov] } : undefined,
    notes:
      norm(r.company_status) === "strike off listed"
        ? ["The register lists the company for strike-off (a notice, not yet a strike-off)"]
        : [],
  };
}
