# Changelog

All notable changes. Dates are absolute. Versions follow semver; 0.x may change without notice.

## [Unreleased]

### Added

- **`get_officers` and `get_ownership`** (UK, Companies House): officers with roles, dates and published personal details; the PSC chain followed upwards (default 3 levels, max 10; 30 companies per call fetched 5 at a time) with owner-to-owned edges, control bands, and a reason where each chain ends (D38).
- **`screen_sanctions` `include` / `owners_depth`**: also screen an entity's current officers and owners; `overall` is the worst result and is `incomplete` whenever a requested group could not be fully screened (D39).
- Third `xhigh` code review (officers, ownership, related screening): 13 defects fixed with regression tests.

- **`screen_sanctions` tool and the `sanctions/` module**: UK Sanctions List, EU consolidated list and OFAC SDN downloaded (once per 24 h), parsed per designation, cached as snapshots and matched locally by name (exact, reordered, fuzzy, containment, low-quality-alias cap) and by entity registration number. Results are `match`, `possible_match`, `no_match` or `incomplete`, always with list version dates and a caveat (D36, D37).
- `HttpClient.getText` for bulk downloads (size and time overrides, allow-listed redirect hosts, streamed decoding).
- Staleness guard: a warning after 14 days and `incomplete` after 45 days.
- Second `xhigh` code review of the sanctions code: 13 defects fixed with regression tests.

- Documentation set: module reference, development guide, tool reference, coverage matrix, security and
  privacy, code-review process (`docs/20`-`25`), documentation index.
- Claude Code skills for thorough review: `review-code`, `review-adapter`, `review-security`,
  `review-tests`, `review-docs`, and `add-adapter` (`.claude/skills/`).
- `npm run verify` (typecheck, lint, format check, tests, build) and architecture guard tests (layering,
  stdout, secrets, eval).
- Golden-set test harness (`test/golden/`).

### Changed

- UK designations now come from the **UK Sanctions List (FCDO)**. The first build used the OFSI Consolidated List, which closed on 2026-01-28 while its old URL kept serving a frozen file (D36).

- Crosswalks are an adapter capability; the services layer no longer imports a concrete adapter.
- The adapter catalogue (`src/adapters/registry.ts`) now owns construction and the identifier schemes
  each adapter serves; source priority and text folding are defined once.
- Entity tools split into one file per tool; shared arguments in `tools/shared.ts`.
- The UK number -> LEI crosswalk runs concurrently with the Companies House lookup.

### Fixed (xhigh code review, 2026-10-17)

- Company names such as "Deutsche Bank" were treated as VAT numbers in search.
- Greek and Cyrillic names were erased during normalisation (all matched each other); Nordic and German
  letters (o-slash, ae, sharp s) were dropped; fallback entity ids collided for non-Latin names.
- Search merged two distinct records from the same source into one candidate.
- VIES error responses were reported (and cached for 24 h) as "VAT not valid".
- A 429 response could make the rate limiter refuse requests for a full window instead of Retry-After.
- Automatic HTTP redirects could forward credential headers to another host; the response size cap was
  applied after buffering the whole body.
- Cache storage errors (for example two server instances locking the SQLite file) failed whole lookups;
  "not found" results were cached for hours.
- Status provenance credited sources that had said "unknown" as supporting the chosen value.
- Out-of-range configuration (for example `EIM_SANCTIONS_MATCH=95`) was silently accepted.
- The audit log stored free-text search queries; it now stores a hash.
- Malformed GLEIF and Companies House bodies could crash with a TypeError or be cached.

## [0.0.1] - 2026-10-17

### Added

- Scaffold, ELv2 licence, planning documents.
- Tools: `check_coverage`, `search_entities`, `get_entity` (identity), `resolve_identifier`.
- Adapters: GLEIF, VIES, Companies House. Rate-limited HTTP client, SQLite cache, metadata-only audit log.
