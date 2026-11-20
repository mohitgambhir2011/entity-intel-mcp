# STATUS: entity-intel-mcp
Last updated: 2026-11-20
Status: AMBER (uncommitted marketing/; officer fields work started 20 Nov)
Phase: Build
Progress: UNVERIFIED
Target date: UNSET
## Goal
MCP server to look up, resolve and sanctions-screen UK/EU legal entities with provenance on every field.
## Done recently
- 20 Nov: get_officers adds officerRef and verification (D48), commit 4be2b46, 412 tests pass; live register behaviour UNVERIFIED (fixture only)
- 28 Oct: structured ownership edges (D47); get_group_structure from GLEIF Level 2 (D46); machine-readable unavailable reasons (D45)
- 17 Oct: Ireland CRO adapter, FCA register, kyb_check prompt, filings and insolvency tool, Nordic registers
## In progress
- Untracked marketing/ folder (uncommitted, age unverified)
## Next 3 actions
1. Decide what to do with marketing/ (commit, ignore or remove)
2. Nominee evidence (appointment count by officerRef, formation-agent address) for EntityGraph; one live Companies House call to confirm the verification field
3. Tidy README: says "Ten tools"; Ireland listed in one sentence but not the next
## Milestones (Milestone | Due | State)
UNSET
## Blockers and risks (item | owner | mitigation | due)
- Repo is public: check commits for secrets before pushing (owner standing rule)
## Decisions needed (question | options | needed by)
UNVERIFIED
## Dependencies (Needs / Feeds)
Feeds: entity-graph
## Evidence
Last commit 2026-11-20 4be2b46 "get_officers: register person id..."; pushed to origin/main
