---
name: review-adapter
description: Review checklist for data-source adapters and the HTTP/cache/rate-limit layer in entity-intel-mcp (src/adapters, src/infra). Use when an adapter is added or changed, when src/infra/http.ts, cache.ts or ratelimit.ts change, or when a registry's behaviour is in question.
---

# Review a source adapter

An adapter turns one external registry into `PartialEntity` / `SearchHit` values. It is the place
where untrusted, inconsistent, rate-limited data enters the system. Check every item; each one is a
real failure mode seen in this codebase or in registries like it.

## Contract (`src/adapters/types.ts`)

- [ ] `supports(identifier)` is cheap, pure and exact (no network, no false positives).
- [ ] `lookup` returns `undefined` **only** for a genuine "no such record" (HTTP 404 / empty result).
      Every other failure throws `SourceError` with the right `kind` (`unavailable`, `rate_limited`,
      `auth`, `not_found`, `bad_response`).
- [ ] Failures are never mapped to a negative fact (VIES outage != "VAT invalid").
- [ ] Optional capabilities (`search`, `crosswalks`) are declared on the adapter, not special-cased
      in services (`gather` must not import a concrete adapter).
- [ ] The adapter is listed in `src/adapters/registry.ts` with `requiredEnv`, `schemes`, `create`.

## Requests (`src/infra/http.ts`)

- [ ] All traffic goes through `HttpClient` (rate limiting, timeout, size cap, redirect policy).
      No direct `fetch`.
- [ ] The host has a rule in `DEFAULT_HOST_RULES` matching the source's published limit, with margin.
      Where the limit is unverified, say so in a comment and in `docs/10-source-assessment.md`.
- [ ] Credentials are sent only in headers, never in URLs (URLs are logged and cached). The key is
      never in an error message, log line, cache key, fixture or tool output.
- [ ] Query values are `encodeURIComponent`-encoded. Path segments built from user input are
      validated first (`isValidLei`, `normalizeGbCompanyNumber`, `parseVat`).
- [ ] Redirects: only same-host https hops are followed (so credential headers can't leak).

## Responses

- [ ] The body is validated at the boundary before it is cached or mapped: required fields present,
      expected types, arrays really arrays. A `200` with an error body is an error, not a result.
- [ ] Optional fields are optional in the types **and** handled (`undefined`, `null`, `""`, `"---"`,
      `"N/A"`). Sentinel values for "withheld" are not treated as data (VIES `---`).
- [ ] Text normalisation is Unicode-safe (names in Greek, Cyrillic, Nordic scripts).
- [ ] Source wording is kept (`EntityStatus.sourceText`); unknown wording maps to `unknown`, never a guess (D21).
- [ ] Dates stay in the source's precision; partial dates are not padded.
- [ ] Personal data (officers, owners) is flagged `personal: true` in the cache call (shorter TTL, D11).

## Caching (`src/infra/cache.ts`)

- [ ] The cache key contains everything that changes the answer (identifier, endpoint, page size,
      country) and nothing secret.
- [ ] TTL comes from `TTL` constants (D7); "not found" uses the short negative TTL.
- [ ] Only definite answers are cached. Errors, partial and malformed responses throw _before_ `getOrFetch` stores them.
- [ ] `fresh` is honoured.

## Provenance and mapping

- [ ] Every mapped value carries a `Provenance` with source, record id, URL (if human-checkable),
      `retrievedAt`, `fromCache`, and the licence string where the source requires attribution.
- [ ] Identifiers: `validated` is true only when checksum/format or the issuing service confirmed it.
- [ ] The adapter reports what it cannot provide through coverage, not by returning empty arrays.

## Licence and terms

- [ ] `docs/10-source-assessment.md` records: access, auth, limits, caching/redistribution terms,
      attribution requirement. No bulk redistribution of data that forbids it (D4, D8, D15).
- [ ] Paid or restricted sources are opt-in via the user's own credentials (D8).

## Tests (`test/unit/adapters.test.ts`, `test/fixtures/<adapter>/`)

- [ ] Recorded real responses (scrub keys and incidental personal data); at least: found, not found,
      malformed/error body, withheld field, rate limited, server error.
- [ ] Assertions on provenance, status mapping, auth header shape, and that secrets are not in URLs.
- [ ] A golden-set entry for a real entity in this country (D16).
- [ ] A live smoke run (`scripts/live-smoke.ts`) was done at least once and its output noted in the PR.

## Report

List unchecked items as findings with the failing input. If the source's real behaviour was not
observed (only documentation read), say so and mark the claim UNVERIFIED.
