# Module reference

Audience: contributors and reviewers. Read this to find where a behaviour lives, what each module
promises, and what must stay true when you change it. The layering rule is enforced by
`test/architecture.test.ts`; the design rationale is in [13-architecture.md](13-architecture.md) and
the decisions log ([01-DECISIONS.md](01-DECISIONS.md)).

```
index.ts ─► server/ ─► services/ ─► adapters/ ─► infra/ ─► core/
              │           │  └─► resolution/ ─────────────► core/
              └─ runtime.ts (wires config, infra, adapters)
```

Allowed dependencies (a module may import its own area plus):

| Area | May import |
| --- | --- |
| `core` | nothing |
| `resolution` | core |
| `infra` | core |
| `sanctions` | core, infra, resolution |
| `adapters` | core, infra |
| `services` | core, resolution, adapters, infra, sanctions, runtime (types) |
| `server` | core, services, runtime |
| `runtime` | core, infra, adapters, sanctions |
| `index` | core, runtime, server |

## core/ - vocabulary with no I/O

| File | Responsibility | Invariants |
| --- | --- | --- |
| `types.ts` | Shared types: `Provenance`, `Sourced<T>`, `Identifier`, `EntityStatus`, `PartialEntity`, `SearchHit`; `makeStatus()` | `EntityStatus.group` is derived from `normalized` in one table. Adding a status means adding it to that table |
| `people.ts` | Personal-data families: `Officer`, `Controller`, `ControlNatures`, `OfficersResult`, `ControllersResult` (each with record-level provenance), `Availability<T>`, `displayPersonName` / `stripTitles`, `PERSONAL_DATA_NOTICE` | Absence is explicit (`Availability`); display names drop honorifics so they match list names |
| `entity.ts` | `EntityProfile`, `Conflict`, `CoverageReport`, `mergeProvenance` | Provenance entries are unique per `(source, sourceRecordId)` |
| `identifiers.ts` | Validation and detection: LEI ISO 7064 check, UK company number normalising, VAT parsing and per-country shapes, `detectIdentifier` | `parseVat` is lenient (explicit user input, VIES decides); `detectIdentifier` is strict (free text) so company names are not mistaken for VAT numbers. Bare digits are a UK number only when `country=GB` |
| `ids.ts` | Entity ids (D20, D33): `GB:CH:<number>`, `ID:LEI:<lei>`, `ID:VAT:<vat>`, `hash:<cc>:<h>` | Ids are stable and derived, never random. `hash:` ids cannot be looked up |
| `text.ts` | Unicode-aware tokenizer and folding (diacritics, ø æ ß ł) | Never erases letters of any script; never returns an empty key for a non-empty name |
| `sources.ts` | `SOURCE_PRIORITY`, `sourceRank` | Single definition of "which source wins" |
| `config.ts` | Environment parsing with range checks and a `problems` list | Invalid numbers fall back to defaults and are reported, never silently accepted |
| `errors.ts` | `SourceError(kind)`, `InvalidInputError` | `SourceError` messages are server-authored; they never embed upstream text |

## resolution/ - names

| File | Responsibility |
| --- | --- |
| `normalise.ts` | `normaliseName(name) -> { tokens, suffix, key }`: strips a trailing legal form (Ltd, PLC, GmbH, A/S, B.V., S.A. ...) and a leading "The". Used for scoring and de-duplication only; the original name is always what is shown. Never reduces a name to nothing |
| `score.ts` | `scoreName(query, candidate)`: 1.0 identical; 0.97 identical after normalisation; 0.90 if only the legal form differs (with a warning); otherwise the best of Levenshtein ratio, token overlap, and 0.75 for a token-prefix, capped at 0.89. **Never returns `certain`**: that band is reserved for exact identifiers (D26) |

## infra/ - everything that touches the outside world or disk

| File | Responsibility | Invariants |
| --- | --- | --- |
| `ratelimit.ts` | Sliding-window limiter per host, plus `penalise(retryAfter)` after a 429 | Waits up to 30 s, then throws `rate_limited` instead of hanging a tool call |
| `http.ts` | `HttpClient.getJson` / `getText`: rate limit, timeout (20 s, per-request override), one retry on 429/5xx/network error, manual redirects (same host + https; other hosts only if listed in `allowRedirectHosts` with a dot-boundary match, and then without custom headers; 3 hops), streamed bounded body read (5 MB default, per-request override), error bodies discarded. `DEFAULT_HOST_RULES` | Credential headers can never reach another host. Errors never contain header values or upstream text. A refused redirect is final (not retried) |
| `cache.ts` | `Cache.getOrFetch(key, opts, fetcher)` over `Storage` | Never serves expired rows (D28). Storage failure or a corrupt row degrades to "uncached", never fails the lookup. `null` results ("not found") live 120 s. Personal data TTL is capped (D11) |
| `audit.ts` | One metadata row per tool call (D14) | A failed audit write is logged to stderr and never breaks a lookup |
| `storage/index.ts` | `Storage` interface (cache + audit) | Implementations are swappable (D31) |
| `storage/sqlite.ts` | `node:sqlite` implementation, WAL, parameter-bound SQL | Default path: per-user data dir, overridable with `EIM_DB_PATH` |
| `storage/memory.ts` | In-memory implementation (tests, fallback if SQLite can't open) | Same behaviour as SQLite |

## sanctions/ - sanctions lists (no MCP, no registry knowledge)

| File | Responsibility | Invariants |
| --- | --- | --- |
| `types.ts` | `SanctionEntry` (normalised designation), `ListSnapshot`, `SanctionsHit`, `SanctionsScreening`, `SCREENING_CAVEAT` | List ids: `UK`, `EU`, `OFAC_SDN` |
| `xml.ts` | Safe XML helpers: chunk-per-designation parsing, entity processing OFF (manual decode of the five standard entities), `acceptIdentifier` (6-30 letters/digits, at least one digit, never a date), `assertComplete` | A DOCTYPE or custom entity can never expand; truncated files are rejected |
| `parsers/uk.ts`, `eu.ts`, `ofac.ts` | One parser per list -> `SanctionEntry[]` + version date | Each checks the document type and that it ends with its root closing tag; OFAC also checks the declared `Record_Count`. Personal documents (passports, national ids, dates of birth) are not read; identifiers are indexed for entities and vessels only |
| `lists.ts` | Catalogue: id, label, URL, allowed redirect hosts, minimum plausible size, parser | OFAC may redirect to `.treasury.gov`, `.treas.gov`, `.amazonaws.com` only |
| `matching.ts` | `ListIndex`: in-memory name and identifier index; scoring; weak-alias cap | Fuzzy matching only for names of 8+ characters; identifiers 8+ characters; weak aliases never reach the match threshold |
| `index.ts` | `SanctionsIndex`: download (cap 150 MB, 180 s, streamed), parse, floor check, cache the snapshot 24 h, hold the index; `warmFromCache()` at startup | One in-flight load per list; failures are never cached; staleness measured from download time; startup never touches the network |

## adapters/ - one folder per source

| File | Responsibility |
| --- | --- |
| `types.ts` | `SourceAdapter` (`supports`, `lookup`, optional `search`, optional `crosswalks`), `Crosswalk`, `AdapterContext` |
| `companies-house/people.ts` | Officers and PSC: pure mapping (`mapOfficer`, `mapController`, `parseNatures`, `currentPscExemption`) and cached, paged fetching (100 per page, 5 pages max, flagged `truncated`) | Cached as personal data (capped TTL); the cached value carries no provenance (it describes *this* fetch, added after); exemptions count only if in force today; overlapping control bands keep the widest range |
| `registry.ts` | **The catalogue.** `ADAPTERS` lists every source (implemented or planned) with id, country, label, `requiredEnv`, `schemes`, `create`. `adapterStatuses()` decides enabled/disabled with a reason; `buildAdapters()` instantiates the enabled ones |
| `gleif/` | LEI lookup, name search, and the crosswalk UK company number -> LEI. Validates the JSON:API body before caching; GLEIF `INACTIVE` maps to `unknown` (not "ended") |
| `vies/` | VAT validity. `---` means "withheld by the member state". A body without a boolean `isValid`, or with `errorWrappers`, is `unavailable` and **never cached** |
| `companies-house/` | Company profile and name search with HTTP Basic auth (key as username). Status table per D21; former names; validates the body before caching |

Adapter rules: all HTTP through `ctx.http`; validate inside the cache fetcher; throw `SourceError`
for failures; `undefined` only for "no such record"; full `Provenance`. Checklist:
`.claude/skills/review-adapter/SKILL.md`; recipe: `.claude/skills/add-adapter/SKILL.md`.

## services/ - orchestration (no HTTP, no MCP)

| File | Responsibility | Invariants |
| --- | --- | --- |
| `company.ts` | `resolveCompany`: resolve a seed to an entity and its UK number once; `whyUnavailable` (not yet supported vs requires credentials vs no such record) | Officer / PSC tools hang off the same entity as `get_entity` |
| `officers.ts` | `getOfficers`: filter (active, role), sort (current first, newest first), page; availability states | Outage = `error` state + warning, never an empty list |
| `ownership.ts` | `getOwnership`: breadth-first walk up the PSC chain; levels fetched 5 at a time; budget 30 companies, 200 nodes; cycles safe; one node per person; terminal reasons; `cutBy` | A root failure is an `error`, not an empty graph; `depth` is by design, the other cuts lose information |
| `related.ts` | `collectRelated`: officers and/or owners as screening subjects, fetched concurrently from an already-resolved company; reasons for incompleteness | Anything that makes the party list incomplete sets the block's `incomplete` |
| `entityRef.ts` | Tool arguments -> one seed `Identifier` (`entity_id`, or `identifier` + `scheme`/`country`) | Rejects ambiguous or malformed input with an actionable `InvalidInputError`; names are never accepted |
| `gather.ts` | From a seed identifier: run every enabled adapter that supports it, follow newly revealed identifiers (up to 3 rounds), run crosswalks concurrently with lookups | One warning per failing source; disabled-but-relevant adapters are named in a warning with the reason; `fromCache` is true only if all data was cached |
| `merge.ts` | `PartialEntity[] -> EntityProfile`: priority per `sources.ts`, conflicts recorded, provenance merged only from sources that agree, entity id chosen | A value from a source that said "unknown" never outranks a real value and is never credited as corroboration |
| `search.ts` | Name search across adapters with `search`; identifier queries resolve exactly | Candidates merge only across **different** sources; two records from one source stay separate. Sorted by score, then operating first. Never auto-picks |
| `screen.ts` | Sanctions screening orchestration: resolve the entity (via `gather`) or take a name, load the requested lists, screen, derive `match / possible_match / no_match / incomplete`, add warnings (unavailable, stale >14 d, stale >45 d forces incomplete, nameless entity, identifier-only hits) | Never reports `no_match` when any list is missing, cut off or stale, or when nothing could be screened by name |
| `audit.ts` | `auditSubject(query)`: identifiers as typed, names as `name#<hash> (<n> chars)` | Free-text names never reach the audit log |

## server/ - MCP surface

| File | Responsibility |
| --- | --- |
| `server.ts` | Creates the `McpServer`, sets `instructions` (registry text is data), registers tools |
| `envelope.ts` | `ok()` builds `{ summary, warnings, data, meta, disclaimer? }`; `fail()`; `guard()` maps `InvalidInputError` to a tool error and anything else to a generic error (details to stderr) |
| `tools/shared.ts` | Flat entity-reference argument shape, read-only annotations |
| `tools/search.ts`, `getEntity.ts`, `getOfficers.ts`, `getOwnership.ts`, `resolveIdentifier.ts`, `screenSanctions.ts`, `coverage.ts` | One file per tool: parse, call one service, shape the envelope, write one audit row |

Rule: no business logic here. `summary` and `warnings` are written by the server and must not
contain registry text.

## runtime.ts and index.ts
`createRuntime(config, overrides)` builds storage (SQLite, falling back to memory), HTTP client,
cache, audit log and adapters, reports config problems, and runs housekeeping (purge expired cache
rows and old audit rows). `overrides` exists for tests (fake fetch, fake clock, memory storage).
`index.ts` connects the stdio transport; **stdout is the protocol channel, log to stderr only**
(enforced by the architecture test).

## Test layout
| Path | Purpose |
| --- | --- |
| `test/unit/*` | Pure logic and adapters over recorded fixtures; `regressions.test.ts` holds one test per past defect |
| `test/integration/tools.test.ts` | A real MCP client over an in-memory transport against the whole server |
| `test/architecture.test.ts` | Layering, stdout, secrets, eval guards |
| `test/golden/` | Golden set of real entities with expected answers (D16) |
| `test/fixtures/<source>/` | Recorded real responses |
| `test/helpers.ts`, `test/harness.ts` | Fake fetch, fake clock, server harness |
