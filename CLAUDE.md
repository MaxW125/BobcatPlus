# Bobcat Plus — [CLAUDE.md](http://CLAUDE.md)

AI-powered schedule planner Chrome extension for Texas State University.
Scrapes Banner (registration) and DegreeWorks (degree audit); shows a
student what courses they still need, which are open this term, and lets
an AI or the student build a conflict-free weekly schedule.

This file is the router. Read it first in every new session, then follow
the links below for depth.

---

## Where to read next


| For…                                                         | Read                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Current state, what just shipped, what's next                | `HANDOFF.md`                                                                     |
| *Why* we agreed to do things this way (ADR log, append-only) | `docs/decisions.md` — **if this and another doc disagree, `decisions.md` wins.** |
| Per-bug postmortems + fix plans                              | `docs/bug*-diagnosis.md` (incl. Bug 8 login popup / `docs/bug8-banner-half-auth-login-popup-diagnosis.md`) |
| Phase / feature RFCs                                         | `docs/*-rfc.md` (`requirement-graph-rfc`, `METRICS`, `advising-flow`)            |


---

## Two execution contexts (hard rule)


| Context        | File                      | Talks to                                            |
| -------------- | ------------------------- | --------------------------------------------------- |
| Service worker | `extension/background.js` | DegreeWorks API, Banner API, `chrome.storage.local` |
| Tab page       | `extension/tab.js`        | `background.js` via `chrome.runtime.sendMessage`    |


**Never** import tab.js functions into background.js or vice versa. They
share a Banner session cookie but run in separate JS contexts. Communicate
only through message passing.

---

## The load-bearing invariants (break at your peril)

1. **Session mutex.** Every Banner call that touches `term/search` or
  `getResults` goes through `withSessionLock` (background) or
   `queueRegistrationFetch` (tab). Parallel calls corrupt Banner's
   per-term session state silently. Any new Banner fetch must join one
   of these queues.
2. `**bail()` checks in `runAnalysis`.** Every `await` in `runAnalysis`
  is followed by `if (bail()) return`. Removing any of these lets a
   stale term analysis mutate the UI after the user switches terms.
3. **Bounded pool + timeout on per-CRN Banner fetches.** Prereq,
  description, and (soon) restriction fetches go through
   `self.BPPerf.mapPool(coursesWithSections, ≤6, mapper)` and each inner
   fetch uses `self.BPPerf.fetchWithTimeout(url, opts, ≥12s)`. Unbounded
   `Promise.all` + raw `fetch` is what caused the 4-minute prereq hang
   — see the Bug 4 / perf fix in `HANDOFF.md`. Do not revert.
4. **Affinity cache wipe per turn** (`handleUserTurn`). Without it,
  career keywords from a prior turn silently bias the next one.
5. **Jaccard tiered dedup in `pickTop3`.** Do not simplify to
  section-signature-only — regresses the "same courses, different lab"
   bug (Phase 0 fix).
6. `**validateSchedule()` is defense in depth, not the enforcer.** The
  CSP solver is supposed to guarantee no conflicts. If `validateSchedule`
   ever fires, the solver is wrong — fix the solver, don't silence the
   check.

---

## File map

### Extension runtime code


| File                                                | Role                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `extension/manifest.json`                           | MV3 manifest — permissions, host_permissions.                                                                            |
| `extension/background.js`                           | Service worker. Audit fetch, Banner search (subject-batch + per-course), prereqs, cache, session mutex, plan management. |
| `extension/tab.js`                                  | Full-page UI. Calendar renderer, chat panel, eligible list, working schedule.                                            |
| `extension/tab.html` / `tab.css` / `extension/css/` | Shell + styles. CSS custom properties, not hard-coded colors.                                                            |
| `extension/popup.html` / `extension/popup.js`       | Toolbar popup. Mostly defers to tab.                                                                                     |
| `extension/scheduleGenerator.js`                    | Whole AI pipeline. Attached to `window.BP`. Plain script, no ESM.                                                        |
| `extension/facultyScraper.js`                       | RateMyProfessor / faculty directory scraping.                                                                            |
| `extension/courseColors.js`                         | Deterministic chip color assignment.                                                                                     |


### Pure modules (service-worker via `importScripts`, also Node-unit-testable)


| File                                          | Exports                                                                 | Role                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/requirements/graph.js`             | `BPReq.`* primitives                                                    | RequirementGraph node kinds, factories, traversal, invariants.                                                                                                               |
| `extension/requirements/txstFromAudit.js`     | `BPReq.buildGraphFromAudit`, `BPReq.deriveEligible`                     | TXST DegreeWorks adapter. **Source of truth for `needed[]*`* (per D17). Legacy `findNeeded` is fallback only.                                                                |
| `extension/requirements/wildcardExpansion.js` | `BPReq.expandAuditWildcards`, `BPReq.normalizeCourseInformationCourses` | Pure orchestrator + normalizer for DW `course-link` responses. Handles `except` subtraction (Bug 4 Layer C).                                                                 |
| `extension/performance/concurrencyPool.js`    | `BPPerf.mapPool`, `BPPerf.fetchWithTimeout`                             | Bounded concurrency + AbortController-based fetch timeout. Inline fallbacks in `background.js` mirror these so a failed `importScripts` cannot regress to unbounded fan-out. |


---

## Cache (`chrome.storage.local`)

All reads through `cacheGet(key, ttl)`, writes through `cacheSet(key, data)`.
Never write raw.


| Key pattern    | TTL       | Populated by     | Notes           |
| -------------- | --------- | ---------------- | --------------- |
| `course        | {term}    | {subject}        | {courseNumber}` |
| `subjectSearch | v2        | {term}           | {subject}`      |
| `prereq        | {term}    | {crn}`           | 24h             |
| `desc          | {term}    | {crn}`           | 7d              |
| `courseLink    | {subject} | {numberPattern}` | 1h              |
| `terms`        | 24h       | `getTerms`       |                 |


---

## Eligible-course pipeline (high-level)

```
getStudentInfo                      → { id, school, degree }
getAuditData                        → { completed, inProgress, needed, graph, wildcards }
                                      (RequirementGraph, per D17 / D18)
        │
        ▼
BPReq.expandAuditWildcards          → needed[] ⋃ wildcard-expanded courses
    via fetchCourseLinkFromDW         (Bug 4 Layers B + C; `except` subtracted)
        │
        ▼
searchCoursesBySubjects             → Map<subject, sections[]>
                                      (1 paginated Banner call per distinct
                                       subject, single session handshake)
        │
        ▼
index by "subject|courseNumber"     → attach sections to each needed[] entry
        │
        ▼
BPPerf.mapPool (concurrency ≤ 6)    → for each course-with-sections:
                                       checkPrereqs + getCourseDescription
                                       via BPPerf.fetchWithTimeout (15s)
        │
        ▼
eligible[] | blocked[] | notOffered[]
        │
        ▼
sendUpdate({ type: "done" })        → tab.js renders, solver consumes
```

---

## AI pipeline (`scheduleGenerator.js`)

See `HANDOFF.md` § "Architecture (v3 hybrid)" for the full 5-stage
diagram: Intent LLM → deterministic calibrator → Affinity LLM →
CSP solver (`solveMulti`) → ranker (`pickTop3`) → Rationale LLM. The
calibrator corrects LLM weight miscalibration ("preferably" → 0.7 cap,
"cannot" → 1.0 floor). Feature flags fully removed per D17; rollback
is `git revert`.

---

## External APIs


| API                 | Base URL                                             | Auth           | Notes                                             |
| ------------------- | ---------------------------------------------------- | -------------- | ------------------------------------------------- |
| DegreeWorks         | `dw-prod.ec.txstate.edu/responsiveDashboard/api`     | Session cookie | Student audit + `course-link` wildcard expansion. |
| Banner registration | `reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb` | Session cookie | Stateful — session mutex required.                |
| AI (n8n webhook)    | `ml3392.app.n8n.cloud`                               | Webhook secret | Routes to OpenAI.                                 |
| RateMyProfessor     | GraphQL via `facultyScraper.js`                      | None           | Public.                                           |


All TXST APIs require an active SSO session. The extension detects auth
failure and opens a **login popup** from `extension/background.js`
(`openLoginPopup`). **Do not** seed that popup with
`/ssb/registration/registration` alone — Banner often serves the anonymous
**“What would you like to do?”** hub without hitting the IdP. The shipped entry
and recovery URL is **`StudentRegistrationSsb/saml/login`** (SP-initiated
SAML); see `docs/decisions.md` **D19** and `docs/bug8-banner-half-auth-login-popup-diagnosis.md`.

---

## Common tasks

**Add a new Banner endpoint:**

- Wrap in `withSessionLock` if it touches `term/search` first.
- Use `self.BPPerf.fetchWithTimeout`, not bare `fetch`.
- Use `cacheGet` / `cacheSet` — pick or add a row in the cache table above.
- Handle `if (bail()) return` if called inside `runAnalysis`.
- If per-CRN, fan it into the existing `mapPool` lane alongside prereqs/descriptions.

**Change what courses appear as eligible:**

- Source of truth is `BPReq.deriveEligible` in `requirements/txstFromAudit.js`. **Not `findNeeded`** (fallback only).
- Wildcard expansion is `BPReq.expandAuditWildcards`. Test against `tests/fixtures/wildcard/cs-4@.json`.

**Add a UI panel section:**

- HTML → `tab.html`, CSS → `tab.css` (CSS custom properties only), wire in `tab.js`.
- Keep render functions pure (no side effects other than DOM mutation).

**Add a chip color:** `courseColors.js` + add a `chip-N` class in `tab.css`.

---

## Tests

- `node tests/unit/run.js` — deterministic unit suite (115+ cases, no OpenAI). Must stay green on every change.
- `OPENAI_API_KEY=... node tests/intent-fixture.js` — property tests on 11 canonical prompts. Not required per-change.

---

## Documentation rules (humans + AI)

**Where new docs go (pick the existing bucket; making a new one requires a reviewer):**

- **Architectural decision** → append to `docs/decisions.md` with date + "reversible by" clause. **Never start a new file for a decision.**
- **Bug diagnosis** → new `docs/bugN-{short-name}-diagnosis.md`. Mark "closed" in the status header when the fix ships. Keep as historical record.
- **Phase / feature RFC** → `docs/{name}-rfc.md`.
- **Module-level "why"** → top-of-file comment in the module. Do not create a standalone doc for per-file context (see `wildcardExpansion.js` / `concurrencyPool.js` for the template).
- **Any other markdown at `docs/` or repo root** → requires human review.

**Rules:**

1. **AI drafts, humans ratify.** If you commit a doc, you've read it line-by-line and can defend every claim. No unread AI output in the docs tree.
2. **Docs describe *why* + *what would change this decision*.** Not what the code does — the code does that. Paraphrases of code go stale the moment the code changes and waste tokens on every future AI turn.
3. **No end-of-task narrative docs.** Commit messages exist. If something is worth a postmortem, it's a decision (→ `decisions.md`) or a bug (→ diagnosis doc).
4. **Every new doc must be linked from this file's § File map or from `docs/README.md`.** Unindexed = dead.

---

## Session hygiene (for AI sessions)

**Mandatory:** If any trigger below fires during your turn, say so
explicitly. Do not wait to be asked. API budget is finite —
~$20/month, and this project has already eaten meaningful chunks of it.

### Recommend **Auto mode** (cheap models) when the task is:

- Implementing against a diagnosis doc that already exists.
- Adding a test in an existing suite.
- Wiring a function whose signature is already specified.
- UI copy / styling / button-handler changes.
- Doc-only edits.
- Any git commit / push / PR task.

### Stay on **premium (Opus / API)** when the task involves:

- Design with multiple valid approaches or real trade-offs.
- Algorithm work (solver, scorer, planner math, archetype design).
- Debugging without a written diagnosis yet.
- LLM prompt engineering.
- First-time implementation of a new phase.

### Recommend a **new chat window** when any of:

- This chat has had more than ~20 substantive turns OR you've read more than ~10 distinct files.
- You're about to switch phases or feature areas.
- A logical unit just wrapped AND HANDOFF.md was updated with the new state.
- You notice yourself re-reading files you already read this conversation.
- Rough self-check says this chat has consumed more than ~8% of the monthly API quota.

When recommending a new chat, **give the next contributor a paste-ready
opener**, including `cd` into the repo root and the specific `HANDOFF.md`
section + diagnosis docs the next session should read.

**Repo root is the directory containing this file.** The older
`.claude/worktrees/` workflow is deprecated as of 2026-04-21 — do not route
new sessions into a worktree path.

### Do NOT switch mid-flow when:

- Mid-implementation of something complex with live state in the conversation.
- Re-onboarding a fresh session would cost more turns than finishing.
- A contributor is in flow and a context switch would break their thinking — lead with the work, mention the switch at the end.

### Honesty clause

If you don't know how much budget has been used, say so — don't guess.

### Mandatory "Next steps" block on every response

Every turn must end with a short `### Next steps` block, containing in order:

1. **Do now (you):** one concrete action in the browser / terminal / this chat.
2. **Next chat opener:** paste-ready, including `cd` into the repo root and which docs to read. Marked Auto or Opus/API per the routing rules. If the current chat should continue instead, say so explicitly.
3. **Branch point:** if the next action depends on the outcome of step 1, name the branches (`if X → chat A, if Y → chat B`).

Keep it ≤ 8 lines total. It is the receipt the next contributor takes to the next chat, not a report.

---

## Branch + deploy workflow

- `main` — stable, eventually deployed to Chrome Web Store.
- `Demo` — demo-ready branch for external demos.
- `LLM-algorithm` — active AI scheduler work.
- Feature branches: `git checkout -b my-feature` from whichever base applies.

Milestones merge via PR. Per D17, commit-scoped rollback is the default; feature flags only when a phase needs shadow-mode or multi-commit bisection, and flags are stripped once the phase lands.

---

## Files NOT to touch carelessly


| File / area                                                          | Risk                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `background.js` — `withSessionLock` / `sessionQueue`                 | Bypassing causes cross-term Banner race conditions. Silent, hard to reproduce.                                             |
| `background.js` — `runAnalysis` `bail()` checks                      | Removing any `if (bail()) return` lets stale analyses mutate UI after term switch.                                         |
| `background.js` — prereq / description `mapPool` block               | Reverting to `Promise.all` + raw `fetch` reintroduces the 4-minute prereq hang (A1 fix).                                   |
| `background.js` — `searchCoursesBySubjects` cache key version (`v2`) | Bump if caching semantics change. Do not silently mutate cached shape under an existing key.                               |
| `background.js` — inline `BPPerf.`* fallbacks                        | If `performance/concurrencyPool.js` ever fails to load, these keep guardrails on. Do not weaken to the pre-A1 naive shape. |
| `tab.js` — `addToWorkingSchedule`                                    | Replaces by CRN AND transfers lock. Keep both behaviors together.                                                          |
| `scheduleGenerator.js` — affinity cache wipe in `handleUserTurn`     | Without it, prior-turn career keywords silently bias this turn.                                                            |
| `scheduleGenerator.js` — Jaccard tiered dedup in `pickTop3`          | Don't simplify to section-signature-only dedup; regresses "same courses, different lab".                                   |
| `scheduleGenerator.js` — `validateSchedule`                          | Defense in depth. If it fires, the solver is wrong — fix the solver.                                                       |


