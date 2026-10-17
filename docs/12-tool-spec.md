# Phase 3 — MCP tool specification (DRAFT v0.1)

> **Implementation status (2026-10-17):** `check_coverage`, `search_entities`, `get_entity` (identity family only), `resolve_identifier`, `get_officers`, `get_ownership`, `get_filings_and_insolvency` (UK: filings, charges, insolvency; no `since` filter, `category` instead) and `screen_sanctions` are implemented. The `kyb_check` prompt is not. Differences from the sections below: inputs are flat (D33); `screen_sanctions` uses lists `UK | EU | OFAC_SDN` (D36), adds `incomplete` (D37) and `include` for officers / owners (D39); `get_officers` covers the UK and Norway, `get_ownership` the UK only, and other countries report why (D38, D40). The authoritative description is [22-tool-reference.md](22-tool-reference.md).

Implements D24 (8 tools + prompt), D25 (response shape), D26 (search), D27 (sanctions), D28 (errors). Types refer to `11-data-model.md`. Transport: stdio (D10). Server name: `entity-intel-mcp`.

## 0. Conventions

**Response envelope (all tools):**
```ts
interface ToolResult<T> {
  summary: string;                 // 1-3 plain-language sentences, read first
  warnings: string[];              // partial data, missing keys, stale cache, truncation
  data: T;
  meta: {
    entityId?: string;
    sourcesQueried: SourceId[];
    retrievedAt: ISODateTime;
    fromCache: boolean;
    page?: { total: number; limit: number; offset: number };
  };
  disclaimer?: string;             // personal-data notice (D13) on tools returning people data
}
```
**Inputs common to entity tools (amended by D33):** flat arguments `entity_id` **or** `identifier`, plus optional `scheme` (LEI | GB_CRN | VAT), `country`, `fresh`. Exactly one of `entity_id` / `identifier` is required. Names are never accepted here (D26). Wherever this spec says `entity`, read it as these arguments.
**Common options:** `fresh?: boolean` (bypass cache, D7), `limit?` (default 25), `offset?`.
**Annotations:** all tools are read-only, idempotent, open-world (they call external services).

## 1. Tools

### 1.1 `search_entities`
Find candidate entities.
- Input: `query: string` (name, or an identifier-looking string), `country?: CountryCode`, `status?: "operating"|"distressed"|"ended"|"any"` (default any), `limit?` (default 10, max 25).
- Behaviour: if `query` parses as a known identifier (LEI checksum, GB company number, VAT, Norwegian orgnr…), resolve exactly and return one `certain` candidate. Otherwise fan out to search endpoints for relevant countries (all supported, or `country`), normalise names (strip legal-form suffixes for scoring only), score, dedupe across sources, rank.
- Output `data`: `{ candidates: { entityId, names[0], jurisdiction, status, identifiers[], match: MatchInfo }[] }`.
- Warnings: countries not searched (no adapter/credentials), "name-only matches, verify identifier".

### 1.2 `get_entity`
Unified profile.
- Input: `entity`, `include?: ("identity"|"officers"|"ownership"|"filings"|"regulatory"|"insolvency"|"sanctions")[]` (default: identity + regulatory + sanctions summary + `coverage`).
- Behaviour: heavy families are opt-in to keep responses small. Merges sources, fills `conflicts`.
- Output `data`: `Entity` (families not requested are omitted, not shown as unavailable).

### 1.3 `resolve_identifier`
Crosswalk between identifier schemes.
- Input: `identifier: { scheme?, value, country? }` (scheme optional → auto-detect).
- Output `data`: `{ entityId, identifiers: Identifier[], detectedScheme, validated: boolean, notes[] }` — e.g. LEI → GB company number + VAT, with VIES validity.

### 1.4 `get_officers`
- Input: `entity`, `activeOnly?: boolean` (default true), `role?`, paging.
- Output `data`: `Availability<Officer[]>`. Includes personal data → `disclaimer` (D13). DOB at published precision (D23).

### 1.5 `get_ownership`
- Input: `entity`, `depth?` (default 3, max 10, D22), `minShare?: number`, `includePersons?: boolean` (default true).
- Behaviour: walks edges from GLEIF Level 2, Companies House PSC and country sources; stops at `depth`, request budget, or unresolvable owners; marks `truncated`.
- Output `data`: `Availability<OwnershipGraph>`; per-country restricted data returns `unavailable: restricted_access` rather than empty.

### 1.6 `get_filings_and_insolvency`
- Input: `entity`, `include?: ("filings"|"insolvency"|"charges")[]`, `since?: ISODate`, paging.
- Output `data`: `{ filings: Availability<Filing[]>, insolvency: Availability<InsolvencyRecord[]> }`. Document links only, no downloading.

### 1.7 `screen_sanctions`
- Input: `entity?` (screen the entity, its officers and owners if `scope` says so) **or** `name: string` + `country?`; `scope?: ("entity"|"officers"|"owners")[]` (default entity); `lists?: ("OFSI"|"EU"|"OFAC_SDN")[]` (default all).
- Behaviour: local index of downloaded lists (OFSI ~54 MB, EU ~26 MB, OFAC SDN), refreshed daily; thresholds per D27.
- Output `data`: `SanctionsScreening` with list version dates and fixed caveat.

### 1.8 `check_coverage`
- Input: `country?: CountryCode`.
- Output `data`: coverage matrix per country and family (`full|partial|identity_only|none`), which credentials are configured (names only, never values), and which adapters are enabled.
- Purpose: lets the assistant tell the user up front what a lookup can and cannot return.

## 2. MCP prompt

### `kyb_check`
Arguments: `entity` (identifier or name), `country?`, `depth?`.
Instruction text steers the assistant to: (1) `check_coverage`; (2) `search_entities` or `resolve_identifier`; ask the user to confirm the candidate if confidence < `high`; (3) `get_entity` with identity, regulatory; (4) `get_ownership`, `get_officers`; (5) `screen_sanctions` with scope entity+officers+owners; (6) `get_filings_and_insolvency`; (7) produce a report with sections for findings, gaps (every `unavailable`/`error`), conflicts, and source citations. States clearly that it is not legal advice.

## 3. MCP resources (optional, v1.1)
- `entity://{entityId}` — last fetched profile (read from cache).
- `coverage://matrix` — coverage table.

## 4. Safety rules baked into tool design
1. **Registry text is untrusted.** Names, remarks and free-text fields are returned in `data` fields only, never concatenated into `summary`/`warnings`, and the server description tells the client to treat registry content as data, not instructions.
2. **No write actions.** The server never sends messages or changes anything outside its own cache.
3. **Secrets never echoed.** `check_coverage` lists env var names and configured/not configured only.
4. **Input validation** with zod: identifier formats, country codes, bounds on `limit`, `depth`.
5. **Audit log** (D14): one metadata row per tool call.

## 5. Open items for Phase 4
- Exact zod schemas and JSON Schema export.
- Request-budget values per source for ownership traversal.
- Whether `get_entity` should auto-include a sanctions summary by default (currently yes, cheap after local index).
