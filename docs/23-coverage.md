# Coverage: what each source and country can return

Audience: users deciding whether this server can answer their question, and contributors planning
adapters. Updated whenever an adapter or a source's behaviour changes. Last verified: 2026-10-17.

State words are used precisely:

- **yes** - implemented and verified against the live service
- **planned** - decided (D12) but not built
- **restricted** - exists but legally closed to the public or to this use (not fixable by us)
- **payment** - available only through paid access
- **not published** - the source does not hold or release it
- **unverified** - from documentation or third parties, not observed live

## Implemented today (v0.0.1)

| Source | Access | Verified live | What it gives | Known limits |
| --- | --- | --- | --- | --- |
| Companies House (GB) | Free key, 600 req / 5 min per key | 2026-10-17 | Company profile, status, former names, registered address, SIC (not yet mapped), search | OGL v3.0 attribution carried in provenance. Dormancy is not in the status field (it is in the accounts type), so `dormant` is never produced yet. Overseas companies' addresses are labelled GB |
| GLEIF | Free, no key | 2026-10-17 | LEI record: legal name, addresses, legal form (ELF code), jurisdiction, registration status and renewal, registration authority + number (gives the UK number crosswalk), name search | Only LEI holders. `INACTIVE` is mapped to `unknown`, not "ended". Name search is broad |
| Companies House officers and PSC (GB) | same key | 2026-10-17 | Current and resigned officers (role, dates, nationality, occupation, month/year of birth, address, corporate officers' UK numbers); persons with significant control with share / voting bands and board-control flags; PSC exemptions and statements | Individuals are personal data (D13). Percentages are bands. Overseas entities' beneficial owners follow the same endpoint but have not been exercised. Registry text is untrusted |
| Norway: Enhetsregisteret (Bronnoysund) | Free, no key; rate limit unverified (client allows 10/s) | 2026-10-17 | Identity (name, former names, legal form by code, status from flags, founding date, registered or postal address), name search, **roles** (CEO, chair, board members, deputies, auditor, accountant, signatories; full birth date as published, deceased flag; no appointment dates), LEI and VAT crosswalk via GLEIF | NLOD 2.0 attribution in provenance. Beneficial owners are not public (`restricted_access`). Sub-units (underenheter) are not looked up. The 410 Gone body shape for deleted units is unverified, so it is handled without trusting the body |
| Finland: PRH open data v3 | Free, no key; rate limit unverified (client allows 5/s) | 2026-10-17 | Identity (names with history, trade-register status, company situations, legal form, address, registration date), name search, LEI crosswalk via GLEIF, VAT number computed from the business ID and validated by VIES | CC BY 4.0. The `status` field is "2" for every company and is ignored; status is inferred (see D40) and is `unknown` for companies outside the trade register (housing companies, associations). Officers are not in the open data (`not_published_by_source`); beneficial owners are not public (`restricted_access`). Situation codes other than KONK and SELTILA are reported as `unknown` |
| UK Sanctions List (FCDO) | Free, no key; 22 MB XML | 2026-10-17 | 6,408 designations (people, entities, ships), names + aliases with quality, regime, designation date, UK company numbers of entities | Replaced the OFSI Consolidated List (closed 2026-01-28). Dates of birth, passports and ids are deliberately not read |
| EU consolidated sanctions list | Free, public token URL; 26 MB XML | 2026-10-17 | 6,234 designations, names + aliases, programme, registration numbers of enterprises | Token URL is fixed and public; override with EIM_EU_SANCTIONS_URL if it rotates |
| US OFAC SDN list | Free; 29 MB XML via a redirect to Treasury's CDN | 2026-10-17 | 19,457 entries, names + aka with strength, programmes, company / VAT / registration numbers of entities | Redirect to an amazonaws.com host is explicitly allowed (no credentials sent) |
| VIES (EU) | Free, no key | 2026-10-17 | VAT validity; name and address where the member state releases them | Germany (and others) withhold names. Member-state outages are reported as errors, never as "invalid". UK VAT numbers are not covered |

## Roadmap by country (D12)

| Wave | Countries | Source | Access (as assessed) | Identity | Officers | Owners | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core | GB | Companies House | free key | yes | **done** | **done** (PSC chain) | Filings, charges, insolvency planned |
| Core | GB | FCA Register | free key (verified 2026-10-17) | planned | planned | - | Regulatory status; headers `X-Auth-Email`/`X-Auth-Key` verified, rate limit unverified |
| Core | EU | GLEIF Level 2 | free | planned | - | partial: only entities that report parents | Direct/ultimate parent relationships |
| Core | all | UK, EU, OFAC sanctions lists | free downloads | - | - | - | **Done**: `screen_sanctions`, local index, 24 h refresh |
| 1 | NO | Bronnoysund | free, no key (verified) | **done** | **done** (roles incl. birth date) | restricted | Filings and sub-units not built |
| 1 | FI | PRH open data | free, no key (verified) | **done** | not published | restricted | Name search is broad; status inferred; officers sit in the non-open trade-register extract |
| 1 | DK | CVR | free but requires registration (unverified) | planned | planned | restricted | Apply for system-to-system access early; third-party cvrapi.dk returned 403 |
| 1 | IE | CRO | free search; no verified API (unverified) | planned | unverified | **restricted** (RBO closed since the 2022 CJEU ruling) | Needs official-doc check |
| 2 | FR | SIRENE / INPI | free (unverified) | planned | unverified | restricted | |
| 3 | NL, BE | KvK, KBO | mixed free/paid (unverified) | planned | payment? | restricted | |
| Later | DE, ES, IT, others | national registers | often paid or hard to automate | identity via GLEIF/VIES only | payment | restricted | Handelsregister is partly paid |

## Data families and why some will stay unavailable

| Family | Typical reality |
| --- | --- |
| Identity | Widely available for LEI holders, VAT-registered traders and UK companies. Most EU companies without an LEI are reachable only by VAT number until their national register adapter exists |
| Officers | **Implemented for the UK and Norway** (`get_officers`). Finland does not publish them in its open data; Denmark and the rest are planned; mixed elsewhere; contains personal data (D13) |
| Beneficial owners | **Implemented for the UK PSC register** (`get_ownership`). **Restricted** in most EU registers since the 2022 CJEU ruling (public access removed; obliged entities only), including Norway and Finland: the server reports `unavailable: restricted_access` with that explanation rather than an empty list. UK PSC data remains public |
| Filings, accounts | Document links only; availability varies |
| Regulatory | UK (FCA) planned; EU needs ESMA / national regulator registers |
| Insolvency, charges | UK via Companies House; EU insolvency registers are national and fragmented |
| Sanctions | **Implemented** (`screen_sanctions`): UK Sanctions List, EU consolidated list, OFAC SDN; name- and registration-number-based (LEI, UK company number, VAT; Norwegian and Finnish registry numbers are deliberately not compared with list identifiers because bare 8-9 digit numbers collide); refreshed every 24 h; not a legal determination. An entity's officers (UK, Norway) and owners (UK) can be screened with it; dates of birth are not used |

## How the server reports gaps
`get_entity.data.coverage.families.<family>.state` is one of `available`, `not_yet_supported`,
`unavailable` (with a reason: `not_published_by_source`, `restricted_access`, `requires_paid_access`,
`requires_credentials`, `not_enabled`, `no_such_record`) or `error`. An empty list is never used to
mean "unknown". The `officers` and `ownership` families are worked out **per company** from the
enabled adapters and what each country's register provides (a Finnish profile says officers are not
published; a Norwegian one says ownership is restricted; a UK one with no key says why), with the
explanation in `note`. The tools return the same reason in `data.officers` / `data.ownership`.

## Lesson: check that a source is still being published

The first sanctions build used the OFSI Consolidated List (`ConList.xml`). A live run reported its
version as months old; the HTTP `Last-Modified` header agreed. The publisher had **closed that list on
2026-01-28** and replaced it with the UK Sanctions List, but the old URL kept answering 200 with a frozen
file, so nothing failed. Safeguards now in place: each list reports its own version date, a warning is
raised after 14 days, a list older than 45 days can only produce `incomplete`, and the review skills
require a currency check for every source (see [25-code-review.md](25-code-review.md)).
