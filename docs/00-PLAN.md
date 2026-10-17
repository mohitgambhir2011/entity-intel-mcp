# LEI MCP — Legal Entity Intelligence MCP Server (UK + Europe)

Working name: **LEI MCP** (project/package name `entity-intel-mcp`, D18). Status: Phases 0–4 done (planning, source assessment partial, data model v0.2, tool spec v0.1, architecture v0.1); next Phase 5 MVP build (scaffold first). Where this file conflicts with 01-DECISIONS.md, the decisions log wins (e.g. D5 direct registers only, D15 ELv2 licence). Decisions are logged in `01-DECISIONS.md`; open questions in `02-QUESTIONS.md`.

## 1. What we are building (one paragraph)

An MCP (Model Context Protocol) server that lets an AI assistant look up, resolve, verify and monitor **legal entities** in the UK and Europe. Given a name, LEI, company number or VAT number, it returns a unified, source-cited entity profile: identity, status, registered address, officers, ownership/parents, regulatory status, sanctions screening, and filings. "LEI" here is read as *legal entity information*, with the ISO 17442 **Legal Entity Identifier** as the backbone identifier. (Confirm in Q1.)

## 2. Candidate data sources (all to be validated in Phase 1)

| Area | Source | Access | Notes |
|---|---|---|---|
| Global LEI backbone | GLEIF API / Golden Copy | Free, no key | Level 1 (who is who), Level 2 (who owns whom). Covers UK + EU entities that hold an LEI only. |
| UK registry | Companies House REST API | Free, API key | Profile, officers, PSC (beneficial owners), charges, filings. Rate limit ~600 req / 5 min. |
| UK regulated firms | FCA Register API | Free, key | Authorisation status, permissions, individuals. |
| UK charities | Charity Commission API | Free, key | Optional. |
| UK sanctions | OFSI consolidated list | Free download | Also UK Sanctions List (FCDO). |
| UK VAT | HMRC VAT check API | Free, OAuth | Validates VAT number, returns name/address. |
| EU cross-border | BRIS / e-Justice portal | Mostly web, limited API | Gateway only; not a clean API. |
| EU national registers | Handelsregister (DE), KvK (NL), INPI/Infogreffe (FR), Registro Mercantil (ES), Registro Imprese (IT), CBE (BE), Brønnøysund (NO), CVR (DK), PRH (FI), Bolagsverket (SE) | Varies: some open, some paid | Do per-country, prioritised by user demand. |
| EU VAT | VIES | Free SOAP/REST | Validity + name/address where member state returns it. |
| EU sanctions | EU Consolidated Financial Sanctions List | Free | Plus OFAC SDN optionally. |
| Aggregators | OpenCorporates, Open Ownership (BODS), Wikidata | Paid / free tiers | Possible shortcut for breadth; licence implications. |
| Regulators | ESMA registers, EBA, ECB MFI list | Free downloads | For financial institutions. |

## 3. Build phases (step by step)

**Phase 0 — Decide (this is where we are).** Answer scoping questions (see `02-QUESTIONS.md`). Output: locked `01-DECISIONS.md`.

**Phase 1 — Source validation (1–2 days).** Register for API keys; hit each Tier-1 source with 5 real entities; record fields, rate limits, licence/terms (esp. redistribution and caching), data freshness. Output: `10-source-assessment.md`.

**Phase 2 — Unified entity model (1 day).** Design the canonical schema: `Entity`, `Identifier` (LEI, CRN, VAT, EORI…), `Address`, `Officer`, `Ownership link`, `Status`, `Source/Provenance`. Every field carries source + retrieved-at. Align with GLEIF Level 1/2 and BODS for ownership. Output: `11-data-model.md` + JSON Schema.

**Phase 3 — MCP tool design (1 day).** Define tools, inputs/outputs, error semantics. Draft set:
- `search_entities(query, country?, status?)`
- `get_entity(identifier, type)` → unified profile
- `resolve_identifier(any_id)` → LEI ↔ CRN ↔ VAT crosswalk
- `get_officers(entity)`, `get_ownership(entity, depth)` (parents/children/PSC)
- `get_filings(entity)`, `get_regulatory_status(entity)`
- `screen_sanctions(entity | name)`
- `validate_vat(number, country)`
- `compare_sources(entity)` — flags disagreements between registries
Plus MCP resources (entity profile docs) and prompts (e.g. "KYB check"). Output: `12-tool-spec.md`.

**Phase 4 — Architecture & stack (0.5 day).** Language (TypeScript or Python), MCP SDK, transport (stdio local vs. streamable HTTP remote), caching (SQLite/Redis), rate-limit handling, secrets, adapter-per-source pattern, fuzzy-matching library. Output: `13-architecture.md`.

**Phase 5 — MVP build (1–2 weeks).** Walking skeleton: GLEIF + Companies House + VIES + UK/EU sanctions, 4–5 tools, tests with recorded fixtures, run in Claude Desktop/Code. Output: working server in `src/`.

**Phase 6 — Entity resolution & quality (1 week).** Name normalisation (legal-form suffixes: Ltd/GmbH/SAS/B.V./S.p.A.…), fuzzy match scoring, confidence + explanation, dedupe across sources, conflict reporting.

**Phase 7 — Expand coverage.** Add EU national registers by priority; FCA; ownership graph traversal.

**Phase 8 — Hardening & compliance.** GDPR (officer/PSC personal data), source licence compliance, audit logging, rate limiting, error budgets, monitoring, security review (prompt-injection via registry text fields — treat all registry content as untrusted data).

**Phase 9 — Packaging & release.** README, install docs, versioning, Docker image, optional hosted deployment, registry listing, evals (golden set of entities with expected answers).

## 4. Key risks

1. **Coverage gap**: only a fraction of EU entities have an LEI; real coverage needs national registers, which are fragmented, sometimes paid and not API-first.
2. **Licensing**: some registers forbid caching/redistribution or commercial use.
3. **GDPR**: officers/beneficial owners are personal data → lawful basis, minimisation, retention.
4. **Entity resolution errors** have real-world cost (wrong company flagged in KYB) → always return confidence + sources.
5. **Prompt injection** via free-text fields in registry data.
6. **Scope creep** into full KYC/AML product.

## 5. Document index (this folder)

- `00-PLAN.md` — this file
- `01-DECISIONS.md` — decisions as locked
- `02-QUESTIONS.md` — question rounds and answers
- Later: `10-` source assessment, `11-` data model, `12-` tool spec, `13-` architecture
