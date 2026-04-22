# Bobcat Plus — AI Scheduler Handoff

You are picking up the `LLM-algorithm` branch of a Chrome extension that scrapes
Texas State's Banner + DegreeWorks and lets students build a weekly schedule
with AI help. Read `CLAUDE.md` first for the broader project context. This
doc covers only the AI scheduler pipeline (`extension/scheduleGenerator.js`)
and the known problems left to solve.

> **Before you change anything, read `docs/decisions.md`.** It is the running
> ADR-lite log of every locked-in decision — what we agreed to build, what we
> rejected, and what's reversible by whom. If HANDOFF and decisions ever
> disagree, decisions.md wins and HANDOFF should be updated.

---

## Architecture (v3 hybrid)

One function — `BP.handleUserTurn({ userMessage, rawData, studentProfile, ... })`
— runs a 5-stage pipeline:

```
[ userMessage ]
      │
      ▼
┌────────────────────────┐
│ 1. Intent LLM          │  gpt-4o-mini, temp 0
│    callIntent()        │  Returns frozen IntentSchema v1:
│                        │    { intent, confidence, recap,
│                        │      newCalendarBlocks, newAvoidDays,
│                        │      removeAvoidDays, resetAvoidDays,
│                        │      statedPreferences { noEarlierThan,
│                        │        noLaterThan, targetCredits,
│                        │        careerKeywords, *Weights }, ... }
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 1b. calibrateIntent-   │  Deterministic post-processor. Scans the
│     Weights()          │  raw message for hedge ("preferably"…) or
│                        │  hard ("cannot"/"never"…) language near
│                        │  each weight field and caps at 0.7 or
│                        │  floors at 1.0. Rescues LLM miscalibration.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 2. Context recap       │  Surfaced to the student immediately
│    (UI action)         │  so misreads are caught in <1s.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 3. Affinity LLM        │  Scores each eligible course 0-1 for
│    callAffinity()      │  career-goal fit. Skipped when no career
│                        │  keywords. Cached per (eligibleHash,
│                        │  careerKeywords). Cache is WIPED at the
│                        │  top of each turn to prevent cross-turn
│                        │  bias — see handleUserTurn().
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 4. CSP solver          │  solveMulti() runs 4 orderings (MRV,
│    (deterministic)     │  reverse-MRV, 2 seeded shuffles) and
│                        │  pools dedup'd results. Hard constraints
│                        │  (calendarBlocks, hardAvoidDays, creditCap,
│                        │  lab pairing) NEVER violated. Max 2000
│                        │  results / 200k nodes — see SOLVER_*_CAP.
│                        │
│    solveWithRelaxation │  If 0 results, relax softly in order:
│                        │    1. morning cutoff  (if weight < 1.0)
│                        │    2. late cutoff     (if weight < 1.0)
│                        │    3. soft avoid days
│                        │    4. credit band widening
│                        │    5. online preference
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 5. Ranking             │  scoreSchedule() emits metrics for each
│    pickTop3()          │  feasible schedule; applyVector() combines
│                        │  them via 3 different weight vectors
│                        │  (affinity / online / balanced).
│                        │  Top-3 uses tiered Jaccard dedup on
│                        │  course sets — identical coursesets are
│                        │  rejected even across orderings.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 6. Rationale LLM       │  callRationales() — grounded 2-sentence
│                        │  explanation per schedule, passed ONLY
│                        │  structured facts (no invention).
└──────────┬─────────────┘
           │
           ▼
     [ actions[] → tab.js ]
```

### Why this shape

- **LLM for understanding, deterministic for constraints.** The LLM is
  good at parsing ambiguous English but bad at respecting hard rules. The
  CSP solver guarantees no time conflicts and no violated hard constraints.
- **Frozen schema, post-processing for calibration.** The intent schema
  version is pinned (`INTENT_SCHEMA_VERSION`). When the LLM miscalibrates a
  weight ("preferably" → 0.9), the deterministic calibrator corrects it in
  code — no prompt-engineering battles.
- **Defense in depth.** After the solver runs, `validateSchedule()` checks
  every top schedule against calendarBlocks and course conflicts. Should
  never fire, but catches data-quality bugs (sections with bad meeting data).

### File boundaries

| File | Role |
|---|---|
| `extension/scheduleGenerator.js` | The whole AI pipeline, plain script, attaches to `window.BP`. No ESM. |
| `extension/tab.js` | UI. Consumes `handleUserTurn`, processes the actions[] array. |
| `extension/tab.html` / `tab.css` | Shell + styles. |
| `extension/background.js` | Scrapes Banner + DegreeWorks. **Don't touch** unless fixing scrape bugs. |
| `extension/requirements/graph.js` | Phase-1 RequirementGraph primitives — node kinds, factories, traversal, invariants. Pure data, no DegreeWorks knowledge. |
| `extension/requirements/txstFromAudit.js` | Phase-1 TXST adapter. Turns raw DegreeWorks audit JSON into a `RequirementGraph` + a `deriveEligible()` compat view that mimics the legacy `needed[]` shape. Wired into `background.js` behind `bp_phase1_wiring` as of 2026-04-21. |
| `extension/requirements/wildcardExpansion.js` | Pure normalizer + cache-key helpers for DW `courseInformation` responses. Fed by the yet-to-be-wired Layer-B HTTP fetcher (see D13). Tested against `tests/fixtures/wildcard/cs-4@.json`. |
| `scripts/generate-phase1-baseline.js` | Regenerates `docs/baselines/phase1-*.json` from the fixture audits. Run before flipping `bp_phase1_wiring` on for real users; the snapshot is the regression baseline every later phase must not beat. |
| `tests/intent-fixture.js` | Node runner. Property-test assertions (not exact match) against 11 canonical student prompts. Needs the LLM. `OPENAI_API_KEY=... node tests/intent-fixture.js`. |
| `tests/unit/*.test.js` | Deterministic unit tests (no OpenAI). Cover `solve`, `scoreSchedule`, `applyVector`, `pickTop3`, `rankSchedules`, the Phase-0 metric helpers, and the Phase-1 audit adapter. Run with `node tests/unit/run.js`. |
| `tests/fixtures/audits/` | Real TXST audit JSONs (English BA, CS BS + Music minor). Replay material for the adapter tests. |
| `tests/fixtures/banner/` | Subject-wide Banner dumps (CS, MATH, Music, English) for downstream integration tests. |
| `tests/fixtures/wildcard/` | DegreeWorks `courseInformation` expansion for `CS 4@`. Evidence the `courseInformation` endpoint is the right wildcard resolver, not Banner subject search. |
| `docs/METRICS.md` | Exact formulas for the four Phase-0 scheduler metrics. The acceptance gate for every later phase is written here. |
| `docs/requirement-graph-rfc.md` | Phase-1 RFC for the `RequirementGraph` node types + DW mapping. Updated 2026-04-21 with the `numberOfGroups`/`numberOfRules` resolution and the many-to-many product decision. |
| `docs/bug4-eligible-diagnosis.md` | Layered fix plan for Bug 4 (missing eligible courses). Updated 2026-04-21 — wildcard expansion now ships via DegreeWorks `courseInformation`, not Banner subject search. |
| `docs/bug1-morning-preference-diagnosis.md` | Bug 1 trace analysis + two-layer solver fix plan (2026-04-21 PM). Read this before implementing `bp_phase2_solver_prefordering` / `bp_phase2_solver_hardfloor`. |
| `docs/decisions.md` | **Running ADR-lite log.** Every locked-in decision (architecture, product, process, phase ordering) lives here with a date and a "reversible by" clause. If you're unsure what we agreed on, read this first. |
| `docs/advising-flow.md` | Product + reality-check doc for the pre-advising conversational flow and the advisor-facing brief (Phases 4a/4b/5). Captures the 5-question draft and which advisor capabilities are realistic at which phase. |

---

## Known problems (in rough priority)

### 1. Schedule variety is still homogeneous

**Symptom:** When a student gives no preferences and says "build me a schedule",
all three returned schedules look nearly identical — same CS core, differing
only in one elective and lab section. User wants each of the three to be an
*archetype*:
- Schedule A: evenly spread across 5 days
- Schedule B: compressed into Tue/Thu
- Schedule C: all-mornings or all-afternoons

**Root cause:** The three weight vectors (affinity / online / balanced)
converge when the student is silent. With no career keywords, `affinityNorm`
is 0.5 uniformly. With no online preference, `onlineRatio` barely moves.
Only `balance` meaningfully differentiates — and balance rewards spread, so
all three schedules trend toward MWF+TR mixes.

**Suggested fix:** Replace the current 3 weight vectors with 3 *archetype
scorers* that actively penalize schedules that don't match their shape:

```js
const ARCHETYPES = {
  spread:     { daysUsedBonus: 1.0,  compactnessPenalty: 0 },
  compact:    { daysUsedBonus: -1.0, compactnessPenalty: 0 },  // prefers ≤2 days
  allMorning: { afternoonPenalty: 1.0 },
  allAfternoon: { morningPenalty: 1.0 },
};
```

Pick any 3 archetypes that look meaningfully different given the eligible
pool (e.g., skip `compact` if only 1 Tue/Thu schedule is feasible). Fallback
is the current vectors.

### 2. `noLaterThan` was not enforced — partially fixed in 8e49fa8

**Symptom:** "Done by 5pm every day" got ignored; schedule included a 5-6:20pm
class. Root cause: the intent schema had `noLaterThan` but no scorer /
solver code consulted it. A late-cutoff penalty is now wired into
`scoreSchedule` / `applyVector`, a relaxation step for it, honored/unhonored
rendering, and a calibrator entry for "done by"/"finish by"/"out by"
language.

**Still to verify:** the intent LLM reliably extracts the time from "done by
5pm" into `noLaterThan: "1700"`. If you find it misses, tighten the prompt
example in `buildIntentPrompt()`.

### 3. Section-level preference handling — diagnosed 2026-04-21 PM

**Status.** Trace captured from real "no classes before noon, no classes
Friday" run on the CS BS audit. **Root cause confirmed: solver
enumeration bias, not a scorer gap.** The scorer is already penalizing
correctly (`morningPen: 0.375` across every top-20 schedule), but
`solveMulti` exhausts its 2000-schedule cap along a branch that commits
to CS 4371 CRN 12118 (9:30 AM) before ever attempting CRN for the 12:30 PM
section. The 12:30 PM schedule would rank #1 on every archetype if it
made it into the pool — it never does.

See `docs/bug1-morning-preference-diagnosis.md` and `docs/decisions.md`
D14 for the full trace analysis.

**Two-layer fix (deferred to Phase-2 precursor ticket, both flags gated):**

1. **`bp_phase2_solver_prefordering`** — 5th ordering in `solveMulti` that
   sorts each course's sections ascending by preference-distance. The
   first schedules the solver generates honor the prefs, so even at the
   2000 cap the ranker sees them.
2. **`bp_phase2_solver_hardfloor`** — when `calibrateIntentWeights` floors
   a soft weight at 1.0 ("no", "cannot", "never"), promote the
   corresponding pref to a solver hard constraint. Prunes instead of
   grows the search space. Closes Bug 1 and Bug 3 together and unblocks
   the `expectedToFail` `preferInPerson` scoring test.

**Separate concern (also in the diagnosis doc):** when `morningCutoffWeight
> 0` but `noEarlierThan` is null (fuzzy "don't like early mornings"
without a specific cutoff), apply a soft monotonic penalty by start time.
Small scorer tweak, same PR as Fix 1.

### 4. `removeAvoidDays` / `resetAvoidDays` reliability

**Symptom:** Intent LLM sometimes fails to emit `resetAvoidDays: true` when
the student's next message implies it ("now make me one that just has no
classes on Friday" after a prior "only Tue/Thu"). Schema and orchestrator
support this; the LLM just doesn't always recognize the reset cue.

**Suggested fix:** Either tighten the prompt examples (cheap, try first) or
add a deterministic detector: if the user's message contains "just" / "now"
/ "actually" / "instead" AND introduces a new day preference, force
`resetAvoidDays: true` even if the LLM said false.

### 5. Affinity over-generalization

**Symptom:** Student says "I need a science course" → intent LLM expands
career to include biology, student gets BIO ★0.90 badges even though they
expressed no biology interest. Career cache is already wiped per-turn (see
handleUserTurn), but the expansion within a single turn is too aggressive.

**Suggested fix:** Tighten the `CAREER KEYWORD EXPANSION` section in
`buildIntentPrompt()` to require *explicit* career language ("want to work
in", "career in", "interested in") before expanding. Generic requirement
talk ("need a science course") should leave `careerKeywords: []`.

### 6. Advisor summary feature (requested, never built)

The user asked for a feature that extracts insights from conversation
history + final schedule and produces a structured markdown block for an
advising session. **2026-04-21: upgraded in scope** — this is now Phases
4a (pre-advising flow) + 4b (advisor brief synthesis) + 5 (multi-semester
planner). See `docs/advising-flow.md` for the product spec and reality
check. Original MVP sketch (one gpt-4o call, strict JSON in + markdown
out) is still valid as the Phase 4b baseline; 4a and 5 add substantial
new data collection and deterministic computation layers on top.

### Bug 5 — Conflict detector ignores the `online` flag (2026-04-21, ✅ fixed)

**Status.** Fixed 2026-04-21. `detectWorkingConflict()` now delegates to
the shared `BP.findOverlapPair()` helper in `scheduleGenerator.js`, which
authoritatively skips `online: true` entries regardless of populated
meeting fields. 10 regression tests land in
`tests/unit/overlap.test.js`. Full suite: 64 passed · 0 failed · 1
known-failure (Phase 2 preferInPerson). The data-normalization
sustainable fix (zero out `days`/`beginTime`/`endTime` at ingestion
when `online: true`) is deferred to Phase 1 wiring, per D11.

**Symptom.** Screenshot: schedule contains MATH 3305 (MW 3:20–4:50 PM) and
CS 4371 (CRN 35071, `Online - Computer System Security`). The status bar
fires `⚠ MATH 3305 overlaps with CS 4371 on Wed`. CS 4371 is labeled
online in the schedule summary *and* appears in the bottom "online /
asynchronous" bar — yet the conflict detector still flags it.

**Root cause — located.** Two parts:

1. Banner returns meeting-time data (`days`, `beginTime`, `endTime`) for
   sections whose `instructionalMethod === "INT"`. The ingest code in
   `tab.js` (around lines 1658 and 1801) sets `online: true` on the
   course object but keeps the meeting-time fields populated. Result:
   data inconsistency — the course is logically online but has times.
2. `detectWorkingConflict()` in `tab.js` (line 2652) only short-circuits
   when `days` is empty or `beginTime/endTime` is null. It does not
   check the `online` flag, so it treats those phantom times as real.

**Short fix (~3 lines).** In `detectWorkingConflict`, skip entries whose
`online` flag is set:

```js
for (let i = 0; i < workingCourses.length; i++) {
  const a = workingCourses[i];
  if (a.online) continue;                // ← add
  ...
  for (let j = i + 1; j < workingCourses.length; j++) {
    const b = workingCourses[j];
    if (b.online) continue;              // ← add
    ...
  }
}
```

**Sustainable fix (defer to Phase 1 wiring).** Normalize online sections
at ingestion: when `online: true` is set on a `workingCourses` entry,
also zero out `days`, `beginTime`, `endTime`. That way every downstream
consumer stays correct without having to remember the invariant.
Candidates to update: `tab.js:68`, `tab.js:1031` (already OK),
`tab.js:1658`, `tab.js:1801`, `tab.js:2473`.

**Defense in depth.** Also add a unit test: synthesize a `workingCourses`
with a "registered MWF 3pm" course + a "CS 4371 online, but days=[Wed]
begin/end populated" course, assert `detectWorkingConflict()` returns
null. Currently no test covers this path because the harness operates on
solver outputs, not on `workingCourses` UI state.

### Bug 6 — Import button UX + auth-expiry handling (deferred, see `docs/decisions.md` D11)

**Symptom A.** Clicking `Import` doesn't load the current schedule by
default — the student has to manually interact to see anything.

**Symptom B.** When the extension is opened after auth has expired, the
behavior is confusing: the UI shows stale data with no clear prompt to
re-authenticate.

**Desired end state.** No Import button at all. Opening the extension
kicks off a background fetch of the latest data. If auth is valid, the
current schedule loads silently within a second. If auth is invalid, the
user sees a clear "you've been signed out, re-authenticate here" banner.
This is the "everything just loads" UX.

**Why deferred.** Aidan explicitly said "probably best to focus on what
we got right now" — correct call. The scheduler bugs (1–5) affect every
interaction; the import UX is a first-use / stale-state annoyance. Fix
after Phase 2 / before Max's refactor.

**Investigation to do at that time.**
- Read `extension/background.js` login/SAML/session-expired paths; the
  recent commits in the log (`fff6e80`, `4f48968`, `832a155`) have been
  chipping at this already.
- Decide whether the "no auth" banner lives in the popup, the tab view,
  or both.
- Shared session-mutex interaction: does auto-load race with manual
  interaction? `withSessionLock` should already serialize this, but
  verify no deadlock paths when the session is dead.

### Load-bearing invariants — do not break

- **Affinity cache wipe in handleUserTurn.** Without it, career keywords
  from a prior turn silently bias the next.
- **Jaccard tiered dedup in pickTop3.** Don't simplify it back to section-
  signature-only; that regresses the "same courses, different lab" bug.
- **`validateSchedule()` is defense in depth, not the enforcer.** The
  solver is supposed to guarantee no conflicts. If `validateSchedule`
  ever fires, the solver is wrong — don't just silence it.
- **Hard vs soft constraints split.** Anything the LLM weight-ranks is
  soft; anything the user/config flagged is hard. Don't promote soft→
  hard without versioning the intent schema.

---

## Phase progress (as of 2026-04-21)

| Phase | Goal | Status |
|---|---|---|
| 0 | Instrument the pipeline — metrics, trace payloads, unit harness | ✅ done |
| 1 | RequirementGraph parser, TXST adapter, compat layer | ✅ wired 2026-04-21 behind `bp_phase1_wiring` (default OFF) + `bp_phase1_shadow` (parity logging). Live `courseInformation` fetcher split to follow-up (see D13). 76 unit tests green. |
| 1.5 | Solver consumes the graph natively (ChooseN / AllOf / exclusivity / multi-count satisfaction table) | ⬜ not started |
| 2-precursor | **Bug 1/3 solver fix.** Two gated flags: `bp_phase2_solver_prefordering` (5th pref-biased `solveMulti` ordering) + `bp_phase2_solver_hardfloor` (weight-1.0 soft → solver hard). Diagnosis complete — see `docs/bug1-morning-preference-diagnosis.md`. | ⬜ diagnosed 2026-04-21 PM, implementation ticket ready for a fresh chat |
| 2 | Scorer fidelity — fuzzy time prefs (weight>0 without `noEarlierThan`), `preferInPerson` scoring term, silent-prefs floor | ⬜ not started. Depends on the Bug 1/3 solver fix landing first so tests can assert behavior end-to-end. |
| 2.5 | **Prereq awareness within a term.** Solver refuses to propose Calc 2 if Calc 1 is not completed or in-progress. Data source: DW `courseInformation.prerequisites[]`. | ⬜ not started (new phase, see `docs/decisions.md` D8) |
| 3 | Archetype-seeded ranking (spread / compressed / time-blocked) | ⬜ not started |
| 4a | Pre-advising conversational flow (5-question, progress bar, schedule hand-off) | ⬜ not started (see `docs/advising-flow.md`) |
| 4b | Advisor brief synthesis + RAG for catalog prose (BA vs BS, policy Qs) | ⬜ not started |
| 5 | **Multi-semester path planner.** "You have N semesters; here's the term-by-term sequence; Calc 1 must start now or you can't graduate on time." Powers the advisor Q&A. Needs seasonality data (open). | ⬜ not started (new phase, see `docs/decisions.md` D8) |
| X | Bug 4 — eligible-course fix rollup (Layers A/B/C from diag doc) | 🟡 Layer A shipped (concrete `hideFromAdvice` fallbacks, wildcards + excepts recorded behind feature flag). Layer B normalizer (`normalizeCourseInformationCourses`) shipped + tested against `cs-4@.json`. Live fetcher blocked on capturing the `courseInformation` endpoint URL from DevTools — see D13. |

### Delta vs legacy `findNeeded`, measured on real fixtures

| Audit | Legacy `needed[].length` | New concrete entries | New wildcards routed for DW expansion | Notes |
|---|---:|---:|---:|---|
| English BA | 151 | 191 | 8 refs / 3 unique (`@@`, `ENG3@`, `ENG4@`) | +40 concretes (hideFromAdvice fallbacks recovered); every wildcard gets a handle instead of being silently dropped |
| CS BS + Music | 34 | 29 | 14 refs / 12 unique (`CS3@`, `CS4@`, `MUSP3@`, `PHYS@`, …) | Legacy was emitting **8 phantom "courses"** named `3@`/`4@` that nobody could register for; new parser routes them to the wildcard list. Real-course count is 26 → 29 (+3 recovered `hideFromAdvice` entries) |

### Next action (revised 2026-04-21 PM)

Each step is sized to be one chat (fresh session, reads this file + the
referenced doc, ships the change, updates decisions.md).

0. ~~**Bug 5 quick fix.**~~ ✅ Landed 2026-04-21 AM.
1. ~~**Phase 1 wiring.**~~ ✅ Landed 2026-04-21 PM. Shadow-mode parity run
   on CS BS audit matched the baseline exactly (`legacyCount: 34,
   derivedCount: 29, onlyInLegacy: 8, onlyInDerived: 3, wildcardCount:
   14`). Flipping `bp_phase1_wiring` ON is safe.
2. ~~**Bug 1 diagnosis.**~~ ✅ Landed 2026-04-21 PM. Real trace captured,
   root cause identified as solver enumeration bias (see
   `docs/bug1-morning-preference-diagnosis.md` and D14).
3. **Bug 1/3 solver fix.** Implement the two gated flags from D14.
   Specifically: (a) pref-biased ordering in `solveMulti`, (b) promote
   weight-1.0 soft prefs to solver hard constraints when user said "no".
   Also flip the `preferInPerson` `expectedToFail` test in
   `scoring.test.js` to passing once (b) ships. One fresh chat.
4. **Capture the `courseInformation` URL → Layer B.** Open DevTools on the
   DW audit page, click a wildcard (e.g. CS 4@), copy the XHR URL. Paste
   it into a new decisions-log entry, then wire
   `expandWildcardViaCourseInformation` in `background.js` behind
   `bp_phase1_wildcards`. Normalizer is already in
   `extension/requirements/wildcardExpansion.js` — only the fetch +
   1-hour cache + call site are needed. Very short chat.
5. **Bug 6 import-button UX.** Separate chat, cheap to fix (probably a
   single `runAnalysis` call on popup open + auth-expired detection).
   Fine to do with Auto mode instead of Opus/API.
6. **Phase 1.5 solver.** Start the graph-aware solver only after steps
   3–5 have landed and shadow mode has been clean on ≥3 audits.

---

## Session hygiene — model + chat-window routing (instruction to every AI session)

**Mandatory:** If any trigger below fires during your turn, say so explicitly
in your response. Do not wait for Aidan to ask. One line at the end is fine;
don't bury it. API budget is finite — Aidan has ~$20/month of included
API quota and this project has already eaten meaningful chunks of it.

### Recommend dropping to **Auto mode** (cheap models — Sonnet, GPT-4o-mini, etc.) when the task is:

- Following a pattern that's already designed (adding a test in an existing
  suite, wiring a function whose signature is already specified in a docs/
  file, git commits, small refactors).
- A UI tweak where the behavior is already decided (styling, copy changes,
  button handlers that delegate to existing logic).
- A doc-only edit.
- Implementing a bug fix whose diagnosis doc already exists in `docs/`.
- "Senior engineer already wrote the spec, you're just typing it out."

Concrete calls in the current plan that should default to Auto: **Bug 6
import-button UX fix, Layer B fetcher wiring (normalizer exists),
doc-only updates, any commit-and-push chat.**

### Stay on the **premium model (Opus / API)** when the task involves:

- Design decisions with multiple valid approaches or real trade-offs.
- Algorithm work (solver, planner, scorer math, archetype design).
- Debugging without a written diagnosis yet.
- LLM prompt engineering (intent / affinity / rationale / advisor prompts).
- Any first-time implementation of a new phase.

Concrete calls in the current plan that justify Opus: **Bug 1/3 solver fix
(only partially diagnosed — the math is clear but implementation choices
around ordering heuristics matter), Phase 1.5 graph-aware solver, Phase 2
scorer fidelity, Phase 5 multi-semester planner, Phase 4a/b advisor
design.**

### Recommend starting a **new chat window** when any of:

- This chat has had more than ~20 substantive turns OR you've read more
  than ~10 distinct files.
- You're about to switch phases or feature areas (e.g. finishing Phase 1
  wiring and moving to Bug 1/3 solver — new chat).
- A logical unit just wrapped AND HANDOFF was updated with the new state.
- Aidan asks a question that does not build on this chat's accumulated
  state.
- You notice yourself re-reading files you've already read earlier in the
  same conversation.
- Your rough self-check says this chat has probably consumed more than
  ~8% of the included API quota (very long conversations get expensive
  fast because each turn re-loads the whole transcript).

When you recommend a new chat, **give Aidan the exact opener to paste**,
with the specific HANDOFF section + diagnosis doc the next chat should
read.

**Critical — worktree path.** This AI scheduler work lives on branch
`LLM-algorithm` inside a git worktree at
`/Users/aidanvickers/Desktop/BobcatPlus/.claude/worktrees/flamboyant-hodgkin-1ae885/`.
New chats that open at the plain repo root (`/Users/aidanvickers/Desktop/BobcatPlus`)
will be on `main` and will NOT see any of the scheduler work. Every
opener you suggest must instruct the fresh session to `cd` into the
worktree first, or reference files by their full worktree-absolute path.

Example opener:

> "Good stopping point. In a new chat, paste:
> *cd `/Users/aidanvickers/Desktop/BobcatPlus/.claude/worktrees/flamboyant-hodgkin-1ae885`
> and confirm `git branch --show-current` prints `LLM-algorithm`. Then
> read `HANDOFF.md` and `docs/bug1-morning-preference-diagnosis.md`, and
> implement the Bug 1/3 solver fix behind `bp_phase2_solver_prefordering`
> + `bp_phase2_solver_hardfloor`.* That fresh session will start at ~2%
> per turn instead of whatever this one is at now."

### When NOT to switch (avoid cargo-culting this):

- Mid-implementation of something complex with a lot of live state in the
  conversation (e.g. debugging a prompt that's emitting weird JSON).
- When re-onboarding a fresh session would cost more turns than finishing
  what's in progress.
- When Aidan is in flow and a context switch would interrupt their
  thinking — lead with the work, mention the switch at the end.

### Honesty clause

If you don't know how much budget has been used, say so — don't guess.
It's better to say *"if this chat is getting long, consider a new window
after this step"* than to invent a percentage.

### Mandatory "Next steps" block on every response

**Every turn must end with a short `### Next steps` block.** Aidan should
never have to guess what to do after you finish speaking. The block must
contain, in this order:

1. **Do now (you, Aidan):** one-line concrete action in the current chat
   or in the browser / terminal — verify a fix, paste a console command,
   reload the extension, etc. Skip this bullet only if there is
   genuinely nothing for Aidan to do between turns.
2. **Next chat opener:** if the current turn ended a logical unit OR the
   chat is getting long, give the exact paste-ready opener for the new
   chat, including the `cd` into the worktree. Mark it as Auto or
   Opus/API per the routing rules above. If the current chat should
   continue instead of forking, say so explicitly: *"Stay in this chat
   for the next step."*
3. **Branch point:** if the next action depends on the outcome of
   step 1, say what the branches are. Example: *"If the console test
   works → next chat is `flip solver flag defaults to on`. If it still
   fails → next chat is `diagnose solver fix with fresh trace dump`."*

Keep the block tight. No more than ~8 lines total. This is not a report
— it is the receipt Aidan takes to the next chat.

---

## Process gates (trimmed 2026-04-21 PM for solo-dev reality; see D10 + D15)

Solo dev, one user, small surface area — three gates earn their keep, the
rest were ceremony. If you skip one, say so in the PR description.

1. **Postmortem-in-advance.** Before code starts on any phase or non-trivial
   prompt change, write a short "it is six months from now, we rolled this
   back, what happened?" in `docs/decisions.md`. Record the top two failure
   modes and their mitigations. For LLM prompt changes specifically, one of
   the bullets must answer "could this rule live in deterministic JS
   instead?" — prompts are for ambiguity, not invariants.
2. **Feature flag per phase.** Use `chrome.storage.local` keys like
   `bp_phase1_wiring`, `bp_phase2_solver_prefordering`. Rollback is a toggle,
   never a revert. No flag, no merge.
3. **Metric baseline before merge.** Snapshot the offline-measurable Phase-0
   metrics on fixture prompts into `docs/baselines/phaseN-{date}.json`. The
   next phase cannot merge if any regresses without written justification.

Cut from the original list: prompt-vs-code audit (folded into gate 1), "what
would the LLM do wrong here?" checklist (folded into gate 1), weekly log
(was decoration for a one-person project).

---

## Recent commit history (branch: LLM-algorithm)

- `8e49fa8` — Enforce noLaterThan in scorer + calibrator (this handoff)
- `88dcdce` — Positive day framing + avoid-day removal/reset
- `62722e2` — Fix day-balance scorer + Jaccard<1.0 fallback tier
- `dfe2da6` — × button on 'Kept clear' tag to remove avoid-days
- `6394f16` — Weight calibration + transparency for unhonored constraints
- `3e1ece2` — Reset career-signal cache per turn
- `876b777` — Intent-only golden fixture
- `e7148a9` — Online-courses bar below the calendar
- `a0c3037` — Silence chat noise when adding/locking a schedule
- `a4b27d7` — Friday overlay + Clear All button + badge copy
- `bea63cb` — Lab pairing + credit hour accuracy

See `git log LLM-algorithm ^main` for the full diff from `main`.
