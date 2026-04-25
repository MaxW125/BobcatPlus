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

| For… | Read |
| ---- | ---- |
| **System shape** (contexts, pipelines, APIs, cache) | [`docs/architecture.md`](docs/architecture.md) |
| **Load-bearing rules** (mutex, `bail()`, pool/timeout, tests) | [`docs/invariants.md`](docs/invariants.md) |
| **Where code lives** | Browse `extension/`. Every module has a top-of-file comment explaining its role; treat that as the truth, not a paraphrase doc. |
| **Open bugs (Jira + in-repo diagnoses)** | [`docs/open-bugs.md`](docs/open-bugs.md) → [`docs/bugs/`](docs/bugs) |
| **Current state / phase / open question** | [`compass.md`](compass.md) |
| **ADR log — architecture only (tiebreaker)** | [`docs/decisions.md`](docs/decisions.md) — if another doc disagrees, **this wins**. Older entries: [`docs/decisions-archive.md`](docs/decisions-archive.md). |
| **How to add docs** | [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) + [`docs/README.md`](docs/README.md) index |
| **Plans / RFCs (in-progress design)** | [`docs/plans/`](docs/plans) |
| **Postmortems (closed bugs + refactors)** | [`docs/postmortems/`](docs/postmortems) |
| **Metrics** | [`docs/METRICS.md`](docs/METRICS.md) |
| **Pattern-pinned guidance for agents** | [`.cursor/rules/`](.cursor/rules) — auto-loaded by glob; humans don't memorize these. |
| **Repo-shared agent skills** | [`.cursor/skills/`](.cursor/skills) — file a bug, rebase a PR, add an ADR. |

---

## Two execution contexts (hard rule)

| Context | File | Talks to |
| ------- | ---- | -------- |
| Service worker | `extension/background.js` | DegreeWorks, Banner, `chrome.storage` |
| Tab page | `extension/tab.js` → `extension/tab/*` | UI; `background.js` via `chrome.runtime.sendMessage` only |

Never import tab code into the service worker or the reverse. They share a
Banner session cookie but not a JS heap. See [`docs/architecture.md`](docs/architecture.md).

---

## Common tasks (pointers)

| Task | Go to |
| ---- | ----- |
| New Banner fetch | [`docs/invariants.md`](docs/invariants.md) #1 and #3; `bg/session.js`, `bg/bannerApi.js` |
| Eligible list / needed courses | `BPReq.deriveEligible` in `requirements/txstFromAudit.js` (not legacy `findNeeded` except fallback) |
| New UI section | `tab.html`, `extension/css/tab-*.css` (load order in `tab.html`), wire in `tab/*` — follow existing layout tokens (CSS custom properties) |
| New chip color | `courseColors.js` + `tab-calendar.css` / `tab-lists-plans.css` chip class |

---

## Tests

- `node tests/unit/run.js` — must stay green (no OpenAI in the default suite).
- CI runs the same command on every PR (see `.github/workflows/test.yml`).
- `OPENAI_API_KEY=… node tests/intent-fixture.js` — optional intent goldens.

---

## Documentation rules (short)

1. **Architecture / product decisions** → append [`docs/decisions.md`](docs/decisions.md) (never a new file per decision).
2. **Bugs** — status lives in **Jira**. Create `docs/bugs/scrum-{N}-{slug}.md` only when the bug has a non-obvious failure mode worth writing down. When closed, `git mv` it to `docs/postmortems/`.
3. **Feature / phase design** → `docs/plans/{name}.md`.
4. **Module "why"** → top-of-file comment in the module (see `wildcardExpansion.js`).
5. **Index** — new markdown must appear in [`docs/README.md`](docs/README.md) or this router.
6. **AI drafts, humans ratify** — every committed line has a human reviewer.

---

## Session hygiene (for AI sessions)

**Budget:** say so if a trigger below applies. API spend is limited (~$20/mo
project context).

- **Auto / cheap** — tests, wiring to an existing spec, UI copy, doc-only, git/PR.
- **Premium** — new algorithms, unclear bugs, prompt work, new phases, multi-way design.
- **New chat** — ~20+ substantive turns, or ~10+ files read, or phase switch, or
  [`compass.md`](compass.md) just updated and you are starting a new unit of work, or
  self-check says >~8% monthly quota.

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

- `main` — stable; ships to the Chrome Web Store.
- `Demo` — external demos.
- `rule-shape-discovery` — Phase 1.5 graph-native solver work ([PR #12](https://github.com/BobcatPlus/BobcatPlus/pull/12)).

Milestones merge via PR. Prefer `git revert` for rollback (D17); feature flags
only when a phase needs shadow mode, then remove.

---

## Out of scope here

Tables of every cache key, the full v3 pipeline diagram, and the “do not touch”
file list live in [`docs/architecture.md`](docs/architecture.md) and
[`docs/invariants.md`](docs/invariants.md). Keep this file under ~200 lines so
it stays a **router**, not a second copy of the repo.
