# Bobcat Plus — documentation index

**Read order (humans and LLMs):** load the smallest context first, then branch
by task. Deeper content lives in linked files — do not duplicate long tables
in chat.

1. `[../CLAUDE.md](../CLAUDE.md)` — router: contexts, where to read next, rules, session hygiene.
2. `[../HANDOFF.md](../HANDOFF.md)` — what's next, phases, short commit pointers.
3. `[decisions.md](decisions.md)` — **tiebreaker** ADR log (architecture/product only); if any doc disagrees, this wins.

---

## Core reference (refactored `extension/`)


| Doc                                  | One-line role                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `[architecture.md](architecture.md)` | Two JS contexts, eligible + v3 AI pipelines, external systems, cache contract, v3 diagram.                                   |
| `[invariants.md](invariants.md)`     | Non-negotiables (session mutex, `bail()`, pool+timeout, affinity wipe, Jaccard, `validateSchedule`, `addToWorkingSchedule`). |
| `[file-map.md](file-map.md)`         | `bg/`*, `tab/*`, entrypoints, pure `requirements/*` + `performance/*` — *where* to edit.                                     |
| `[METRICS.md](METRICS.md)`           | Phase-0 metric formulas (`honoredRate`, `archetypeDistance`, etc).                                                           |
| `[open-bugs.md](open-bugs.md)`       | Pointer into Jira + in-repo bug diagnoses.                                                                                   |


---

## Decisions and process


| Doc                                  | Role                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `[decisions.md](decisions.md)`       | Append-only ADRs (architecture/product). Never split a decision into a new file.          |
| `[process.md](process.md)`           | Meta-process rules (plan-doc workflow, gates, model routing). Extracted from the ADR log. |
| `[CONTRIBUTING.md](CONTRIBUTING.md)` | How to add docs; new markdown must be indexed here or in `CLAUDE.md`.                     |


---

## Plans (future / in-progress design)


| Doc                                                                    | Role                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `[plans/requirement-graph.md](plans/requirement-graph.md)`             | `RequirementGraph` parser (Phase 1 shipped) + Phase 1.5 open questions.                           |
| `[plans/advising-flow.md](plans/advising-flow.md)`                     | Phases 4a / 4b / 5 product shape (advisor brief, multi-term planner).                             |
| `[plans/rule-shape-discovery.md](plans/rule-shape-discovery.md)`       | Phase 1.6 — how to get ~800 what-if audits for rule-shape inventory (S0–S6 plan).                 |
| `[plans/whatif-endpoint.md](plans/whatif-endpoint.md)`                 | DW What-If endpoint reverse-engineering notes (T3 / S2). Gate doc for pull-audits.js driver (S3). |
| `[plans/rule-shape-inventory.md](plans/rule-shape-inventory.md)`       | T5 / S4 output — counts of every requirementType, ruleType, qualifier, exception across all fixtures. Regen: `node scripts/shape/extract-shapes.js`. |


---

## Open bug diagnoses (`[bugs/](bugs/)`)

In-repo diagnoses only exist when a bug has a non-obvious failure mode.
Status, priority, and triage live in Jira.


| Doc                                                                                        | Status                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `[bugs/bug4-eligible.md](bugs/bug4-eligible.md)`                                           | 🟡 A/B/C shipped; live-verify pending |
| `[bugs/bug6-import-ux.md](bugs/bug6-import-ux.md)`                                         | 🟡 Deferred                           |
| `[bugs/bug9-plans-empty-after-term-switch.md](bugs/bug9-plans-empty-after-term-switch.md)` | 🟡 Open                               |
| `[bugs/bug10-session-expired-status-bar.md](bugs/bug10-session-expired-status-bar.md)`     | 🟡 Open                               |


---

## Postmortems (`[postmortems/](postmortems/)`)

Historical record of closed issues and completed refactors. Do not edit —
append a one-line correction only if a claim turned out to be wrong.


| Doc                                                                                                      | Notes                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `[postmortems/refactor-on-main-split.md](postmortems/refactor-on-main-split.md)`                         | ES module split of `background.js` + `tab.js` (9/9 complete). |
| `[postmortems/bug1-morning-preference.md](postmortems/bug1-morning-preference.md)`                       | Shipped `5975c90` (D14).                                      |
| `[postmortems/bug5-online-conflict.md](postmortems/bug5-online-conflict.md)`                             | Shipped `fda436e` (D12).                                      |
| `[postmortems/bug8-banner-half-auth-login-popup.md](postmortems/bug8-banner-half-auth-login-popup.md)`   | Shipped with D19.                                             |
| `[postmortems/bug11-post-saml-degreeworks-warmup.md](postmortems/bug11-post-saml-degreeworks-warmup.md)` | D22 + D23.                                                    |


---

## Baselines


| Path                                                                   | Role                                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `[baselines/phase1-2026-04-21.json](baselines/phase1-2026-04-21.json)` | Phase-1 adapter snapshot; regen via `scripts/generate-phase1-baseline.js` when the parser/adapter changes. |


---

## Intentionally not duplicated here

- **Per-module "what the code does"** — top-of-file comments in
`extension/`** (e.g. `requirements/wildcardExpansion.js`,
`performance/concurrencyPool.js`, `bg/analysis.js`, `tab/auth.js`).
- **Commit narratives** — git history; use `decisions.md` for durable *why*.
- **Live bug triage** — Jira; `open-bugs.md` is a pointer.