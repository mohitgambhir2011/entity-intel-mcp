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

/**
 * What the register shows about a person's identity verification (Companies House, from 2025).
 * `not_shown` means the register shows nothing: it is NOT evidence that the person is unverified,
 * because the register may not have rolled the field out for this company or appointment (D28).
 * `verified` needs the register's own identity-verified date. `period_only` means the register shows an
 * appointment-verification period but no verified date: what that period proves is not documented by
 * the register, so it is never reported as verified (D48, amended after the live check of 2026-11-21).
 */
export interface OfficerVerification {
  state: "verified" | "period_only" | "not_shown" | "unknown";
  /** As published (YYYY-MM-DD). */
  identityVerifiedOn?: string;
  appointmentVerificationStartOn?: string;
  /** Absent when the register's open-ended placeholder date is used. */
  appointmentVerificationEndOn?: string;
}

export interface Officer {
  kind: "person" | "corporate";
  /**
   * The register's own id for this person (Companies House officer id), the same across companies.
   * A person-level identifier: personal data, never logged. Absent when the register gives none.
   */
  officerRef?: string;
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
  /** Persons only, and only where the source publishes this at all (UK). */
  verification?: OfficerVerification;
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

/** One appointment the register lists under a person's register id (D49). No personal details. */
export interface OfficerAppointment {
  companyNumber: string;
  companyName?: string;
  /** The register's wording for the company's status, kept as published. */
  companyStatus?: string;
  role: OfficerRole;
  sourceRole: string;
  appointedOn?: string;
  resignedOn?: string;
  active: boolean;
}

/**
 * Evidence about one register id, never a verdict about the person. The register can hold one
 * person under several ids, so these counts are a LOWER BOUND on the person's appointments.
 */
export interface OfficerAppointmentsResult {
  appointments: OfficerAppointment[];
  /** All appointments the register lists under this id (active and resigned). */
  total: number;
  /** Counted over the appointments fetched; equals the register's number when not truncated. */
  activeCount: number;
  /** Register entries without a usable company number: listed in `total` but not in `appointments`. */
  skipped: number;
  truncated: boolean;
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
