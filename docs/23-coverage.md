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
| VIES (EU) | Free, no key | 2026-10-17 | VAT validity; name and address where the member state releases them | Germany (and others) withhold names. Member-state outages are reported as errors, never as "invalid". UK VAT numbers are not covered |

## Roadmap by country (D12)

| Wave | Countries | Source | Access (as assessed) | Identity | Officers | Owners | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core | GB | Companies House | free key | yes | planned | planned (PSC) | Filings, charges, insolvency planned |
| Core | GB | FCA Register | free key (verified 2026-10-17) | planned | planned | - | Regulatory status; headers `X-Auth-Email`/`X-Auth-Key` verified, rate limit unverified |
| Core | EU | GLEIF Level 2 | free | planned | - | partial: only entities that report parents | Direct/ultimate parent relationships |
| Core | all | OFSI, EU, OFAC lists | free downloads (EU needs the public token URL) | - | - | - | Sanctions screening: local index, daily refresh |
| 1 | NO | Bronnoysund | free, no key (verified) | planned | planned (roles incl. birth date) | restricted | Easiest source |
| 1 | FI | PRH open data | free, no key (verified) | planned | unverified | unverified | Name search is broad |
| 1 | DK | CVR | free but requires registration (unverified) | planned | planned | restricted | Apply for system-to-system access early; third-party cvrapi.dk returned 403 |
| 1 | IE | CRO | free search; no verified API (unverified) | planned | unverified | **restricted** (RBO closed since the 2022 CJEU ruling) | Needs official-doc check |
| 2 | FR | SIRENE / INPI | free (unverified) | planned | unverified | restricted | |
| 3 | NL, BE | KvK, KBO | mixed free/paid (unverified) | planned | payment? | restricted | |
| Later | DE, ES, IT, others | national registers | often paid or hard to automate | identity via GLEIF/VIES only | payment | restricted | Handelsregister is partly paid |

## Data families and why some will stay unavailable

| Family | Typical reality |
| --- | --- |
| Identity | Widely available for LEI holders, VAT-registered traders and UK companies. Most EU companies without an LEI are reachable only by VAT number until their national register adapter exists |
| Officers | Public in the UK and Nordics; mixed elsewhere; contains personal data (D13) |
| Beneficial owners | **Restricted** in most EU registers since the 2022 CJEU ruling (public access removed; obliged entities only). The server will report `unavailable: restricted_access` rather than an empty list. UK PSC data remains public |
| Filings, accounts | Document links only; availability varies |
| Regulatory | UK (FCA) planned; EU needs ESMA / national regulator registers |
| Insolvency, charges | UK via Companies House; EU insolvency registers are national and fragmented |
| Sanctions | Planned from OFSI, EU and OFAC bulk lists; name-based; not a legal determination |

## How the server reports gaps
`get_entity.data.coverage.families.<family>.state` is one of `available`, `not_yet_supported`,
`unavailable` (with a reason: `not_published_by_source`, `restricted_access`, `requires_paid_access`,
`requires_credentials`, `no_such_record`) or `error`. An empty list is never used to mean "unknown".
