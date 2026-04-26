# Bobcat Plus — documentation index

Read order is **load smallest context first**. Deeper content lives in
linked files; do not duplicate long tables in chat or in this index.

## Load priority

| Tier | Always read | When |
| --- | --- | --- |
| **T1** | [`../CLAUDE.md`](../CLAUDE.md), [`../compass.md`](../compass.md), [`decisions.md`](decisions.md) (active) | Every session. |
| **T2** | [`architecture.md`](architecture.md), [`invariants.md`](invariants.md), the relevant [`plans/*`](plans/) | When working in the phase those docs describe. |
| **T3** | [`postmortems/`](postmortems/), [`decisions-archive.md`](decisions-archive.md) | Only when you need historical context. |

If anything below contradicts [`decisions.md`](decisions.md), decisions
wins.

---

## Core reference

| Doc | One-line role |
| --- | --- |
| [`architecture.md`](architecture.md) | Two JS contexts, eligible + v3 AI pipelines, external systems, cache contract, v3 diagram. |
| [`invariants.md`](invariants.md) | Non-negotiables (session mutex, `bail()`, pool+timeout, affinity wipe, Jaccard, `validateSchedule`, `addToWorkingSchedule`). |
| [`METRICS.md`](METRICS.md) | Phase-0 metric formulas (`honoredRate`, `archetypeDistance`, etc). |
| [`open-bugs.md`](open-bugs.md) | Pointer into Jira + in-repo bug diagnoses. |

## Decisions

| Doc | Role |
| --- | --- |
| [`decisions.md`](decisions.md) | Append-only ADRs (architecture/product). Active entries (D17 onward). |
| [`decisions-archive.md`](decisions-archive.md) | Older ADRs (D2–D14). Read only when you need history. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to add docs. New markdown must be indexed here or in `CLAUDE.md`. |

## Plans (RFCs)

Tracks live in [`../compass.md`](../compass.md). Each plan below is the
detailed RFC for one track — read the plan when you're working in that
area, the compass for the bird's-eye view.

| Track | Plan |
| --- | --- |
| Graduation Tracker MVP — header strip, ships independent | [`plans/grad-tracker.md`](plans/grad-tracker.md) |
| Course Catalog (L2) — bundled prereq DAG + seasonality + refresh | [`plans/course-catalog.md`](plans/course-catalog.md) |
| Graph-aware Scheduler — solver consumes Catalog, ChooseN, many-to-many UX | [`plans/requirement-graph.md`](plans/requirement-graph.md) |
| Forward Planner — multi-semester, pace slider, drag-and-replan deferred | [`plans/forward-planner.md`](plans/forward-planner.md) |
| Advising flow — pre-advising questions + advisor brief | [`plans/advising-flow.md`](plans/advising-flow.md) |

Tree-style requirement visualization is speculative; tracked in compass
and Jira, no plan doc yet.

## Open bug diagnoses ([`bugs/`](bugs/))

| Doc | Status |
| --- | --- |
| [`bugs/scrum-63-eligible.md`](bugs/scrum-63-eligible.md) | A/B/C shipped; live-verify pending |
| [`bugs/scrum-79-import-ux.md`](bugs/scrum-79-import-ux.md) | Deferred |
| [`bugs/scrum-47-plans-empty.md`](bugs/scrum-47-plans-empty.md) | Open |
| [`bugs/scrum-80-session-expired-status-bar.md`](bugs/scrum-80-session-expired-status-bar.md) | Open |

## Postmortems ([`postmortems/`](postmortems/))

Historical record. Don't edit — append a one-line correction only if a
claim turned out to be wrong.

| Doc | Notes |
| --- | --- |
| [`postmortems/scheduler-refactor.md`](postmortems/scheduler-refactor.md) | `scheduleGenerator.js` → `scheduler/*` split (D25). |
| [`postmortems/refactor-on-main-split.md`](postmortems/refactor-on-main-split.md) | ES module split of `background.js` + `tab.js`. |
| [`postmortems/bug1-morning-preference.md`](postmortems/bug1-morning-preference.md) | Shipped `5975c90` (D14). |
| [`postmortems/bug5-online-conflict.md`](postmortems/bug5-online-conflict.md) | Shipped `fda436e` (D12). |
| [`postmortems/bug8-banner-half-auth-login-popup.md`](postmortems/bug8-banner-half-auth-login-popup.md) | Shipped with D19. |
| [`postmortems/bug11-post-saml-degreeworks-warmup.md`](postmortems/bug11-post-saml-degreeworks-warmup.md) | D22 + D23. |

## Baselines

| Path | Role |
| --- | --- |
| [`baselines/phase1-2026-04-21.json`](baselines/phase1-2026-04-21.json) | Phase-1 adapter snapshot; regen via `scripts/generate-phase1-baseline.js` when the parser/adapter changes. |

---

## Intentionally not duplicated here

- **Per-module "what the code does"** — top-of-file comments in
  `extension/` (e.g. `requirements/wildcardExpansion.js`,
  `performance/concurrencyPool.js`, `bg/analysis.js`, `tab/auth.js`).
- **Commit narratives** — git history; use [`decisions.md`](decisions.md)
  for durable *why*.
- **Live bug triage** — Jira; [`open-bugs.md`](open-bugs.md) is a pointer.
- **Pattern-pinned coding rules for AI agents** — `.cursor/rules/` (auto-loaded).
