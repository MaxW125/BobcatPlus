# Bobcat Plus — Documentation Index

Every markdown doc in the project, one sentence each. If a doc isn't
listed here, it doesn't exist yet (and adding one requires linking it
here — see `CONTRIBUTING.md`).

Start new AI sessions with the **Top of the stack** entries, in order.

---

## Top of the stack (read in this order every new session)


| Order | Doc                              | Why                                                                                                                                  |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `[../CLAUDE.md](../CLAUDE.md)`   | Project orientation: what it is, two-context architecture, load-bearing invariants, file map, cache, session hygiene, model routing. |
| 2     | `[../HANDOFF.md](../HANDOFF.md)` | Live status: scheduler architecture (v3 hybrid), open problems, phase progress, next action, recent commits.                         |
| 3     | `[decisions.md](decisions.md)`   | Running ADR log. **Tiebreaker** — if any other doc disagrees with this, this wins and the other doc updates.                         |


## Decisions + rules


| Doc                                  | Role                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `[decisions.md](decisions.md)`       | Append-only log of every locked-in decision with date + "reversible by" clause. |
| `[CONTRIBUTING.md](CONTRIBUTING.md)` | Four rules for adding / editing docs. Read once, follow always.                 |


## Phase + feature RFCs


| Doc                                                    | Role                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[requirement-graph-rfc.md](requirement-graph-rfc.md)` | Phase-1 RFC: `RequirementGraph` node types + DegreeWorks mapping.                                                                                   |
| `[METRICS.md](METRICS.md)`                             | Exact formulas for the four Phase-0 scheduler metrics. Acceptance gate for later phases.                                                            |
| `[advising-flow.md](advising-flow.md)`                 | Product + reality-check doc for Phases 4a / 4b / 5 (pre-advising flow + advisor brief + multi-semester planner). Captures Aidan's 5-question draft. |


## Bug diagnoses


| Doc                                                                            | Status                                             | Role                                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `[bug1-morning-preference-diagnosis.md](bug1-morning-preference-diagnosis.md)` | ✅ Closed (shipped `5975c90`)                       | Trace + two-layer solver fix for "schedule picks 9:30 AM class when noon+ alternative exists."                                                 |
| `[bug4-eligible-diagnosis.md](bug4-eligible-diagnosis.md)`                     | 🟡 Layers A/B/C shipped, live-verification pending | Layered fix plan for missing eligible courses (wildcard expansion via DegreeWorks `course-link`, `except` subtraction).                        |
| `[bug5-online-conflict-diagnosis.md](bug5-online-conflict-diagnosis.md)`       | ✅ Closed (shipped `fda436e`)                       | Online courses were flagged as conflicting with in-person courses because Banner populates `days` / `beginTime` / `endTime` on `INT` sections. |
| `[bug6-import-ux-diagnosis.md](bug6-import-ux-diagnosis.md)`                   | 🟡 Deferred                                        | Auto-load current schedule + clear auth-expiry banner. Fix after Phase 2.                                                                      |
| `[bug8-banner-half-auth-login-popup-diagnosis.md](bug8-banner-half-auth-login-popup-diagnosis.md)` | ✅ Closed (2026-04-22, D19)                         | Login popup opened Banner anonymous hub instead of TXST SSO; fix uses `/saml/login` as entry + recovery.                                         |


## Baselines


| Path                                                                   | Role                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[baselines/phase1-2026-04-21.json](baselines/phase1-2026-04-21.json)` | Regression snapshot of the Phase-1 RequirementGraph adapter against real TXST audit fixtures. Regenerate with `scripts/generate-phase1-baseline.js` whenever the parser or adapter changes. |


---

## What's NOT here (on purpose)

- **Per-module "what this code does" docs.** Lives in the top-of-file
 comment of the module itself. See `extension/requirements/wildcardExpansion.js`
or `extension/performance/concurrencyPool.js` for the template.
- **End-of-task narrative summaries.** Commit messages cover those.
- **Unreviewed AI drafts.** If it's checked in, a human has read it
 line-by-line. See `CONTRIBUTING.md` rule 1.

