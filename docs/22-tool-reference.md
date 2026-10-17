# Tool reference (implemented tools)

Audience: people and agents using the server. This documents what the code does **today**; the design
of the full set is in [12-tool-spec.md](12-tool-spec.md). Examples are real responses built from recorded
fixtures (`npx tsx scripts/print-examples.ts <tool>`), trimmed.

## Response envelope (all tools)

```jsonc
{
  "summary": "Server-written sentence. Never contains registry text.",
  "warnings": ["Server-written. Partial data, skipped sources, conflicts, truncation."],
  "data": { /* tool-specific; registry text lives only here */ },
  "meta": {
    "entityId": "GB:CH:00445790",          // when the call resolved to one entity
    "sourcesQueried": ["companies_house", "gleif"],
    "retrievedAt": "2026-10-17T11:40:42.418Z",  // time of the call; per-field times are in provenance
    "fromCache": false,                    // true only if all data came from cache
    "page": { "total": 33, "limit": 10, "offset": 0 }   // lists only
  },
  "disclaimer": "present on tools that return personal data (none yet)"
}
```

Errors: invalid input, or "no entity found", is returned as an MCP tool error (`isError: true`) with a
plain-text, actionable message. Source problems are **warnings** on a successful call (D28).

Read-only, idempotent. `openWorldHint` is true except for `check_coverage`.

## Identifiers and entity ids

| Scheme | Example | Notes |
| --- | --- | --- |
| `LEI` | `2138002P5RNKC5W2JZ46` | ISO 17442; checksum validated |
| `GB_CRN` | `00445790`, `SC123456` | Companies House number; digits are zero-padded to 8; bare digits need `country=GB` |
| `NO_ORGNR` | `923609016`, `923 609 016`, `NO923609016MVA` | Norwegian organisation number: 9 digits, mod-11 check digit (validated before any request). The `NO...MVA` VAT form is recognised without a scheme; bare digits need `country=NO` |
| `FI_YTUNNUS` | `0112038-9`, `01120389`, `112038-9` | Finnish business ID: 7 digits and a check digit (validated before any request); the hyphenated form is recognised without a scheme, bare digits need `country=FI`; the leading zero may be omitted |
| `VAT` | `IE6388047V`, `FI01120389` | EU/VIES prefix (`EL` for Greece, `XI` Northern Ireland). `GB` VAT is not covered. A Finnish VAT number is linked to the business ID; a Norwegian one (`NO...MVA`) is read as `NO_ORGNR`, also with `scheme=VAT` |

`entity_id` forms (D20, D33, D40): `GB:CH:<number>` for UK companies, `NO:BR:<orgnr>` for Norwegian,
`FI:PRH:<business id>` for Finnish, `ID:LEI:<lei>`, `ID:VAT:<vat>`, `hash:<cc>:<h>` (name-derived; not
directly lookable). An entity reachable by several identifiers has one canonical id and lists the
others in `aliases`.

## `search_entities`

Arguments: `query` (2-200 chars, required), `country`, `status` (`operating|distressed|ended|any`),
`limit` (1-25, default 10), `fresh`.

Behaviour:
1. If `query` is an identifier (valid LEI; VAT number with a valid per-country shape; Norwegian
   `NO...MVA`; Finnish `0112038-9`; UK number with a letter prefix; or digits with `country=GB`, `NO`
   or `FI`), it is resolved exactly and returned as one candidate with band `certain`.
2. Otherwise the registers and GLEIF are searched: Companies House (when configured), Enhetsregisteret
   and PRH. With `country` set, only that country's register and GLEIF are asked (`country=NO` never
   calls Companies House or PRH). Hits with the same normalised name and country from **different**
   sources are merged into one candidate; two records from one source stay separate. A ceased
   Finnish company is still found (its last official name is its legal name).
3. Candidates are scored (`match.confidence` 0-1, band `high` >= 0.9, `medium` >= 0.7, else `low`),
   sorted, and capped at `limit`. `page.total` is the number before the cap.

Candidate warnings you may see: `different legal form suffix`, `entity status is dissolved`,
`several entities share this name: verify by identifier`, `same name also appears in another country`.

```jsonc
// search_entities { "query": "Tesco PLC", "country": "GB", "limit": 2 }
{
  "summary": "5 candidate(s); showing 2. Verify the right one before use.",
  "warnings": [],
  "data": { "candidates": [
    { "entityId": "GB:CH:00445790", "name": "TESCO PLC", "jurisdiction": "GB",
      "status": { "normalized": "active", "group": "operating", "sourceText": "active" },
      "identifiers": [ { "scheme": "GB_CRN", "value": "00445790", "country": "GB" },
                       { "scheme": "LEI", "value": "2138002P5RNKC5W2JZ46", "country": "GB" } ],
      "sources": ["companies_house", "gleif"],
      "match": { "confidence": 1, "band": "high",
                 "reasons": ["names are identical", "same name and country in 2 sources"], "warnings": [] } },
    { "entityId": "ID:LEI:JL5Y1BHW3R0NH5H6C288", "name": "TESCO PLC PENSION SCHEME",
      "match": { "confidence": 0.75, "band": "medium", "reasons": ["query matches the start of the name"], "warnings": [] } }
  ] }
}
```

Guidance for assistants: never act on a `medium`/`low` candidate without confirming by identifier,
country and address; call `get_entity` with the chosen `entityId`.

## `get_entity`

Arguments: `entity_id` **or** `identifier`; optional `scheme` (`LEI|GB_CRN|NO_ORGNR|FI_YTUNNUS|VAT`), `country`, `fresh`.

`data` is the merged profile:

| Field | Meaning |
| --- | --- |
| `entityId`, `aliases` | Canonical id; other ids that redirect here |
| `names[]` | `legal` first, then `former` (with `validFrom/validTo`), each with provenance |
| `identifiers[]` | Union across sources; `validated` is true only if a checksum or the issuing service confirmed it |
| `legalForm` | `{ code? (ISO 20275), localName, normalized? }` |
| `status` | `{ normalized, group, sourceText }`. Normalised: `active, dormant, suspended, in_liquidation, liquidation_voluntary, liquidation_compulsory, in_administration, insolvent, merged_or_converted, dissolved, struck_off, unknown`. Group: `operating, distressed, ended, unknown` |
| `incorporationDate`, `dissolutionDate` | ISO dates, as published. Norway: the founding date only (never the date the unit entered the register). Finland: the trade-register registration. Sources can differ by a day (Nokia: PRH 1896-12-19, GLEIF 1896-12-18), which appears in `conflicts` |
| `registeredAddress`, `headquartersAddress` | Lines + formatted string |
| `conflicts[]` | `{ field, values: [{ value, provenance }] }` where sources disagree; the headline value is the home registry's |
| `coverage.families` | Per data family: `available`, `not_yet_supported`, `unavailable`, `error`, with sources tried and a `note`. `officers` and `ownership` are worked out for this company (a Finnish profile says officers are not published; a Norwegian one says ownership is restricted) |
| `sources` | Sources that contributed |

Every value is `{ value, provenance: [{ source, sourceRecordId, sourceUrl?, retrievedAt, fromCache, licence? }] }`.

Errors: `No entity found for <scheme> <value>.` (with any source warnings appended) when no source has a
record; input errors (malformed LEI, UK VAT number, `hash:` ids).

## `resolve_identifier`

Same arguments. Returns `found`, `entityId`, `aliases`, `detectedScheme`, `validated`, `identifiers[]`
(each with `status`, `validated`, `sources`) and `notes` (for example `DE does not release the registered
name through VIES`, or `VIES reports this VAT number as not valid or not registered`). When nothing is found
it returns `found: false` as a normal result, not an error.

```jsonc
// resolve_identifier { "identifier": "2138002P5RNKC5W2JZ46" }
{ "summary": "Resolved to GB:CH:00445790; 2 identifier(s) known.", "warnings": [],
  "data": { "found": true, "entityId": "GB:CH:00445790", "aliases": ["ID:LEI:2138002P5RNKC5W2JZ46"],
            "detectedScheme": "LEI", "validated": true,
            "identifiers": [ { "scheme": "LEI", "value": "2138002P5RNKC5W2JZ46", "status": "active", "validated": true, "sources": ["gleif"] },
                             { "scheme": "GB_CRN", "value": "00445790", "validated": true, "sources": ["gleif", "companies_house"] } ],
            "notes": [] } }
```

## `get_officers`

Arguments: entity reference (`entity_id` or `identifier`, optional `scheme`, `country`, `fresh`), `active_only` (default true), `role` (`director|ceo|chair|board_member|deputy|secretary|llp_member|manager|auditor|accountant|authorised_signatory|other`), `limit` (1-100, default 25), `offset`.

`data.officers` is an availability object: `available` with `officers[]` (current first, then newest appointment), `matching` (after filters), `registryTotal`, `activeCount`, `resignedCount`, `truncated` and record-level `provenance`; or `not_yet_supported` (no register for the company's country is built yet; the detail lists the countries covered); `unavailable` with a reason - `not_published_by_source` (Finland), `requires_credentials` (UK without a key), `not_enabled` (switched off by `EIM_ADAPTERS`), `no_such_record`; or `error`. `truncated` is also set when the register listed roles that could not be read (then `registryTotal` is the register's count and a warning says how many were readable).

**Norway** (Enhetsregisteret): the board (`chair`, `board_member`, `deputy`), `ceo`, `auditor`, `accountant` and `authorised_signatory`, with `sourceRole` such as `DAGL Daglig leder`. Persons carry the full `birth` date as Norway publishes it (D23) and `deceased`; corporate roles (the auditor) carry their `NO_ORGNR`. A role is `active` unless the register marks it resigned (`fratraadt`) or deregistered (`avregistrert`). Norway publishes **no appointment dates**, so `appointedOn` is absent. Each officer: `kind` (`person|corporate`), `name` as published ("SURNAME, Forenames"), `displayName` ("Forenames SURNAME", titles dropped), `role` + `sourceRole`, `appointedOn`, `resignedOn`, `active`, `birth` (month and year, as the register publishes), `nationality`, `countryOfResidence`, `occupation`, `address`, `corporateIdentifier` (UK number of a corporate officer). Up to 500 officers are fetched (5 pages); more is flagged as `truncated`. Carries a personal-data `disclaimer`.

## `get_ownership`

Arguments: entity reference, `depth` (1-10, default 3), `include_ceased` (default false), `include_persons` (default true; false only counts individuals in `personsOmitted`).

`data.ownership` (availability object as above) holds a graph: `nodes[]` (`nodeId`, `kind entity|person`, `name`, `level`, `terminal` + `terminalDetail` where a chain ends), `edges[]` (`from` = controller, `to` = controlled company, `natures{ codes, sharesMin/Max, votingMin/Max, appointsDirectors, significantInfluence }`, `notifiedOn`, `ceasedOn`, `active`), `ultimateOwners[]` (nodes nobody in the graph owns), `depthReached`, `companiesExpanded` (at most 30 per call), `truncated` and `cutBy` (`depth` is by design; `budget`, `size`, `error`, `registry` lose information), `provenance[]`.

Companies outside the UK: Norway and Finland answer `unavailable` with `restricted_access` and a detail saying beneficial owners are not published openly there; other countries answer `not_yet_supported`.

Terminal reasons: `natural_person`, `exempt` (only exemptions in force today), `statement` (e.g. "no person or entity with significant control"), `all_ceased`, `no_controllers_published`, `not_followable` (registered outside Companies House or without details), `redacted` (protected identity), `depth_limit`, `budget`, `error`. Person node ids are pseudonymous hashes of the published identity (one person = one node across the graph). Real example (`00519500`): Tesco Stores Limited <- Tesco Holdings Limited (75-100% shares and voting, right to appoint directors) <- Tesco Plc (terminal `exempt`: shares traded on a regulated market).

## `get_filings_and_insolvency`

Arguments: entity reference, `include` (any of `filings|charges|insolvency`, at least one; default all), `category` (a registry filing category such as `accounts`, `confirmation-statement`, `capital`, `change-of-name`, `incorporation`, `liquidation`, `officers`, `resolution`; lower-case letters and hyphens only), `limit` (1-100, default 25) and `offset` for the filings.

`data` holds `company`, `families` (those requested) and one availability object per family (`available` with data, `unavailable` with a reason - `requires_credentials`, `not_enabled`, `no_such_record` -, `not_yet_supported` for countries without an adapter, or `error` with a warning):

- `filings.data`: `items[]` (`transactionId`, `date`, `category`, `type` such as `AA` or `SH06`, `description` (the registry's code), `actionDate`, `paperFiled`, `pages`, `documentUrl` only when it points at the registry's document API), `total` (matching the category on the register), `offset`. `meta.page` carries total, limit and offset. The filing text is the registry's wording and is untrusted.
- `charges.data`: `charges[]` (`number`, `status`, `createdOn`, `deliveredOn`, `satisfiedOn`, `classification`, `particulars` cut to 300 characters, `personsEntitled`), `total`, `outstanding` (everything not fully satisfied, so a part-satisfied charge counts), `satisfied`, `partSatisfied`, `truncated`. At most 500 charges are fetched; more is flagged with a warning. A 404 on the charges endpoint is reported as `unavailable: no_such_record`, never as "no charges".
- `insolvency.data`: `cases[]` (`number`, `type`, `dates[]`, `practitioners[]` with `name`, `role`, `appointedOn`, `ceasedToActOn`) and `statusFlags`. Companies House answers 404 for a company with no insolvency record, which is reported as an empty `cases` list. When the company's status says it is in liquidation or insolvent but no case is listed, a warning says to check the register.

Personal data: practitioners and charge holders can be named individuals, so these two families are cached as personal data (capped lifetime) and the response carries the personal-data disclaimer when either is present.

Real example (Tesco PLC, `00445790`): 8,372 filings (newest `SH03`), 9 charges of which 2 outstanding, no insolvency case. A liquidated Northern Ireland company (`NI017460`): status `in_liquidation`, one `compulsory-liquidation` case.

## `screen_sanctions`

Arguments: `name` (2-200 chars) **or** an entity (`entity_id` / `identifier` + optional `scheme`, `country`); `type` (`person|entity|any`, for names); `lists` (subset of `UK|EU|OFAC_SDN`, default all); `fresh` (re-download the lists).

Behaviour:
1. Each requested list is loaded (downloaded at most once per 24 h, cached as a parsed snapshot, indexed in memory). Matching is done locally: the name you screen is never sent to a list publisher.
2. A **name** is compared with every designated name and alias; an **entity** is first resolved (as in `get_entity`) and then screened under its legal, former and trading names **and** its LEI / UK company number / VAT number against the registration numbers on the lists (entities only, 8+ characters; personal documents are never read). Norwegian and Finnish registry numbers are deliberately **not** compared with list identifiers (the lists store identifiers without their type, a bare 8-9 digit number can equal an unrelated passport or tax number, and an identifier hit scores 1.0), so those companies are screened by name, LEI and VAT.
3. Scores: 1.0 identical after normalisation (case, punctuation, diacritics, legal form such as Ltd/PJSC/GmbH); 0.98 same words, different order; fuzzy edit-distance below that (names of 8+ characters only); 0.85 when all words of a distinctive multi-word name are contained in the other. Aliases the list marks low quality are capped below the match threshold.
4. **Result**: `match` (top score >= 0.95 or an exact registration number), `possible_match` (>= 0.80), `no_match`, or `incomplete`.

`incomplete` means "this is not a clear result". It is returned when any requested list could not be loaded, is cut off or older than 45 days, or when the entity has no published name (for example a German VAT number, whose name VIES withholds). A hit found on the lists that did load is still reported as `match`/`possible_match` with a warning.

Every response carries the list versions and the caveat in `disclaimer`. Identifier hits add a warning: numbers are compared without the issuing country, so check the jurisdiction. Up to 25 hits are returned, highest score first.

```jsonc
// screen_sanctions { "name": "BNK UK Limited", "type": "entity" }
{
  "summary": "Result: match; 1 hit(s); 3 of 3 list(s) checked. Name-based screen, not a legal determination: review every hit.",
  "warnings": [],
  "data": {
    "screening": {
      "screenedAt": "2026-10-17T13:20:11.000Z",
      "result": "match",
      "listsChecked": [
        { "list": "UK", "state": "checked", "versionDate": "2026-10-16", "fetchedAt": "...", "entries": 6408, "ageDays": 1 },
        { "list": "EU", "state": "checked", "versionDate": "2026-10-15", "entries": 6234, "ageDays": 2 },
        { "list": "OFAC_SDN", "state": "checked", "versionDate": "2026-10-15", "entries": 19457, "ageDays": 2 }
      ],
      "hits": [
        { "list": "UK", "entryId": "BEL0107", "entryName": "BNK (UK) Ltd", "matchedName": "BNK UK Limited",
          "score": 1, "basis": "exact_name", "subjectType": "entity",
          "programmes": ["The Republic of Belarus (Sanctions) (EU Exit) Regulations 2019"],
          "listedOn": "2021-06-21", "countries": ["United Kingdom"] }
      ],
      "thresholds": { "match": 0.95, "possible": 0.8 },
      "caveat": "This is an automated, name- and identifier-based screen ..."
    },
    "screened": { "names": ["BNK UK Limited"], "identifiers": [] }
  }
}
```

**Officers and owners.** With `include: ["officers", "owners"]` (needs `entity_id` / `identifier`; officers for UK and Norwegian companies, owners for UK companies; a group the company's country does not provide is reported with its reason and makes `overall` `incomplete`) the response gains `data.overall` (the worst result across the entity and every party) and `data.related`: `officers` and `owners` blocks (`requested`, `state`, `subjects`, `notScreenable`, `incomplete`), `screened` (names screened, personal data), and `hits[]` for parties with a `match` / `possible_match` (`relations`, `description`, `result`, `score`, up to 3 hits without list remarks; at most 25 parties). Officers are current ones (up to 100); owners are followed `owners_depth` levels (default 3). `overall` is `incomplete` when a requested group is unavailable, was cut short by an error, the request budget or size, has more than 100 officers, or contains protected identities; reaching the depth limit is stated in a warning but does not by itself force `incomplete`. Individuals are matched by name only, so any hit on a person warns you to confirm identity.

Hit `basis`: `exact_identifier`, `exact_name` (primary designated name), `alias` (an alias matched exactly), `fuzzy_name`. `weakAlias: true` marks a match to a low-quality alias. `remarks` is list text (untrusted, capped at 300 characters).

Errors: neither or both of name and entity given; a name with no letters or digits; an entity that cannot be found ("nothing to screen").

## `check_coverage`

Argument: `country` (optional ISO code). Returns every catalogued source with `enabled`, `reason`
(`enabled`, `missing credentials: NAME`, `not in EIM_ADAPTERS allow-list`, `not implemented yet`),
`requiredEnv` (names), `schemes`, the state of each sanctions list (`not_loaded`, `loading`, `loaded` with version date and entry count, or `error`), plus `familiesSupported` (the officer and ownership countries come from the enabled adapters, for example `officers (GB, NO: get_officers)`) and `familiesNotYetSupported`.

## Common warnings

| Warning | Meaning | What to do |
| --- | --- | --- |
| `Companies House not queried: missing credentials: COMPANIES_HOUSE_API_KEY` | UK data skipped | Set the key |
| `companies_house is unavailable (HTTP 503)` | Source failed after one retry | Retry later; the rest of the answer is still valid |
| `Local rate limit reached for companies_house; next slot in 41s` | Protecting your key | Wait or narrow the request |
| `Sources disagree on: status (see data.conflicts)` | Registries differ | Inspect `conflicts`; treat as a finding, not an error |
| `The register lists 136 charges but only 100 could be read` | More charges than the 500 fetched, or a page failed | The list is incomplete; check the register |
| `The company's status is distressed but the registry lists no insolvency case` | Status and case list disagree | Check the register directly |
| `This looks like a company number; add country=GB, country=NO or country=FI ...` | Bare digits in a name search | Repeat with the right `country` |
| `The registry lists 16 officers but only 15 could be read` | The register listed roles the server could not read (no usable name) | The list is incomplete; a screen built on it is `incomplete` |
| `brreg_no is unavailable (HTTP 500)` / `... is rate limiting requests (HTTP 429)` | The Norwegian (or Finnish) register failed after one retry | The profile still holds what GLEIF and the others said; retry later |
| `EU could not be checked: ...` / `Not all requested lists were checked, so this is NOT a clear result` | A sanctions list failed to load | Retry; never treat `incomplete` as clear |
| `UK is 21 days old (version ...): the publisher may have stopped updating it` | List older than 14 days (over 45 days it forces `incomplete`) | Check the publisher; try `fresh: true` |
| `This entity has no published name, so it was screened by identifier only` | VIES withheld the name | Screen by the company's name once known |
