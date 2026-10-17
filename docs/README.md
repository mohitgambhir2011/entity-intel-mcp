# Documentation index

Who each document is for and when to read it. Numbers group documents by purpose: 0x = project
management, 1x = design, 2x = reference and practice.

| Doc | Audience | Read it when |
| --- | --- | --- |
| [00-PLAN.md](00-PLAN.md) | everyone | you want the original phased plan and risks (partly superseded; the decisions log wins) |
| [01-DECISIONS.md](01-DECISIONS.md) | everyone, reviewers | you need to know **why** something is the way it is. Locked decisions D1-D34 |
| [02-QUESTIONS.md](02-QUESTIONS.md) | maintainers | you want the questions asked and the answers given, in order |
| [10-source-assessment.md](10-source-assessment.md) | adapter authors | adding or changing a data source: access, auth, limits, licence, what was verified live |
| [11-data-model.md](11-data-model.md) | adapter authors, reviewers | changing types: entity, identifiers, availability states, provenance |
| [12-tool-spec.md](12-tool-spec.md) | tool authors | the **design** of the 8 planned tools (4 implemented) and the `kyb_check` prompt |
| [13-architecture.md](13-architecture.md) | contributors | layering, mechanisms (HTTP, cache, sanctions index), build order |
| [20-modules.md](20-modules.md) | contributors | you need the responsibilities and invariants of each source file |
| [21-development.md](21-development.md) | contributors | setup, scripts, testing strategy, recording fixtures, release checklist |
| [22-tool-reference.md](22-tool-reference.md) | users, integrators | exact arguments and responses of each implemented tool, with real examples |
| [23-coverage.md](23-coverage.md) | users | what each source and country can and cannot return, and why |
| [24-security-and-privacy.md](24-security-and-privacy.md) | users, reviewers | threat model, secret handling, personal data, retention |
| [25-code-review.md](25-code-review.md) | contributors, reviewers | how reviews are done here and how to run the review skills |

## Conventions

- **Decision numbers** (D1...) are stable; amendments get a new number rather than editing history.
- **Dates** are absolute (2026-10-17).
- **UNVERIFIED** marks a claim that came from documentation or a third party and was not observed live.
- **Status words** are used precisely: _not published_ (source doesn't hold it), _restricted_ (legal
  access limit), _requires payment_, _not yet supported_ (we haven't built it), _error_ (source failed).
