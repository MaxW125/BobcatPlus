# Bobcat Plus — AI Scheduler Handoff

Live status for the `LLM-algorithm` branch. Read `CLAUDE.md` first for
project orientation, invariants, file map, and session-hygiene rules.
Read `docs/decisions.md` before changing anything load-bearing — if
HANDOFF and decisions disagree, **decisions wins and HANDOFF updates.**

This doc is intentionally short. It covers only:

1. AI scheduler architecture (source of truth for the diagram).
2. Open problems (one-liners pointing to diagnosis docs).
3. Phase progress + next action.
4. Recent commits.

For anything deeper, follow the links.

---

## Architecture (v3 hybrid)

One function — `BP.handleUserTurn({ userMessage, rawData, studentProfile, ... })`
— runs a 5-stage pipeline. `CLAUDE.md` § Load-bearing invariants lists
the lines you cannot remove from this.

```
[ userMessage ]
      │
      ▼
┌────────────────────────┐
│ 1. Intent LLM          │  gpt-4o-mini, temp 0
│    callIntent()        │  Returns frozen IntentSchema v1.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 1b. calibrateIntent-   │  Deterministic post-processor. Scans the raw
│     Weights()          │  message for hedge ("preferably"…) or hard
│                        │  ("cannot" / "no X" / "never"…) language near
│                        │  each weight field and caps at 0.7 or floors
│                        │  at 1.0. Rescues LLM miscalibration.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 2. Context recap       │  Surfaced to the student immediately so
│    (UI action)         │  misreads are caught in <1s.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 3. Affinity LLM        │  Scores each eligible course 0-1 for career
│    callAffinity()      │  fit. Skipped when no career keywords.
│                        │  Cached per (eligibleHash, careerKeywords);
│                        │  cache WIPED at the top of each turn to
│                        │  prevent cross-turn bias — see handleUserTurn.
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ 4. CSP solver          │  solveMulti() runs 4 orderings (pref-distance
│    (deterministic)     │  FIRST, MRV, reverse-MRV, seeded shuffle) and
│                        │  pools dedup'd results with a per-pass budget
│                        │  so no single ordering monopolizes the 2000
│                        │  result cap. Hard constraints (calendarBlocks,
│                        │  hardAvoidDays, creditCap, lab pairing,
│                        │  hardNoEarlierThan, hardNoLaterThan,
│                        │  hardDropOnline) never violated.
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
│ 5. Ranking             │  scoreSchedule() emits metrics per feasible
│    pickTop3()          │  schedule; applyVector() combines them via
│                        │  3 weight vectors (affinity / online /
│                        │  balanced). Top-3 uses tiered Jaccard dedup
│                        │  on course sets — identical coursesets are
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

- **LLM for understanding, deterministic for constraints.** The LLM
 parses ambiguous English; the CSP solver guarantees no time conflicts
and no violated hard constraints.
- **Frozen schema, post-processing for calibration.** When the LLM
 miscalibrates a weight ("preferably" → 0.9), the deterministic
calibrator corrects it in code. No prompt-engineering battles.
- **Defense in depth.** After the solver runs, `validateSchedule()`
 checks every top schedule against `calendarBlocks` and course
conflicts. Should never fire, but catches data-quality bugs.

---

## Open problems (in rough priority)


| #   | Summary                                                                                                                                                     | Details                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **Registration-restriction awareness.** Filter out courses with Banner restrictions the student doesn't satisfy (majors-only, minors-only, class-standing). | Not started. Next implementation target after the current PR merges. No diagnosis doc yet — create `docs/bug7-registration-restrictions-diagnosis.md` when work starts. |
| 4   | **Eligible-course list was missing wildcard expansions.** Bug 4 Layers A + B + C shipped. **Live verification pending.**                                    | See `docs/bug4-eligible-diagnosis.md`. Verify after the current PR by confirming the CS BS / English-CW audits surface ≥50 eligible courses.                            |
| —   | **Current schedule doesn't render on calendar on first load.** Sibling to Bug 6.                                                                            | Will file its own diagnosis when we investigate. Deferred.                                                                                                              |
| 6   | **Import-button UX + auth-expiry handling.** Deferred.                                                                                                      | `docs/bug6-import-ux-diagnosis.md`.                                                                                                                                     |
| —   | **Schedule variety is homogeneous** when student gives no preferences — all three top schedules look the same.                                              | Fix is Phase 3 archetype-seeded ranking (see phase table below). Preserved here as context for that phase.                                                              |
| —   | `**removeAvoidDays` / `resetAvoidDays` reliability.** Intent LLM sometimes misses reset cues ("now make me one that just has no classes Friday").           | Tighten prompt examples first; deterministic detector as fallback. Small Phase 2 scope.                                                                                 |
| —   | **Affinity over-generalization.** "I need a science course" should not expand career to BIO.                                                                | Tighten `CAREER KEYWORD EXPANSION` section in `buildIntentPrompt()` to require explicit career language. Small Phase 2 scope.                                           |
| —   | **Advisor summary feature.** Requested, never built.                                                                                                        | Upgraded to Phases 4a + 4b + 5. See `docs/advising-flow.md`.                                                                                                            |


Closed bugs (historical record only): `docs/bug1-morning-preference-diagnosis.md`, `docs/bug5-online-conflict-diagnosis.md`, `docs/bug8-banner-half-auth-login-popup-diagnosis.md`.

---

## Phase progress (as of 2026-04-22)


| Phase       | Goal                                                                                                                                                                                    | Status                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0           | Instrument the pipeline — metrics, trace payloads, unit harness                                                                                                                         | ✅ done                                                                                                                                                                                                            |
| 1           | RequirementGraph parser, TXST adapter, compat layer                                                                                                                                     | ✅ wired 2026-04-21; feature flags removed in D17. RequirementGraph is the authoritative `needed[]` source whenever `BPReq` loads (legacy `findNeeded` fallback only).                                             |
| 1.5         | Solver consumes the graph natively (ChooseN / AllOf / exclusivity / multi-count satisfaction table)                                                                                     | ⬜ not started                                                                                                                                                                                                     |
| 2-precursor | Bug 1/3 solver fix: `pref-distance` ordering first in `solveMulti` + per-pass budget; `DECLARATIVE_NO_PATTERN` calibrator; weight-1.0 → hard-constraint promotion in `buildConstraints` | ✅ shipped 2026-04-21 PM in `5975c90`, verified live on "no classes before noon, no classes friday". Flags removed in D17.                                                                                         |
| 2           | Scorer fidelity — fuzzy time prefs (weight > 0 without `noEarlierThan`), silent-prefs floor                                                                                             | ⬜ not started. `preferInPerson` scoring term shipped with the 2-precursor commit.                                                                                                                                 |
| 2.5         | **Prereq awareness within a term.** Solver refuses to propose Calc 2 if Calc 1 is not completed or in-progress.                                                                         | ⬜ not started. Data source: DW `courseInformation.prerequisites[]`. See D8.                                                                                                                                       |
| 3           | Archetype-seeded ranking (spread / compressed / time-blocked)                                                                                                                           | ⬜ not started                                                                                                                                                                                                     |
| 4a          | Pre-advising conversational flow (5-question, progress bar, schedule hand-off)                                                                                                          | ⬜ not started. See `docs/advising-flow.md`.                                                                                                                                                                       |
| 4b          | Advisor brief synthesis + RAG for catalog prose                                                                                                                                         | ⬜ not started                                                                                                                                                                                                     |
| 5           | **Multi-semester path planner.** "Calc 1 must start now or you can't graduate on time."                                                                                                 | ⬜ not started. Needs seasonality data (open). See D8.                                                                                                                                                             |
| X           | Bug 4 — eligible-course fix rollup (Layers A/B/C)                                                                                                                                       | 🟡 Layers A + B + C shipped; **pending live verification** (reload extension, confirm ≥50 eligible on CS BS / English-CW audits). Attribute wildcards (Layer D) and many-to-many rule mapping (Layer E) deferred. |
| Y           | **A1+B perf fix + cache-poisoning fix** (`e687ad6`). Bounded concurrency pool + fetch-with-timeout; batch subject search; `subjectSearch                                                | v2                                                                                                                                                                                                                |


### Delta vs legacy `findNeeded`, measured on fixture audits


| Audit         | Legacy `needed[].length` | New concretes | New wildcards routed for DW expansion                      | Notes                                                                                                                                                                                                     |
| ------------- | ------------------------ | ------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| English BA    | 151                      | 191           | 8 refs / 3 unique (`@@`, `ENG3@`, `ENG4@`)                 | +40 concretes (hideFromAdvice fallbacks recovered); every wildcard gets a handle instead of being silently dropped                                                                                        |
| CS BS + Music | 34                       | 29            | 14 refs / 12 unique (`CS3@`, `CS4@`, `MUSP3@`, `PHYS@`, …) | Legacy was emitting 8 phantom "courses" named `3@`/`4@` that nobody could register for; new parser routes them to the wildcard list. Real-course count is 26 → 29 (+3 recovered `hideFromAdvice` entries) |


---

## Next action (as of 2026-04-21 PM)

Each step is sized to one chat. New sessions should `cd` into the repo
root (the directory containing this file), confirm `git branch --show-current`
prints `LLM-algorithm`, then read `CLAUDE.md` + `HANDOFF.md` + the relevant
diagnosis doc.

1. ✅ Bug 5, Phase 1 wiring, Bug 1 diagnosis, Bug 1/3 solver fix,
  D17 flag removal, Layer B/C wildcard expansion. See commit history
   and closed-bug docs.
2. ✅ **A1+B perf fix + cache-poisoning fix** (`e687ad6`): `performance/concurrencyPool.js` +
  `searchCoursesBySubjects` + `subjectSearch|v2|…` cache versioning.
   Eligible list fills in <3s; prereq phase shows progress instead of
   hanging. Verified live by Aidan. **Needs PR to `main`.**
3. **Open the PR** (Auto mode, fresh chat). Branch `LLM-algorithm` →
  `main`. Covers Bug 4 Layers A/B/C + A1+B perf + cache-poisoning
   fix + documentation cleanup.
4. **Bug 7 — registration-restriction awareness** (Opus/API, fresh
  chat). Parse Banner `getRestrictions` per section, compare against
   student major/minor, filter violating sections. File
   `docs/bug7-registration-restrictions-diagnosis.md` first.
5. **Current-schedule-on-calendar bug** (Auto mode, fresh chat, after
  Bug 7). File its own diagnosis doc.
6. **Phase 1.5 solver** (Opus/API). Start the graph-aware solver only
  after steps 3–5 have landed. `auditDiagnostics.parity` in the
   background-fetch payload is the regression canary now that shadow
   logging is gone — spot-check it on ≥3 real audits first.

---

## Recent commit history (branch: `LLM-algorithm`)

- **D19 / Bug 8:** Banner login popup opens `/saml/login`
  (SP-initiated SSO), recovery + DegreeWorks fallback aligned, verify
  listener/timer fixes; docs: `docs/decisions.md` D19,
  `docs/bug8-banner-half-auth-login-popup-diagnosis.md`, CLAUDE/HANDOFF/README.
  _(Subject: `fix(auth): Banner login popup uses SAML SP entry`.)_
- `e687ad6` — A1+B perf fix + `subjectSearch|v2|` cache versioning +
 `performance/concurrencyPool.js` + `docs/bug5-`*, `docs/bug6-`*,
`docs/README.md`, `docs/CONTRIBUTING.md`, HANDOFF trim, CLAUDE.md rewrite
- `88a9d05` — phase(D17): strip `bp_phase1_*` + `bp_phase2_*` feature flags
- `bbba06c` — docs: close Bug 1/3 in HANDOFF + D14 (shipped `5975c90`, verified live)
- `5975c90` — phase2(bug1): close calibrator + solver gaps so "no X" constraints reach live run
- `2b07036` — docs(HANDOFF): require mandatory Next steps block on every AI response
- `24b1ce7` — docs: HANDOFF + decisions log (D1-D16) + Bug 1 diagnosis + advising flow
- `76abc17` — phase1(wiring): feature-flag RequirementGraph + add Bug 4 audit diagnostics
- `0cbceb6` — phase1(offline): RequirementGraph parser + wildcard normalizer + baseline
- `fda436e` — phase0: instrument scheduler + test harness + Bug 5 fix
- `4420fd5` — Enforce `noLaterThan` in scorer + calibrator
- `88dcdce` — Positive day framing + avoid-day removal/reset
- `62722e2` — Fix day-balance scorer + Jaccard<1.0 fallback tier
- `6394f16` — Weight calibration + transparency for unhonored constraints
- `3e1ece2` — Reset career-signal cache per turn
- `876b777` — Intent-only golden fixture
- `bea63cb` — Lab pairing + accurate credit hours
- `ac75707` — v3 hybrid scheduler: Intent LLM + CSP + Affinity + Rationale

See `git log LLM-algorithm ^main` for the full diff from `main`.