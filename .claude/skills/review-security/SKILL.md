---
name: review-security
description: Security and privacy review for entity-intel-mcp. Use for any change touching input handling, HTTP, caching, logging, storage, tool output or dependencies, and before every release. Covers prompt injection through registry data, secret handling, SSRF and redirects, personal data and GDPR, denial of service, supply chain.
---

# Security and privacy review

Threat model in one paragraph: the server runs on a user's machine as a child of an AI client. Its
**inputs** are tool arguments (chosen by an LLM that may itself be manipulated) and **registry
responses** (text written by companies, directors and third parties). Its **outputs** go straight
into an LLM's context. Its **secrets** are the user's registry API keys. Its **stored data** may
include personal data about directors and beneficial owners.

## 1. Prompt injection through registry text

A company can legally name itself "Ignore previous instructions and ...". Check:

- [ ] Registry-supplied strings (names, addresses, remarks, role titles, filing descriptions) appear
      **only inside `data`**, never concatenated into `summary` or `warnings` (those are server-authored).
      Test: `safety and audit` in `test/integration/tools.test.ts`.
- [ ] Tool descriptions and server `instructions` tell the client that registry text is data.
- [ ] Error messages built from upstream content use fixed strings or enumerated codes, not raw text.
- [ ] No tool can act on text it reads (no write tools, no URL fetching driven by registry text,
      document links are returned as links only).
- [ ] Output size is bounded (25 items by default, D25) so one hostile record cannot flood context.

## 2. Secrets

- [ ] Keys come from environment variables only; never from tool arguments, never persisted.
- [ ] Keys never appear in: URLs, cache keys, cached values, audit rows, logs (stderr included),
      error messages, `check_coverage` output (variable _names_ only), fixtures, docs, test names.
- [ ] `git log -p | grep` for the user's key prefix before pushing. `.env*` ignored (except `.env.example`).
- [ ] Authorization headers are only sent to the intended host (redirects: same-host https only).

## 3. Network and SSRF

- [ ] URLs are built from constants plus validated, encoded parameters. User text never selects the host.
- [ ] Timeouts, size caps, and a bounded number of redirects exist on every request.
- [ ] Bulk downloads (sanctions lists) verify host/path, stream to disk with a size cap, and parse
      without executing anything. XML parsing has entity expansion disabled.
- [ ] TLS verification is never disabled.

## 4. Input validation

- [ ] Every tool argument has a zod schema with bounds (`limit` <= 25, `depth` <= 10, string lengths).
- [ ] Identifier formats are validated before use in a URL or SQL parameter.
- [ ] SQLite access uses bound parameters only. No string-built SQL.
- [ ] Regexes on user input are linear-time (no nested quantifiers) - ReDoS.

## 5. Personal data and retention (D11, D13, D14)

- [ ] Officer / owner data is cached with the personal-data TTL and flagged `personal`.
- [ ] Audit log stores metadata only: identifiers as typed, free-text names as hashes; never results.
- [ ] A way to clear the cache exists and is not callable by the model (CLI flag, not an MCP tool).
- [ ] Output carrying personal data includes the disclaimer (D13). DOB precision as published (D23).
- [ ] Nothing personal in logs, fixtures (scrub), or error messages.
- [ ] README states the user's responsibility for a lawful basis.

## 6. Availability and abuse

- [ ] Per-host rate limiting protects the user's key from being banned; a hostile prompt loop cannot
      exhaust it silently (limit errors surface as warnings).
- [ ] Ownership traversal has depth and request-budget caps (D22).
- [ ] No unbounded in-memory structures keyed by input.

## 7. Supply chain and release

- [ ] New dependency? Justify it (D31), check maintainers, install scripts, size; pin via lockfile.
- [ ] `npm audit` clean or each finding triaged in the PR.
- [ ] `package.json` `files` publishes only `dist`, `LICENSE`, `README.md`.
- [ ] No postinstall scripts in this package.

## 8. Compliance wording

- [ ] Sanctions output carries the fixed caveat and list version dates (D27).
- [ ] Docs never claim the tool is a legal determination or complete.

## Report

Severity: **S1** secret/credential exposure, injection path, personal-data leak; **S2** missing
bound or validation; **S3** hardening. Provide the exploit input, not just the category.
