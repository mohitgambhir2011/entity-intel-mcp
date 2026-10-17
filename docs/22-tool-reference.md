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
| `VAT` | `IE6388047V` | EU/VIES prefix (`EL` for Greece, `XI` Northern Ireland). `GB` VAT is not covered |

`entity_id` forms (D20, D33): `GB:CH:<number>` for UK companies, `ID:LEI:<lei>`, `ID:VAT:<vat>`,
`hash:<cc>:<h>` (name-derived; not directly lookable). An entity reachable by several identifiers has one
canonical id and lists the others in `aliases`.

## `search_entities`

Arguments: `query` (2-200 chars, required), `country`, `status` (`operating|distressed|ended|any`),
`limit` (1-25, default 10), `fresh`.

Behaviour:
1. If `query` is an identifier (valid LEI; VAT number with a valid per-country shape; UK number with a
   letter prefix, or digits with `country=GB`), it is resolved exactly and returned as one candidate with
   band `certain`.
2. Otherwise GLEIF and (if configured and `country` is GB or unset) Companies House are searched.
   Hits with the same normalised name and country from **different** sources are merged into one
   candidate; two records from one source stay separate.
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

Arguments: `entity_id` **or** `identifier`; optional `scheme` (`LEI|GB_CRN|VAT`), `country`, `fresh`.

`data` is the merged profile:

| Field | Meaning |
| --- | --- |
| `entityId`, `aliases` | Canonical id; other ids that redirect here |
| `names[]` | `legal` first, then `former` (with `validFrom/validTo`), each with provenance |
| `identifiers[]` | Union across sources; `validated` is true only if a checksum or the issuing service confirmed it |
| `legalForm` | `{ code? (ISO 20275), localName, normalized? }` |
| `status` | `{ normalized, group, sourceText }`. Normalised: `active, dormant, suspended, in_liquidation, liquidation_voluntary, liquidation_compulsory, in_administration, insolvent, merged_or_converted, dissolved, struck_off, unknown`. Group: `operating, distressed, ended, unknown` |
| `incorporationDate`, `dissolutionDate` | ISO dates, as published |
| `registeredAddress`, `headquartersAddress` | Lines + formatted string |
| `conflicts[]` | `{ field, values: [{ value, provenance }] }` where sources disagree; the headline value is the home registry's |
| `coverage.families` | Per data family: `available`, `not_yet_supported`, `unavailable`, `error`, with sources tried |
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

## `check_coverage`

Argument: `country` (optional ISO code). Returns every catalogued source with `enabled`, `reason`
(`enabled`, `missing credentials: NAME`, `not in EIM_ADAPTERS allow-list`, `not implemented yet`),
`requiredEnv` (names), `schemes`, plus `familiesSupported` and `familiesNotYetSupported`.

## Common warnings

| Warning | Meaning | What to do |
| --- | --- | --- |
| `Companies House not queried: missing credentials: COMPANIES_HOUSE_API_KEY` | UK data skipped | Set the key |
| `companies_house is unavailable (HTTP 503)` | Source failed after one retry | Retry later; the rest of the answer is still valid |
| `Local rate limit reached for companies_house; next slot in 41s` | Protecting your key | Wait or narrow the request |
| `Sources disagree on: status (see data.conflicts)` | Registries differ | Inspect `conflicts`; treat as a finding, not an error |
| `This looks like a company number; add country=GB ...` | Bare digits in a name search | Repeat with `country=GB` |
