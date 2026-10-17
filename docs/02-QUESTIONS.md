# Question rounds

## Round 1 — Purpose, users, scope (asked 2026-10-17)

- Q1. What does "LEI" mean for this project (ISO 17442 identifier backbone vs. general legal entity info)?
- Q2. Primary use case / user?
- Q3. Geographic scope for v1?
- Q4. Distribution model (personal/local vs. product)?

Answers:
- Q3: **C — all of EU + UK** (2026-10-17). See D1.
- Q2: **A primarily, B secondarily** (2026-10-17). See D2.
- Q1: **C — general entity info** (2026-10-17). See D3.
- Q4: **B — open source** (2026-10-17). See D4.

## Round 2 — Data (asked 2026-10-17)

- Q5. Aggregator vs. direct registers for EU breadth (with open source + BYO keys)?
- Q6. Which data fields are must-have for v1?
- Q7. Freshness: live lookups vs. cached?
- Q8. Budget for paid sources?

Answers:
- Q5: **C — direct registers only** (2026-10-17). See D5.
- Q6: **All seven families** (2026-10-17). See D6.
- Q7: **B — live with short cache** (2026-10-17). See D7.
- Q8: **B — free by default, optional paid adapters** (2026-10-17). See D8.

## Round 3 — Tech (asked 2026-10-17)

- Q9. Language / SDK?
- Q10. Transport: stdio, remote HTTP, or both?
- Q11. Cache storage?
- Q12. First-wave countries?

Answers:
- Q9: **A — TypeScript** (2026-10-17). See D9.
- Q10: **A — stdio only** (2026-10-17). See D10.
- Q11: **A — SQLite** (2026-10-17). See D11.
- Q12: **Wave 1 = Ireland + Nordics; Wave 2 = France; Wave 3 = NL + BE; rest later** (2026-10-17). See D12.

## Round 4 — Compliance (asked 2026-10-17)

- Q13. GDPR handling of officer / beneficial-owner personal data?
- Q14. Audit log contents and retention?
- Q15. Open-source licence?
- Q16. Disclaimers / "not legal advice" positioning?

Answers:
- Q13: **A — return in full, with notice** (2026-10-17). See D13.
- Q14: **A — metadata only** (2026-10-17). See D14. Retention default still open.
- Q15: **Source-available** (2026-10-17). See D15.
- Q16: **Elastic License 2.0** (2026-10-17). See D15.

## Round 5 — Quality and rollout (not yet asked)

- Q17. Success metrics and eval set? **A + B + D** (2026-10-17). See D16.
- Q18. Timeline: **C — no fixed timeline, phase by phase** (2026-10-17). See D17. Build split: **A — Claude builds, user reviews** (2026-10-17).
- Q19. Name: **entity-intel-mcp** (2026-10-17). See D18.
- Q20. First keys: **Companies House + FCA** (2026-10-17). See D19.

Round 5 complete. Phase 1 source assessment in progress (10-source-assessment.md).

## Round 8 — Architecture (Phase 4, started 2026-10-17)

- Q30. Repo location: **A — new repo C:\Users\mohit\code\entity-intel-mcp, docs copied to docs/** (2026-10-17). See D29.
- Q31. Tooling: **A — Node 22 LTS, npm, TypeScript strict ESM, Vitest** (2026-10-17). See D30.
- Q32. Libraries: **A — accept the recommended table** (2026-10-17). See D31.
- Q33. Adapters: **A — built-in, auto-enabled by credentials, `EIM_ADAPTERS` override** (2026-10-17). See D32.

Round 8 complete.

## Round 7 — MCP tool design (Phase 3, started 2026-10-17)

- Q25. Tool granularity: **A — ~8 task-shaped tools + kyb_check prompt** (2026-10-17). See D24.
- Q26. Response format: **A — structured JSON, summary first, lists capped at 25 with paging** (2026-10-17). See D25.
- Q27. Search: **A — ranked candidates, never auto-pick** (2026-10-17). See D26.
- Q28. Sanctions: **A — three outcomes, 0.95/0.80 thresholds, fixed caveat** (2026-10-17). See D27.
- Q29. Errors: **A — partial results with explicit status** (2026-10-17). See D28.

Round 7 complete.

## Round 6 — Data model (Phase 2, asked 2026-10-17)

Draft in 11-data-model.md.
- Q21. Entity ID: **A — derived from home-country registry number** (`<country>:<registry>:<number>`, e.g. `GB:CH:00445790`); fallback hash of name+country when no registry number; old IDs kept as aliases and redirect (2026-10-17).
- Q22. Status vocabulary: **A + B combined** — 12 fine-grained values plus a coarse `group` (operating / distressed / ended / unknown); `in_liquidation` kept for sources that don't say voluntary vs compulsory; source text always retained (2026-10-17).
- Q23. Ownership depth: **A — default 3, hard cap 10**, `truncated` flag when cut off (2026-10-17).
- Q24. Officer birth date: **A — exactly as published by the source** (2026-10-17).

Round 6 complete (Q21-Q24 answered). Next: Phase 3, MCP tool design.

## Upcoming rounds (not yet asked)

- Round 2 — Data: which fields matter most (ownership, officers, filings, sanctions), freshness needs, budget for paid sources (OpenCorporates etc.).
- Round 3 — Tech: language, local vs. hosted, caching/storage, auth.
- Round 4 — Compliance: GDPR stance, licence constraints, audit/logging needs.
- Round 5 — Quality & rollout: eval set, success metrics, timeline.
