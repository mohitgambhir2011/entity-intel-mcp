// Subset of docs/11-data-model.md needed by the first adapters. Grows with each phase.

export type CountryCode = string;
export type ISODate = string;
export type ISODateTime = string;

export type SourceId =
  "gleif" | "vies" | "companies_house" | "fca" | "brreg_no" | "prh_fi" | "cro_ie";

export interface Provenance {
  source: SourceId;
  sourceRecordId: string;
  sourceUrl?: string;
  retrievedAt: ISODateTime;
  fromCache: boolean;
  licence?: string;
}

export interface Sourced<T> {
  value: T;
  provenance: Provenance[];
}

export type IdentifierScheme =
  | "LEI"
  | "GB_CRN"
  | "VAT"
  | "IE_CRO"
  | "NO_ORGNR"
  | "FI_YTUNNUS"
  | "DK_CVR"
  | "FR_SIREN"
  | "NL_KVK"
  | "BE_KBO"
  | "FCA_FRN";

export interface Identifier {
  scheme: IdentifierScheme;
  /** Normalised value (no spaces or punctuation). */
  value: string;
  raw?: string;
  country?: CountryCode;
  status?: "active" | "lapsed" | "retired" | "unknown";
  /** Format/checksum valid, or confirmed valid by the issuing service (VAT). */
  validated: boolean;
  provenance: Provenance[];
}

export type NormalizedStatus =
  | "active"
  | "dormant"
  | "suspended"
  | "in_liquidation"
  | "liquidation_voluntary"
  | "liquidation_compulsory"
  | "in_administration"
  | "insolvent"
  | "merged_or_converted"
  | "dissolved"
  | "struck_off"
  | "unknown";

export type StatusGroup = "operating" | "distressed" | "ended" | "unknown";

export interface EntityStatus {
  normalized: NormalizedStatus;
  group: StatusGroup;
  /** The source's own wording, always kept. */
  sourceText: string;
}

export interface Address {
  lines: string[];
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: CountryCode;
  formatted: string;
}

export interface EntityName {
  name: string;
  kind: "legal" | "former" | "trading" | "other";
  validFrom?: ISODate;
  validTo?: ISODate;
  provenance: Provenance[];
}

export interface LegalForm {
  /** ISO 20275 ELF code when the source provides one. */
  code?: string;
  localName: string;
  normalized?:
    | "limited_company"
    | "public_company"
    | "llp"
    | "partnership"
    | "sole_proprietor"
    | "cooperative"
    | "branch"
    | "other";
}

/** What one adapter knows about one entity. The merger combines these into an Entity. */
export interface PartialEntity {
  source: SourceId;
  names: EntityName[];
  identifiers: Identifier[];
  jurisdiction?: CountryCode;
  legalForm?: Sourced<LegalForm>;
  status?: Sourced<EntityStatus>;
  incorporationDate?: Sourced<ISODate>;
  dissolutionDate?: Sourced<ISODate>;
  registeredAddress?: Sourced<Address>;
  headquartersAddress?: Sourced<Address>;
  notes: string[];
}

export interface SearchHit {
  source: SourceId;
  name: string;
  identifier: Identifier;
  jurisdiction?: CountryCode;
  status?: EntityStatus;
  address?: string;
}

const GROUP: Record<NormalizedStatus, StatusGroup> = {
  active: "operating",
  dormant: "operating",
  suspended: "operating",
  in_liquidation: "distressed",
  liquidation_voluntary: "distressed",
  liquidation_compulsory: "distressed",
  in_administration: "distressed",
  insolvent: "distressed",
  merged_or_converted: "ended",
  dissolved: "ended",
  struck_off: "ended",
  unknown: "unknown",
};

export function makeStatus(normalized: NormalizedStatus, sourceText: string): EntityStatus {
  return { normalized, group: GROUP[normalized], sourceText };
}
