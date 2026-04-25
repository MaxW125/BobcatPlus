# Bobcat Plus — handoff

> **Status (2026-04-23).** Scheduler refactor **complete on `scheduler-refactor`** (C1–C7,
> SCRUM-38–44). `extension/scheduleGenerator.js` deleted; all pipeline logic now lives in
> `extension/scheduler/*` (15 ESM modules). `tab/*` import directly — no `window.BP` globals.
> Postmortem: [`docs/postmortems/scheduler-refactor.md`](docs/postmortems/scheduler-refactor.md).
> Jira: [**SCRUM-34**](https://aidanavickers.atlassian.net/browse/SCRUM-34).
>
> **Ready to merge `scheduler-refactor` → `main`.** Smoke passed (C6). C7 is the doc pass
> (this commit). After merge: open Phase 1.5 (SCRUM-35) and Bug 7 work.

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
- **Implementation detail:** `extension/scheduler/index.js` (entry point) + `scheduler/*` modules

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

1. **Merge `scheduler-refactor` → `main`** — C7 smoke + PR, then merge. Unblocks everything below.
2. **Phase 1.5** — [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35). Graph-native solver
  (ChooseN / AllOf / …). RFC: [`docs/plans/requirement-graph.md`](docs/plans/requirement-graph.md).
  Requires more audit fixtures — see item 3.
3. **Audit-fixture collection (Max)** — 3–5 more real DegreeWorks audits as
  `tests/fixtures/audits/audit-{major}-{name}.json`. Feeds Phase 1.5.
  See [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35).
4. **Bug 7** (registration restrictions) — file `docs/bugs/bug7-registration-restrictions.md` first.
  Premium turn. Unblocked after merge.
5. **Bug 4 live-verify** — [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36). Confirm
  eligible list ≥ 50 on a real CS BS / English-CW audit during next Chrome smoke.
6. **Harness H2 migration** — move test files from `require("./_harness")` to ESM `import`.
  Follow-up to H1 (C6). Low priority; H1 is stable.

For session boot: `cd` to repo root, `git branch --show-current`, then read
`CLAUDE.md` + this file + the diagnosis doc for the line of work.

---

## Recent commit history (abbrev.)

**`scheduler-refactor` — C1–C7**

- `bfaf886` — C6: ESM flip — delete scheduleGenerator.js, H1 harness, named imports
- `bcba18b` — C5: affinity, rationale, advisor LLMs + orchestrator + fixture
- `b55a5d2` — C4: LLM infra + intent (openai.js, intent.js)
- `083dfff` — C3: solver bundle (constraints, rank, solver)
- `64ac0e2` — C2: pure-leaves bundle (time, trace, profile, validate, metrics)
- `192c025` — C1: RAG-seam signature pin (llmSignatures.test.js)
- `9f8ed13` — C0: scheduler-refactor plan + Jira wiring

**`main` (post-`7e51ebb` merge)** — see `git log main` for full history.

**Deferred Refactor-only fixes** recorded as `docs/bugs/bug9-plans-empty-after-term-switch.md`
and `docs/bugs/bug10-session-expired-status-bar.md`; see D24 in
`docs/decisions.md` for superseded Refactor tickets.

---

## Notes

- The **full v3 pipeline ASCII** lives in `[docs/architecture.md](docs/architecture.md)` (not here).
- The `[CLAUDE.md](CLAUDE.md)` `**### Next steps`** block applies to **AI chat turns**, not to this file.
- **Tab page CSS (extension):** the monolithic `extension/css/tab.css` was split into `tab-base.css` … `tab-dark.css` with **load order in `extension/tab.html`** (same cascade as the old file). Pointers: [`docs/file-map.md`](docs/file-map.md) “Tab page styles”, updated [`CLAUDE.md`](CLAUDE.md) task row. Trims: duplicate pre-Simone modal rules (Simone + shared `.modal-body` in `tab-lists-plans` / `tab-modal`), **removed** dead course-modal color-picker markup/CSS (never wired in JS), **merged** the two `prefers-color-scheme: dark` blocks into `tab-dark.css`. Calendar: course chips use clip + bottom fade at tight zoom in `tab-calendar.css`.

