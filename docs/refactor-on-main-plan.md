# Refactor-on-main — ES module split of background.js + tab.js

**Status.** In flight. Branch: `refactor-on-main` (off `main @ 6d5c80e`).
**Commits landed:** 7 of 9 (`3b9ccef`, `64c817d`, `021e87a`, `a3f6086`, `f78264a`, `5b4fdae`, `20e7991`).
**Owner.** Aidan + AI sessions (Opus/API for commits 4–8, Auto for commit 9).
**Gate discipline.** Commits 3–8 require a Chrome browser smoke before the next commit stacks on top. 133 unit tests must stay green on every commit (132 + `bailContract.test.js` added in commit 7).

---

## Context — why this doc exists

The `Refactor` branch (HEAD `d201844`) sliced the legacy `background.js` + `tab.js` monoliths into `extension/bg/*` (9 modules) + `extension/tab/*` (8 modules) with thin entry-point routers (≤210 lines each). That work was authored **before** the following landed on `LLM-algorithm` and merged into `main` today:

- Phase 0 instrumentation + Bug 5 fix (`fda436e`)
- Phase 1 RequirementGraph parser + wiring + wildcard expansion (`0cbceb6`, `76abc17`)
- Bug 1/3 solver fix — pref-distance ordering, per-pass budget, calibrator (`5975c90`)
- D17 flag strip (`88a9d05`)
- **A1+B perf fix** — `BPPerf.mapPool`, `fetchWithTimeout`, `searchCoursesBySubjects`, `subjectSearch|v2|` cache, inline `BPPerf.*` fallbacks (`e687ad6`)
- Closed-term schedule via `registrationHistory` + SAML `/saml/login` popup (`ed8d99d`, D19)

**Consequence.** Refactor cannot be merged or cherry-picked. Its `bg/*` modules are ~30–60% the size of `main`'s current pre-split equivalents, and it's missing the `extension/requirements/` and `extension/performance/` directories entirely.

**Approach.** Re-perform the refactor on current `main`, using Refactor's boundaries as a **blueprint**, not a patch set. Two explicit deviations from Refactor per GSE critique (see "Blueprint deltas" below).

---

## Blueprint — Refactor's module map + our deltas

### `extension/bg/` (service worker, ES modules)


| Module            | Source of truth                                                                                                            | Notes                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `constants.js`    | URL bases, `GRADE_MAP`, `SUBJECT_MAP`, IDs                                                                                 | Stateless leaf.                                                              |
| `cache.js`        | `cacheGet` / `cacheSet` wrappers                                                                                           | Wraps `chrome.storage.local`.                                                |
| `session.js`      | `sessionQueue` + `withSessionLock` singleton                                                                               | **Module-level singleton; never re-exported** (Refactor contract preserved). |
| `bannerApi.js`    | `getTerms`, `searchCourse`, `**searchCoursesBySubjects`** (from `main`)                                                    | All Banner calls go through `session.js`.                                    |
| `prereqs.js`      | `checkPrereqs`, `getCourseDescription`, **BPPerf mapPool wiring**                                                          | Uses `self.BPPerf` imported as side-effect by `background.js`.               |
| `studentInfo.js`  | `getStudentInfo`, `getAuditData`, `getDegreeAuditOverview`, **RequirementGraph wiring + wildcard expansion** (from `main`) | Largest bg module. Source of `auditDiagnostics.parity`.                      |
| `registration.js` | `getCurrentSchedule`, `**registrationHistory` fallback**, `**/saml/login` popup** (both from `main`)                       | Preserves D19 behavior.                                                      |
| `plans.js`        | Banner plan CRUD, `fetchPlanCalendar`                                                                                      | Includes save/delete/list/events.                                            |
| `analysis.js`     | `runAnalysis` with **every `bail()` guard verbatim**                                                                       | **Deviation A: split further if > 400 lines** (see below).                   |


### `extension/tab/` (page context, ES modules)


| Module              | Source of truth                                                 | Notes                                                                        |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `state.js`          | Shared state cells, `$`, `persistRegistrationEvents`            |                                                                              |
| `calendar.js`       | `buildEmptyCalendar`, `renderCalendarFromWorkingCourses`        |                                                                              |
| `schedule.js`       | `loadBannerPlans`, `renderSavedList`, `updateSaveBtn`           |                                                                              |
| `auth.js`           | `checkAuth`, `loadSchedule`, `registrationFetchQueue` singleton | Preserves Refactor's per-tab queue.                                          |
| `eligibleList.js`   | `autoLoadEligibleCourses`, `renderEligibleList`                 |                                                                              |
| `ai.js`             | `addMessage`, `waitWithChatCountdown`, chat wiring              |                                                                              |
| `modal.js`          | Modal DOMContentLoaded wiring, registration-event metadata      |                                                                              |
| `overview.js`       | Degree-audit overview panel, `setPanelMode`, week-hours         |                                                                              |
| `**chat.js`** (new) | `addMessage` + `waitWithChatCountdown` primitives               | **Deviation B: replaces Refactor's callback-injection pattern** — see below. |


### Entry points after the split

- `extension/background.js` — ≤150 lines. `onMessage` router + `analysisGeneration` counter. Side-effect imports for `requirements/`* + `performance/concurrencyPool.js` happen here (single source).
- `extension/tab.js` — ≤220 lines. Boot IIFE + term-change handler + module wiring.
- `extension/manifest.json` — `"background": { "service_worker": "background.js", "type": "module" }` (✅ landed in commit 3).
- `extension/tab.html` — `<script type="module" src="tab.js">` (flipped in commit 8, not commit 3).

### Blueprint deltas (two deliberate departures from Refactor)

**Deviation A — `bg/analysis.js` may be split into sub-modules.**
Refactor's `bg/analysis.js` is 145 lines. Main's `runAnalysis` is ~500 lines with ten `bail()` guards, `BPPerf.mapPool` wiring, `searchCoursesBySubjects` integration, RequirementGraph usage, and wildcard expansion. If the port exceeds ~400 lines, split into `bg/analysis/pipeline.js` (orchestration) + `bg/analysis/eligible.js` (eligible-course derivation). Decision deferred to commit 7.

**Deviation B — replace Refactor's callback injection with a shared module.**
Refactor wires `auth.js` and `ai.js` via `setAddMessage(addMessage)` / `setWaitWithChatCountdown(waitWithChatCountdown)` at boot. That's not resolving a circular dependency — it's hiding it behind closures. Instead, extract the chat primitives into `tab/chat.js` as a dependency of both modules. Both consumers then use direct named imports. The wire-up boilerplate in `tab.js` drops.

---

## Invariants — what must not regress

From `CLAUDE.md § Load-bearing invariants`, plus the smoke-check protocol:

1. **Session mutex.** Every Banner call through `withSessionLock` (service worker) or `queueRegistrationFetch` (tab). A single `sessionQueue` / `registrationFetchQueue` module-level singleton per context. **Test:** manual smoke — concurrent term switches do not race.
2. `**bail()` checks in `runAnalysis`.** Every `await` still followed by `if (bail()) return`. Every guard copied verbatim in commit 7. **Test:** chrome.mock-backed `bail()` contract test added in commit 7.
3. **Bounded pool + timeout on per-CRN Banner fetches.** Prereq + description + (future) restriction fetches go through `self.BPPerf.mapPool(…, ≤6, …)` with `self.BPPerf.fetchWithTimeout(…, ≥12s)`. **The inline fallback has been deleted** (D20). Imports must succeed or the SW fails to start. **Test:** eligible list fills in <3s on manual smoke.
4. **Affinity cache wipe per turn.** `affinityCache.clear()` at the top of `handleUserTurn`. **Test:** `tests/unit/affinityCache.test.js` (landed commit 2).
5. **Jaccard tiered dedup in `pickTop3`.** Pass-1 `<= 0.7`, Pass-2 `< 1.0`, Pass-3 fallback. **Test:** `tests/unit/ranker.test.js` (landed commit 1).
6. `**validateSchedule()` is defense in depth.** If it fires, the solver is wrong. **Test:** `tests/unit/validator.test.js` (landed commit 1).
7. `**addToWorkingSchedule` replaces by CRN AND transfers lock.** Preserved in `tab/schedule.js`. **Test:** manual smoke — lock + save + reload.

---

## Commit chain


| #   | Status | Commit    | Summary                                                                                                                                                                                                                                                                  | Gate                                                                             |
| --- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | ✅      | `3b9ccef` | `validateSchedule` pinned (12 cases) + Jaccard course-set dedup regression test.                                                                                                                                                                                         | `node tests/unit/run.js` green (128).                                            |
| 2   | ✅      | `64c817d` | Affinity cache wipe pinned (4 cases). Seeded `tests/mocks/chrome.js`.                                                                                                                                                                                                    | 132 green.                                                                       |
| 3   | ✅      | `021e87a` | SW `type: "module"`; `importScripts` → ES side-effect `import`; inline `BPPerf.`* fallback deleted (–78 / +38 lines).                                                                                                                                                    | **Manual browser smoke** — ✅ passed.                                             |
| 4   | ✅     | `a3f6086` | Moved `bg/constants.js` (URL bases, `GRADE_MAP`, `SUBJECT_MAP`), `bg/cache.js` (`CACHE_TTL` + `cacheGet/Set/Age`), `bg/session.js` (`withSessionLock` module singleton), `bg/bannerApi.js` (`getTerms`, `getCurrentTerm`, `searchCourse`, `searchCoursesBySubjects`), `bg/prereqs.js` (`checkPrereqs`, `getCourseDescription`). `background.js` gained named ES imports; removed definitions dropped. 132 tests green, Node SW-module-graph smoke (FIFO + cache round-trip) ✓. | Manual smoke: eligible list fills <3s.                               |
| 5   | ✅      | `f78264a` | Moved `bg/studentInfo.js` (`getStudentInfo`, `getDegreeAuditOverview`, `getAuditData` with RequirementGraph wiring + legacy `findNeeded` fallback, `fetchCourseLinkFromDW` wildcard-expansion helper). Moved `bg/registration.js` (`getCurrentSchedule` with `registrationHistory` fallback for closed terms, `openLoginPopup` at `/saml/login` per D19, synchronizer-token cache, SAML SW resolver incl. HTML-entity decode for SAML forms, DW worksheet post-Banner warm-up per D23). Later: `3764566` lands bug11 login fixes on top. `background.js` slimmed to plans + `runAnalysis` + router until commit 6. 132 tests green. | Closed-term smoke + parity spot-check completed by owner.                               |
| 6   | ✅      | `5b4fdae` | Moved `bg/plans.js` — Banner Plan Ahead CRUD (`saveManualPlanToTxst`, `getBannerPlanItems`, `getAllBannerPlans`, `fetchPlanCalendar`, `deleteTxstPlan`, `getBannerPlanEvents`) + helpers. `background.js` now ~550 lines (`runAnalysis` + `onMessage`). 132 tests green.                                                                                                                                                                                                                                                                                            | Manual smoke: save/load/delete a Banner plan.                                             |
| 7   | ✅      | `20e7991` | Moved `bg/analysis.js` (330 lines — under the 400-line Deviation A split threshold, so kept as one module). `runAnalysis` copied verbatim: all 13 `if (bail()) return;` guards preserved, Bug 4 wildcard-expansion block intact, named imports pull `cacheSet` / `getTerms` / `getCurrentTerm` / `searchCoursesBySubjects` / `checkPrereqs` / `getCourseDescription` / `getStudentInfo` / `getAuditData` / `fetchCourseLinkFromDW` from the leaf `bg/*` modules. `background.js` slims to a 224-line `onMessage` router + `analysisGeneration` counter; side-effect imports for `requirements/*` + `performance/concurrencyPool.js` stay here (single source per D20). New `tests/unit/bailContract.test.js` pins `bail()` / `current()` definitions and asserts exactly 13 guards in `runAnalysis.toString()` to prevent silent drift. 133 tests green. | Tests green + full smoke: auth → term → eligible → AI → lock/save. |
| 8   | ⬜      | —         | Split `tab.js` into `tab/`* using direct imports (Deviation B — new `tab/chat.js`). Flip `tab.html` to `type="module"`. Slim `tab.js`.                                                                                                                                   | Tests green + full smoke.                                                        |
| 9   | ⬜      | —         | Doc restructure per approved table (CLAUDE.md router, `docs/architecture.md`, `docs/invariants.md`, `docs/file-map.md`, `docs/open-bugs.md`, HANDOFF trim, per-module docstrings). File `docs/bug9` + `docs/bug10` diagnoses for Refactor fixes we deferred (see below). | —                                                                                |


**Success metric:** after commit 8, touching the eligible-list UI requires reading ≤ 400 lines, not ≤ 3000.

---

## Deferred from `Refactor` branch

Four bug-fix commits landed on `Refactor` after the module split. Handling per refinement dialogue:


| Refactor commit                             | Fate                                                                                                                                                                      | Action                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `d201844` load plans before schedule        | **File diagnosis; fix later.** Main's current order is `loadSchedule → loadBannerPlans`; `loadSchedule` calls `registrationHistory/reset` which can clobber plan session. | File `docs/bug9-plans-empty-after-term-switch-diagnosis.md` in commit 9. |
| `4f48968` preserve auth error in status bar | **File diagnosis; fix later.** UX-visible; low priority.                                                                                                                  | File `docs/bug10-session-expired-status-bar-diagnosis.md` in commit 9.   |
| `a2583f6` prereq 10s AbortController        | **Superseded by `e687ad6`.** `BPPerf.fetchWithTimeout` provides 12–15s bounded timeout already.                                                                           | Close out in D-new-2 in commit 9 decisions log.                          |
| `832a155` import popup logged-in fix        | **Superseded by `ed8d99d` (D19).** Main's `/saml/login` entry + SAML recovery handle this case differently.                                                               | Close out in D-new-2.                                                    |


---

## Next-session opener (paste-ready)

```
cd /Users/aidanvickers/Desktop/BobcatPlus && git checkout refactor-on-main && git log --oneline main..HEAD && node tests/unit/run.js
```

Model: Opus/API (per the status line, commits 4–8 are premium — commit 8 touches page-context invariants like the `registrationFetchQueue` singleton and `addToWorkingSchedule` lock transfer).

Context to read:

1. `CLAUDE.md` — project orientation, invariants, file map
2. `HANDOFF.md` — current phase status
3. `**docs/refactor-on-main-plan.md` (this doc)** — blueprint, invariants, commit chain
4. `git show 20e7991` — commit 7 (analysis.js extraction baseline for commit 8)

Task for next chat: **Commit 8** — split `extension/tab.js` into `extension/tab/*` using direct named imports per Deviation B (new `tab/chat.js` hosts `addMessage` + `waitWithChatCountdown` as a shared dependency of `tab/auth.js` and `tab/ai.js`; no more `setAddMessage` / `setWaitWithChatCountdown` callback injection). Flip `extension/tab.html` to `<script type="module" src="tab.js">`. Slim `tab.js` to ≤ 220 lines (boot IIFE + term-change handler + module wiring). Gate: tests green + full smoke.


_(Previous chat openers kept for history — commit 4 was "move `bg/constants.js`, `bg/cache.js`, `bg/session.js`, `bg/bannerApi.js`, `bg/prereqs.js`"; commit 5 was "move `bg/studentInfo.js` + `bg/registration.js`"; commit 6 was "move `bg/plans.js`"; commit 7 was "move `bg/analysis.js`".)_

---

## Historical reference

This doc is append-only until the refactor is complete. Do not rewrite status rows — add a dated note if something changes direction.