# Decisions — archive (D2–D14)

Older ADRs split out from [`decisions.md`](decisions.md) on 2026-04-25 to
keep the active log small. **All entries here are still authoritative
unless explicitly superseded by a newer entry in the active file.** The
"newer date wins" tiebreaker rule still applies across both files.

Process / workflow meta-decisions previously known as P1–P3 (ex-D1, D10,
D11, D15, D16) are no longer tracked as standalone documents — their
substance now lives in [`../.cursor/rules/process-gates.mdc`](../.cursor/rules/process-gates.mdc)
and the *Session hygiene* section of [`../CLAUDE.md`](../CLAUDE.md). For
the original wording, `git log --diff-filter=D --follow -- docs/process.md`.

---

## 2026-04-21 PM — D14: Bug 1 root cause is solver enumeration bias

**Context.** A maintainer captured a full rank-breakdown trace from a real run
("no classes before noon, no classes Friday"; CS BS audit). Analysis:

- Scorer applied `morningPen: 0.375` uniformly to all 20 top schedules,
which is correct for CS 4371 at 9:30 AM (2.5h × 0.15).
- Every one of the 20 top schedules used CS 4371 **CRN 12118** (9:30 AM
Tue/Thu). The build panel confirms CS 4371 Section 002 is available at
**Tue/Thu 12:30 PM, 13 open seats** — it would score +0.375 higher on
every archetype if it made it into the candidate pool.
- `totalCandidates: 2000` — the solver hit `SOLVER_MAX_RESULTS`. The 2000
pooled schedules never included CRN 12118's 12:30 PM alternative.

**Decision.** Bug 1 is **not** a scorer bug and therefore not a direct
Phase 2 scope item. The scorer is ranking correctly; the solver is
running out of exploration budget before it generates a single schedule
that uses the preferred section. Two fixes on the table:

1. **Preference-biased ordering (cheap).** Add a 5th ordering to
  `solveMulti` that, for each course, sorts sections ascending by
   penalty distance from active soft prefs (`noEarlierThan`,
   `noLaterThan`, `preferInPerson`). The first schedules generated will
   honor the prefs even if the pool caps at 2000.
2. **Weight-1.0 soft → solver hard.** When `calibrateIntentWeights`
  floors a weight at 1.0 (the user said "no", not "preferably no"),
   promote the corresponding preference to a solver hard constraint.
   This prunes the search tree instead of growing it.

Ship both. Fix 1 is the safe default; fix 2 is the principled semantics.

**Rationale.** The data shows the ranker and scorer are already working
as designed — they did penalize the morning section. The problem is that
the ranker never had a non-morning alternative to compare against because
the solver's DFS exhausted its 2000-schedule cap along one branch of the
CS-4371 CRN axis. Growing the cap is a band-aid; fixing ordering and
hoisting weight-1.0 prefs to hard constraints is the real cure.

**Status.** Shipped 2026-04-21 PM in `5975c90` on branch
`LLM-algorithm`. Verified live: "no classes before noon, no classes
friday" on the CS BS audit no longer returns CS 4371 CRN 12118 (9:30 AM)
in the top-3. Full file-level breakdown in the commit message.
Landed changes:

- Intent-prompt example realignment + `DECLARATIVE_NO_PATTERN` rescue in
`calibrateIntentWeights` (bare "no X" → 1.0, hedged phrasings stay
soft). Fix 2's trigger now fires for realistic student phrasing.
- `solveMulti` runs `pref-distance` ordering first when the prefordering
flag is on, plus per-pass budget (`SOLVER_RESULT_CAP / passes`) so no
single ordering can monopolize the 2000-schedule pool. Closes the
live-trace failure mode where MRV-first saturated the cap along one
CS 4371 CRN branch.
- `buildConstraints(prefs, profile, locked, flags)` promotes
morningCutoff / lateCutoff / online weights ≥ 1.0 to solver hard
constraints (`hardNoEarlierThan`, `hardNoLaterThan`, `hardDropOnline`)
when the hardfloor flag is on.
- `breakdownOf` inverts `onlineTerm` when `preferInPerson` is true, so
in-person outranks fully-online under affinity even when hardfloor is
not engaged. Closes the `expectedToFail` scoring invariant.
- 19 new unit tests: 16 end-to-end calibrator → buildConstraints chain
cases (positive, negative, hedged, flag-off gating) + 3 solver ordering
/ budget cases. 98/98 green.

**Reversible by.** `git revert 5975c90` now that D17 has stripped the
`bp_phase2_solver_prefordering` / `bp_phase2_solver_hardfloor` flags.

---

## 2026-04-21 — D13: Phase 1 wiring — postmortem-in-advance + Layer-B split

**Context.** RFC signed off, Bug 5 shipped, Phase 1 wiring green-lit. Before
touching `background.js` I'm spending D10's postmortem-in-advance gate on
this phase and splitting Layer B (live `courseInformation` fetch) into a
follow-up because the exact endpoint URL requires a DevTools capture we
haven't done yet.

**Postmortem-in-advance.** *It is six months from now. Phase 1 has been
rolled back. What happened?*

Top-2 failure modes:

1. **Silent behavior change on flag-on rollout.** The parity logging said
  "N identical", the flag turned on, and a week later a student reported
   their whole LANG track disappeared. Root cause: `deriveEligible()`'s
   "first-label-wins" dedup matched a different parent than legacy did on
   some audit shape we didn't have a fixture for. Mitigation: ship the
   flag OFF by default; when flipping ON, run a 48-hour shadow mode where
   both parsers run, discrepancies are logged to `auditDiagnostics.parity`,
   and the flag auto-disables on N>5 high-severity mismatches per user.
   Keep the legacy parser live until the shadow is clean on ≥20 real
   audits.
2. **importScripts path break on MV3 service-worker cold start.** The
  worker restarts, `importScripts` fails silently because the relative
   path resolved against the wrong base, and `BPReq` is `undefined` when
   `buildGraphFromAudit` is called. The whole getAuditData returns
   garbage. Mitigation: guard every call site with `if (typeof BPReq !==  "object" || typeof BPReq.buildGraphFromAudit !== "function") { fall  back to legacy }`. Emit a `console.warn` so we see it in logs. Add a
   unit-style test that eval-loads graph.js + txstFromAudit.js from the
   exact same relative path and asserts `self.BPReq.buildGraphFromAudit`
   is a function.

**Decision.** Phase 1 wiring ships today. Layer B (the live
`courseInformation` HTTP fetcher) splits into D14/a follow-up turn:

- In this turn: parser wired into `getAuditData` behind
`bp_phase1_wiring`, pure normalizer `normalizeCourseInformationCourses`
shipped in `extension/requirements/wildcardExpansion.js` and covered by
a unit test against `cs-4@.json`. No live HTTP yet.
- In the follow-up: user captures the `courseInformation` endpoint URL +
params from DevTools. One-page PR wires the fetcher + cache, gated on
a second flag `bp_phase1_wildcards`.

**Rationale.** The parser wiring is fully testable offline and the risk
budget is spent on the shadow-mode + fallback patterns above. Layer B
without the real URL would be speculation that could silently fail in
production; splitting it costs one extra round-trip with a maintainer and
removes guesswork from the diff.

**Reversible by.** Flipping `bp_phase1_wiring` to false. The legacy
`findNeeded` and its diagnostics remain intact.

---

## 2026-04-21 — D12: Bug 5 fix landed via shared `findOverlapPair` helper

**Context.** D11 ordered Bug 5 as item 0. Green light received 2026-04-21.

**Decision.** Rather than ship the 3-line patch in `tab.js`, the fix
extracts the pair-finder into `scheduleGenerator.js` as
`BP.findOverlapPair(courses)` and `detectWorkingConflict()` delegates to
it. This eliminates a second, divergent implementation of conflict
detection (the solver's `validateSchedule` and the UI's
`detectWorkingConflict` previously had slightly different behavior — now
they share exactly one code path).

**Rationale.** The user-facing symptom would have been solved by the
3-line local patch, but two implementations of "do these two meeting
times overlap?" is exactly the kind of latent duplication that bites
later. Centralizing it now is 10 extra lines of code and saves a future
bug where the two detectors drift. The helper is pure, format-tolerant
(HHMM or HH:MM, `beginTime` or `start` aliases), and covered by 10 unit
tests.

**Reversible by.** Easily — `findOverlapPair` is additive. If a future
phase needs different semantics for solver-vs-UI, keep the helper and
fork from it. Nothing locks us in.

---

## 2026-04-21 — D9: Many-to-many rule satisfaction IS surfaced to students

**Context.** DegreeWorks marks each rule/course with `EXCLUSIVE` ("DontShare"
— this course can only count toward one rule) or `NONEXCLUSIVE` ("ShareWith"
— same course can count toward multiple rules simultaneously). The question
was whether we surface this to students or collapse it silently.

**Decision.** Surface it. When a course satisfies multiple requirements, the
AI explicitly says so in its rationale ("ENG 4358 covers British Lit,
Early Lit, AND Single Author — one course, three boxes checked"), and when
swapping it for a different course the AI explains the downstream impact
on remaining credits/requirements.

**Rationale.** This is the kind of insight a real advisor would give and
that students cannot piece together from the audit PDF alone. It's
precisely the "feels like talking to a great advisor" gap we're trying to
close. Technically the graph already has the index; cost is prompt/UX work
in Phase 1.5, not solver work.

**Reversible by.** Scope creep in Phase 1.5 would force us to defer the
UX-side surfacing to Phase 3; the data side must ship with 1.5 regardless.

---

## 2026-04-21 — D8: Prereq + multi-semester planning are in scope (Phases 2.5 + 5)

**Context.** Aidan: "if a student has 5 semesters left and needs Calc 1→2→3,
the system should tell them to start Calc 1 now. With 3 semesters left, it
MUST tell them." This was not in the original 7-phase plan.

**Decision.** Add two phases:

- **Phase 2.5** — *single-term prereq awareness*. The solver refuses to
propose Calc 2 if Calc 1 is not completed/in-progress. Uses the
`prerequisites[]` field already present in DegreeWorks `courseInformation`
responses.
- **Phase 5** — *multi-semester path planner*. Given the requirement graph,
the student's completed/in-progress courses, and course-offering
seasonality, produce a term-by-term plan that minimizes semesters to
graduation (or fits a credit-load cap). This is what powers the advisor
Q&A ("how many semesters at 15 cr?"), and it's what produces the
"you must start Calc 1 now or you can't graduate on time" alert.

**Rationale.** Without these phases, the advisor tool can only describe the
*current* term. The whole value proposition — real actionable insight, not
just a pretty calendar — lives in multi-term reasoning. Phase 2.5 is cheap
(data already in hand). Phase 5 is expensive; we're deliberately placing
it late because the advisor flow (Phase 4a) can collect useful data from
students even without it, and the advisor brief (Phase 4b) can flag "prereq
risk" as a yes/no even before we can compute full paths.

**Open data dependency.** We do not yet have clean course-offering
seasonality (fall/spring/both/summer) data. Options investigated in Phase 5
planning:

- Scrape multiple terms of Banner and infer patterns.
- Ask TXST for the official offering pattern file.
- Fall back to "if offered this term, assume offered every subsequent same-
season term" — OK for MVP.

**Reversible by.** If Phase 5 proves unbounded, cut down to "warn about
prereq risk" (a boolean per incomplete rule) without generating a full
term-by-term plan. That demotes Phase 5 to part of Phase 4b.

---

## 2026-04-21 — D7: Bug 1/3 diagnostic trace is required for Phase 2, not before

**Context.** Aidan cannot reproduce Bug 1 (morning-class slips in despite
"prefer no classes before noon") or Bug 3 (ignores "all in-person") right
now. Does that block progress?

**Decision.** No. Continue through Phase 1 wiring + Bug 4 fetcher + Phase 1.5
without a fresh trace. Phase 2 **cannot** land until Aidan provides a
trace-panel dump (the Phase-0 `rankBreakdown` payload) from a real
reproduction. The adapter tests + scorer unit tests guard against
regressions in the meantime.

**Rationale.** Phase 2 is the first phase where we're tuning numbers against
user intent (rather than enforcing deterministic invariants). Tuning without
a real trace = guessing. Everything before Phase 2 has tests that already
tell us whether the fix works.

**Reversible by.** If Phase 2 becomes urgent before a trace is available,
we scope it down to only the `preferInPerson` scorer term (which is purely
structural — we KNOW no term exists) and defer fuzzy-time to a later sub-
phase. The `expectedToFail` unit test already guards the `preferInPerson`
gap.

---

## 2026-04-21 — D6: Advisor tool is an extension of the scheduler, not a parallel product

**Context.** Aidan shared the pre-advising vision (5-question flow, advisor
brief, advising Q&A including "BA vs BS in CS" and "semesters to graduate
at 12/15/max credits").

**Decision.** Treat the advisor tool as Phases 4a/4b/5 of the same system,
not a separate product. The requirement graph, the solver, and the scorer
are all reused; the advisor tool adds a pre-advising conversational flow
(4a) and an advisor-facing synthesis (4b) on top of the existing pipeline.
RAG over TXST catalog prose is only introduced in 4b, and only for narrative
Q&A — never for anything deterministic (satisfaction of requirements is
always computed from the graph, never retrieved).

**Rationale.** Building the advisor tool as a second codebase would
guarantee inconsistency: students would see one answer in the scheduler
and advisors would see another in the brief. One pipeline, two surfaces.

**Reversible by.** If institutional sales demands an advisor-only surface
that ships before the student product matures, we'd fork the pipeline —
but that's a product decision, not an engineering one.

---

## 2026-04-21 — D5: DegreeWorks `courseInformation` is the wildcard resolver

**Context.** `cs-4@.json` fixture revealed that the DegreeWorks wildcard
endpoint returns scoped results with `attributes[]` AND inline `sections[]`.
Banner's subject search lacks both.

**Decision.** Wildcard expansion in Bug 4's fix uses DegreeWorks
`courseInformation` per unique wildcard, cached for 1h. Banner's per-section
search remains for concrete/user-typed course lookups only.

**Rationale.** One call per wildcard vs. one call per subject *and* one
call per section for attribute data. Lower latency, lower request count,
already-hydrated data.

**Reversible by.** Discovery that DegreeWorks rate-limits or refuses certain
wildcard shapes (e.g. `@@ with ATTRIBUTE=xxx`). At that point we fall back
to the pattern documented in `bugs/scrum-63-eligible.md` Layer D1:
use the concrete `hideFromAdvice` fallback courses the audit already
lists under the attribute wildcard.

---

## 2026-04-21 — D4: Group semantics come from `requirement.numberOfGroups`

**Context.** Original RFC proposed reading `advice.numberGroupsNeeded`, with
fallback. Fixture evidence across both audits shows
`requirement.numberOfGroups` is authoritative.

**Decision.** Parser reads `numberOfGroups`. `advice.`* is UI hint, not
truth. When `numberOfGroups === numberOfRules`, the node collapses to
`AllOfNode` at parse time for downstream simplicity.

**Rationale.** Directly encoded in DegreeWorks, matches behavior across
every Group we've observed.

**Reversible by.** Encountering a Group where `numberOfGroups` is absent or
nonsensical. Record a new entry if we hit one.

---

## 2026-04-21 — D3: TXST-only in the parser; no adapter interface until #2 ships

**Context.** "Should the parser already abstract over universities?"

**Decision.** No. `extension/requirements/txstFromAudit.js` is the only
producer. When university #2 ships, extract the interface from observed
divergence, not from speculation.

**Rationale.** Every premature abstraction in this system has cost more
than it's saved. We already have one adapter; extracting an interface from
one implementation is guessing.

**Reversible by.** The day university #2 onboarding begins, this becomes a
refactor task.

---

## 2026-04-21 — D2: Requirement graph is additive in Phase 1; solver stays unchanged

**Context.** The RFC proposes replacing `needed[]` with a graph. That's a
large contract change.

**Decision.** Phase 1 lands the parser + a compat shim (`deriveEligible`)
that produces the legacy flat shape. The solver does not change in Phase

1. Solver native-graph consumption is deferred to Phase 1.5.

**Rationale.** Two smaller, independently testable PRs beat one big one.
Phase 1 can land and be rolled forward without behavior change; Phase 1.5
then adds the new semantics under a feature flag.

**Reversible by.** If Phase 1.5 slips past 6 weeks, we consider splitting
it further (ChooseN-only first, many-to-many later).
