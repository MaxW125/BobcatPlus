# Bobcat Plus — CLAUDE.md (router)

AI-powered schedule planner Chrome extension for Texas State University.
Scrapes Banner (registration) and DegreeWorks (degree audit); shows remaining
requirements, open sections, and builds conflict-free schedules via a
deterministic solver with LLM intent/affinity/rationale stages.

**This file is the router.** Read it first in every new session, then follow the
links — do not duplicate long context here; the linked docs are the canonical
depth for humans and LLMs.

---

## Where to read next


| For…                                                          | Read                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **System shape** (contexts, pipelines, APIs, cache)           | `[docs/architecture.md](docs/architecture.md)`                                            |
| **Load-bearing rules** (mutex, `bail()`, pool/timeout, tests) | `[docs/invariants.md](docs/invariants.md)`                                                |
| **Where code lives** (`bg/`*, `tab/`*, entrypoints)           | `[docs/file-map.md](docs/file-map.md)`                                                    |
| **Open bugs (Jira + in-repo diagnoses)**                      | `[docs/open-bugs.md](docs/open-bugs.md)` → `[docs/bugs/](docs/bugs)`                      |
| **Current sprint / phase / next action**                      | `[HANDOFF.md](HANDOFF.md)`                                                                |
| **ADR log — architecture only (tiebreaker)**                  | `[docs/decisions.md](docs/decisions.md)` — if another doc disagrees, **this wins**.       |
| **Process / workflow rules**                                  | `[docs/process.md](docs/process.md)`                                                      |
| **How to add docs**                                           | `[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)` + `[docs/README.md](docs/README.md)` index |
| **Plans / RFCs (in-progress design)**                         | `[docs/plans/](docs/plans)`                                                               |
| **Postmortems (closed bugs + refactors)**                     | `[docs/postmortems/](docs/postmortems)`                                                   |
| **Metrics**                                                   | `[docs/METRICS.md](docs/METRICS.md)`                                                      |


---

## Two execution contexts (hard rule)


| Context        | File                                   | Talks to                                                  |
| -------------- | -------------------------------------- | --------------------------------------------------------- |
| Service worker | `extension/background.js`              | DegreeWorks, Banner, `chrome.storage`                     |
| Tab page       | `extension/tab.js` → `extension/tab/`* | UI; `background.js` via `chrome.runtime.sendMessage` only |


Never import tab code into the service worker or the reverse. They share a
Banner session cookie but not a JS heap. See `[docs/architecture.md](docs/architecture.md)`.

---

## Common tasks (pointers)


| Task                           | Go to                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| New Banner fetch               | `[docs/invariants.md](docs/invariants.md)` #1 and #3; `bg/session.js`, `bg/bannerApi.js`            |
| Eligible list / needed courses | `BPReq.deriveEligible` in `requirements/txstFromAudit.js` (not legacy `findNeeded` except fallback) |
| New UI section                 | `tab.html`, `extension/css/tab-*.css` (load order in `tab.html`), wire in `tab/*` — follow existing layout tokens (CSS custom properties) |
| New chip color                 | `courseColors.js` + `tab-calendar.css` / `tab-lists-plans.css` chip class                                                                |

---

## Tests

- `node tests/unit/run.js` — must stay green (no OpenAI in the default suite).
- `OPENAI_API_KEY=… node tests/intent-fixture.js` — optional intent goldens.

---

## Documentation rules (short)

1. **Architecture / product decisions** → append `docs/decisions.md` (never a new file per decision).
2. **Process / workflow rules** → `docs/process.md` (meta only; not ADR).
3. **Bugs** — status lives in **Jira**. Create `docs/bugs/bugN-{name}.md` only when the bug has a non-obvious failure mode worth writing down. When closed, `git mv` it to `docs/postmortems/`.
4. **Feature / phase design** → `docs/plans/{name}.md`.
5. **Module "why"** → top-of-file comment in the module (see `wildcardExpansion.js`).
6. **Index** — new markdown must appear in `docs/README.md` or this router.
7. **No** code paraphrase graveyards, **no** end-of-task narrative files in `docs/`.
8. **AI drafts, humans ratify** — every committed line has a human reviewer.

---

## Session hygiene (for AI sessions)

**Budget:** say so if a trigger below applies. API spend is limited (~$20/mo
project context).

- **Auto / cheap** — tests, wiring to an existing spec, UI copy, doc-only, git/PR.
- **Premium** — new algorithms, unclear bugs, prompt work, new phases, multi-way design.
- **New chat** — ~~20+ substantive turns, or ~10+ files read, or phase switch, or
`HANDOFF.md` just updated and you are starting a new unit of work, or
self-check says >~~8% monthly quota.

**Repo root** = directory containing this file. The old `.claude/worktrees/`
flow is deprecated (2026-04-21).

### Honesty clause

If you don’t know how much budget was used, say so.

### Mandatory `### Next steps` on every response

End each turn with a short `### Next steps` block, in order:

1. **Do now (you):** one concrete action.
2. **Next chat opener:** paste-ready, `cd` to repo root, which docs to read, Auto vs premium.
3. **Branch point** if step 1 can fork work (`if X → …, if Y → …`).

Keep it ≤8 lines. Receipt for the next contributor, not a report.

---

## Branch + deploy

- `main` — stable; ships to the Chrome Web Store. (scheduler-refactor merged at `0e67756`; retrospective at `docs/postmortems/scheduler-refactor.md`.)
- `Demo` — external demos.
- `rule-shape-discovery` — Phase 1.6 (SCRUM-48): catalog scraper, DW What-If driver, shape extractor, 312-audit inventory (4 catalog years, no new shapes), parser learns `BLOCK_TYPE.CONC`. Plan: `docs/plans/rule-shape-discovery.md`. Discovery gate clear; ready to merge.

Milestones merge via PR. Prefer `git revert` for rollback (D17); feature flags
only when a phase needs shadow mode, then remove.

---

## Out of scope here

Tables of every cache key, the full v3 pipeline diagram, and the “do not touch”
file list live in `[docs/architecture.md](docs/architecture.md)` and
`[docs/invariants.md](docs/invariants.md)`. Keep this file under ~200 lines so
it stays a **router**, not a second copy of the repo.