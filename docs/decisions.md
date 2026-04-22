# Decisions — Bobcat Plus AI Scheduler

A running, dated log of the architectural and product decisions that shape the
scheduler. Each entry is an ADR-lite record: *context → decision → rationale →
who can reverse it*. New entries go at the **top**. Do not rewrite history —
add a new entry that supersedes the old one if we change our minds.

This file is the single source of truth for "what did we agree on?". The RFCs
and the HANDOFF describe *how* we build things; this file captures *what we
chose and why*. If a decision here ever contradicts an RFC, the newer date
wins and the RFC must be updated.

---

## 2026-04-21 PM — D16: Codify model-and-chat-routing rules for every AI session

**Context.** API budget is finite (~$20/month of included quota) and
long chats get quadratically expensive because every turn re-loads the
full transcript. Aidan asked for explicit instructions that every future
AI session reads, so the assistant *proactively* says when to drop to a
cheaper model or start a new chat — not only when Aidan notices and asks.

**Decision.** Add a "Session hygiene" section at the top of HANDOFF.md
(above Process gates) with three rules the AI must follow on every
response:

1. **Recommend Auto mode** (Sonnet / GPT-4o-mini) when the task is
   pattern-following (tests, wiring, commits, UI tweaks, doc edits,
   fixes with an existing diagnosis doc).
2. **Stay on Opus / API** when the task is design, algorithm,
   undiagnosed debugging, prompt engineering, or a first-time phase.
3. **Recommend a new chat** when the chat crosses ~20 substantive
   turns, when switching phases, when a logical unit just wrapped, or
   when the model catches itself re-reading the same files. When
   recommending, supply the exact opener to paste.

Honesty clause: if the model does not actually know the token burn, it
says so instead of inventing a percentage.

**Rationale.** Aidan should not have to monitor token usage — that's the
assistant's job. The rule lives in HANDOFF.md (not in this decisions
log) because HANDOFF is what every fresh chat is instructed to read
first. The current plan has at least three tasks (Bug 6, Layer B
wiring, doc updates) that do not need Opus, and shifting them to Auto
conservatively buys back multiple fresh-chat budgets for the harder
work (Bug 1/3 solver, Phase 1.5, Phase 5 planner, Phase 4 advising).

**Reversible by.** Aidan (edit the Session hygiene section in
HANDOFF.md; this decision record stays as the audit trail).

---

## 2026-04-21 PM — D15: Trim process gates to 3 essentials

**Context.** The original 6 process gates from D10 were patterned on a
multi-person team. This is a solo project with one real user (Aidan) and a
limited API budget. Aidan flagged that the documentation overhead had
consumed ~32% of this month's API quota in one session.

**Decision.** Cut the gates to three: postmortem-in-advance, feature flag
per phase, metric baseline before merge. Fold the "prompt-vs-code audit"
and "what would the LLM do wrong here?" questions into the postmortem as
required bullets when the change touches a prompt. Delete the weekly log
entirely — it was decoration for a one-person project.

**Rationale.** The postmortem-in-advance has already paid for itself twice
this week: it caught the `importScripts` fallback path in Phase 1 wiring
and surfaced the shadow-mode parity log as the right safety net. Feature
flags are non-negotiable — rollback without a flag means a revert, which
spends more context and breaks trust. Metric baselines are the only
mechanism keeping us honest across phases. The other two were pre-emptive
checklists whose output was 95% overlap with what the postmortem asks.

**Reversible by.** Aidan (trivially — re-expand the gates in HANDOFF).

---

## 2026-04-21 PM — D14: Bug 1 root cause is solver enumeration bias

**Context.** Aidan captured a full rank-breakdown trace from a real run
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

**Reversible by.** Flipping `bp_phase2_solver_prefordering` and/or
`bp_phase2_solver_hardfloor` to `false` in `chrome.storage.local`
disables each layer independently — but only until the D17 flag-removal
commit lands. After that, rollback is `git revert 5975c90`.

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
   garbage. Mitigation: guard every call site with `if (typeof BPReq !==
   "object" || typeof BPReq.buildGraphFromAudit !== "function") { fall
   back to legacy }`. Emit a `console.warn` so we see it in logs. Add a
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
production; splitting it costs one extra round-trip with Aidan and
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

## 2026-04-21 — D11: Bug-fix order (post-screenshot triage)

**Context.** Two new bugs surfaced during the 2026-04-21 review: (5) class
overlap is being mis-detected (screenshot shows phantom conflict between a
Mon/Wed math class and an online CS class); (6) the `Import` button UX is
broken after auth expiry and should eventually be eliminated entirely.

**Decision.** Priority ordering for *remaining* work:

1. **Bug 5 — overlap detection** (quick win, high trust impact). Ship before
   Phase 1 wiring.
2. **Phase 1 wiring** (background.js emits the graph; `deriveEligible` drives
   the solver). Gated on RFC sign-off.
3. **Bug 4 live fetcher** (wildcard expansion via DW `courseInformation`).
4. **Phase 1.5** (graph-native solver + many-to-many) — fixes Bug 2.
5. **Phase 2** (scorer fidelity: fuzzy time prefs + `preferInPerson`) — fixes
   Bugs 1 & 3. Requires a real trace dump before code lands (see D7).
6. **Phase 2.5** (prereq awareness within a term) — new, required for the
   advisor vision.
7. **Phase 3** (archetype ranking).
8. **Phase 4a** (pre-advising flow).
9. **Phase 4b** (advisor brief + RAG).
10. **Phase 5** (multi-semester path planner).
11. **Bug 6** (import UX overhaul toward "no button, just load").
12. **Max's refactor** (file-split of `tab.js`/`background.js`).

**Rationale.** Bug 5 is a data-correctness bug that shakes user trust in every
schedule the product returns — must-fix before we invest more. Bug 6 is
medium-effort, medium-impact, and the user explicitly said "focus on what we
got". Max's refactor lands last because every test + module boundary we ship
before then is a safety net that makes the refactor mechanical.

**Reversible by.** Any phase can be re-ordered by updating this entry with a
reason. Phase 5 can slip below Phase 4b if the advisor pipeline doesn't need
seasonality data as much as we currently think.

---

## 2026-04-21 — D10: Adopt the process toolset, not just plan docs

**Context.** Aidan asked whether plan-doc-driven AI coding is the "gold
standard". The honest answer is it's one of several good patterns; what makes
it work here is the surrounding process, not the doc.

**Decision.** Adopt the following as gates, not suggestions:

- **Postmortem-in-advance** per phase: before code lands, spend 5 minutes
  writing "It's six months from now and we rolled this back. What happened?"
  Record the top two failure modes in the phase's RFC before starting.
- **Prompt-vs-code audit** per LLM change: every new instruction to
  `callIntent` / `callAffinity` / `callAdvisor` gets asked "could this live
  in deterministic JS instead?". If yes, push it to code.
- **Metric baselines** before every Phase-N merge: snapshot
  `honoredRate` / `archetypeDistance` / `penaltyEffectiveness` into
  `docs/baselines/phaseN-*.json` on the fixtures. Phase N+1 cannot merge if
  any regresses without a written justification.
- **Feature flags per phase**: use `chrome.storage.local` keys like
  `bp_phase1_wiring` so rollback is one toggle, not a revert.
- **Weekly status** (Monday AM) in `HANDOFF.md`: what landed, what's stuck,
  who is touching what (especially as Max's refactor approaches).
- **"What would the LLM do wrong here?" checklist** for LLM-touching
  changes: enumerate 3 concrete misbehaviors and whether the deterministic
  layer catches each.

**Rationale.** Each of these caught or prevented a specific problem in the
phases we've already shipped. Making them standing gates keeps Phase 2+
(which changes user-visible scoring) honest.

**Reversible by.** Aidan may drop any gate if it's costing more than it
saves; record the drop as a new entry.

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
to the pattern documented in `docs/bug4-eligible-diagnosis.md` Layer D1:
use the concrete `hideFromAdvice` fallback courses the audit already
lists under the attribute wildcard.

---

## 2026-04-21 — D4: Group semantics come from `requirement.numberOfGroups`

**Context.** Original RFC proposed reading `advice.numberGroupsNeeded`, with
fallback. Fixture evidence across both audits shows
`requirement.numberOfGroups` is authoritative.

**Decision.** Parser reads `numberOfGroups`. `advice.*` is UI hint, not
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

---

## 2026-04-21 — D1: Plan-doc-driven workflow with grumpy critique gates

**Context.** How are we working together?

**Decision.** Every substantive change gets (a) an RFC or diagnosis doc
*before* code, (b) a grumpy-senior-engineer critique pass, (c) unit tests
that can run in Node without OpenAI, (d) fixture-grounded assertions where
possible, and (e) a postmortem-in-advance per phase.

**Rationale.** Documented in `HANDOFF.md`. Caught every architectural
mistake we would otherwise have made in this conversation.

**Reversible by.** For small, local changes (a button, a color, a typo),
this overhead is skipped. Use judgment.
