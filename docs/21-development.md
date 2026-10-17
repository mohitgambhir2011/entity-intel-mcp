# Development guide

Audience: anyone changing the code. Read once; then use `npm run verify` and the review skills.

## Setup

Requires Node 22+ (the project uses built-in `fetch` and `node:sqlite`) and git.

```bash
npm install
npm run verify
```

`node:sqlite` prints an `ExperimentalWarning` on stderr; that is expected on Node 22 (D31). The storage
code sits behind an interface so it can be replaced if the API changes.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run verify` | typecheck, lint, format check, all tests, build. **Must pass before every commit** |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run test:architecture` | Only the layering/stdout/secret guards |
| `npm run typecheck`, `lint`, `format`, `format:check` | tsc, ESLint, Prettier |
| `npm run build` | Compile `src/` to `dist/` |
| `npm run dev` | Run the server from source over stdio |
| `npx tsx scripts/live-smoke.ts` | Real calls to GLEIF, VIES, Companies House |
| `npx tsx scripts/live-people.ts` | Real Companies House officers / PSC for the Tesco group and a related-party sanctions screen (prints counts and company names only). Needs your key |
| `npx tsx scripts/live-nordic.ts` | Real Norwegian and Finnish registers (no key): Equinor ASA and Nokia Oyj through identifier, LEI and VAT forms, a ceased and a bankrupt company, roles and the reasons ownership and Finnish officers are unavailable, and name searches. Prints counts and company data only (no individuals' names). Run it after touching `src/adapters/no-brreg`, `fi-prh` or the GLEIF crosswalks |
| `npx tsx scripts/live-records.ts` | Real Companies House filing history, charges and insolvency for Tesco PLC, Tesco Stores and a liquidated company (counts and types only). Needs your key |
| `npx tsx scripts/live-sanctions.ts` | Downloads the real UK, EU and OFAC lists (about 100 MB), prints entry counts, versions and timings, and screens sample names. Run it after touching `src/sanctions/` and whenever a publisher changes a list |
| `npx tsx scripts/live-mcp-smoke.ts` | Spawns the built server and calls every tool over stdio against real services |
| `npx tsx scripts/print-examples.ts <tool>` | Prints a tool response from the recorded fixtures (keeps docs honest) |

Live scripts need `COMPANIES_HOUSE_API_KEY` in the environment. They are not part of the test suite
(no network in tests).

## Testing strategy (D16)

1. **Unit tests** for pure logic: identifiers, normalisation, scoring, merging, config.
2. **Adapter tests over recorded fixtures**: found, not found, error bodies, withheld fields, auth header
   shape, secrets absent from URLs.
3. **Integration tests** drive the full server with a real MCP client over an in-memory transport and a
   fake `fetch` that replays fixtures. They check the envelope, warnings, caching, conflicts, audit rows,
   and that registry text never reaches `summary`/`warnings`.
4. **Architecture tests** fail on layering violations, `console.log` (stdout is the protocol), hard-coded
   secrets, `eval`.
5. **Regression tests**: every defect found in review gets a test named for it
   (`test/unit/regressions.test.ts`). Write it first and watch it fail.
6. **Golden set** (`test/golden/`): real entities with expected answers, replayed from fixtures; grows with
   every country. Re-record deliberately and explain changes.
7. **Manual KYB trial** before a release: 10 real companies end to end (D16-D).

### Recording fixtures
1. Call the real API with curl/PowerShell or a script; save the raw JSON under `test/fixtures/<source>/`.
2. Remove keys and any personal data the test does not need. Never edit values to suit the code.
3. Note the recording date in the commit message.
4. Gotcha: PowerShell's `Invoke-WebRequest` returns a byte array for `application/vnd.api+json` (GLEIF);
   decode it as UTF-8 before saving.

## Coding rules
- TypeScript strict, ESM, `noUncheckedIndexedAccess`. No `any` in `src/`.
- Errors that are expected (source down, bad input) are `SourceError` / `InvalidInputError`. Anything else
  is a bug and surfaces as a generic error with details on stderr.
- Never write to stdout. Never put a secret or registry text in a log, URL, cache key or `summary`.
- One definition per concept; grep before adding a constant or helper.
- Comments explain **why** (a source quirk, a decision number), not what.
- When writing regexes via a shell, mind backslash escaping: verify the file contents afterwards. (A lost
  backslash in a character class once turned `\p{L}` into `p{L}` and broke every name match.)
- Windows: Git converts LF to CRLF on commit (warnings are harmless). Do not commit generated files.

## Adding things
| You want to | Do |
| --- | --- |
| Add a source/country | Follow `.claude/skills/add-adapter/SKILL.md`, then `review-adapter` |
| Add a tool | Zod schema in `src/server/tools/`, one service call, envelope, audit row; update `docs/12-tool-spec.md`, README, `docs/22-tool-reference.md`; integration tests |
| Change a decision | New row in `docs/01-DECISIONS.md` (new D-number), update the affected docs and tests in the same commit |
| Add an env var | `src/core/config.ts` (with range), `.env.example`, README table, `docs/13-architecture.md` table |

## Release checklist (v0.x)
1. `npm run verify` green on a clean clone.
2. `npx tsx scripts/live-mcp-smoke.ts` output reviewed.
3. Run `review-code`, `review-security`, `review-docs` skills; no open S1/S2 findings.
4. `npm audit` triaged; lockfile committed; `files` in `package.json` still only `dist`, LICENSE, README.
5. `CHANGELOG.md` updated; version bumped; tag created.
6. Check the npm and GitHub names and run a trademark search (D18) before the first public publish.
7. Re-read the README limitations section against reality.
