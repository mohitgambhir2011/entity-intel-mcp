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
- **Norway / Finland**: verified and built; see the section "Norway and Finland" below.
- **Denmark / Ireland / France / Netherlands / Belgium**: still UNVERIFIED beyond the notes above.

## Sanctions lists (verified live 2026-10-17)

| List | URL | Size | Version signal | Structure | Notes |
| --- | --- | --- | --- | --- | --- |
| UK Sanctions List (FCDO) | https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml | 22 MB | `<DateGenerated>dd/mm/yyyy` in the file; `Last-Modified` agrees | `<Designations>` of `<Designation>` (UniqueID, OFSIGroupID, Names/Name with Name1..Name6 + NameType + AliasStrength, NonLatinNames, RegimeName, IndividualEntityShip, DateDesignated, Addresses, EntityDetails/BusinessRegistrationNumbers, ShipDetails/IMONumbers) | 6,408 designations. **Replaced the OFSI Consolidated List on 2026-01-28.** Free text in BusinessRegistrationNumber ("UK Company no. 06527449") |
| ~~OFSI Consolidated List~~ (`ofsistorage.blob.core.windows.net/.../ConList.xml`) | closed | 54 MB | `Last-Modified: 2026-06-03` | one row per name, GroupID | Still answers 200 but is frozen. **Do not use.** Found by noticing a months-old version date |
| EU consolidated financial sanctions list | https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw | 26 MB | `generationDate` attribute; `Last-Modified` agrees | `<export>` of `<sanctionEntity>` (nameAlias wholeName/strong, subjectType person|enterprise, regulation programme, identification, citizenship) | 6,234 entities. The token is a fixed public value (base64 of "token-2017"); override with EIM_EU_SANCTIONS_URL |
| OFAC SDN | https://www.treasury.gov/ofac/downloads/sdn.xml | 29 MB | `<Publish_Date>MM/DD/YYYY</Publish_Date>`, `<Record_Count>` | `<sdnList>` of `<sdnEntry>` (uid, firstName/lastName, sdnType, programList, akaList/aka with category strong|weak, idList/id with idType + idNumber, addressList) | 19,457 entries. 302 to a pre-signed S3 URL (`*.amazonaws.com`), so that host family is explicitly allowed for this download |

ID types seen on OFAC entities: "Registration Number", "Tax ID No.", "Business Registration Number", "Company Number", "V.A.T. Number", "Legal Entity Number", "SWIFT/BIC", "Commercial Registry Number", "Unified Social Credit Code (USCC)" and many non-identifiers ("Organization Established Date", "Secondary sanctions risk:", "Website"): only an allow-list of registration-style types is indexed.

Licence/terms: all three are official publications intended for public use. Redistribution terms are not asserted by this project; the lists are downloaded by each user's own server.

## Companies House officers and PSC (verified live 2026-10-17)

- `GET /company/{n}/officers?items_per_page=100&start_index=` -> `items[]` (name "SURNAME, Forenames", officer_role, appointed_on, resigned_on, date_of_birth{month,year}, nationality, country_of_residence, occupation, address, identification{registration_number, place_registered, legal_authority, identification_type} for corporate officers), `total_results`, `active_count`, `resigned_count`. Tesco PLC: 74 officers (11 current). Corporate roles (`corporate-secretary`) can lack `identification`.
- `GET /company/{n}/persons-with-significant-control?items_per_page=100` -> `items[]` with `kind` (`individual-/corporate-entity-/legal-person-/super-secure-person-with-significant-control`, and `-beneficial-owner` variants), `name`, `name_elements`, `natures_of_control[]` (e.g. `ownership-of-shares-75-to-100-percent`, `right-to-appoint-and-remove-directors`), `identification{}` for corporate controllers, `ceased`. An empty list with `links.exemptions` means look at `GET /company/{n}/exemptions` (Tesco PLC: `psc_exempt_as_trading_on_uk_regulated_market`); otherwise `GET .../persons-with-significant-control-statements` (404 when none).
- Chain verified end to end: Tesco Stores Limited (00519500) <- Tesco Holdings Limited (00243011) <- Tesco Plc (00445790, exempt). Havin Bank (01074897) <- Banco Central De Cuba (foreign, not followable).
- Each company costs 1 request (PSC), plus 1 more when it has no controllers (exemptions or statements). The rate limit (600 / 5 min) is protected by the 30-company budget per call.

## Ireland: CRO open data (verified live 2026-10-17, `scripts/live-ireland.ts`)

- `https://opendata.cro.ie` is a CKAN portal. Dataset `companies` ("Company Records", CC BY 4.0, daily, EU high-value dataset) has one datastore resource (`3fef41bc-...`, found through `package_show?id=companies`). No key. Over 850,000 rows, 457,000 of them dissolved.
- `datastore_search?resource_id=&filters={"company_num":249885}` -> `result.records[]` with `company_num` (number), `company_name`, `company_status_code` and `company_status` (the codes differ for one wording: `Normal` is 1151, 1051, 1153, 1141), `company_type_code` / `company_type`, `company_reg_date`, `comp_dissolved_date`, `company_status_date`, `company_address_1..4`, `eircode`, `nace_v2_code`, `last_ar_date`, `last_accounts_date`. Dates look like `1998-01-29T00:00:00`. A non-numeric filter gives an error body.
- Name search: `q={"company_name":"..."}` (full text, every word must match, case-insensitive); operators and punctuation in the text do not break it (HTTP 200) but `O'Brien (Ireland) Ltd` found nothing while `O Brien` found 959, hence the query cleaning. `datastore_search_sql` works but is not used.
- Status wordings seen: Normal, Dissolved, Dissolved-20 years, Strike Off Listed, Liquidation, Ceased IRL, Dissolved PostMerger, Ceased, Struck Off, Deleted CB Merger, De-Registered ICAV, Conv. to IndProvSoc, Administration (UK), Deleted CB Conversion, Deleted per SE merge, Deleted as per SE Tr, Liquidation (UK), Examinership, Liquidation stayed, Dissolved by Divis, De-Registered Investment Company, Administration. About 45 company types.
- GLEIF: registration authority `RA000402`, `registeredAs` is the plain number (Ryanair Holdings: 249885 -> `635400BR2ROC1FVEBQ56`).
- Not in the open data: directors, shareholders, filings. The CRO web services (`services.cro.ie`) are reported by third parties to need sign-up and to return officers (UNVERIFIED, not built). The beneficial ownership register is closed to the public. Bulk director data is a paid licence (third-party figures disagree: UNVERIFIED).
- Fixtures: the liquidation and strike-off rows have their addresses replaced with synthetic ones.

## FCA Financial Services Register (verified live 2026-10-17, `scripts/live-fca.ts`)

- Base `https://register.fca.org.uk/services/V0.1`, headers `X-Auth-Email` and `X-Auth-Key`. **Every reply is HTTP 200**, including not found and invalid input; the outcome is in the body: `Status` (e.g. `FSR-API-02-01-00`) and `Message` (`Ok...`). Codes ending `-11` mean nothing found (`Firm not found`, `No search result found`), `-21` is `Bad Request: Invalid Input` (also returned for endpoints that do not exist, such as `/Disciplinary`). No rate-limit headers are returned: the limit is unverified.
- `GET /Search?q=&type=firm` -> `Data[]` with `Status` (`Authorised`, `No longer authorised`), `Reference Number`, `Name` (with `(Postcode: ...)`). **It matches names and FRNs but not Companies House numbers.**
- `GET /Firm/{frn}` -> one object with `FRN`, `Organisation Name`, `Business Type`, `Status Effective Date` (dd/mm/yyyy), `Client Money Permission`, `MLRs Status`, **`Companies House Number`**, and links to sub-resources. Its own `Status` is the placeholder `See full details`: the authorisation status is only in the search result.
- `/Firm/{frn}/Permissions` (object keyed by activity, each a list of limitation blocks; 20 per page, `ResultInfo.Next` and `?pgnp=n`; Barclays UK: 34), `/Regulators` (FCA and PRA with dates), `/Requirements` (each requirement's text under a different field name, e.g. `RFB Sub-group`), `/Names`, `/Address`, `/Individuals` (2,289 for Barclays UK: personal data, not used), `/Passports`, `/Waivers`, `/Exclusions` are read as noted in [23-coverage.md](23-coverage.md).
- Design consequence: a company is found by name and confirmed by its company number (D43).

## Norway and Finland (verified live 2026-10-17, `scripts/live-nordic.ts`)

### Norway: Enhetsregisteret (Bronnoysund Register Centre)

- Base `https://data.brreg.no/enhetsregisteret/api`, no key, licence **NLOD 2.0** (attribution is carried in each provenance entry).
- `GET /enheter/{orgnr}` -> the unit (`navn`, `organisasjonsform{kode,beskrivelse}`, `stiftelsesdato`, `forretningsadresse` / `postadresse`, flags `konkurs`, `underAvvikling`, `underTvangsavviklingEllerTvangsopplosning` with dates, `slettedato`, `historiskeNavn`). 404 = no such unit. **410 Gone** is the documented answer for a deleted unit; its body shape has **not** been observed, so the adapter does not trust it (a nameless deleted unit stays nameless).
- `GET /enheter?navn={q}&size={n}` -> `_embedded.enheter[]` plus `page`. A query with no hits has no `_embedded`; a body with neither `_embedded` nor `page` is treated as an error and never cached.
- `GET /enheter/{orgnr}/roller` -> `rollegrupper[].roller[]` with `type{kode,beskrivelse}`, `person{navn{fornavn,mellomnavn,etternavn}, fodselsdato, erDoed}` or `enhet{organisasjonsnummer, navn[]}`, `fratraadt`, `avregistrert`. Equinor ASA: 15 roles (DAGL 1, LEDE 1, NEST/MEDL 8, VARA 3, REVI 1, ...; 13 current). **No appointment dates are published.** Individuals in the test fixture are synthetic; the company data is real.
- Role codes mapped: DAGL ceo, LEDE chair, NEST and MEDL board member, VARA deputy, REVI auditor, REGN accountant, SIGN and PROK authorised signatory, INNH and FFØR manager; anything else is `other` with the register's wording kept.
- Organisation number: 9 digits, mod-11 check digit (weights 3,2,7,6,5,4,3,2; a computed check of 10 is invalid). The VAT form is `NO` + number + `MVA`.
- **GLEIF crosswalk**: registration authority `RA000472` (Enhetsregisteret); GLEIF stores the number with spaces (`923 609 016`). The unspaced spelling is also asked, both at the same time, and the authority is checked client side (as for the UK).
- Beneficial owners are not in this API and are not public: reported as `restricted_access`.
- Not verified: the rate limit (the client allows 10 requests/s per host as a conservative guess); sub-units (`/underenheter`) are not used.

### Finland: PRH open data (YTJ v3)

- Base `https://avoindata.prh.fi/opendata-ytj-api/v3`, no key, licence **CC BY 4.0**.
- `GET /companies?businessId={id}` and `GET /companies?name={q}&maxResults={n}` -> `{ totalResults, companies[] }`. **An unknown business ID answers 200 with `companies: []`**, so shape is the only check; a list that does not contain the company asked for is an error, not "not found".
- Language codes in descriptions: 1 Finnish, 2 Swedish, 3 English (English preferred).
- Names: `type` 1 = official name, 2 = parallel name, 3 = auxiliary (trading) name; `endDate` marks a name that ended. A ceased company's official name usually has an `endDate`, so the newest official name is still taken as its legal name.
- **Status**: the `status` field was "2" for every company in a sample of **1,466 companies** and means nothing. The signals are `companySituations` (current ones only: KONK bankruptcy, SELTILA liquidation; others unrecognised) and the trade-register entry (`registeredEntries` with `register` = "1": "Registered" / "Ceased"). Companies without a trade-register entry (housing companies, associations) are `unknown`. Verified on a ceased company, a bankrupt one, one in liquidation and a housing company (fixtures `test/fixtures/prh_fi/`).
- Business ID: 7 digits + hyphen + mod-11 check digit (weights 7,9,10,5,8,4,2; remainder 1 invalid); the short spelling without the leading zero is accepted. The VAT number is `FI` + the ID without the hyphen, validated through VIES (`FI01120389` valid for Nokia).
- **GLEIF crosswalk**: registration authority `RA000188`; GLEIF stores the hyphenated ID.
- Officers and beneficial owners: not in the open API (officers sit in the trade-register extract, which is not open data): `not_published_by_source` and `restricted_access`.
- Not verified: the rate limit (the client allows 5 requests/s per host as a conservative guess); the meaning of situation codes other than KONK and SELTILA.
- **Observed disagreement**: Nokia's PRH registration date is 1896-12-19 while GLEIF's creation date is 1896-12-18. Both are shown as a `conflicts` entry and a warning, which is the intended behaviour for differing sources.
- **Fixture hygiene**: `test/fixtures/prh_fi/0104057-3.json` is a real bankruptcy record whose partnership is named after a person, so its name and street were replaced with synthetic values; the Norwegian roles are synthetic individuals. Company records otherwise keep their real data.
