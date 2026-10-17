import { normalizeFiBusinessId } from "../../core/identifiers.js";
import { ownEntry } from "../../core/tables.js";
import { makeStatus } from "../../core/types.js";
import type {
  Address,
  EntityName,
  EntityStatus,
  Identifier,
  LegalForm,
  PartialEntity,
  Provenance,
} from "../../core/types.js";

export const LICENCE = "Creative Commons Attribution 4.0 (Finnish Patent and Registration Office)";
export const BASE = "https://avoindata.prh.fi/opendata-ytj-api/v3";

/** PRH language codes. */
const FI = "1";
const EN = "3";

// ---------------------------------------------------------------- raw shapes (only what we read)

interface Described {
  descriptions?: { languageCode?: string; description?: string }[];
}

export interface PrhCompany {
  businessId?: { value?: string; registrationDate?: string };
  names?: {
    name?: string;
    type?: string;
    registrationDate?: string;
    endDate?: string;
  }[];
  companyForms?: (Described & { type?: string; registrationDate?: string; endDate?: string })[];
  companySituations?: (Described & {
    type?: string;
    registrationDate?: string;
    endDate?: string;
  })[];
  registeredEntries?: (Described & {
    type?: string;
    register?: string;
    registrationDate?: string;
    endDate?: string;
  })[];
  addresses?: {
    type?: number;
    street?: string;
    buildingNumber?: string;
    entrance?: string;
    apartmentNumber?: string;
    co?: string;
    postOfficeBox?: string;
    postCode?: string;
    postOffices?: { city?: string; languageCode?: string }[];
    endDate?: string;
  }[];
  registrationDate?: string;
}

export interface PrhResponse {
  totalResults?: number;
  companies?: PrhCompany[];
}

// ---------------------------------------------------------------- helpers

const current = <T extends { endDate?: string }>(items: T[] | undefined): T[] =>
  (items ?? []).filter((i) => !i.endDate);

/** The wording in the preferred language (English, then Finnish, then whatever exists). */
export function describe(
  d: Described | undefined,
  prefer: string[] = [EN, FI],
): string | undefined {
  const list = d?.descriptions ?? [];
  for (const lang of prefer) {
    const hit = list.find((x) => x.languageCode === lang && x.description);
    if (hit) return hit.description;
  }
  return list.find((x) => x.description)?.description;
}

// ---------------------------------------------------------------- legal form

/** By PRH's English wording; unknown wording is "other" and the wording is kept as localName. */
const FORMS: Record<string, LegalForm["normalized"]> = {
  "limited company": "limited_company",
  "public limited company": "public_company",
  "limited partnership": "partnership",
  partnership: "partnership",
  cooperative: "cooperative",
  "private trader": "sole_proprietor",
  "sole trader": "sole_proprietor",
};

export function mapFiLegalForm(c: PrhCompany): LegalForm | undefined {
  const form = current(c.companyForms).at(-1) ?? c.companyForms?.at(-1);
  const english = describe(form, [EN]);
  const name = english ?? describe(form);
  if (!name) return undefined;
  return { localName: name, normalized: ownEntry(FORMS, name.toLowerCase()) ?? "other" };
}

// ---------------------------------------------------------------- status

/** Company situation codes we can read. Anything else is reported as unknown, never as active. */
const SITUATIONS: Record<string, [Parameters<typeof makeStatus>[0], string]> = {
  KONK: ["insolvent", "bankruptcy (konkurssi)"],
  SELTILA: ["in_liquidation", "liquidation (selvitystila)"],
};

/**
 * PRH has no single status field (`status` is "2" for every company). The signals are the
 * company situations (bankruptcy, liquidation) and the trade register entry ("Registered" or
 * "Ceased"). A company that is not in the trade register (housing companies, associations ...) has
 * no signal we can interpret and is reported as unknown rather than guessed (D21).
 */
export function mapFiStatus(c: PrhCompany): EntityStatus {
  const situations = current(c.companySituations);
  const codes = situations.map((s) => s.type).filter(Boolean);
  for (const s of situations) {
    const known = ownEntry(SITUATIONS, s.type);
    if (known) return makeStatus(known[0], known[1]);
  }
  if (codes.length > 0) {
    // A situation we do not know how to read must not be hidden behind "registered".
    return makeStatus("unknown", `company situation ${codes.join(", ")}`);
  }

  const trade = (c.registeredEntries ?? [])
    .filter((e) => e.register === "1")
    .sort((a, b) => (b.registrationDate ?? "").localeCompare(a.registrationDate ?? ""));
  const entry = trade.find((e) => !e.endDate) ?? trade[0];
  const wording = describe(entry, [EN]);
  if (!wording) return makeStatus("unknown", "not in the trade register");
  switch (wording.toLowerCase()) {
    case "registered":
      return makeStatus("active", `trade register: ${wording}`);
    case "ceased":
      return makeStatus("dissolved", `trade register: ${wording}`);
    default:
      return makeStatus("unknown", `trade register: ${wording}`);
  }
}

// ---------------------------------------------------------------- names, addresses

export function mapFiNames(c: PrhCompany, prov: Provenance): EntityName[] {
  const out: EntityName[] = [];
  const sorted = [...(c.names ?? [])].sort((a, b) =>
    (b.registrationDate ?? "").localeCompare(a.registrationDate ?? ""),
  );
  for (const n of sorted) {
    const name = n.name?.trim();
    if (!name || out.some((o) => o.name === name && o.kind !== "former")) continue;
    const ended = Boolean(n.endDate);
    // Type 1 is the registered (official) name, 3 an auxiliary business name; others are kept.
    const kind: EntityName["kind"] = ended
      ? "former"
      : n.type === "1"
        ? "legal"
        : n.type === "3"
          ? "trading"
          : "other";
    out.push({ name, kind, validFrom: n.registrationDate, validTo: n.endDate, provenance: [prov] });
  }
  // A ceased company has no current official name: the one it carried to the end (the newest
  // registered name) is still its legal name, with the date it ended. Without this a ceased
  // company has no legal name and drops out of searches.
  if (!out.some((o) => o.kind === "legal")) {
    const last = sorted.find((n) => n.type === "1" && n.name?.trim());
    const at = last
      ? out.findIndex((o) => o.kind === "former" && o.name === last.name!.trim())
      : -1;
    if (at >= 0) out[at] = { ...out[at]!, kind: "legal" };
  }
  // The newest current official name must come first.
  return out.sort((a, b) => Number(b.kind === "legal") - Number(a.kind === "legal"));
}

function formatStreet(a: NonNullable<PrhCompany["addresses"]>[number]): string {
  const street = [a.street, a.buildingNumber, a.entrance].filter(Boolean).join(" ").trim();
  const flat = a.apartmentNumber ? ` ${a.apartmentNumber}` : "";
  return street ? `${street}${flat}` : a.postOfficeBox ? `PL ${a.postOfficeBox}` : "";
}

export function mapFiAddress(c: PrhCompany): Address | undefined {
  const addresses = current(c.addresses);
  // Type 1 is the street (visiting) address, type 2 the postal address.
  const a = addresses.find((x) => x.type === 1) ?? addresses.find((x) => x.type === 2);
  if (!a) return undefined;
  const city = (a.postOffices?.find((p) => p.languageCode === FI) ?? a.postOffices?.[0])?.city;
  const lines = [a.co ? `c/o ${a.co}` : "", formatStreet(a)].filter(Boolean);
  const locality = [a.postCode, city].filter(Boolean).join(" ");
  const parts = [...lines, locality, "Finland"].filter(Boolean);
  if (lines.length === 0 && !locality) return undefined;
  return {
    lines,
    locality: city,
    postalCode: a.postCode,
    country: "FI",
    formatted: parts.join(", "),
  };
}

// ---------------------------------------------------------------- entity

export function mapFiEntity(c: PrhCompany, prov: Provenance): PartialEntity | undefined {
  const id = c.businessId?.value ? normalizeFiBusinessId(c.businessId.value) : undefined;
  if (!id) return undefined;
  const names = mapFiNames(c, prov);
  if (names.length === 0) return undefined;
  const identifier: Identifier = {
    scheme: "FI_YTUNNUS",
    value: id,
    country: "FI",
    validated: true,
    provenance: [prov],
  };
  const status = mapFiStatus(c);
  const form = mapFiLegalForm(c);
  const address = mapFiAddress(c);
  return {
    source: "prh_fi",
    names,
    identifiers: [identifier],
    jurisdiction: "FI",
    legalForm: form ? { value: form, provenance: [prov] } : undefined,
    status: { value: status, provenance: [prov] },
    incorporationDate: c.registrationDate
      ? { value: c.registrationDate, provenance: [prov] }
      : undefined,
    registeredAddress: address ? { value: address, provenance: [prov] } : undefined,
    notes: [],
  };
}
