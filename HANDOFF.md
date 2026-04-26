# Bobcat Plus — handoff

> **Status (2026-04-25).** `scheduler-refactor` **merged to `main`** (`0e67756`).
> Phase 1.6 **rule-shape discovery** is active on
> `rule-shape-discovery` — full S1–S4 toolchain shipped, **4-year corpus
> (2022–2026) complete**: 312 audits (309 what-if + 3 seed), 309 ok / 34
> invalid-combo / 0 http-errors. Inventory regenerated; **no new shapes vs
> 83-audit corpus — all ruleTypes, requirementTypes, and qualifier codes
> handled.** Discovery gate for Phase 1.5 is clear.
> Plan + status: `[docs/plans/rule-shape-discovery.md](docs/plans/rule-shape-discovery.md)`.
> Inventory: `[docs/plans/rule-shape-inventory.md](docs/plans/rule-shape-inventory.md)`.
> Jira: **[SCRUM-48](https://aidanavickers.atlassian.net/browse/SCRUM-48)** (epic),
> SCRUM-49 → SCRUM-54 (T1–T6).
>
> **Ready to merge `rule-shape-discovery` → `main`.** Tests green (137/137).
> One known gap: what-if dumps simulate a fresh student so `IfStmt` ElsePart
> branches are structurally present but never marked satisfied. Closes via S6
> real-audit backfill, tracked under SCRUM-35.

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
- **Implementation detail:** `extension/scheduler/index.js` (entry point) + `scheduler/`* modules

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

## Phase progress (as of 2026-04-25)


| Phase       | Goal                                 | Status                                                                                                                                                                                   |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0           | Instrument pipeline                  | ✅                                                                                                                                                                                        |
| 1           | RequirementGraph + TXST adapter      | ✅ (D17: flags removed)                                                                                                                                                                   |
| 1.6         | Rule-shape discovery                 | 🟢 4-year corpus (312 audits) complete; no new shapes vs 83-audit run. Discovery gate for Phase 1.5 clear. T6 partial (CONC landed; ElsePart triad + curated fixtures remain). SCRUM-48. |
| 1.5         | Solver + graph (ChooseN / AllOf / …) | ⬜ [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35) — unblocked by Phase 1.6 inventory                                                                                     |
| 2-precursor | Bug 1/3 solver + calibrator          | ✅ `5975c90`                                                                                                                                                                              |
| 2           | Scorer fidelity                      | ⬜                                                                                                                                                                                        |
| 2.5         | Prereq-in-term in solver             | ⬜                                                                                                                                                                                        |
| 3           | Archetype-seeded ranking             | ⬜                                                                                                                                                                                        |
| 4a–5        | Advising + planner                   | ⬜ — see `docs/plans/advising-flow.md`                                                                                                                                                    |
| X           | Bug 4 rollup                         | 🟡 A/B/C shipped; live verify [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36)                                                                                            |
| Y           | A1+B perf                            | ✅ `e687ad6`                                                                                                                                                                              |


Fixture deltas vs legacy `findNeeded` remain in earlier commits / RFCs; do not
duplicate the big table here.

---

## Next action

1. **Merge `rule-shape-discovery` → `main`** — open the PR. Branch is the Phase 1.6
  toolchain + 312-audit inventory + `BLOCK_TYPE.CONC` parser update. 137/137 tests green.
  Discovery gate confirmed clean (2026-04-25).
2. **Phase 1.5** — [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35). Graph-native solver
  (ChooseN / AllOf / …). RFC: `[docs/plans/requirement-graph.md](docs/plans/requirement-graph.md)`.
  Inventory in §0.4 of that doc gates the solver design.
3. **S6 real-audit backfill** (ongoing, low cadence) — transfer student → for IfStmt
  ElsePart shape; teacher-cert student → for cert overlay; Honors student → for
  Honors block. Tracked under SCRUM-35.
4. **Bug 7** (registration restrictions) — file `docs/bugs/bug7-registration-restrictions.md` first.
  Premium turn.
5. **Bug 4 live-verify** — [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36). Confirm
  eligible list ≥ 50 on a real CS BS / English-CW audit during next Chrome smoke.
6. **Harness H2 migration** — move test files from `require("./_harness")` to ESM `import`.
  Follow-up to H1. Low priority.

For session boot: `cd` to repo root, `git branch --show-current`, then read
`CLAUDE.md` + this file + the diagnosis doc for the line of work.

---

## Recent commit history (abbrev.)

`**rule-shape-discovery` — T1–T6 partial**

- `1658273` — feat: add `BLOCK_TYPE.CONC` + `inferBlockType` handler (S5 partial)
- `ce25dce` — docs: regenerate rule-shape-inventory over 83 audits (full what-if dump)
- `70e56ac` — T5 (SCRUM-53): shape extractor + map-dw-codes fixes (phase S4)
- `95a0d51` — docs + fixture: T1–T4 status updates, marketing audit fixture
- `6e4910e` — T4 (SCRUM-52): What-If audit driver (phase S3)
- `6a612c7` — T3 (SCRUM-51): DW What-If endpoint reverse-engineering notes + HAR fixtures
- `db338ea` — T2 (SCRUM-50): catalog scraper + DW code mapper (phase S1)
- `2231681` — docs: add rule-shape-discovery plan (Phase 1.6 pre-RFC)

`**main` (post-`0e67756` scheduler-refactor merge)** — see `git log main` for full history.

**Deferred Refactor-only fixes** recorded as `docs/bugs/bug9-plans-empty-after-term-switch.md`
and `docs/bugs/bug10-session-expired-status-bar.md`; see D24 in
`docs/decisions.md` for superseded Refactor tickets.

---

## Notes

- The **full v3 pipeline ASCII** lives in `[docs/architecture.md](docs/architecture.md)` (not here).
- The `[CLAUDE.md](CLAUDE.md)` `**### Next steps`** block applies to **AI chat turns**, not to this file.
- **Tab page CSS (extension):** the monolithic `extension/css/tab.css` was split into `tab-base.css` … `tab-dark.css` with **load order in `extension/tab.html`** (same cascade as the old file). Pointers: [`docs/file-map.md`](docs/file-map.md) “Tab page styles”, updated [`CLAUDE.md`](CLAUDE.md) task row. Trims: duplicate pre-Simone modal rules (Simone + shared `.modal-body` in `tab-lists-plans` / `tab-modal`), **removed** dead course-modal color-picker markup/CSS (never wired in JS), **merged** the two `prefers-color-scheme: dark` blocks into `tab-dark.css`. Calendar: course chips use clip + bottom fade at tight zoom in `tab-calendar.css`.

