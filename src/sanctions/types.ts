export type SanctionsListId = "UK" | "EU" | "OFAC_SDN";

export const ALL_LISTS: SanctionsListId[] = ["UK", "EU", "OFAC_SDN"];

export type SubjectType = "person" | "entity" | "vessel" | "other";

export interface SanctionName {
  name: string;
  /** The designation's main name, as opposed to an alias. */
  primary: boolean;
  /** False for aliases the list itself marks as low quality (OFAC "weak", UK "Low quality a.k.a"). */
  strong: boolean;
}

/** One designated person, entity or vessel, normalised from any of the three lists. */
export interface SanctionEntry {
  list: SanctionsListId;
  entryId: string;
  subjectType: SubjectType;
  names: SanctionName[];
  /** Registration / company numbers, LEIs, IMO numbers: normalised (upper case, no separators). */
  identifiers: string[];
  programmes: string[];
  listedOn?: string;
  countries: string[];
  /** Free text from the list; untrusted. */
  remarks?: string;
}

/** A downloaded and parsed list. This is what gets cached. */
export interface ListSnapshot {
  list: SanctionsListId;
  /** Date the publisher says the list was generated or last updated (ISO date), if known. */
  versionDate?: string;
  fetchedAt: string;
  entries: SanctionEntry[];
}

export type MatchBasis = "exact_identifier" | "exact_name" | "alias" | "fuzzy_name";

export interface SanctionsHit {
  list: SanctionsListId;
  entryId: string;
  /** The designated name that matched. */
  entryName: string;
  /** The name from the screened subject that matched it. */
  matchedName: string;
  score: number;
  basis: MatchBasis;
  subjectType: SubjectType;
  programmes: string[];
  listedOn?: string;
  countries: string[];
  /** True when the match is to an alias the list marks as low quality: capped below "match". */
  weakAlias?: boolean;
  remarks?: string;
}

export type ScreeningResult = "no_match" | "possible_match" | "match" | "incomplete";

export interface ListCheck {
  list: SanctionsListId;
  state: "checked" | "unavailable";
  versionDate?: string;
  fetchedAt?: string;
  entries?: number;
  /** Days between the list's own version date and now. */
  ageDays?: number;
  /** True when the list is too old to support a clean result (see screen.ts). */
  stale?: boolean;
  /** Server-written reason when unavailable. */
  reason?: string;
}

export interface SanctionsScreening {
  screenedAt: string;
  result: ScreeningResult;
  listsChecked: ListCheck[];
  hits: SanctionsHit[];
  thresholds: { match: number; possible: number };
  caveat: string;
}

export const SCREENING_CAVEAT =
  "This is an automated, name- and identifier-based screen against the list versions shown. " +
  "It is not a legal determination and does not replace screening by a regulated firm. " +
  "Transliteration variants, name changes and unlisted aliases can be missed; every hit " +
  "needs human review against the official list.";
