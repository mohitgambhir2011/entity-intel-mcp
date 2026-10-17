# entity-intel-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant look up, resolve and
verify **legal entities in the UK and Europe**. It merges company registries, GLEIF (LEIs) and VIES
(EU VAT) into one profile, and puts **provenance on every field**: which source said it, when, from
cache or not, under which licence.

Built for **KYB / due diligence first, research second**. It is honest about gaps: when a country
does not publish a data family, or a source is down, the result says so instead of returning silence
or a guess.

> **Status: early development (v0.0.1).** Four tools work (below). Officers, beneficial owners,
> filings, regulatory status, insolvency and sanctions screening are **not implemented yet**, and
> only the UK has a national registry adapter. See [Coverage](#coverage) and the
> [roadmap](docs/01-DECISIONS.md) (D12).

## Contents

- [What you get](#what-you-get) · [Quick start](#quick-start) · [Tools](#tools) · [Configuration](#configuration)
- [Coverage](#coverage) · [Limitations](#limitations) · [Privacy, legal and licence](#privacy-legal-and-licence)
- [Development](#development) · [Project layout](#project-layout) · [Documentation](#documentation)

## What you get

| Question an assistant can answer                                                     | Tool                 |
| ------------------------------------------------------------------------------------ | -------------------- |
| "Which companies are called Tesco PLC in the UK, and which one is the listed group?" | `search_entities`    |
| "Give me the profile of UK company 00445790 / LEI 2138002P5RNKC5W2JZ46"              | `get_entity`         |
| "Is this LEI or VAT number valid, and what are the entity's other identifiers?"      | `resolve_identifier` |
| "What can this server actually tell me about Norway today?"                          | `check_coverage`     |

Design rules that shape every answer:

- **Search never auto-picks.** Name searches return ranked candidates with a confidence band, reasons
  and warnings; an exact identifier returns one `certain` match (D26).
- **Disagreement is data.** When registries differ (status, date, address, name) both values are
  returned in `conflicts` and the home registry wins the headline value (D2).
- **Failure is not a fact.** A registry outage never becomes "VAT invalid" or "not found"; partial
  results come back with a warning naming the cause (D28).
- **Registry text is untrusted.** Names and addresses appear only inside `data`; the server-written
  `summary` and `warnings` never contain registry text (prompt-injection defence).

## Quick start

Requires **Node 22 or later**. Not yet published to npm: build from source.

```bash
git clone <this repo>
cd entity-intel-mcp
npm install
npm run build
```

Add to your MCP client (Claude Desktop shown; the path must be absolute):

```json
{
  "mcpServers": {
    "entity-intel": {
      "command": "node",
      "args": ["C:/path/to/entity-intel-mcp/dist/index.js"],
      "env": {
        "COMPANIES_HOUSE_API_KEY": "your-key"
      }
    }
  }
}
```

Keys: a free Companies House **REST** key from <https://developer.company-information.service.gov.uk>
(create an application, then a REST key). GLEIF and VIES need no key. Without a Companies House key
the server still works for LEIs and VAT numbers, and says which source was skipped.

Try it from your assistant: _"Use entity-intel to find Tesco PLC in the UK and show me the profile."_

## Tools

All tools are read-only. Arguments are flat; names are never accepted where an identifier is required.

### `search_entities`

Find entities by **name**, or resolve an **identifier** to one entity.

| Argument           | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `query` (required) | A name, or an LEI / UK company number / EU VAT number                                       |
| `country`          | ISO code to restrict results (`GB`). Also lets a bare number be read as a UK company number |
| `status`           | `operating`, `distressed`, `ended`, `any` (default)                                         |
| `limit`            | 1-25, default 10                                                                            |
| `fresh`            | Bypass the cache                                                                            |

Returns `candidates[]` with `entityId`, `name`, `jurisdiction`, `status`, `identifiers`, `sources` and
`match { confidence, band, reasons, warnings }`. Bands: `certain` (exact identifier only), `high`,
`medium`, `low`.

### `get_entity`

Identity profile: names (legal and former), identifiers (LEI, company number, VAT), legal form,
status (12 normalised values + `operating/distressed/ended` group + the source's own wording),
incorporation / dissolution dates, registered address, `conflicts`, and a `coverage` report listing
which data families are available. Takes `entity_id` **or** `identifier` (+ optional `scheme`,
`country`, `fresh`).

### `resolve_identifier`

Validates an identifier and returns every other identifier known for the same entity (LEI to UK
company number and back; VAT validity through VIES, including that Germany withholds names).

### `check_coverage`

Which sources are enabled, which credentials are configured (**names only**), which data families
are supported. Call it first when a result is thinner than expected.

Full request/response reference with real examples: [docs/22-tool-reference.md](docs/22-tool-reference.md).

## Configuration

Environment variables only. Nothing is read from tool arguments and nothing is persisted.
See [`.env.example`](.env.example).

| Variable                                        | Purpose                                         | Default / range         |
| ----------------------------------------------- | ----------------------------------------------- | ----------------------- |
| `COMPANIES_HOUSE_API_KEY`                       | Enables the UK Companies House adapter          | adapter off             |
| `FCA_AUTH_EMAIL`, `FCA_AUTH_KEY`                | FCA Register (adapter not implemented yet)      | off                     |
| `EIM_ADAPTERS`                                  | Allow-list of adapter ids, e.g. `gleif,vies,gb` | all with credentials    |
| `EIM_DB_PATH`                                   | SQLite cache and audit file                     | per-user data directory |
| `EIM_PERSONAL_DATA_TTL_DAYS`                    | Cache lifetime cap for officer / owner data     | 30 (0-3650)             |
| `EIM_AUDIT_RETENTION_DAYS`                      | Audit log retention                             | 365 (1-3650)            |
| `EIM_SANCTIONS_MATCH`, `EIM_SANCTIONS_POSSIBLE` | Sanctions thresholds (not yet used)             | 0.95, 0.80              |

Out-of-range values are replaced by the default and reported on stderr at startup.

## Coverage

What the server can return **today** (v0.0.1). "Identity" = names, identifiers, status, legal form,
dates, address.

| Source                | Countries             | Identity                                                 | Officers | Owners            | Filings | Regulatory | Insolvency | Sanctions |
| --------------------- | --------------------- | -------------------------------------------------------- | :------: | ----------------- | :-----: | :--------: | :--------: | :-------: |
| Companies House (key) | GB                    | yes                                                      |    -     | -                 |    -    |     -      |     -      |     -     |
| GLEIF                 | LEI holders worldwide | yes                                                      |    -     | parents (planned) |    -    |     -      |     -      |     -     |
| VIES                  | EU member states + XI | VAT validity; name/address where the state releases them |    -     | -                 |    -    |     -      |     -      |     -     |

`-` = not implemented yet. Planned order and per-country detail, including data that will stay
unavailable for legal reasons (for example most EU beneficial-owner registers since 2022):
[docs/23-coverage.md](docs/23-coverage.md).

## Limitations

- **Coverage is partial by design.** Only a minority of European companies hold an LEI, and only the
  UK has a registry adapter, so most EU companies can currently be reached by VAT number only.
- **Responses are verbose** because provenance is attached to each field. A compact mode is planned.
- **Name search quality depends on the sources.** GLEIF and Companies House return broad matches; the
  server ranks and flags them but cannot know which company you mean. Always confirm by identifier.
- **Caching:** profiles are cached 1-24 h (VIES 24 h, GLEIF 6 h, Companies House 1 h, searches
  15 min, "not found" 2 min). Use `fresh: true` when currency matters.
- **No sanctions screening yet.** Do not treat the absence of a sanctions field as a clear result.

## Privacy, legal and licence

- **Not legal advice**, and not a compliance determination. Sanctions screening (when added) is
  name-based and says so in every response.
- **Personal data.** Officer and beneficial-owner data (when added) is personal data. You are
  responsible for having a lawful basis under UK GDPR / GDPR. It is cached on your machine with a
  capped lifetime and never logged. The audit log stores metadata only; name queries are stored as
  hashes. See [docs/24-security-and-privacy.md](docs/24-security-and-privacy.md).
- **Data terms.** The licence below covers this code, not the data. Each source has its own terms
  (Companies House data is under the Open Government Licence v3.0; see
  [docs/10-source-assessment.md](docs/10-source-assessment.md)). You bring your own keys.
- **Licence: [Elastic License 2.0](LICENSE).** Use, modify and self-host freely; you may not offer
  it to third parties as a hosted or managed service. This is source-available, not OSI open source.

## Development

```bash
npm install
npm run verify          # typecheck + lint + format check + tests + build  (run before every commit)
npm test                # 120+ tests: unit, MCP-client integration, architecture guards
npm run dev             # run the server from source over stdio
npx tsx scripts/live-smoke.ts       # real calls to GLEIF, VIES, Companies House (needs your key)
npx tsx scripts/live-mcp-smoke.ts   # end-to-end over stdio against real services (after build)
```

Contributing starts with [CONTRIBUTING.md](CONTRIBUTING.md); the review process and the Claude Code
skills that enforce it are described in [docs/25-code-review.md](docs/25-code-review.md).

## Project layout

```
src/
  core/         types, identifiers, ids, config, text folding   (depends on nothing)
  resolution/   name normalisation and scoring                  (core)
  infra/        HTTP client, rate limiter, cache, audit, SQLite (core)
  adapters/     one folder per source + the catalogue/registry  (core, infra)
  services/     gather, merge, search, identifier parsing       (core, resolution, adapters, infra)
  server/       MCP tools, response envelope                    (core, services, runtime)
  runtime.ts    wires config + infra + adapters
  index.ts      stdio entry point
test/           unit, integration (MCP client), architecture guards, fixtures
docs/           plan, decisions, design, references
.claude/skills/ review-* and add-adapter skills for Claude Code
```

Layering is enforced by `test/architecture.test.ts`. Module-by-module reference:
[docs/20-modules.md](docs/20-modules.md).

## Documentation

Start at [docs/README.md](docs/README.md). Highlights: [decisions log](docs/01-DECISIONS.md) (why),
[architecture](docs/13-architecture.md), [module reference](docs/20-modules.md),
[tool reference](docs/22-tool-reference.md), [coverage](docs/23-coverage.md),
[security and privacy](docs/24-security-and-privacy.md), [development guide](docs/21-development.md).
