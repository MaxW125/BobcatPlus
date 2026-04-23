# Bobcat Plus — handoff

> **Refactor (2026-04-23).** Branch `refactor-on-main`: ES module service worker + tab split
> is **code-complete** through commit `998e63f` (`extension/tab/`* per Deviation B). Doc
> restructure landed in `bad7af0` + a follow-up pass that introduced `docs/bugs/`,
> `docs/plans/`, `docs/postmortems/`, `docs/process.md`, a Jira-pointing `open-bugs.md`,
> and trimmed `decisions.md` to architecture-only ADRs. **No runtime behavior changes**
> in the doc passes. Retrospective: `[docs/postmortems/refactor-on-main-split.md](docs/postmortems/refactor-on-main-split.md)`.

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
| 1.5         | Solver + graph (ChooseN / AllOf / …) | ⬜                                     |
| 2-precursor | Bug 1/3 solver + calibrator          | ✅ `5975c90`                           |
| 2           | Scorer fidelity                      | ⬜                                     |
| 2.5         | Prereq-in-term in solver             | ⬜                                     |
| 3           | Archetype-seeded ranking             | ⬜                                     |
| 4a–5        | Advising + planner                   | ⬜ — see `docs/plans/advising-flow.md` |
| X           | Bug 4 rollup                         | 🟡 A/B/C shipped; live verify pending |
| Y           | A1+B perf                            | ✅ `e687ad6`                           |


Fixture deltas vs legacy `findNeeded` remain in earlier commits / RFCs; do not
duplicate the big table here.

---

## Next action

1. **Merge or PR** `refactor-on-main` → `main` when you are ready — if `gh pr view` shows no PR,
  create one (`gh pr create`). Auto: fresh chat, green `node tests/unit/run.js`, Chrome smoke on
  auth → term → eligible → AI → lock/save if anything non-doc touched).
2. **Bug 7** — registration restrictions (Opus/API) — file `docs/bugs/bug7-registration-restrictions.md` first.
3. **Bug 4 live verify** after merge — CS BS / English-CW ≥50 eligible.
4. **Phase 1.5** only after Bug 7 + calendar-first-load are understood or filed.

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

