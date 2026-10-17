---
name: review-docs
description: Review that documentation, decisions and code of entity-intel-mcp agree. Use after any behaviour change, when adding a tool, source or country, before a release, and when the user asks to review or update the docs.
---

# Review documentation and decisions

Documentation here is part of the product: users rely on the coverage table and caveats to know what
the server can and cannot tell them. Stale docs are bugs.

## Consistency checks (do all)

1. **Decisions vs code.** Read `docs/01-DECISIONS.md`. For each decision the change touches, confirm the
   code still does what it says. A deliberate deviation needs a new or amended decision (like D33) in
   the same change; never silently diverge.
2. **Tool spec vs tools.** `docs/12-tool-spec.md` and the zod schemas/descriptions in
   `src/server/tools/*.ts` must match: names, arguments, defaults, bounds, output fields, status.
   Run `check_coverage` and compare the families listed with the README.
3. **Data model vs types.** `docs/11-data-model.md` vs `src/core/types.ts`, `entity.ts`. Fields added in
   code appear in the doc (and vice versa) with their meaning.
4. **Architecture vs layout.** `docs/13-architecture.md` folder tree, layer rules and env-var table vs
   `src/` and `src/core/config.ts`. `test/architecture.test.ts` `ALLOWED` table matches the doc.
5. **Sources.** `docs/10-source-assessment.md` has, per source: access, auth, limits, licence, what was
   _verified live_ (with date) vs UNVERIFIED. Unverified claims are labelled.
6. **README.** Status line, tool list, install snippet, configuration, GDPR / licence / not-legal-advice
   notes are true today. Nothing is promised that is not built.
7. **Env vars.** Every variable read in `config.ts` is in `.env.example`, README and the architecture table, with default and range.
8. **Examples run.** Commands and JSON examples in docs actually work (run them or the smoke script).

## Quality bar for what is written

- Say **why**, not just what. Record the alternative that was rejected.
- Be specific: numbers, file paths, exact variable names, exact behaviour on failure.
- Distinguish states precisely: _not published_, _restricted_, _requires payment_, _not yet supported_, _error_.
- No marketing language. No claims of completeness, compliance, or legal effect.
- Dates are absolute (2026-10-17), never "recently" / "now".
- One source of truth per fact: link to it instead of repeating it.
- Each doc starts with who it is for and when to read it.

## Where things go

| Change                           | Update                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| New/changed decision             | `docs/01-DECISIONS.md` (new D-number, date, status) and `02-QUESTIONS.md` if a question was asked |
| New tool or argument             | `docs/12-tool-spec.md`, README tool list, tool `description`                                      |
| New source/country               | `docs/10-source-assessment.md`, coverage table in README, `registry.ts`, `.env.example`           |
| New module/layer                 | `docs/13-architecture.md`, `test/architecture.test.ts`                                            |
| Bug fix with user-visible effect | `CHANGELOG.md`                                                                                    |
| Behaviour users must know about  | README (limitations section)                                                                      |

## Report

List each inconsistency as `doc:section vs file:line`, which side is right, and the edit. If a claim
cannot be verified from code or a live check, mark it UNVERIFIED rather than rewording it.
