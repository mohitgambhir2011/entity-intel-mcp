---
name: review-code
description: Thorough, repo-specific code review for entity-intel-mcp. Use before every commit, PR or merge, and whenever the user asks to review, audit or check code in this repository. Runs the mechanical gates first, then reviews correctness, security, data integrity, modularity and tests against the project's decisions, and delegates to the specialised review-* skills.
---

# Review code (entity-intel-mcp)

This server answers KYB / due-diligence questions. A wrong answer (a false "not sanctioned", a merged
pair of companies, an "invalid VAT" that was really an outage) has real cost, and registries are an
untrusted input. Review accordingly: **assume the code is wrong until the evidence says otherwise.**

## 0. Scope

1. Decide what is under review: `git diff main...HEAD`, `git diff HEAD` (uncommitted), a path, or a PR.
   If the user named nothing, review uncommitted changes plus the last commit.
2. Read every changed file **in full**, not just the hunks. Bugs live in the unchanged lines of a
   touched function and in the callers of a changed signature (grep for the symbol).
3. Read `docs/01-DECISIONS.md` for the decisions the change touches (D-numbers), and
   `docs/13-architecture.md` for layering. A change that contradicts a locked decision is a finding
   unless it also amends the decision in the same change.

## 1. Mechanical gates (run first, report failures verbatim)

```bash
npm run verify      # typecheck + lint + format check + all tests + build
```

`test/architecture.test.ts` already enforces: layering, no writes to stdout (it is the MCP protocol
channel), no hard-coded secrets, no eval/child_process. If a gate fails, that is finding #1; fix it
before spending effort on anything else.

## 2. Review passes (do all of them; do not stop at the first finding)

Work through each pass as a separate read of the code. Record candidates as `file:line - claim -
concrete failing input`. Prefer reporting a doubtful finding with its uncertainty over dropping it.

### Pass A - correctness line by line

For every line: what input, state, timing or platform makes it wrong? Specifically look for:
inverted conditions, off-by-one, falsy-zero (`if (x)` where 0 or "" is valid), missing `await`,
swallowed errors, `?.` hiding a bug, regexes with unescaped metacharacters or lost backslashes,
`Array.sort` comparators that are not total orders, Map/Set key collisions (are keys unique?),
mutation of shared objects (a returned `Sourced.value` that aliases cached data), string vs byte length.

### Pass B - data integrity (the failure modes that matter here)

- **Entity identity:** can two different entities be merged (name-only match, same-source duplicates,
  hash collisions on non-Latin names)? Can one entity be split? `docs/11-data-model.md` section 4:
  name-only matches never merge entities.
- **Provenance:** does every value that reaches `data` carry the source that actually supports it?
  A source that said "unknown" must not be credited as corroboration.
- **Absence vs failure:** "not found", "not published", "restricted", "source down" and "not yet
  supported" are five different states (D28, `Availability`). A failure must never be reported as a
  negative fact (`invalid`, `no match`, `no officers`) and must never be cached as one.
- **Freshness:** is stale data ever served silently (D28)? Are "not found" results cached for long?
- **Dates, statuses, numbers:** partial dates, timezones, status mapping (D21: unknown wording maps
  to `unknown`, never a guess), thresholds in 0..1.
- **Unicode:** names are Latin, Greek, Cyrillic, Nordic. Anything using `[a-z0-9]`, `\w`, `toUpperCase`
  or `slice` on names is suspect.

### Pass C - security and privacy -> run the `review-security` skill

Registry text is attacker-controlled; secrets must never be logged or returned; personal data
(officers, owners) has retention rules (D11, D13, D14).

### Pass D - external sources -> run the `review-adapter` skill when anything under `src/adapters/` or `src/infra/http.ts` changed

Auth, rate limits, response validation, caching, licence terms, fixtures.

### Pass E - modularity and design

- Dependencies point down only (`core` <- `infra`/`resolution` <- `adapters` <- `services` <- `server`).
  New area? Add it to the table in `test/architecture.test.ts` and `docs/13-architecture.md`.
- No logic in `server/` beyond input parsing, calling one service, and shaping the envelope.
- One definition per concept (source priority, status mapping, identifier shapes, TTLs). Grep for
  duplicates before accepting a new constant or helper; name the existing one to reuse.
- Is a special case being layered onto shared infrastructure instead of fixing the mechanism?
- Files over ~250 lines or functions over ~60 lines should have a reason. Split by responsibility.
- Public interfaces: narrow, typed, documented with the invariant (not the obvious).

### Pass F - efficiency

Sequential awaits that could be parallel, repeated I/O for the same key, unbounded loops or lists,
work at startup, memory held by closures, large responses (the 25-item cap, D25), rate-limit budget
consumed per call.

### Pass G - tests -> run the `review-tests` skill

Every behavioural change needs a test that fails without it. Every fixed bug needs a regression test
named for the defect.

### Pass H - docs and decisions -> run the `review-docs` skill

Behaviour changed? The tool spec, README, decisions log and coverage table must change with it.

## 3. Report

Use `ReportFindings` when the host provides it, otherwise a table. Order by severity:
**S1** wrong answer / security / data loss, **S2** wrong in edge cases or misleading output,
**S3** robustness / maintainability, **S4** style. For each finding give:
`file:line`, one-sentence defect, the concrete failing input or state, the fix, and the test that
would catch it. Do not pad: but do not drop a finding because it is unlikely. State what you checked
and found clean, so the reader knows the coverage.

## 4. After fixes

- Write the regression test first, watch it fail, then fix.
- Re-run `npm run verify`.
- Re-report each finding with its outcome (fixed / skipped with reason / not a bug).
- A review is not finished until the gates are green and every S1/S2 finding has an outcome.

## Anti-patterns (reject in review)

- "Handled" errors that only `console.error` and carry on to return a confident answer.
- Casting upstream JSON to a type and trusting it (`as Foo`) without a runtime check at the boundary.
- A catch-all that turns every error into the same message.
- Tests that assert the happy path only, or that were adjusted to match the code rather than the spec.
- Comments that restate the code; missing comments on the non-obvious _why_ (e.g. why a status maps to `unknown`).
