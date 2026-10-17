# Security and privacy

Audience: users deciding whether to run this, and reviewers. Read together with
`.claude/skills/review-security/SKILL.md`, which is the checklist applied to every change.

## What the server is
A local process started by an MCP client (stdio, D10). It makes outbound HTTPS requests to public
registries using the user's own API keys, keeps a local SQLite cache and audit log, and returns
text to an AI assistant. It has **no write actions** and no inbound network listener.

## Assets and threats

| Asset | Threat | Controls |
| --- | --- | --- |
| The assistant's context and behaviour | **Prompt injection through registry data**: a company, director or address field containing instructions | Registry text only inside `data`; `summary`/`warnings` are server-written; server `instructions` and tool descriptions say registry text is data; no tool acts on text it reads; output size capped (25 items); regression test with a hostile company name |
| User's API keys | Leak via logs, URLs, cache, audit, errors, tool output, redirects, fixtures | Keys only from environment variables; sent in headers only; never in URLs/cache keys/errors; `check_coverage` reports variable names only; redirects followed only same-host over https (credential headers cannot reach another host); tests assert absence; secret-pattern guard in `test/architecture.test.ts` |
| User's registry quota | Exhaustion / ban by a looping assistant | Per-host rate limiter with margin below published limits; 429 backoff honouring Retry-After; local limit errors surface as warnings; ownership traversal budget (planned, D22) |
| Correctness of answers | Wrong or silently stale data in a KYB decision | Failure never becomes a negative fact; expired cache never served; conflicts surfaced; unknown wording maps to `unknown`; response bodies validated before caching |
| Personal data (officers, owners; planned) | Over-retention, exposure in logs | Cache TTL capped by `EIM_PERSONAL_DATA_TTL_DAYS` (default 30); audit log has metadata only; no personal data in errors/logs; disclaimer in output (D13); user owns the lawful basis |
| Host machine | Malicious input causing code execution or resource exhaustion | No eval / shell / dynamic loading (guard test); SQL only with bound parameters; zod-validated, bounded inputs; request timeouts and a 5 MB response cap with a streaming read; no arbitrary URL fetching |
| Supply chain | Malicious dependency | Five runtime dependencies (D31); lockfile; `npm audit` before release; no install scripts; published files limited to `dist`, LICENSE, README |

## Data the server stores locally

Location: `EIM_DB_PATH`, default per-user data directory (`%LOCALAPPDATA%\entity-intel-mcp` on Windows,
`$XDG_DATA_HOME` or `~/.local/share` elsewhere).

| Table | Contents | Retention |
| --- | --- | --- |
| `cache` | Registry responses keyed by source + endpoint + parameters (never keys). Entries are purged when expired at startup | Profile 1 h (Companies House), 6 h (GLEIF), 24 h (VIES), searches 15 min, "not found" 2 min; personal data capped at 30 days |
| `audit` | `at`, `tool`, `subject`, `sources`, `cacheHit`. `subject` is an identifier as typed, or `name#<hash> (<n> chars)` for free text. **No results** | 365 days by default (`EIM_AUDIT_RETENTION_DAYS`) |

Clearing: delete the file (the server recreates it). A `--clear-cache` command is planned (D11) and is
deliberately not an MCP tool, so an assistant cannot trigger it.

## What leaves the machine
Requests to: `api.company-information.service.gov.uk` (company numbers, search text),
`api.gleif.org` (LEIs, search text), `ec.europa.eu` (VAT numbers). Search text is sent to those
services as typed. Use `EIM_ADAPTERS` to restrict which services may see your queries (D32).
Nothing is sent to Anthropic or any telemetry endpoint by this server.

## Personal data and GDPR (D13)
Officer and beneficial-owner data will be returned as published by each source. The server does not
decide whether you may process it: you must have a lawful basis (for KYB this is usually legal
obligation or legitimate interests), keep it only as long as needed, and handle subject requests.
Retention defaults are conservative; adjust to your policy.

## Sanctions and compliance wording (D27)
When added, every sanctions result states that it is a name-based screen against the listed versions
and is not a legal determination. Documentation never claims completeness.

## Known gaps (tracked)
- No `--clear-cache` command yet (D11).
- Sanctions list download hardening (size cap, XML entity expansion off) arrives with that module.
- FCA rate limit unverified; a conservative local limit is configured.
- Responses are verbose; large profiles cost tokens. A compact mode is planned.

## Reporting a vulnerability
See [SECURITY.md](../SECURITY.md). Do not include real keys or personal data in reports.
