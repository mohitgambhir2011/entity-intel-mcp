# Code review process

Audience: contributors and reviewers (human or AI). This project is a KYB tool: a wrong answer has
real cost, registry data is untrusted, and the failure modes are subtle. Reviews are therefore layered:
**mechanical gates first, then focused reviews, then a report with outcomes.**

## 1. Mechanical gates (automated, run on every change)

```bash
npm run verify    # typecheck + lint + format check + tests + build
```

Included in the tests, `test/architecture.test.ts` fails on:

- a module importing from a layer it must not depend on (see [20-modules.md](20-modules.md));
- any write to stdout (the MCP protocol channel);
- hard-coded API keys / tokens / passwords;
- `eval`, `new Function`, `child_process`.

If a gate fails there is nothing to discuss until it is fixed.

## 2. Review skills (Claude Code)

The repository ships skills under `.claude/skills/`. Invoke them by name in Claude Code
(for example "run the review-code skill on my uncommitted changes").

| Skill | Use it for | Depth |
| --- | --- | --- |
| `review-code` | **The default.** Every change. Runs the gates, then passes for correctness, data integrity, security, sources, modularity, efficiency, tests, docs; delegates to the specialised skills below | Line by line plus callers |
| `review-adapter` | Anything in `src/adapters/` or `src/infra/http.ts`, `cache.ts`, `ratelimit.ts` | Checklist: contract, requests, response validation, caching, provenance, licence, tests |
| `review-security` | Input handling, HTTP, storage, logging, tool output, dependencies; before every release | Threat-model checklist: injection, secrets, SSRF/redirects, personal data, DoS, supply chain |
| `review-tests` | New or changed tests; any bug fix | Would the test fail on regression? Fixtures real and scrubbed? |
| `review-docs` | Any behaviour change; before releases | Decisions vs code, tool spec vs schemas, coverage table, env vars, examples that run |
| `add-adapter` | Implementing a new source | A 12-step recipe ending in the reviews above |

Claude Code also has built-in `/code-review <low|medium|high|xhigh|max>` for an independent multi-angle
pass over a diff or path; use `xhigh` before merging anything that touches `src/`. The first xhigh
review of this codebase (2026-10-17) found 15 defects, all fixed with regression tests; see
`test/unit/regressions.test.ts`.

## 3. What a good review report contains

- Scope: what was read (full files, not just hunks), what was run.
- Findings ordered by severity - **S1** wrong answer / security / data loss, **S2** wrong in edge cases or
  misleading, **S3** robustness / maintainability, **S4** style - each with `file:line`, the defect, a
  concrete failing input, the fix and the test that catches it.
- What was checked and found clean.
- Outcomes after fixing: fixed / skipped (reason) / not a bug.

## 4. Merge criteria
1. `npm run verify` green.
2. `review-code` run; no open S1/S2.
3. For adapter changes: `review-adapter` complete and live smoke output attached.
4. For anything touching secrets, personal data, HTTP or tool output: `review-security` complete.
5. Docs and decisions updated in the same change (`review-docs`).
6. New behaviour has tests that fail without it; fixed bugs have a named regression test.

## 5. Lessons recorded from past reviews (check for these first)

| Defect class | Example | Guard |
| --- | --- | --- |
| Heuristic detection that fires on ordinary text | Company names parsed as VAT numbers ("Deutsche Bank" -> DE...) | Per-country shapes; negative tests with real names |
| ASCII-only assumptions | `[a-z0-9]` erased Greek/Cyrillic and ø/æ | Unicode tokenizer; tests with Greek, Cyrillic, Nordic names |
| Failure reported as a fact | VIES outage cached as "VAT invalid" | Only definite answers are cached; error-shaped fixtures |
| Name-only merging | Two same-name entities from one source merged | Merge across sources only |
| Optimisation that can fail the request | Cache write error aborted a lookup | Cache degrades to uncached |
| Credential forwarding | Automatic redirects sent custom auth headers | Manual same-host redirects |
| Sloppy limits | 429 penalty blocked a whole window; config 95 vs 0.95 | Tests with prior traffic; range-checked config |
| Over-crediting provenance | A source that said "unknown" listed as supporting | Weak values don't corroborate |
| A source that silently froze | The OFSI list closed 2026-01-28 but its URL kept returning a stale file | Report each list's version date; warn at 14 days, `incomplete` past 45; the `review-adapter` skill requires a currency check |
| Free-text "identifier" extraction | Dates and "Organization Established Date" values indexed as registration numbers | One `acceptIdentifier()` (shape, digit, not a date) and an explicit allow-list of id types |
| Silent truncation | A cut-off XML file parsed fine into a partial list | Closing root tag, declared record count, minimum size; never cache a failed check |
| A clean result from nothing | A blank name or a nameless entity returned `no_match` | Reject degenerate input; `incomplete` when nothing could be screened by name |
| Unobserved promise started early | A background lookup that could reject before it was awaited (crash risk in Node) | Attach a handler at creation; test with a slow dependency and a failing one |
| A stale fact presented as current | An expired PSC exemption reported as exempt | Check dates against today; test with expired / future / current cases |
| An outage shown as an empty result | Root company unreadable -> one-node 'available' graph | Error state; tests per failure position (root vs higher up) |
| Shell-escaped regexes | A lost backslash silently broke matching | Read generated files back; tests with real inputs |
| Privacy drift | Audit log stored names despite "metadata only" | Hash free text; test the audit rows |
| Registry text used as a table key | `ROLES[code]` / `known[type]` with a code of `constructor` returns a member of `Object.prototype` (a TypeError or a function where a string belongs) | `ownEntry()` for every table keyed by registry text; a test with `constructor`, `toString`, `__proto__` |
| A record that drops out silently | A Norwegian role without a usable name vanished from the list, so the officer list and a screen built on it looked complete | Count what could not be read; `truncated` and a warning; test through the tools |
| An answer about another record | A register answering for a different number would become the requested company's profile | Compare the returned id with the one asked for; `bad_response` and no caching |
| The last name is still the name | A ceased company's only official name has an end date, so it had no legal name and could not be searched | Test with a real ceased-company fixture, not only live ones |
| Claims written by hand | The profile said officers were "available" for every country, `check_coverage` listed countries in a string | Derive the claim from the adapters (country, capabilities, restrictions); test one company per country |
| Fan-out that ignores the filter | A `country=DE` search still called the Norwegian and Finnish registers | Adapters declare their country; test the sources queried per country |
| A short numeric id compared across countries | Bare 8-9 digit registry numbers can equal unrelated passport or tax numbers on a list, and an identifier hit scores 1.0 | Only typed, long identifiers (LEI, UK company number, VAT) are compared; the rest are screened by name |

The sixth `xhigh` review (`kyb_check` prompt) found 4 issues (marker forgery through the entity text, tool names that could drift, no rule for families unavailable by design, unvalidated depth), fixed with tests in `test/integration/kyb.test.ts`. Lesson: text a user supplies to a prompt is untrusted too.

The fifth `xhigh` review (filings, charges and insolvency, 2026-10-17) found 9 more defects (a part-satisfied charge not counted as outstanding, a 404 read as "no charges", charge holders not treated as personal data, a stale tool description, duplicated helpers), fixed with tests in `test/unit/records.test.ts` and `test/integration/records.test.ts`.

The fourth `xhigh` review (Norway and Finland, the generalised officers / ownership code and the GLEIF crosswalks, 2026-10-17) found 15 more defects, all fixed with tests in `test/unit/nordic.test.ts` and `test/integration/nordic.test.ts` (the "review regressions" groups). A live run before the review had already shown the Nokia date disagreement between PRH and GLEIF, which is the conflict machinery working as intended.

The third `xhigh` review (officers, ownership and related-party screening, 2026-10-17) found 13 more defects, all fixed with tests in `test/integration/people-review.test.ts`.

The second `xhigh` review (sanctions module, 2026-10-17) found 13 more defects, all fixed with tests in `test/unit/sanctions-review.test.ts` and `test/integration/sanctions.test.ts`. A live run after the review then exposed the stale OFSI feed, which no review of the code could have found: **review the code, then run it against the real world.**
