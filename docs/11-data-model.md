# Phase 2 — Unified entity data model (DRAFT v0.1)

Implements decisions D3 (internal entity ID, LEI optional), D2 (provenance + confidence), D5/D6 (per-country adapters, seven data families), D7 (cache metadata), D13 (personal data returned in full). Written as TypeScript types (D9); a JSON Schema will be generated from these in Phase 5.

## 1. Design principles

1. **Every fact has provenance.** No bare values: each field that comes from a source is wrapped in `Sourced<T>`.
2. **Absence is explicit.** A missing family is never an empty list. It is `unavailable` with a reason, so "no officers" never gets confused with "this country does not publish officers".
3. **Disagreement is data.** When two sources differ, keep both values and flag it. Do not silently pick one.
4. **Source-native fidelity.** Keep the raw source payload reference so nothing is lost in normalisation.
5. **Country-neutral core, country-specific extension.** Core fields are the same for all countries; quirks go in `extensions[countryCode]`.

## 2. Shared building blocks

```ts
type CountryCode = string;      // ISO 3166-1 alpha-2, "GB", "IE", "NO"...
type ISODate = string;          // "2026-10-17" or partial "1968-05" (partial dates allowed)
type ISODateTime = string;

interface Provenance {
  source: SourceId;             // "companies_house" | "gleif" | "brreg_no" | "prh_fi" | "vies" | ...
  sourceRecordId: string;       // ID in that source (company number, LEI, org number)
  sourceUrl?: string;           // human-checkable link when available
  retrievedAt: ISODateTime;
  fromCache: boolean;           // D7
  cacheAgeSeconds?: number;
  licence?: string;             // e.g. "OGL v3.0", "CC BY 4.0", "NLOD"
}

interface Sourced<T> {
  value: T;
  provenance: Provenance[];     // >1 when sources agree
}

interface Conflict {
  field: string;                // "status", "registeredAddress"...
  values: Sourced<unknown>[];   // each source's differing value
  note?: string;
}

type Availability<T> =
  | { state: "available"; data: T }
  | { state: "unavailable"; reason: UnavailableReason; detail?: string }
  | { state: "not_yet_supported"; detail?: string }   // we have not built it for this country
  | { state: "error"; detail: string };               // source failed this call

type UnavailableReason =
  | "not_published_by_source"   // e.g. Germany VIES name withheld
  | "restricted_access"         // e.g. beneficial owners after 2022 CJEU ruling
  | "requires_paid_access"
  | "requires_credentials"      // user has not configured a key
  | "no_such_record";
```

## 3. Entity

```ts
interface Entity {
  entityId: string;             // D20: "<country>:<registry>:<number>", e.g. "GB:CH:00445790"; fallback "hash:<country>:<h>"
  aliases?: string[];           // superseded IDs that redirect here
  type: EntityType;             // see below
  names: EntityName[];          // legal name + former/trading names
  identifiers: Identifier[];    // D3: LEI is one of many
  legalForm?: Sourced<LegalForm>;
  status: Sourced<EntityStatus>;
  jurisdiction: CountryCode;    // jurisdiction of formation
  incorporationDate?: Sourced<ISODate>;
  dissolutionDate?: Sourced<ISODate>;
  registeredAddress?: Sourced<Address>;
  headquartersAddress?: Sourced<Address>;
  sicOrNaceCodes?: Sourced<Industry[]>;

  // The seven data families (D6). Each carries its own availability.
  officers: Availability<Officer[]>;
  ownership: Availability<OwnershipGraph>;
  filings: Availability<Filing[]>;
  regulatory: Availability<RegulatoryRecord[]>;
  insolvency: Availability<InsolvencyRecord[]>;   // includes charges/liens as a sub-type
  sanctions: Availability<SanctionsScreening>;

  conflicts: Conflict[];
  coverage: CoverageReport;     // what we tried, per family, per source
  match?: MatchInfo;            // only on search results
  disclaimer: string;           // D13 personal-data notice + "not legal advice"
}

type EntityType =
  | "company" | "partnership" | "sole_trader" | "branch" | "fund"
  | "charity" | "public_body" | "trust" | "other";

type EntityStatus = {
  normalized: "active" | "dormant" | "suspended"
            | "in_liquidation"            // liquidation, type not stated by source
            | "liquidation_voluntary" | "liquidation_compulsory"
            | "in_administration" | "insolvent"
            | "merged_or_converted" | "dissolved" | "struck_off" | "unknown";
  group: "operating" | "distressed" | "ended" | "unknown";   // coarse bucket for quick reads
  // group mapping: active/dormant/suspended -> operating; in_liquidation, liquidation_*,
  // in_administration, insolvent -> distressed; merged_or_converted/dissolved/struck_off -> ended
  sourceText: string;           // the source's own wording, always kept
};

interface EntityName {
  name: string;
  kind: "legal" | "former" | "trading" | "transliterated" | "other";
  language?: string;
  validFrom?: ISODate; validTo?: ISODate;
  provenance: Provenance[];
}

interface LegalForm {
  code?: string;                // ISO 20275 ELF code when known (GLEIF uses these)
  localName: string;            // "Private limited company", "Aksjeselskap"
  normalized?: "limited_company" | "public_company" | "llp" | "partnership"
             | "sole_proprietor" | "cooperative" | "branch" | "other";
}
```

## 4. Identifiers

```ts
interface Identifier {
  scheme: IdentifierScheme;
  value: string;                // normalised (no spaces/punctuation); original in `raw`
  raw?: string;
  country?: CountryCode;
  status?: "active" | "lapsed" | "retired" | "unknown";   // e.g. LEI renewal status
  validated: boolean;           // checksum/format check passed (LEI ISO 17442 mod 97)
  provenance: Provenance[];
}

type IdentifierScheme =
  | "LEI"                       // ISO 17442, 20 chars
  | "GB_CRN"                    // Companies House number (NO_ORGNR and FI_YTUNNUS are implemented, D40)
  | "IE_CRO" | "NO_ORGNR" | "FI_YTUNNUS" | "DK_CVR" | "FR_SIREN" | "FR_SIRET"
  | "NL_KVK" | "BE_KBO" | "DE_HRB"      // grows with each country wave
  | "VAT"                       // value includes country prefix, e.g. "IE6388047V"
  | "EORI" | "FCA_FRN" | "CHARITY_NO" | "DUNS";
```

**Crosswalk rule:** identifiers link to the same `entityId` only when matched by (a) an exact identifier from a source stating both (e.g. GLEIF record lists registration authority + local number) or (b) a high-confidence match flagged in `MatchInfo`. Name-only matches never merge entities automatically.

## 5. Address, officers, ownership

```ts
interface Address {
  lines: string[];
  locality?: string; region?: string; postalCode?: string;
  country: CountryCode;
  formatted: string;            // single-line, as published
}

interface Officer {                 // PERSONAL DATA (D13)
  kind: "person" | "corporate";
  name: string;
  role: OfficerRole;                // normalised; plus sourceRole text
  sourceRole: string;
  appointedOn?: ISODate; resignedOn?: ISODate;
  active: boolean;
  birth?: { year?: number; month?: number; day?: number }; // as published
  nationality?: string; countryOfResidence?: string;
  address?: Address;
  corporateIdentifier?: Identifier; // when kind = corporate
  provenance: Provenance[];
}
type OfficerRole = "director" | "secretary" | "chair" | "ceo" | "board_member"
  | "authorised_signatory" | "liquidator" | "auditor" | "other";

// Ownership modelled as a graph (aligned with Open Ownership BODS ideas
// and GLEIF Level 2 relationships)
interface OwnershipGraph {
  rootEntityId: string;
  nodes: OwnershipNode[];           // entities and natural persons
  edges: OwnershipEdge[];
  depthReached: number;
  truncated: boolean;
}
interface OwnershipNode {
  nodeId: string;
  kind: "entity" | "person" | "state" | "unknown_owner";
  entityId?: string;                // for kind = entity
  name: string;
  identifiers?: Identifier[];
  personDetails?: { nationality?: string; birth?: { year?: number; month?: number }; countryOfResidence?: string };
}
interface OwnershipEdge {
  from: string; to: string;          // owner -> owned
  kind: "shareholding" | "voting_rights" | "board_control" | "other_control"
      | "direct_parent" | "ultimate_parent" | "branch_of";
  shareMin?: number; shareMax?: number;   // percent; bands as published (e.g. 25-50)
  isBeneficialOwnerLink: boolean;
  provenance: Provenance[];
}
```

## 6. Remaining families

```ts
interface Filing {
  date: ISODate;
  category: "accounts" | "annual_return" | "confirmation_statement" | "change_of_officers"
          | "change_of_address" | "charge" | "insolvency" | "other";
  description: string;
  documentUrl?: string;             // link only; we do not store documents
  provenance: Provenance[];
}

interface RegulatoryRecord {
  regulator: string;                // "FCA", "ESMA", "BaFin"...
  firmReference?: string;           // e.g. FRN
  status: "authorised" | "no_longer_authorised" | "registered" | "revoked" | "other";
  sourceStatusText: string;
  permissions?: string[];
  effectiveFrom?: ISODate; effectiveTo?: ISODate;
  provenance: Provenance[];
}

interface InsolvencyRecord {
  kind: "liquidation" | "administration" | "bankruptcy" | "restructuring"
      | "charge" | "lien" | "winding_up_petition" | "other";
  startDate?: ISODate; endDate?: ISODate;
  status: string;
  practitioners?: { name: string; role: string }[];
  provenance: Provenance[];
}

interface SanctionsScreening {
  screenedAt: ISODateTime;
  listsChecked: { list: "UK" | "EU" | "OFAC_SDN"; versionDate?: ISODate; state: "checked" | "unavailable"; stale?: boolean }[];
  result: "no_match" | "possible_match" | "match" | "incomplete";   // incomplete: a list missing/stale, or nothing screenable by name
  hits: SanctionsHit[];
  caveat: string;                   // screening is name-based and not a legal determination
}
interface SanctionsHit {
  list: string; listEntryId: string;
  matchedName: string; entryName: string;
  score: number;                    // 0-1
  basis: "exact_identifier" | "exact_name" | "fuzzy_name" | "alias";
  programme?: string; listedOn?: ISODate; remarks?: string;
}
```

## 7. Match info, coverage, errors

```ts
interface MatchInfo {
  confidence: number;               // 0-1
  band: "certain" | "high" | "medium" | "low";
  reasons: string[];                // "exact company number", "name similarity 0.93 after normalisation"
  warnings: string[];               // "different legal form suffix", "same name different country"
}

interface CoverageReport {
  jurisdiction: CountryCode;
  families: Record<FamilyName, {
    state: "full" | "partial" | "identity_only" | "none";
    sourcesTried: SourceId[];
    note?: string;
  }>;
}
type FamilyName = "identity" | "officers" | "ownership" | "filings" | "regulatory" | "insolvency" | "sanctions";
```

## 8. Source → model mapping (initial, from Phase 1 tests)

| Model field | Companies House | GLEIF | Brønnøysund (NO) | PRH (FI) | VIES |
|---|---|---|---|---|---|
| names | company_name, previous_company_names | entity.legalName | navn | names[] with dates | name (when returned) |
| identifiers | company_number → GB_CRN | lei, registeredAs | organisasjonsnummer | businessId.value | vat number |
| status | company_status | entity.status, registration.status | konkurs/underAvvikling flags | status fields (TBC) | isValid only |
| registeredAddress | registered_office_address | entity.legalAddress | forretningsadresse | addresses (TBC) | address (when returned) |
| officers | /officers | — | /roller | (TBC) | — |
| ownership | /persons-with-significant-control | Level 2 relationships | not in this API | (TBC) | — |
| filings | /filing-history | — | (TBC) | (TBC) | — |
| insolvency | /insolvency, /charges | — | status flags | (TBC) | — |

## 9. Adapter contract (preview for Phase 4)

```ts
interface CountryAdapter {
  country: CountryCode;
  capabilities: Record<FamilyName, "full" | "partial" | "none">;
  lookupByIdentifier(id: Identifier): Promise<PartialEntity>;
  search(query: string, opts): Promise<SearchHit[]>;
  getFamily<F extends FamilyName>(family: F, id: Identifier): Promise<Availability<...>>;
}
```
Each adapter returns `PartialEntity` pieces; a merger builds the `Entity`, computes `conflicts`, and fills `coverage`.

## 10. Design questions — resolved (Round 6)

1. Entity ID: D20 (`<country>:<registry>:<number>`).
2. Status vocabulary: D21 (12 values + group).
3. Ownership depth: D22 (default 3, cap 10, request budget).
4. Officer birth dates: D23 (as published).

Status: data model v0.2, ready for Phase 3 (tool design).
