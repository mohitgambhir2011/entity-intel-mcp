---
name: add-adapter
description: Step-by-step recipe for adding a new data source or country adapter to entity-intel-mcp (for example Norway Bronnoysund, Finland PRH, Ireland CRO, France SIRENE). Use when implementing a new adapter, then finish with the review-adapter skill.
---

# Add a source adapter

Follow in order. Keep each step small and runnable.

1. **Assess the source first** (`docs/10-source-assessment.md`): access, auth, rate limit, licence
   (caching / redistribution / attribution), fields per data family, quirks (withheld values, encodings).
   Hit it live with 3-5 real entities. Mark anything not observed UNVERIFIED. Stop if the terms forbid
   what the server does (D4, D8).
2. **Add the catalogue entry** in `src/adapters/registry.ts`: `id` (used in `EIM_ADAPTERS`), `country`,
   `label`, `requiredEnv`, `schemes`, `implemented: true`, `create`. Keyless sources need no env.
3. **Add the identifier scheme** if new: `IdentifierScheme` in `src/core/types.ts`, a validator and
   normaliser in `src/core/identifiers.ts` (with tests), detection rule only if the shape is unambiguous
   (otherwise require `scheme`/`country`, as for UK company numbers). Extend `SUPPORTED_SCHEMES` and the
   zod enum in `src/server/tools/shared.ts`. Decide the `entityId` form (D20) in `chooseEntityId`.
4. **Add the source id** to `SourceId` and to `SOURCE_PRIORITY` in `src/core/sources.ts` (home registry
   ahead of `gleif`).
5. **Create `src/adapters/<id>/index.ts`** implementing `SourceAdapter`:
   - `supports`, `lookup` (and `search` / `crosswalks` if the source offers them);
   - all HTTP through `ctx.http.getJson` with `source` set; validate the body _inside_ the
     `ctx.cache.getOrFetch` fetcher so bad responses are never cached; return `null` for 404;
   - map to `PartialEntity` with full `Provenance` (+ licence string if required);
   - status via `makeStatus(...)` with unknown wording -> `unknown` (D21);
   - throw `SourceError` with the correct `kind`; never turn failures into negative facts.
6. **Add the host rate rule** to `DEFAULT_HOST_RULES` in `src/infra/http.ts`.
7. **Record fixtures** from the live service into `test/fixtures/<id>/` (found, not found, search, error
   shape, any withheld-field case). Scrub secrets and incidental personal data.
8. **Write tests** in `test/unit/adapters.test.ts` (mapping, 404, auth header, no secrets in URL,
   malformed body not cached) and a case in `test/integration/tools.test.ts` through `get_entity`.
9. **Coverage:** update the per-country coverage matrix (README + `docs/10-source-assessment.md`) with
   exactly which families this country supports and which are restricted/unavailable and why.
10. **Smoke test live:** extend `scripts/live-smoke.ts` / `live-mcp-smoke.ts` and run them.
11. **Run `npm run verify`**, then the `review-adapter`, `review-security` and `review-docs` skills.
12. **Update docs and CHANGELOG** and, if a decision changed, `docs/01-DECISIONS.md`.

Definition of done: gates green, fixtures real, live smoke output recorded, coverage table updated,
reviews run with every S1/S2 finding resolved.
