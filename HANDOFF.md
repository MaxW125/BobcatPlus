# Bobcat Plus — handoff

> **Status (2026-04-23).** `refactor-on-main` **merged to `main`** in `7e51ebb` (PR #8). Service
> worker is ESM, tab is split into `tab/*`, doc restructure shipped. Retrospective:
> [`docs/postmortems/refactor-on-main-split.md`](docs/postmortems/refactor-on-main-split.md).
>
> **Next active stream: scheduler refactor.** Split `extension/scheduleGenerator.js` into
> `extension/scheduler/*` and flip the tab runtime from classic-script + `window.BP` to
> ES modules. Plan: [`docs/plans/scheduler-refactor.md`](docs/plans/scheduler-refactor.md).
> Jira: [**SCRUM-34**](https://aidanavickers.atlassian.net/browse/SCRUM-34) (epic) →
> SCRUM-38..44 (C1–C7). Branch: `scheduler-refactor`.

Read `[CLAUDE.md](CLAUDE.md)` first (router), then `[docs/decisions.md](docs/decisions.md)` before
changing load-bearing behavior. If HANDOFF and decisions disagree, **decisions wins**
and HANDOFF updates.

This file stays **short**: live status, architecture pointer, next action, recent commits.
Depth: `[docs/architecture.md](docs/architecture.md)`, `[docs/open-bugs.md](docs/open-bugs.md)`,
`[docs/file-map.md](docs/file-map.md)`.

---

## Architecture (v3 hybrid)

- **Contexts, eligible + v3 pipelines, APIs, cache, full ASCII diagram:** `[docs/architecture.md](docs/architecture.md)`  
- **Non-negotiables (mutex, `bail`, pool, affinity, Jaccard, etc.):** `[docs/invariants.md](docs/invariants.md)`  
- **Implementation detail:** `extension/scheduleGenerator.js` (top-of-file block comment)

**One-screen summary**

```
[ userMessage ] → Intent LLM → calibrateIntentWeights → context recap
  → Affinity LLM (cache wiped each turn) → solveMulti + relaxation
  → pickTop3 (Jaccard dedup) → Rationale LLM → actions[] to tab
```

---

## Open problems

Authoritative table: `[docs/open-bugs.md](docs/open-bugs.md)` (includes Bug 7, 4 live verify,
6 deferred, 9/10 from Refactor backlog).

---

## Phase progress (as of 2026-04-23)


| Phase       | Goal                                 | Status                                |
| ----------- | ------------------------------------ | ------------------------------------- |
| 0           | Instrument pipeline                  | ✅                                     |
| 1           | RequirementGraph + TXST adapter      | ✅ (D17: flags removed)                |
| 1.5         | Solver + graph (ChooseN / AllOf / …) | ⬜ [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35) — gated behind refactor |
| 2-precursor | Bug 1/3 solver + calibrator          | ✅ `5975c90`                           |
| 2           | Scorer fidelity                      | ⬜                                     |
| 2.5         | Prereq-in-term in solver             | ⬜                                     |
| 3           | Archetype-seeded ranking             | ⬜                                     |
| 4a–5        | Advising + planner                   | ⬜ — see `docs/plans/advising-flow.md` |
| X           | Bug 4 rollup                         | 🟡 A/B/C shipped; live verify [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36) |
| Y           | A1+B perf                            | ✅ `e687ad6`                           |


Fixture deltas vs legacy `findNeeded` remain in earlier commits / RFCs; do not
duplicate the big table here.

---

## Next action

1. **Scheduler refactor** — branch `scheduler-refactor`, epic [SCRUM-34](https://aidanavickers.atlassian.net/browse/SCRUM-34).
  Start fresh chat on C1 (test pin, Auto). Plan: [`docs/plans/scheduler-refactor.md`](docs/plans/scheduler-refactor.md).
  Per-commit model routing + new-chat boundaries in the plan's commit-chain table. 7 commits C1–C7
  (SCRUM-38 through SCRUM-44). Do this before anything else that touches the LLM pipeline.
2. **Audit-fixture collection (Max, runs in parallel to refactor)** — 3–5 more real DegreeWorks audits
  as `tests/fixtures/audits/audit-{major}-{name}.json`. Feeds Phase 1.5. Does not collide with the
  refactor's files. See [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35).
3. **Bug 4 live-verify** — piggyback on the first Chrome smoke after C2/C5/C6: confirm eligible list
  ≥ 50 on a real CS BS / English-CW audit. [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36).
4. **Bug 7** (registration restrictions) — file `docs/bugs/bug7-registration-restrictions.md` first.
  Premium turn, Opus/API. **Gate behind the scheduler refactor landing** so Bug 7 doesn't edit
  files that are about to move.
5. **Phase 1.5** — [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35). Only after the
  scheduler refactor lands on `main` (same-file conflicts). RFC is [`docs/plans/requirement-graph.md`](docs/plans/requirement-graph.md).

For session boot: `cd` to repo root, `git branch --show-current`, then read
`CLAUDE.md` + this file + the diagnosis doc for the line of work.

---

## Recent commit history (abbrev.)

`**refactor-on-main` — doc + split series**

- `998e63f` — tab: split to `tab/*` (Deviation B), `tab.html` module, slim `tab.js`  
- `20e7991` — `bg/analysis.js` + `bailContract` test  
- `5b4fdae` — `bg/plans.js`  
- `3764566` — SAML entity-decode + DW warm-up (bug 11)  
- Earlier: SW ES module, leaf `bg/*` extraction — see `docs/postmortems/refactor-on-main-split.md`

`**main` (post-`6d5c80e` merge)** — D19, A1+B perf, D17, phase work — see `git log main`
for full history.

**Deferred Refactor-only fixes** recorded as `docs/bugs/bug9-plans-empty-after-term-switch.md`
and `docs/bugs/bug10-session-expired-status-bar.md`; see D24 in
`docs/decisions.md` for superseded Refactor tickets.

---

## Notes

- The **full v3 pipeline ASCII** lives in `[docs/architecture.md](docs/architecture.md)` (not here).
- The `[CLAUDE.md](CLAUDE.md)` `**### Next steps`** block applies to **AI chat turns**, not to this file.

