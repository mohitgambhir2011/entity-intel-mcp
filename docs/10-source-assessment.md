# Phase 1 — Source assessment (in progress)

Started 2026-10-17. Status per source: sign-up facts below come from web search; items marked UNVERIFIED must be checked against official docs/portal before we rely on them.

## UK-1 Companies House REST API

- **Cost / access:** free; API key from the Companies House Developer Hub.
- **Sign-up:** (1) create a Developer Hub user account; (2) "Your applications" → register a new application; (3) choose type **REST** (not Streaming — the keys are not interchangeable); (4) copy the generated key.
- **Auth:** key sent as HTTP Basic username (empty password).
- **Rate limit:** 600 requests per 5 minutes per key; exceeding returns HTTP 429 until the window resets. Higher limits by contacting Companies House. Repeated abuse can get an application banned.
- **Design implications:** client-side rate limiter + backoff; cache aggressively (D7); one key per user (BYO keys, D4) — do not share keys.
- **Data families:** identity/status, officers, PSC (beneficial owners), filings, charges, insolvency.
- **Sources:** https://developer-specs.company-information.service.gov.uk/guides/gettingStarted , https://developer-specs.company-information.service.gov.uk/guides/developerGuidelines

## UK-2 FCA Financial Services Register API

- **Cost / access:** free; self-serve registration on the FCA developer portal (register.fca.org.uk/Developer).
- **Sign-up:** register with an email address (becomes the API username) plus basic personal details; API key is then shown in your portal profile.
- **Auth (UNVERIFIED):** headers `X-Auth-Email` and `X-Auth-Key`. Base URL `https://register.fca.org.uk/services/V0.1` (UNVERIFIED).
- **Rate limit (UNVERIFIED):** reported 10 requests per 10 seconds; may change.
- **Support (UNVERIFIED):** RegisterAPISupport@fca.org.uk.
- **Data families:** regulatory status, permissions, individuals/controlled functions, disciplinary history.
- **To verify:** log in to the portal and read the official docs; confirm headers, limits, terms of use for caching.
- **Sources:** https://financial-services-register-api.readthedocs.io , https://apis.io/security/fca-uk/fca-uk-authentication/

## Live test results (2026-10-17)

| Source | Test | Result |
|---|---|---|
| Companies House | GET /company/00445790 with Basic auth (key as username) | 200 — TESCO PLC, active, plc, created 1947-11-27. Response headers `X-Ratelimit-Limit=600`, `X-Ratelimit-Remain`, `X-Ratelimit-Reset`, `X-Ratelimit-Window=5m` — usable for adaptive throttling. **Confirmed.** |
| FCA Register | GET register.fca.org.uk/services/V0.1/Search?q=Barclays Bank&type=firm with `X-Auth-Email` / `X-Auth-Key` | 200 — returned Barclays Bank UK PLC (FRN 759676, Authorised) plus two "No longer authorised" entities. **Base URL, headers and auth confirmed.** No rate-limit headers returned, so the 10 req / 10 s limit stays unverified; build a conservative client-side limiter. |
| GLEIF | GET api.gleif.org/api/v1/lei-records?filter[entity.legalName]=Tesco | 200, no key. Found TESCO PLC (LEI 2138002P5RNKC5W2JZ46). Note name search returns unrelated entities too (Tesco Corporation) → needs matching/disambiguation. |
| VIES (REST) | ec.europa.eu/taxation_customs/vies/rest-api/ms/{CC}/vat/{n} | Works, no key. IE 6388047V → valid, name returned (Google Ireland Limited). DE 811128135 → valid, **name withheld** (as expected for Germany). BE test number returned invalid — likely my test number is wrong, re-test with a verified number. |
| OFSI consolidated list | HEAD ofsistorage…/2022format/ConList.xml | 200, ~54 MB XML. Bulk download; needs local parsing + daily refresh. |
| OFAC SDN | HEAD treasury.gov/ofac/downloads/sdn.xml | 200. |
| EU consolidated sanctions | not yet tested | Download normally needs a registered token — UNVERIFIED. |

**Implications:** sanctions screening must be local (download, parse, index, refresh daily) rather than live API calls (feeds D7 cache design). VIES gives validity everywhere but names only for some member states.

## Wave 1 + EU sanctions (2026-10-17)

| Source | Access | Tested | Findings |
|---|---|---|---|
| **Norway — Brønnøysund Enhetsregisteret** | Free, **no key** | `data.brreg.no/enhetsregisteret/api/enheter/923609016` and `/roller` → 200 | JSON. Identity, address, employees, group flag, and **officers/roles (incl. full name and date of birth)** — personal data, falls under D13. Easiest wave-1 source. Responses are UTF-8 (watch encoding in clients). Beneficial owners not in this API (separate, restricted register) — UNVERIFIED, check. |
| **Finland — PRH open data (YTJ v3)** | Free, **no key** | `avoindata.prh.fi/opendata-ytj-api/v3/companies?name=Nokia` → 200 | JSON with name history, business ID, registration dates. Name search is broad (991 hits for "Nokia", mostly unrelated small firms) → needs ranking. Officers/owners/financials: not checked — UNVERIFIED. |
| **Denmark — CVR** | Official system-to-system access is **free but requires registration** with Erhvervsstyrelsen (apply via datacvr.virk.dk form; Elasticsearch endpoint). Third-party `cvrapi.dk` returned **403** for my test request. | cvrapi.dk → 403 | Per search results (vendor sources, UNVERIFIED): approval step, timeline unknown. Action for user: apply for CVR system-to-system access now since approval can take time. Do not depend on cvrapi.dk (third-party, terms/limits). |
| **Ireland — CRO** | Free web search (CORE); a daily open dataset on data.gov.ie (CC BY 4.0) is claimed by one vendor — UNVERIFIED. No official API spec found. | not tested | Directors: reported via machine-readable text, unconfirmed. **Beneficial ownership (RBO) is closed to the public** since the 2022 CJEU ruling; only designated persons (banks, auditors etc.) get access, reportedly for a fee. Plan: identity from CRO open data/GLEIF; owners = "not available" with an explicit coverage flag. To verify on official CRO/data.gov.ie pages. |
| **EU consolidated sanctions list** | The public download URL **worked with a token** (HTTP 200, ~26 MB XML, generated 2026-10-15) | download → 200 | Full XML list with entity records. The token in the URL is a published public one; confirm in EU FSF docs that it is intended for public use before shipping, and let users override it via env var. Same bulk model as OFSI/OFAC → local index, daily refresh. |

**Cross-cutting findings**
- Norway and Finland are keyless, so wave 1 can start with no sign-ups; Denmark needs an application; Ireland needs more research.
- Beneficial-owner data is the weak point everywhere in the EU (closed after the 2022 CJEU ruling). The coverage matrix must show `beneficial_owners: unavailable (restricted)` per country rather than returning nothing silently.
- All three sanctions sources (OFSI ~54 MB, EU ~26 MB, OFAC) are bulk files → one shared "sanctions index" module.

## Still to assess

Wave 2 SIRENE/INPI; wave 3 KvK/CBE; Sweden (Bolagsverket) for later; official-doc verification of Ireland CRO and Denmark CVR terms; FCA rate limit.

Per source record: access, auth, limits, licence/caching/redistribution terms, fields available, 5 test entities.

## Verification log (2026-10-17, after implementation)

- **GLEIF**: `entity.registeredAt.id = RA000585` with `registeredAs = 00445790` confirmed as Companies House for Tesco PLC; used for the LEI <-> UK number crosswalk. `filter[entity.registeredAs]` works on its own; combining it with `filter[entity.registeredAt.id]` returns HTTP 400, so the authority is checked client side. `Accept: application/vnd.api+json` required. Entity `status` values seen: ACTIVE, INACTIVE.
- **VIES (REST)**: responses carry `isValid`, `userError` (`VALID`/`INVALID`), `name`/`address` (`---` when withheld; Germany withholds). Error shapes for outages are not all observed; the adapter treats any body without a boolean `isValid` as an error and never caches it.
- **Companies House**: HTTP Basic with the key as username; `X-Ratelimit-*` response headers confirmed (limit 600, window 5m). Search relevance is loose (unrelated names appear in the top results), so ranking is done by this server.
- **FCA**: base URL, headers and a successful search verified; rate limit still unverified (no rate-limit headers returned).
- **Denmark / Ireland / France / Netherlands / Belgium**: still UNVERIFIED beyond the notes above.
