# Extension file map

Optimizes for “where do I change X?” without opening three thousand lines of
legacy code. Line counts are approximate; run `wc -l` on the file if a budget
matters (refactor target: entrypoints stay **O(200) lines**).

---

## Entrypoints

| File                                | Lines (approx) | Role                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extension/background.js`           | ~260           | ES module service worker: side-effect imports for `self.BPReq` / `self.BPPerf`, `import` from `bg/*`, `onMessage` router, `runAnalysis` orchestration, `analysisGeneration` stale-run guard. Also handles `getRegisteredSectionMeta` — building+room lookup for popup via `searchCourse`. |
| `extension/tab.js`                  | 212            | ES module tab shell: imports `tab/*`, boot IIFE, term `<select>` handler, `?login=1` toolbar handoff.                                                                                                                                                        |
| `extension/manifest.json`           | —              | MV3; `background.type: "module"`.                                                                                                                                                                                                                            |
| `extension/tab.html`                | —              | `<script type="module" src="tab.js">` plus classic scripts for `courseColors`, `facultyScraper` (run first — they attach `window.BobcatFaculty` / `getChipForCourse`). `scheduleGenerator.js` removed in C6; `tab/*` now import directly from `scheduler/*`. |
| `extension/popup.html` + `popup.js` | —              | Toolbar popup: renders mini weekly calendar with course code, time, and building+room location (fetched via `getRegisteredSectionMeta`); opens full tab.                                                                                                    |

### Tab page styles (`extension/css/`)

Single cascade split for maintainability. **`tab.html` link order is authoritative** (same as former monolithic `tab.css` top-to-bottom).

| File (load order)      | Role                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `tab-base.css`         | Reset, `:root` tokens, `body`                                                                 |
| `tab-shell.css`        | Top bar, hamburger, sidebar, `.main`                                                          |
| `tab-calendar.css`     | Calendar panel, week grid, course/calendar blocks, chips                                      |
| `tab-right-column.css` | Right column: overview, saved schedules, manual builder                                       |
| `tab-chat.css`         | Chat + status bar                                                                             |
| `tab-modal.css`        | Modal overlay + `.modal-body` base (course shell: Simone block in `tab-lists-plans.css`)      |
| `tab-build-ai.css`     | Build section toggles, zoom/import/block chrome, resize, mode tabs, build + AI panels         |
| `tab-lists-plans.css`  | Online courses bar, avoid-day, block buttons, eligible, plans, TXST, **Simone** course modal  |
| `tab-responsive.css`   | `max-width` media queries                                                                     |
| `tab-dark.css`         | `prefers-color-scheme: dark` (single block)                                                   |

---

## Service worker modules (`extension/bg/`)


| File              | Lines (approx) | Exports / role                                                                                                                  |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `constants.js`    | 165            | Bases, `GRADE_MAP`, `SUBJECT_MAP` — no I/O.                                                                                     |
| `cache.js`        | 56             | `cacheGet` / `cacheSet` / `cacheAge` + TTL table.                                                                               |
| `session.js`      | 32             | `withSessionLock` — **singleton** queue (not re-exported).                                                                      |
| `bannerApi.js`    | 281            | `getTerms`, `getCurrentTerm`, `searchCourse`, `searchCoursesBySubjects` — all session-locked I/O.                               |
| `prereqs.js`      | 146            | `checkPrereqs`, `getCourseDescription` — `BPPerf` pool + cache.                                                                 |
| `studentInfo.js`  | 1140+          | `getStudentInfo`, `getDegreeAuditOverview`, `getAuditData`, `fetchCourseLinkFromDW` — DW + RequirementGraph.                    |
| `registration.js` | 644            | `getCurrentSchedule` (incl. `registrationHistory` closed-term path), `openLoginPopup` (`/saml/login`, D19; D22/D23 popup flow). |
| `plans.js`        | 917            | Banner Plan CRUD, `fetchPlanCalendar`, token bootstrap.                                                                         |
| `analysis.js`     | 330            | `runAnalysis` — eligible pipeline, `bail()` contract.                                                                           |


**Pure cross-environment modules** (imported from `background.js` only as side
effects, attach `globalThis` for Node + SW):


| Path                                          | Role                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| `extension/requirements/graph.js`             | RequirementGraph primitives                           |
| `extension/requirements/txstFromAudit.js`     | TXST adapter, `buildGraphFromAudit`, `deriveEligible` |
| `extension/requirements/wildcardExpansion.js` | Wildcard orchestration + `course-link` normalizer     |
| `extension/performance/concurrencyPool.js`    | `BPPerf.mapPool`, `BPPerf.fetchWithTimeout`           |


---

## Tab page modules (`extension/tab/`)


| File              | Lines (approx) | Role                                                                                                                         |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `state.js`        | 144            | Shared mutable UI state, `$`, registration-event cache, `sendToBackground`.                                                  |
| `chat.js`         | 61             | `addMessage`, `waitWithChatCountdown`, countdown helpers — shared by `auth.js` and `ai.js` (no callback injection).          |
| `calendar.js`     | 349            | Week grid, zoom, overlap columns, conflict status via `findOverlapPair` (imported from `../scheduler/time.js`).              |
| `schedule.js`     | 435            | Working schedule, locks, saved/Banner plan list, save-to-TXST.                                                               |
| `auth.js`         | 687            | `checkAuth`, `loadSchedule`, per-tab `registrationFetchQueue`, Import, SAML recovery.                                        |
| `modal.js`        | 593            | Section metadata, RMP URL, modals, CRN fetch.                                                                                |
| `overview.js`     | 387            | Student header, audit overview, week counters, Build/AI toggle, layout.                                                      |
| `eligibleList.js` | 284            | `runAnalysisAndWait`, auto-load, eligible list + cache age.                                                                  |
| `ai.js`           | 726            | Chat, `applyAction`, schedule cards, toolbar, blocks/avoid days; dynamic `import("./overview.js")` breaks a load-time cycle. |


---

## Scheduler modules (`extension/scheduler/`)

Tab-only ESM modules. The AI + CSP pipeline — no `window.BP` globals.


| File                              | Role                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `scheduler/index.js`              | `handleUserTurn` orchestrator — the primary entry point for the AI pipeline. |
| `scheduler/profile.js`            | `buildStudentProfile`, `mergeCalendarBlocks`, `compressForSolver`.           |
| `scheduler/validate.js`           | `validateSchedule` — defense-in-depth (invariant #6).                        |
| `scheduler/trace.js`              | `createTrace` — pipeline observability.                                      |
| `scheduler/time.js`               | Time/day utils: `toMinutes`, `findOverlapPair`, `hashString`.                |
| `scheduler/metrics.js`            | Phase 0 metric helpers: archetype, penalty effectiveness, honored rate.      |
| `scheduler/fixture.js`            | `runFixture` — golden-prompt test runner.                                    |
| `scheduler/solver/solver.js`      | CSP backtracking solver, `solveWithRelaxation`.                              |
| `scheduler/solver/rank.js`        | `rankSchedules`, `pickTop3`, tiered Jaccard dedup (invariant #5).            |
| `scheduler/solver/constraints.js` | `buildConstraints`, relaxation ladder.                                       |
| `scheduler/llm/openai.js`         | `openaiChat`, `openaiJson` — the only network I/O in the scheduler.          |
| `scheduler/llm/intent.js`         | `callIntent`, `calibrateIntentWeights`, frozen IntentSchema v1.              |
| `scheduler/llm/affinity.js`       | `callAffinity`, `clearAffinityCache` (invariant #4).                         |
| `scheduler/llm/rationale.js`      | `callRationales`, `buildRationaleFacts`.                                     |
| `scheduler/llm/advisor.js`        | `callAdvisor`, `buildAdvisorPrompt`.                                         |


---

## Other extension scripts (classic, global)


| File                          | Role                      |
| ----------------------------- | ------------------------- |
| `extension/facultyScraper.js` | Rate My Professor         |
| `extension/courseColors.js`   | Deterministic chip colors |


---

## Tests (sanity)

- `node tests/unit/run.js` — deterministic (no network). **Must stay green** on every change.
- Optional: `OPENAI_API_KEY=… node tests/intent-fixture.js` — intent goldens.

---

## Offline tooling (`scripts/`)

Local Node scripts that don't ship with the extension. Used for fixture
collection, baseline regen, and the Phase 1.6 rule-shape discovery pipeline.
None of these are imported by the extension at runtime.


| Path                                | Role                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/generate-phase1-baseline.js` | Regenerate `docs/baselines/phase1-*.json` after parser/adapter changes.                                                                                                       |
| `scripts/scheduleGenerator.js`        | Frozen Phase-0 reference scheduler kept for baseline diffs only — not the live pipeline (that lives under `extension/scheduler/`).                                            |
| `scripts/catalog/scrape-majors.js`    | TXST course-catalog scraper. Emits `degree-combinations.json`. Defaults to all 4 catalog years; `--year YYYY-YYYY` for one year. No auth.                                     |
| `scripts/catalog/map-dw-codes.js`     | Populates `dwMajorCode` / `dwConcCode` on the manifest by hitting DW's `validations/special-entities/majors-whatif` endpoint. Requires `~/.bobcatplus-dw-cookie`.              |
| `scripts/catalog/README.md`           | Run procedure.                                                                                                                                                                |
| `scripts/whatif/pull-audits.js`       | DW What-If audit driver. Reads the manifest, POSTs each combo to `api/audit`, writes JSON dumps under `tests/fixtures/audits/whatif/` (gitignored). Idempotent + rate-limited. |
| `scripts/whatif/run.log`              | Per-call outcome log (`ok` / `invalid-combo` / `skipped` / `http-error`). Gitignored.                                                                                         |
| `scripts/whatif/README.md`            | Run procedure + cookie setup.                                                                                                                                                 |
| `scripts/shape/extract-shapes.js`     | Walks committed and gitignored audits, regenerates `docs/plans/rule-shape-inventory.md`.                                                                                      |


**Storage policy (`.gitignore`):** the bulk what-if dump
(`tests/fixtures/audits/whatif/`), the catalog manifest, the run log, and the
DW cookie jar are not committed. Curated fixtures live in
`tests/fixtures/audits/audit-*.json` (root) and the HAR captures from the T3
DevTools session live in `tests/fixtures/audits/what-if/` (with the hyphen).