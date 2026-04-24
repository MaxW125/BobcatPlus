# Plan — `scheduleGenerator.js` refactor

**Status.** 🟢 **Approved plan — ready to execute on branch `scheduler-refactor`.**
All five open questions resolved in a GSE + AIE + UXE review meeting
(see "Resolutions" section at the bottom). When the refactor merges, this
file gets copied to `docs/postmortems/scheduler-refactor.md` with actual
SHAs filled in.

**Named in.** `docs/postmortems/refactor-on-main-split.md` ("next refactor
after this one: `extension/scheduleGenerator.js` — its own RFC under
`docs/plans/` when that work starts").

**Owner.** — (assign on epic creation)

**Prereqs.**

1. `main` green (`node tests/unit/run.js` — 133 cases).
2. No other work in flight on `extension/scheduleGenerator.js`,
  `extension/tab/ai.js`, `extension/tab/overview.js`,
   `extension/tab/calendar.js`, `extension/tab.html`, or `tests/unit/_harness.js`.
3. Jira epic **CP-?? Scheduler refactor** created with subtasks mapping 1:1
  to the commits in the chain below.

---

## Context — why this refactor, why now

`extension/scheduleGenerator.js` is the last monolith in the repo: **2098 lines, single IIFE, ~60 functions attached to `window.BP`**. It hosts the entire v3 hybrid pipeline (`[docs/architecture.md](../architecture.md)`): Intent LLM → calibrator → Affinity LLM → CSP solver → ranker → Rationale LLM → advisor.

### Why it has to move

1. **Every future phase edits it.** Phase 1.5 (graph-native solver, D9 many-to-many UX), Phase 2 (scorer fidelity), Phase 2.5 (prereq-in-term in solver), Phase 3 (archetype-seeded ranking) all land in this file. Every AI session that touches it re-ingests ~2000 lines; P3 (budget hygiene) says that's expensive.
2. **Four of seven load-bearing invariants** in `[docs/invariants.md](../invariants.md)` sit inside this file (#4 affinity wipe, #5 tiered Jaccard, #6 `validateSchedule` defense-in-depth, plus the high-risk-areas table). Splitting so each invariant owns one module tightens the "if this breaks, it fails loudly" story.
3. **Prompts and deterministic code are interleaved.** `buildIntentPrompt` (L385–521) + `calibrateIntentWeights` (L546–564) + `callIntent` (L565–593) currently live in the middle of a file that also holds the CSP solver. Splitting by pipeline stage makes "change the intent prompt without disturbing the solver" a one-file diff.

### Why *now*

1. **Merge window is open.** `main` is quiet post-PR #8 (`7e51ebb`); `LLM-algorithm` is merged; 133 unit tests green; `refactor-on-main` is retired.
2. **Refactor muscle memory is hot.** The bg/tab split (`[refactor-on-main-split.md](../postmortems/refactor-on-main-split.md)`) shipped two weeks ago; its deviations + lessons are still readable context, not archaeology.
3. **Downstream blockers are already non-blocking.** Phase 1.5 needs more audit fixtures (`[requirement-graph.md](./requirement-graph.md)` open Qs #3, #5) before Max can start; fixture collection runs in parallel to this refactor.

---

## Goal + success metric

After this refactor, modifying one pipeline stage (intent, affinity, solver, rank, rationale, advisor) requires reading **≤ 300 lines**, not ≤ 2098. Every invariant in `[docs/invariants.md](../invariants.md)` that mentions `scheduleGenerator.js` has a **single-file home** with a comment that links back to the invariant.

**Non-goals.** Behavior change, prompt changes, solver algorithm changes, schema changes. This is a pure code move.

---

## Module map

Target: `extension/scheduler/` (sibling of `extension/requirements/` and `extension/performance/`, matching the cross-environment-pure-ish pattern those two established). ~15 modules averaging ~140 lines.


| Module                            | Source lines (current)                        | Role                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduler/time.js`               | L42–105                                       | Pure time/day utils + `findOverlapPair` + `hashString` (consumed by `tab/calendar.js` conflict status).                                                                                                                                                                                                                                                                     |
| `scheduler/profile.js`            | L177–250                                      | `compressForSolver`, `buildStudentProfile`, `mergeCalendarBlocks`, `creditsFromCourseNumber`, `deriveCredits`, `stripHtml`, `labPartnerCandidate`, `annotateLabPairs`. Pure data shaping.                                                                                                                                                                                   |
| `scheduler/validate.js`           | L257–286                                      | `validateSchedule`. **Invariant #6.** Module-level comment links to the invariant.                                                                                                                                                                                                                                                                                          |
| `scheduler/trace.js`              | L293–325                                      | `createTrace`. Pure; used everywhere.                                                                                                                                                                                                                                                                                                                                       |
| `scheduler/llm/openai.js`         | L330–374                                      | `openaiChat`, `openaiJson`. **The only module that does network I/O.**                                                                                                                                                                                                                                                                                                      |
| `scheduler/llm/intent.js`         | L385–593                                      | `buildIntentPrompt`, `_clausesMentioning`, `_calibrate`, `calibrateIntentWeights`, `callIntent`, `INTENT_SCHEMA_VERSION`. **Keep prompt + schema + calibrator in one file** — IntentSchema v1 is frozen (file header L8) and the calibrator's hedge/hard rules are empirically tuned against the exact intent prompt strings. Changing one without the others is a footgun. |
| `scheduler/llm/affinity.js`       | L604–695 (+ `affinityCache` module-level Map) | `_affinityCacheKey`, `_truncateEligibleForAffinity`, `callAffinity`, exported `clearAffinityCache`. **Invariant #4.** Cache wipe call stays at the top of `handleUserTurn` in `scheduler/index.js`.                                                                                                                                                                         |
| `scheduler/llm/rationale.js`      | L1503–1591                                    | `buildRationaleFacts`, `callRationales`. Facts-only grounding.                                                                                                                                                                                                                                                                                                              |
| `scheduler/llm/advisor.js`        | L1596–1644                                    | `buildAdvisorPrompt`, `callAdvisor`. Separate non-schedule intent path.                                                                                                                                                                                                                                                                                                     |
| `scheduler/solver/solver.js`      | L712–965                                      | `preferenceSectionDistance`, `sectionConflictsFixed`, `sectionsConflict`, `seededRng`, `shuffleInPlace`, `solve`. CSP core.                                                                                                                                                                                                                                                 |
| `scheduler/solver/rank.js`        | L976–1162 + `WEIGHT_VECTORS`                  | `scoreSchedule`, `breakdownOf`, `applyVector`, `rankSchedules`, `pickTop3`. **Invariant #5** (tiered Jaccard).                                                                                                                                                                                                                                                              |
| `scheduler/solver/constraints.js` | L1287–1493                                    | `buildConstraints`, `_constraintSnapshot`, `solveMulti`, `solveWithRelaxation`. Hard/soft constraint translation + relaxation ladder.                                                                                                                                                                                                                                       |
| `scheduler/metrics.js`            | L1170–1273                                    | `_scheduleCourses`, `computeHonoredRate`, `computeArchetypeVector`, `computeArchetypeDistance`, `computePenaltyEffectiveness`, `computeRequirementGraphValidity`. Phase 0 helpers, pure, baseline-producers.                                                                                                                                                                |
| `scheduler/actions.js`            | L1666–1821                                    | `_infeasibleSuggestions`, `_validateCrns`, `_buildRankBreakdown`, `_schedulesForAction`, `_rejectedFromSolver`. The "turn solver output into UI actions" layer; separate from orchestration so `handleUserTurn` stays readable.                                                                                                                                             |
| `scheduler/fixture.js`            | L2026–2052                                    | `runFixture` — exported for `tests/intent-fixture.js`.                                                                                                                                                                                                                                                                                                                      |
| `scheduler/index.js`              | L1823–2097                                    | `handleUserTurn` (the orchestrator) + the module's public surface. Also the single call site for `clearAffinityCache()` at the top of each user turn (invariant #4).                                                                                                                                                                                                        |


### Consumers that have to move with the refactor


| File                                  | Current use                                                                                  | Post-refactor                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/tab.html`                  | `<script src="scheduleGenerator.js">` (classic) before `<script type="module" src="tab.js">` | `<script src="scheduleGenerator.js">` line **removed**; `tab.js` (module) imports what it needs from `./scheduler/index.js`. `courseColors.js` and `facultyScraper.js` remain classic-script for now (separate future cleanup). The comment on L254–258 updates to drop the `handleUserTurn/buildStudentProfile/mergeCalendarBlocks/clearAffinityCache` names from the `window.`* list. |
| `extension/tab/ai.js` L96, L650, L663 | `window.mergeCalendarBlocks`, `window.buildStudentProfile`, `window.handleUserTurn`          | Named imports from `../scheduler/profile.js` + `../scheduler/index.js`.                                                                                                                                                                                                                                                                                                                 |
| `extension/tab/overview.js` L47       | `window.buildStudentProfile`                                                                 | Named import from `../scheduler/profile.js`.                                                                                                                                                                                                                                                                                                                                            |
| `extension/tab/calendar.js` L299–300  | `BP.findOverlapPair`                                                                         | Named import from `../scheduler/time.js`.                                                                                                                                                                                                                                                                                                                                               |
| `tests/unit/_harness.js`              | `eval(fs.readFileSync("scheduleGenerator.js"))` under `window = global` shim                 | Dynamic `await import("../../extension/scheduler/index.js")` + one-time init that returns a `{ BP }` facade with the same shape, so test files continue to `const { BP } = require("./_harness")` unchanged. **Details in "Test harness migration" below.**                                                                                                                             |
| `tests/intent-fixture.js`             | same pattern as `_harness.js`                                                                | Same dynamic-import pattern.                                                                                                                                                                                                                                                                                                                                                            |


### What stays untouched

- `extension/courseColors.js`, `extension/facultyScraper.js` — still classic-script, still install `window.getChipForCourse` / `window.BobcatFaculty`. Out of scope; separate future cleanup.
- `extension/bg/`* — service worker modules, zero dependencies on the scheduler. Untouched.
- `extension/requirements/*`, `extension/performance/*` — cross-environment pure modules, already ES module shape. Untouched.

---

## Architectural decision — classic script → ESM

### Options considered

**Option A — keep IIFE + `window.BP`, split internally via bundler.**
Internal files become ESM; a build step (esbuild / rollup) concatenates them into one classic script at ship time. **Rejected.** The project has no build pipeline today; D20 explicitly moved the SW to ESM to avoid bundler maintenance. Adding esbuild for one file is more moving parts than the refactor itself.

**Option B — keep IIFE + internal `require`-like pattern.**
Fake modules via a shared object passed into each IIFE. **Rejected.** Just reinvents modules, badly.

**Option C — flip to ESM. ← Recommended.**
`scheduler/index.js` + siblings use `export` / `import`. `tab.html` drops the `<script src="scheduleGenerator.js">` line. `tab.js` and `tab/`* switch from `window.BP.*` readers to direct named imports. Back-compat `window.handleUserTurn` etc. (L2093–2097) are deleted entirely — only the four consumers listed above read them, and all four move in the same refactor.

**Rationale for C.** Matches the D20 pattern already adopted for the service worker. Tab.html's load-order constraint (classic scripts must attach `window.BP` before the deferred tab module runs, per the comment at L254–258) goes away — there's nothing to attach. `tab.js` just imports what it needs. No bundler.

**Not obvious until stated:** an atomic C6 commit is structural, not cosmetic.
If we split into C6a (consumers migrate, scheduler becomes pure ESM) and
C6b (delete `scheduleGenerator.js` + `window.`* shim), the repo between
the two commits has **both** `extension/scheduleGenerator.js` and
`extension/scheduler/index.js` coexisting. A clone at C6a imports from the
wrong path and learns the wrong habit. Atomic closes that gap.

### The test-harness cost

**This is the non-trivial part of Option C and the #1 reason to pre-approve the plan.**

Today the harness is CommonJS and loads the scheduler via `eval(fs.readFileSync(...))`. After the flip, scheduler files are ES modules and can only be loaded via `import()`. Options:

**H1 — Dynamic `import()` in the CJS harness.**
`_harness.js` stays CJS. It exposes a one-time initializer that returns `{ BP }`:

```js
let BP = null;
async function init() {
  if (BP) return { BP };
  if (!global.window) global.window = global;
  const scheduler = await import("../../extension/scheduler/index.js");
  const profile   = await import("../../extension/scheduler/profile.js");
  // … assemble the same keys the current BP has …
  BP = Object.freeze({ handleUserTurn: scheduler.handleUserTurn, /* etc. */ });
  return { BP };
}
module.exports = { init, /* assertion helpers unchanged */ };
```

Test files that are currently `const { BP } = require("./_harness")` become slightly different — but we can preserve the shape by making `run.js` await `init()` once before any test file `require()`, and exposing `BP` as a lazy getter on the exports object.

**H2 — Migrate tests to ESM (add `package.json` with `"type": "module"`, rename test files to `.mjs` or keep `.js`).**
Cleaner long-term but a ~15-file churn across `tests/unit/*.test.js`.

**Recommendation: H1.** Minimal test-file churn (one change in `run.js` to await an init; `_harness.js` changes internally; the test files' `const { BP } = require("./_harness")` line can stay as-is if we make the facade lazy). If it gets awkward in practice, we escalate to H2 as a follow-up commit.

**Follow-up ticket filed at merge time.** The moment `_harness.js` starts
feeling gross — dynamic-import boilerplate leaking into test files, async
init races, fake `BP` facade diverging from real scheduler exports — open
"Harness H2 migration" in Jira. Don't let "temporary" turn permanent by
accident. This is a scheduled follow-up, not a maybe.

### `package.json` scope

The harness flip creates a forcing function to add a minimal
`package.json` at the repo root. Four (five) fields, no dependencies, no
lockfile, no `scripts`:

```json
{
  "name": "bobcat-plus",
  "description": "Bobcat Plus Chrome extension",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=18" }
}
```

**Why each field.**

- `type: "commonjs"` — documents H1's contract. Dynamic `import()` from CJS
has predictable resolver behavior, and future `.mjs` additions are
unambiguous.
- `engines.node` — pins the silent `fetch`/`import()` assumption. Running
on Node 16 becomes a hard error instead of a mystery.
- `private: true` — zero chance of accidental publish.
- `name`/`description` — `cat package.json` reads like prose.

**Explicitly out of scope for this refactor:** `scripts`, `dependencies`,
`devDependencies`, `prettier`/`eslint` config, lockfile. File a separate
PR if anyone wants `npm run test`. Lands in C7 (docs pass).

---

## Invariants that must not regress

From `[docs/invariants.md](../invariants.md)`, plus cross-context invariants introduced by the split itself:


| #   | Invariant                                                     | Enforcement                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Affinity cache wipe at start of `handleUserTurn`              | Remains the **first statement** after the `actions = []` init in `scheduler/index.js`. `tests/unit/affinityCache.test.js` pins behavior — must stay green.                                                                                                                         |
| 5   | Tiered Jaccard dedup (≤ 0.7 / < 1.0 / fallback) in `pickTop3` | Moves to `scheduler/solver/rank.js`. `tests/unit/ranker.test.js` pins — must stay green.                                                                                                                                                                                           |
| 6   | `validateSchedule` is defense-in-depth, not the primary gate  | Moves to `scheduler/validate.js` with a module-header comment linking to invariant #6. `tests/unit/validator.test.js` pins — must stay green.                                                                                                                                      |
| 7   | `addToWorkingSchedule` replaces-by-CRN AND transfers lock     | Lives in `tab/schedule.js`; unchanged. Refactor does not touch tab/schedule.js.                                                                                                                                                                                                    |
| —   | RAG seam (`ragChunks[]` on every LLM entry point)             | Every `scheduler/llm/*` function signature keeps `ragChunks = []` as a named parameter even though v1 is empty. Verified by a new test case in `scheduler/llm/llmSignatures.test.js` (trivial `toString().includes("ragChunks")` check).                                           |
| —   | Intent prompt + schema + calibrator ship in one diff          | Enforced by file boundary: all three live in `scheduler/llm/intent.js`. Module-header comment asserts the rule so future AI sessions don't split it.                                                                                                                               |
| —   | Back-compat `window.*` globals removed cleanly                | `grep -r "window\.BP|window\.handleUserTurn|window\.buildStudentProfile|window\.mergeCalendarBlocks|window\.clearAffinityCache" extension/` returns zero after the refactor lands. Verified manually on the final commit + added as an assertion in `tests/unit/_harness.js` init. |


---

## Deviations from `refactor-on-main-split`

The bg/tab refactor established two deviations from its own prior blueprint. Both still apply here:

1. **Deviation A (split large modules if > ~400 lines).** Applies to `scheduler/solver/*` (solver.js ~250 lines, constraints.js ~200 lines, rank.js ~230 lines) — already split three ways up front, so the threshold never triggers. `scheduler/index.js` is ~275 lines; acceptable.
2. **Deviation B (prefer direct imports over callback injection).** Applies: `tab/ai.js` imports `handleUserTurn` directly from `scheduler/index.js` rather than receiving it through a `setHandleUserTurn(...)` wiring call. Zero injection ceremony.

One new deviation specific to this refactor:

1. **Deviation S (no back-compat `window.BP`).** The bg refactor kept `self.BPReq` and `self.BPPerf` as side-effect globals (D20) because `requirements/*` and `performance/*` are cross-environment and truly consumed from both SW and Node. `scheduler/*` is **only** consumed from (a) the tab runtime and (b) Node tests — both of which have clean import access. Therefore we **delete** the `window.BP` surface entirely rather than keeping it as a back-compat alias. If that turns out to break a consumer we missed, the fix is to add the missing import, not to revive the global.

---

## Postmortem-in-advance

*Per P2 gate #1 — record the top two failure modes + mitigations before shipping.*

### Failure mode 1 — "ESM flip breaks a live consumer we missed"

**What this looks like six months out:** a session reports that locking a course via the AI chat no longer works; root cause turns out to be `tab/ai.js` still reading `window.BP.someHelper` that was silently removed in the refactor. The regression slips past unit tests because the tests directly `import` from the scheduler, not via `window.BP`.

**Mitigation.**

1. **Grep audit before the ESM-flip commit:** `rg "window\.BP\.|window\.handleUserTurn|window\.buildStudentProfile|window\.mergeCalendarBlocks|window\.clearAffinityCache|\bBP\." extension/` must enumerate to exactly the four known sites (`tab/ai.js` ×3, `tab/overview.js` ×1, `tab/calendar.js` ×1). Any unexpected match blocks the commit.
2. **Manifest + docs preflight:** `rg scheduleGenerator extension/manifest.json` must return zero (Chrome rejects an MV3 manifest whose `web_accessible_resources` or `content_scripts` reference a non-existent file). `rg scheduleGenerator docs/` output becomes the C7 doc-update worklist — anything that names the old file path by string literal has to move to `scheduler/` paths.
3. **Final-commit assertion in the harness:** after scheduler ESM-flip lands, `_harness.js` init runs the same grep and throws if it finds a stray reference.
4. **Chrome smoke must include AI chat** — specifically: lock a course, send "I want mornings off," verify the response applies and the calendar updates. Also load-unpacked in `chrome://extensions` and confirm zero manifest errors. These are the use-cases most at risk.

### Failure mode 2 — "Prompt/schema drift because the intent file got split later"

**What this looks like six months out:** someone "refactors" `scheduler/llm/intent.js` further, moving `calibrateIntentWeights` into its own file to keep each module small. Later, someone else ships a prompt-wording change in `buildIntentPrompt` without updating the calibrator's hedge/hard phrase-match regex. Hedged weights silently stop calibrating. Students' schedules drift toward whatever the prior cached affinity was.

**Mitigation.**

1. **Module-header comment on `scheduler/llm/intent.js`** explicitly asserts: "`buildIntentPrompt` + `INTENT_SCHEMA_VERSION` + `calibrateIntentWeights` + `callIntent` MUST live in this file. Splitting them is a decision, not a cleanup." Include a one-line rationale ("prompt phrasing and calibrator regexes are tuned together").
2. `**tests/unit/calibrator.test.js` continues to run full-pipeline calibrator cases** against the real `buildIntentPrompt` output (it already does — keep it that way).
3. If a future session proposes splitting the file, an RFC delta to this plan (or its eventual postmortem) is required first.

---

## Commit chain

Planned **7-commit sequence** (narrative preserved for load-bearing cuts, mechanics bundled where bundling is harmless). Each commit: `node tests/unit/run.js` green before commit; Chrome smoke after C2, C5, C6, and C7. Jira subtask key in every commit message.

**Model routing** (per CLAUDE.md *Session hygiene* + `docs/process.md` P3). The default is **Auto** (cheap — Sonnet / Composer 2 / GPT-4o-mini tier). **Premium** (Opus / GPT-5 tier) is reserved for prompt work, first-time architectural decisions, and the two genuinely risky commits. **New chat boundaries** fall on premium-turn edges so expensive context isn't re-ingested across cheap commits.


| #   | Type             | Model                                               | New chat?                                                                                 | Commit summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Gate                                                                                                                                                                                                                                                                |
| --- | ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0  | plan             | **Auto**                                            | — (this chat)                                                                             | Commit this doc (`docs/plans/scheduler-refactor.md`) + related HANDOFF/open-bugs housekeeping (stale `refactor-on-main` action removed, Jira epic URLs pasted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Human review approval (done).                                                                                                                                                                                                                                       |
| C1  | **test (alone)** | **Auto**                                            | **Yes** (fresh chat boots C1→C3 in one session)                                           | Pin RAG-seam signature check: add `tests/unit/llmSignatures.test.js` asserting `callIntent`, `callAffinity`, `callRationales`, `callAdvisor` all accept `ragChunks`. **Runs against the current monolith** (`BP.`*) so an invariant violation surfaces *before* any extraction. Kept standalone so the pin isn't entangled with any extraction — `git log --grep=test` filters cleanly, and a future revert of extractions doesn't blow away the invariant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `node tests/unit/run.js` green.                                                                                                                                                                                                                                     |
| C2  | refactor         | **Auto**                                            | — (same chat as C1)                                                                       | **Pure-leaves bundle** — extract `scheduler/time.js`, `scheduler/trace.js`, `scheduler/profile.js`, `scheduler/validate.js`, `scheduler/metrics.js`. Five modules, zero coupling to each other, all test-covered. `scheduleGenerator.js` becomes a pass-through: it imports the new modules and re-exports via the existing `Object.assign(BP, {...})` block, so `window.BP` surface is unchanged. Harness still works via `eval()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tests green; **Chrome smoke** (auth → term → eligible → AI → lock/save).                                                                                                                                                                                            |
| C3  | refactor         | **Auto**                                            | — (same chat as C1+C2, budget permitting)                                                 | **Solver bundle** — extract `scheduler/solver/solver.js`, `scheduler/solver/rank.js`, `scheduler/solver/constraints.js`. Same pass-through pattern. `WEIGHT_VECTORS` moves with `rank.js`; invariant #5 (tiered Jaccard) gets a module-header comment. Three modules together because they call each other — splitting them across commits would break tests mid-chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tests green.                                                                                                                                                                                                                                                        |
| C4  | refactor         | **Premium**                                         | **Yes** (prompt work — fresh context, can reason about coupling rule carefully)           | **LLM infra + intent** — extract `scheduler/llm/openai.js` and `scheduler/llm/intent.js`. `intent.js` depends on `openai.js`, so they ship together. **Commit body MUST explicitly assert the coupling rule:** `buildIntentPrompt` + `INTENT_SCHEMA_VERSION` + `calibrateIntentWeights` + `callIntent` all live in `intent.js` and change in one diff. Prompt strings are copied **byte-for-byte** from the monolith — no wording changes. *Optional belt-and-suspenders:* if trivial, add a SHA-256 assertion over the concatenated prompt strings comparing old vs new file; if non-trivial, rely on `git log -p -S "buildIntentPrompt"` review at merge time and don't block.                                                                                                                                                                                                                                                                                                                                                                                          | Tests green; optional `OPENAI_API_KEY=… node tests/intent-fixture.js` spot-check.                                                                                                                                                                                   |
| C5  | refactor         | **Auto** (Premium only if escape hatch below fires) | **Yes** (keeps C4's prompt-session context from leaking into the orchestrator extraction) | **LLM stages + orchestrator** — extract `scheduler/llm/affinity.js`, `scheduler/llm/rationale.js`, `scheduler/llm/advisor.js`, `scheduler/actions.js`, `scheduler/fixture.js`, `scheduler/index.js` (with `handleUserTurn`). Six modules together because `handleUserTurn` in `index.js` is the only meaningful consumer of the other five, and `index.js`'s `affinityCache.clear()` call references the module-local cache now in `affinity.js` — splitting them would create a dead-reference window. Prompt strings again byte-for-byte copied; commit body reasserts. **After C5, `extension/scheduleGenerator.js` is a ~30-line shim** that imports every new module and re-attaches to `window.BP` via `Object.assign`. The shim is **load-bearing until C6**: it's what keeps `_harness.js`'s `eval()` path producing a populated `BP`, and what keeps `tab/ai.js` + `tab/overview.js` + `tab/calendar.js` working via `window.BP` during the extraction window.                                                                                                   | Tests green; **Chrome smoke**.                                                                                                                                                                                                                                      |
|     | —                | —                                                   | —                                                                                         | **Escape hatch for C5.** If during execution `scheduler/index.js` turns out non-mechanical — surprise coupling, conditional branches that don't map cleanly, `handleUserTurn` refactor creep — split `index.js` into its own **C5b** commit atomically. **Bump to Premium** for C5b only; the orchestrator is load-bearing and non-mechanical splits need the careful-reasoning model. Document the split in the eventual postmortem. Don't force the orchestrator to extract cleanly if it isn't clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                   |
| C6  | refactor         | **Premium**                                         | **Yes** (risky, multi-file, architectural — expensive context deserves its own chat)      | **ESM flip — atomic, the risky commit.** (a) Remove `<script src="scheduleGenerator.js">` from `extension/tab.html`; update the L254–258 comment to drop `handleUserTurn/buildStudentProfile/mergeCalendarBlocks/clearAffinityCache` from the `window.`* list. (b) `tab/ai.js`, `tab/overview.js`, `tab/calendar.js`: replace all `window.*` reads with named imports from `../scheduler/`. (c) Migrate `tests/unit/_harness.js` to **H1** — dynamic `import()` of `extension/scheduler/index.js` + the other surface-providing modules, assembled into a lazy `BP` facade; `run.js` awaits init once. (d) Delete `extension/scheduleGenerator.js` entirely and its back-compat `window.`* assignments. **Gates:** `rg "window\.BP|window\.handleUserTurn|window\.buildStudentProfile|window\.mergeCalendarBlocks|window\.clearAffinityCache|\bBP\." extension/` returns zero; `rg scheduleGenerator extension/manifest.json` returns zero; `rg scheduleGenerator docs/` output captured as a worklist for C7. Harness throws if a stray `window.BP` reference reappears. | Tests green; **full Chrome smoke with emphasis on AI flows**: lock course, apply suggestion, accept suggestion, reject suggestion, schedule, adjust-schedule, advise, chat. Manifest-validator check (load unpacked in Chrome, no errors in `chrome://extensions`). |
| C7  | docs             | **Auto**                                            | **Yes** (small doc-only context, don't pay Premium for crosswalks)                        | **Docs + `package.json`.** Consume C6's grep worklist. Update `docs/file-map.md` (new `extension/scheduler/` section; `scheduleGenerator.js` row removed), `docs/architecture.md` (v3 pipeline references `scheduler/llm/`* + `scheduler/solver/*`), `docs/invariants.md` high-risk-areas table (file paths change; invariants #4/#5/#6 now point into `scheduler/`), `CLAUDE.md` router (any link that pointed at `scheduleGenerator.js` now points at `scheduler/index.js`), `HANDOFF.md` (next-action updated). Add minimal `package.json` per "`package.json` scope" above. `docs/decisions.md` gets **D25** noting the ESM flip + `window.BP` removal + `package.json` add. This plan file moves to `docs/postmortems/scheduler-refactor.md` with SHAs filled in; `docs/plans/scheduler-refactor.md` is deleted.                                                                                                                                                                                                                                                     | Tests green; doc review.                                                                                                                                                                                                                                            |


**Budget envelope.** **5 Auto commits (C0, C1, C2, C3, C5, C7) + 2 Premium commits (C4, C6).** C5b Premium only if the escape hatch triggers. The intuition: prompt work and the ESM flip are the only cuts where Premium reasoning pays for itself; everything else is pattern-following extraction that an Auto model with the plan doc in context executes reliably. **New-chat boundaries at C1, C4, C5, C6, C7** — five chats total, each scoped to ≤ 10 file reads so the CLAUDE.md new-chat triggers don't fire mid-session. Total budget estimate: ~5 Auto + 2 Premium = roughly 1/3 the dollar cost of doing the whole thing on Premium.

**Guardrail.** If a C2/C3/C5/C7 session is on Auto and keeps making obvious mistakes (re-reading the same file, breaking tests in the same way twice, contradicting the plan doc), **stop and escalate to Premium for that commit.** Auto-for-mechanical-work is the default, not a mandate — if the mechanical assumption turns out wrong, the Premium cost is cheaper than three failed Auto cycles.

**Rollback.** `git revert` the merge commit. Because C2–C5 preserve `window.BP` via pass-throughs and the C5 back-compat shim, any extraction commit can be reverted individually **before C6**. C6 itself deletes the shim — revert-in-isolation is non-trivial. If C6 fails live, revert C6 **and** C7 together (C7's `package.json` + doc changes are downstream of C6).

---

## Manual smoke protocol

**When.** After C2 (pure leaves), C5 (orchestrator in place, monolith is shim), C6 (ESM flip — the full 12-step version below), and C7 (docs + `package.json`). Subset smokes between are discretionary. Follows the `[refactor-on-main-split.md](../postmortems/refactor-on-main-split.md)` protocol, adjusted for this scope. All of these from a clean extension reload on `main`, signed into TXST:

1. **Auth → term select.** Load full tab; term select populates; auth succeeds (SAML popup if cold).
2. **Eligible list.** Switch to a term with a real audit (CS BS / English-CW); eligible list fills in < 5s; count ≥ 50 courses (also closes Bug 4 live-verify for this audit).
3. **Add + remove a calendar block.** Via `#addBlockBtn` modal. Block renders; removal clears it.
4. **Lock a course from eligible list.** `tab/schedule.js addToWorkingSchedule` path; lock icon + CRN preserved.
5. **AI chat — schedule.** "I want mornings off" → `handleUserTurn` runs full pipeline → 3 schedule cards → rationales render → apply one → calendar updates.
6. **AI chat — adjust_schedule.** "Actually, keep Fridays light" → calibrator picks up the hedge → schedules adjust.
7. **AI chat — lock_course / unlock_course.** Verify CRN-validation path via `_validateCrns`.
8. **AI chat — accept_suggestion / reject_suggestion.** Verify early-return branches.
9. **AI chat — advise / chat.** `callAdvisor` path; response shown, no schedule work.
10. **Term switch mid-analysis.** Switch terms while eligible list is loading. `bail()` fires; no stale UI. (Invariant #2.)
11. **Save to TXST.** Save the locked schedule via Banner Plan CRUD.
12. **Hard reload + verify persistence.** Saved plan reloads; locks preserved.

---

## Deferred / non-goals

1. **Classic-script cleanup for `courseColors.js` + `facultyScraper.js`.** Both install `window.`* globals. Out of scope. Open a follow-up plan if we want to finish the tab-ESM story.
2. **Prompt or schema changes.** IntentSchema v1 is frozen per the file header; this refactor does not touch it.
3. **Solver algorithm changes.** Preserved verbatim. Phase 1.5 / 2 / 2.5 work on top of this refactor, not inside it.
4. **Metrics baselines.** No new metrics — `computeHonoredRate` etc. move with identical signatures. Phase 2 is where baselines grow.
5. `**runFixture` API changes.** Signature preserved for `tests/intent-fixture.js`.
6. **Test framework swap.** Still plain Node, still no Jest. `_harness.js` stays the entry point; only its internals change.

---

## Links

- `[docs/architecture.md](../architecture.md)` — v3 pipeline diagram this refactor mirrors
- `[docs/invariants.md](../invariants.md)` — invariants #4–#7
- `[docs/postmortems/refactor-on-main-split.md](../postmortems/refactor-on-main-split.md)` — blueprint shape + Deviations A/B
- `[docs/decisions.md](../decisions.md)` — D9 (many-to-many UX enabled by this layout), D20 (single-source load discipline)
- `[docs/process.md](../process.md)` — P1 plan-doc workflow, P2 postmortem-in-advance gate, P3 model routing
- `extension/scheduleGenerator.js` — the file being split
- `extension/tab.html` — load-order comment at L254–258
- `tests/unit/_harness.js` — harness that currently `eval`s the file

---

## Resolutions

All five original open questions resolved in the GSE + AIE + UXE review meeting. Kept here as the audit trail.


| #   | Question                                                      | Resolution                                                                                                                                                                                                                                                                        | Reason                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Folder: `extension/scheduler/` vs `extension/tab/scheduler/`? | `extension/scheduler/`                                                                                                                                                                                                                                                            | `metrics.js`, `solver/`*, `validate.js` are pure and already loaded in Node tests via `_harness.js`. Nesting under `tab/` creates a "why is a pure module here?" question the next AI session wastes a turn on. Matches the `extension/requirements/` + `extension/performance/` precedent.  |
| 2   | Commit 10 atomic or split 10a/10b?                            | Atomic (now C6).                                                                                                                                                                                                                                                                  | Splitting creates a mid-state where `extension/scheduleGenerator.js` and `extension/scheduler/index.js` coexist; someone cloning mid-chain imports from the wrong path and learns the wrong habit. Atomic closes that window.                                                                |
| 3   | Harness migration H1 vs H2?                                   | H1 (dynamic `import()` in CJS harness).                                                                                                                                                                                                                                           | H2 (full ESM test suite) would touch ~10 test files in what's supposed to be pure code motion. H1 isolates the ESM boundary to `_harness.js`. **Follow-up ticket "Harness H2 migration" filed on Jira at merge time** — don't let H1's "temporary" become permanent.                         |
| 4   | Add `package.json`?                                           | Yes, minimal (5 fields, no `scripts`). Lands in C7.                                                                                                                                                                                                                               | Explicit `type: "commonjs"` documents H1's resolver contract; `engines.node` pins a silent Node ≥ 18 assumption; `private: true` prevents accidental publish. Zero dependencies, zero lockfile. Adding `scripts` etc. is scope creep → separate future PR. See "`package.json` scope" above. |
| 5   | Missing `window.BP` consumers?                                | None known — four sites confirmed (`tab/ai.js` ×3, `tab/overview.js` ×1, `tab/calendar.js` ×1) + `_harness.js`. C6 gates the answer with `rg` over `extension/` **and** `extension/manifest.json` **and** `docs/` — any unexpected hit blocks the commit and feeds C7's worklist. | Enforced by tooling, not hope.                                                                                                                                                                                                                                                               |


### Design items raised in review and incorporated

- **Prompt byte-preservation.** Refactor changes zero prompt strings. C4 and C5 commit bodies both assert this. Optional SHA-256 hash assertion over concatenated prompt strings in C4 if trivial; `git log -p -S "buildIntentPrompt"` at merge time otherwise.
- **C5 escape hatch.** If `scheduler/index.js` (the `handleUserTurn` orchestrator) turns out non-mechanical during extraction, split it out as atomic C5b. Documented in the commit chain row.
- **Shim-as-bridge.** The ~30-line `scheduleGenerator.js` shim after C5 is explicitly load-bearing for `_harness.js`'s `eval()` path and `tab/`*'s `window.BP` reads. C6 deletes it; nothing between C5 and C6 should. Called out in the C5 row.
- **Preflight greps.** `rg scheduleGenerator extension/manifest.json` and `rg scheduleGenerator docs/` added as C6 gates; the docs grep's output is C7's doc-update worklist.

---

## Next steps

1. **Do now (Aidan):** sign off (or request changes) on this revised plan. On sign-off, this agent: (a) creates Jira epic "Scheduler refactor" with **7 subtasks C1–C7** + a parallel "Harness H2 migration" follow-up ticket; (b) creates "Phase 1.5 — graph-native solver" and "Bug 4 live-verify" epics and pastes all three URLs into `docs/open-bugs.md` + `HANDOFF.md`; (c) updates `HANDOFF.md` to drop the stale "merge `refactor-on-main`" action (already merged as PR #8); (d) commits this plan + the housekeeping edits on `main`; (e) creates branch `scheduler-refactor`; then hands off so Aidan opens a fresh chat to start C1.
2. **Next chat opener (C1→C3 session, Auto):** `cd /Users/aidanvickers/Desktop/BobcatPlus && git checkout scheduler-refactor && node tests/unit/run.js`. Read `CLAUDE.md` + `docs/plans/scheduler-refactor.md` + `docs/postmortems/refactor-on-main-split.md`. Execute C1 → smoke → C2 → smoke → C3 in one Auto session. Stop before C4.
3. **Subsequent chats** (follow the Model / New-chat columns in the commit chain above): C4 Premium (prompt work) · C5 Auto (Premium only if escape hatch fires) · C6 Premium (ESM flip) · C7 Auto (doc crosswalks + `package.json`).
4. **Branch point:** if review finds the module map or commit chain wrong → revise plan first, re-commit C0; if review only touches wording → edit in place and proceed to Jira + branch creation.

