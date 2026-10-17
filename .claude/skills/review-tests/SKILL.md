---
name: review-tests
description: Review the quality and adequacy of tests in entity-intel-mcp. Use when tests are added or changed, when a bug is fixed, and when judging whether a change is safe to merge. Checks that tests would actually fail on a regression, that fixtures are real and scrubbed, and that the golden set and architecture guards are maintained.
---

# Review tests

A passing test suite proves nothing unless the tests can fail. Review the tests as skeptically as the code.

## Per change

- [ ] **Fails without the fix.** For a bug fix, mentally (or actually) revert the fix: the new test
      must fail. Regression tests are named for the defect (`test/unit/regressions.test.ts`).
- [ ] **Asserts behaviour, not implementation.** No assertions on private call order or internal
      structure unless that order _is_ the contract (e.g. requests overlap in time).
- [ ] **Covers the unhappy paths** the code claims to handle: 404, 429, 5xx, timeout, malformed
      body, empty result, withheld field, missing credentials, storage failure.
- [ ] **Edge inputs:** empty string, whitespace, very long input, Unicode (Greek, Cyrillic, ø æ ß),
      lowercase identifiers, identifiers with separators, partial dates.
- [ ] **Boundaries:** limit 1 and 25, depth 0/3/10, thresholds exactly at 0.95 and 0.80.
- [ ] **No time or network flakiness:** injected clock (`instantClock`), `fakeFetch`, in-memory
      storage; nothing sleeps for real or touches the network (live checks live in `scripts/`).
- [ ] **Order independence:** tests do not rely on shared state (each builds its own harness).
- [ ] **Negative assertions that matter:** secrets absent from outputs/URLs/audit rows; registry
      text absent from `summary`/`warnings`; no stdout writes.

## Fixtures (`test/fixtures/<source>/`)

- [ ] Recorded from the real service, not hand-written to fit the code. Note the recording date.
- [ ] Scrubbed: no API keys, no incidental personal data beyond what the test needs.
- [ ] When a source's shape changes, re-record and diff; do not patch the fixture to make a test pass.
- [ ] Error-shaped fixtures exist (VIES `errorWrappers`, GLEIF error body, Companies House 404).

## Suites

- `test/unit/*` - pure logic and adapters over fixtures.
- `test/integration/tools.test.ts` - real MCP client over an in-memory transport against the full server.
- `test/architecture.test.ts` - layering, stdout, secrets, eval. Update `ALLOWED` when adding a source area.
- Golden set (D16-A, `test/golden/`) - 50-100 real entities with expected answers. When behaviour for a
  country changes, update the expected answers deliberately and say why in the PR.

## Smells to flag

- Snapshot tests of large JSON with no focused assertions.
- `expect(...).toBeDefined()` / `toBeTruthy()` as the only assertion.
- try/catch inside a test that swallows the failure.
- A test that mirrors the implementation's algorithm (it will agree with the bug).
- `.skip` / `.only` committed.
- Coverage that is high but only on happy paths.

## Report

For each gap: the behaviour that is untested, one concrete input that would expose a regression, and
the test to add. Run `npm test` and report counts; if you changed code to add tests, re-run `npm run verify`.
