# Contributing

The short version: run `npm run verify`, add a test that fails without your change, update the docs, and run the review skills (see [docs/25-code-review.md](docs/25-code-review.md)).

1. Read `docs/01-DECISIONS.md` and `docs/13-architecture.md` first. Decisions there are locked unless discussed in an issue.
2. `npm install`, then `npm run typecheck && npm run lint && npm test` must pass.
3. New source adapters: implement the adapter contract (`docs/11-data-model.md` §9), add recorded fixtures under `test/fixtures/<adapter>/` (scrub keys and personal data not needed for the test), add golden-set entries, and document the source's licence/caching terms in `docs/10-source-assessment.md`.
4. Never commit API keys. Never put registry text into tool `summary` or `warnings` fields.
5. By submitting a pull request you agree to the [CLA](CLA.md).
