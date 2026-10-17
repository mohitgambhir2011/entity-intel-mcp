# Phase 4 — Architecture (DRAFT v0.1)

> **Implementation status (2026-10-17):** the layers `core`, `resolution`, `infra`, `adapters`, `services`, `server` exist and the layering below is enforced by `test/architecture.test.ts`. Differences from this plan: crosswalks are an adapter capability (`SourceAdapter.crosswalks`), the adapter catalogue in `src/adapters/registry.ts` owns construction, text folding lives in `core/text.ts`, source priority in `core/sources.ts`, tools are one file each. Sanctions are built (`src/sanctions/`, `services/screen.ts`, `screen_sanctions`): lists are cached as parsed snapshots in the shared cache and indexed in memory rather than stored in dedicated SQLite tables. Not built yet: `--clear-cache`, ownership traversal. Authoritative module descriptions: [20-modules.md](20-modules.md).

Implements D9 (TypeScript), D10 (stdio), D11 (SQLite), D29–D32. Data model: `11-data-model.md`. Tools: `12-tool-spec.md`.

## 1. Layers

```
MCP client (Claude Desktop / Code)
        │  stdio, JSON-RPC
┌───────▼─────────────────────────────────────────────────┐
│ server/        MCP server: tool + prompt registration,  │
│                zod input schemas, envelope builder      │
├─────────────────────────────────────────────────────────┤
│ services/      Orchestration (one per tool):            │
│                search, getEntity, ownership, sanctions… │
│                fan-out to adapters, merge, conflicts,   │
│                coverage, warnings                       │
├──────────────┬───────────────┬──────────────────────────┤
│ resolution/  │ sanctions/    │ core/                    │
│ normalise,   │ list download,│ types (from 11-), ids,   │
│ score, dedupe│ parse, index, │ identifier validators,   │
│              │ match         │ errors, config           │
├──────────────┴───────────────┴──────────────────────────┤
│ adapters/      one folder per source/country            │
│   gleif  vies  gb  ie  no  fi  fr  nl  be  …            │
│   each implements CountryAdapter (11-data-model §9)     │
├─────────────────────────────────────────────────────────┤
│ infra/         http client (rate limit, retry, UA),     │
│                cache (TTL), audit log, storage iface    │
│                └─ sqlite (node:sqlite)                  │
└─────────────────────────────────────────────────────────┘
        │ HTTPS                       │ local file
   registries / GLEIF / VIES     entity-intel.db (cache, audit, sanctions index)
```
Rules: dependencies point downward only. `adapters/` never import `services/`. `server/` contains no business logic.

## 2. Project structure (target)

```
entity-intel-mcp/
├─ LICENSE                      Elastic License 2.0 (D15)
├─ README.md  CONTRIBUTING.md  CLA.md  SECURITY.md
├─ package.json  tsconfig.json  vitest.config.ts  eslint.config.js
├─ docs/                        00-PLAN … 13-architecture, decisions (copied, D29)
├─ src/
│  ├─ index.ts                  entry: stdio transport
│  ├─ server/                   tools/*.ts, prompts/kyb-check.ts, envelope.ts
│  ├─ services/
│  ├─ core/                     types.ts, ids.ts, identifiers/ (lei, gb, vat…), config.ts, errors.ts
│  ├─ resolution/               normalise.ts, legal-forms/*.json, score.ts
│  ├─ sanctions/                sources/{ofsi,eu,ofac}.ts, index.ts, match.ts
│  ├─ adapters/
│  │   ├─ registry.ts           enable/disable logic (D32)
│  │   ├─ gleif/  vies/  gb-companies-house/  gb-fca/  no-brreg/  fi-prh/  ie-cro/
│  └─ infra/                    http.ts, ratelimit.ts, cache.ts, audit.ts, storage/{index,sqlite}.ts
├─ test/
│  ├─ fixtures/<adapter>/*.json recorded responses (D16-B)
│  ├─ golden/entities.yaml      golden set (D16-A)
│  └─ unit/ integration/
└─ scripts/                     record-fixtures.ts, check-licences.ts
```

## 3. Key mechanisms

### 3.1 Configuration (env vars only, D10/D19)
| Variable | Purpose | Default |
|---|---|---|
| `COMPANIES_HOUSE_API_KEY` | GB adapter | — (adapter off) |
| `FCA_AUTH_EMAIL`, `FCA_AUTH_KEY` | FCA adapter | — (off) |
| `EIM_ADAPTERS` | allow-list, e.g. `gb,no,fi` | all with credentials |
| `EIM_DB_PATH` | SQLite file | OS user data dir |
| `EIM_CACHE_TTL_*` | per-source TTL overrides | per D7 table |
| `EIM_PERSONAL_DATA_TTL_DAYS` | retention for officer/PSC cache (D11) | 30 |
| `EIM_AUDIT_RETENTION_DAYS` | audit log retention (D14) | 365 |
| `EIM_SANCTIONS_MATCH` / `_POSSIBLE` | thresholds (D27, D37), range 0.5-1, possible <= match | 0.95 / 0.80 |
| `EIM_EU_SANCTIONS_URL` | replacement https URL for the EU list (D36) | built-in public URL |
Missing optional credential → adapter disabled, reported in `check_coverage`, never an exception at startup.

### 3.2 HTTP client
Single wrapper around `fetch`: per-host token bucket (Companies House 600/5 min using returned `X-Ratelimit-*` headers; FCA conservative 10/10 s until verified; others default 5 req/s), one retry with jittered backoff on 429/5xx, 20 s timeout, `User-Agent: entity-intel-mcp/<version>`, response size cap, no redirects to other hosts, secrets redacted from logs. Never log full URLs with query strings containing names (privacy).

### 3.3 Cache and storage
Interface `Storage` (get/put with TTL, tables for cache, audit, sanctions index, aliases). SQLite default. Cache key = source + endpoint + normalised params. Entries carry `fetchedAt`, `ttl`; stale entries are never served silently (D28) — if a refresh fails and stale data is used, the result is marked stale in `warnings`. Personal-data entries get the shorter TTL (D11). `clear_cache` is a CLI flag (`entity-intel-mcp --clear-cache`), not an MCP tool, so an assistant cannot trigger it.

### 3.4 Sanctions index
On first use and daily after: download OFSI/EU/OFAC files to temp, parse with fast-xml-parser, normalise names + aliases + identifiers, store in SQLite with list version date. Matching = exact identifier → exact normalised name → fuzzy (Levenshtein + token-set similarity). Refresh failure keeps the old index and adds a staleness warning with the list date.

### 3.5 Entity resolution
`normalise()` lowercases, strips diacritics, removes punctuation, strips legal-form suffixes from a per-country table (Ltd, PLC, LLP, GmbH, AG, S.A., B.V., N.V., AS, ASA, Oy, A/S, ApS, SAS, DAC, …) for scoring only. Score combines token-set similarity, prefix match and country/status signals. Output: confidence band + reasons + warnings (D26).

### 3.6 Merge and conflicts
Merger takes `PartialEntity` from each adapter, groups by entityId (D20), prefers the home-country registry for identity/status, GLEIF for LEI and parent relationships, and records a `Conflict` when normalised values differ (status, address, name).

### 3.7 Audit
One row per tool call: timestamp, tool, identifier or name hash (D14 says identifier; names are stored as given for search — confirm), adapters called, cacheHit. No result bodies.

### 3.8 Security
- All registry text treated as untrusted: only placed in `data`, never in `summary`/`warnings`; server instructions say so.
- Strict zod validation; bounded `limit`/`depth`; request budgets.
- No shell, no filesystem access beyond the DB path and temp download dir; no dynamic code loading.
- Dependencies pinned via lockfile; `npm audit` in CI; keys only from env; secrets redacted.
- Supply chain: minimal dependencies (D31).

### 3.9 Testing (D16)
Unit tests for identifiers, normaliser, scoring, merge. Adapter tests replay recorded fixtures (script re-records on demand, scrubbing keys). Golden set: ~50–100 entities with expected fields, run in CI against fixtures and optionally live (`npm run test:live`, keys required). Manual KYB trial before release.

### 3.10 Distribution
`npx entity-intel-mcp`; package `bin` points at compiled `dist/index.js`; Claude Desktop config snippet in README; versioned with semver; ELv2 LICENSE included; CLA bot/check on PRs.

## 4. Build order (maps to Phase 5)
1. Scaffold: repo, tsconfig, lint, test, CI, LICENSE, docs copy.
2. core: types, identifiers, ids, config, errors.
3. infra: http, ratelimit, storage/sqlite, cache, audit.
4. adapters: gleif, vies, gb-companies-house.
5. services + tools: `check_coverage`, `resolve_identifier`, `get_entity` (identity).
6. sanctions: ofsi, eu, ofac + `screen_sanctions`.
7. `search_entities` with resolution; `get_officers`; `get_ownership` (PSC + GLEIF L2).
8. gb-fca; `get_filings_and_insolvency`.
9. Wave 1: no-brreg and fi-prh (done, D40), dk-cvr (after access), ie-cro.
10. `kyb_check` prompt, README, golden set, manual KYB trial, release.

## 5. Open items
- Audit log: store the searched name or only a hash? (conflicts slightly with D14 wording "identifier looked up").
- Whether to ship a `--clear-cache` / `--export-audit` CLI in v1.
- Sweden (Bolagsverket), Denmark access status.
