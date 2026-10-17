// Officers, controllers and ownership: the personal-data families (D13).
import type { Address, Identifier, Provenance } from "./types.js";

/** Why a family has no data, so "none" is never confused with "not published" (D28). */
export type UnavailableReason =
  | "not_published_by_source"
  | "restricted_access"
  | "requires_paid_access"
  | "requires_credentials"
  /** The adapter exists but is switched off (for example excluded by EIM_ADAPTERS). */
  | "not_enabled"
  | "no_such_record";

export type Availability<T> =
  | { state: "available"; data: T }
  | { state: "unavailable"; reason: UnavailableReason; detail?: string }
  | { state: "not_yet_supported"; detail?: string }
  | { state: "error"; detail: string };

/** Partial birth date as published (D23): the registry decides the precision. */
export interface BirthDate {
  year?: number;
  month?: number;
  day?: number;
}

/** Normalised roles across registries; the registry's own wording is always kept in sourceRole. */
export type OfficerRole =
  | "director"
  | "ceo"
  | "chair"
  | "board_member"
  | "deputy"
  | "secretary"
  | "llp_member"
  | "manager"
  | "auditor"
  | "accountant"
  | "authorised_signatory"
  | "other";

export interface Officer {
  kind: "person" | "corporate";
  /** As published, e.g. "SMITH, John". */
  name: string;
  /** "John SMITH": the form used for display and name matching. */
  displayName: string;
  role: OfficerRole;
  /** The registry's own role wording, always kept. */
  sourceRole: string;
  appointedOn?: string;
  resignedOn?: string;
  active: boolean;
  /** The registry marks this person as deceased. */
  deceased?: boolean;
  birth?: BirthDate;
  nationality?: string;
  countryOfResidence?: string;
  occupation?: string;
  address?: Address;
  /** For corporate officers registered in a registry we can follow (UK company number). */
  corporateIdentifier?: Identifier;
}

export interface OfficersResult {
  officers: Officer[];
  /** Officers the registry reports for the company (all, active and resigned). */
  total: number;
  activeCount: number;
  resignedCount: number;
  /** True when the registry holds more officers than were fetched. */
  truncated: boolean;
  /** Where and when this list was obtained (D2). */
  provenance: Provenance;
}

/** How a person or entity controls a company. Percent bands are as published (25-50, 50-75, 75-100). */
export interface ControlNatures {
  /** Registry codes, kept verbatim. */
  codes: string[];
  sharesMin?: number;
  sharesMax?: number;
  votingMin?: number;
  votingMax?: number;
  appointsDirectors?: boolean;
  significantInfluence?: boolean;
}

export interface Controller {
  kind: "person" | "corporate" | "legal_person";
  /** Absent for protected ("super secure") persons. */
  name?: string;
  displayName?: string;
  /** True when the registry withholds the identity of this controller. */
  redacted?: boolean;
  natures: ControlNatures;
  notifiedOn?: string;
  ceasedOn?: string;
  active: boolean;
  birth?: BirthDate;
  nationality?: string;
  countryOfResidence?: string;
  address?: Address;
  /** Registration details of a corporate controller. */
  registration?: {
    number?: string;
    legalForm?: string;
    countryRegistered?: string;
    placeRegistered?: string;
    legalAuthority?: string;
  };
  /** Present when the controller is registered in a registry this server can follow. */
  corporateIdentifier?: Identifier;
}

export interface ControllersResult {
  controllers: Controller[];
  total: number;
  activeCount: number;
  ceasedCount: number;
  /** Why a company legitimately has no controllers listed (e.g. exempt: listed on a regulated market). */
  exemption?: { code: string; description: string };
  /** PSC statements such as "no individual or entity with significant control". */
  statements: { code: string; description: string }[];
  truncated: boolean;
  /** Where and when this list was obtained (D2). */
  provenance: Provenance;
}

const TITLES = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "mx",
  "dr",
  "prof",
  "professor",
  "sir",
  "dame",
  "lord",
  "lady",
  "rev",
  "reverend",
  "hon",
  "rt",
  "cllr",
  "capt",
  "major",
  "col",
  "gen",
  "lt",
  "sheikh",
  "sheikha",
]);

/** Drops leading honorifics ("Dr", "Mrs", "Sir"...): they are not part of the name on a list. */
export function stripTitles(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && TITLES.has(words[0]!.toLowerCase().replace(/\.$/, ""))) words.shift();
  return words.join(" ");
}

/** Turns "SMITH, John Paul" into "John Paul SMITH"; leaves other names alone. */
export function displayPersonName(published: string): string {
  const comma = published.indexOf(",");
  if (comma < 0) return stripTitles(published);
  const surname = published.slice(0, comma).trim();
  const given = published.slice(comma + 1).trim();
  return stripTitles([given, surname].filter(Boolean).join(" "));
}

export const PERSONAL_DATA_NOTICE =
  "Contains personal data about named individuals as published by the registry. You are responsible " +
  "for having a lawful basis (UK GDPR / GDPR) to process it. Entries are cached locally for a " +
  "limited time and never written to logs.";
