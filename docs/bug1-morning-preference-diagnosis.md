# Bug 1 — "Schedule picks 9:30 AM class when noon+ alternative exists"

**Status:** diagnosed 2026-04-21 from a real trace; fix deferred to
Phase-2 precursor. See `docs/decisions.md` D14 for the decision record.

## Reproduction

- Audit: CS BS + Music minor (the fixture in `tests/fixtures/audits/`).
- Term: Fall 2026.
- Prompt: `Build me a schedule with no classes before noon, no classes friday.`
- Expected: every top-3 schedule honors the noon floor; at minimum, the
  "Best for your goals" pick does.
- Actual: all three top schedules include **CS 4371 CRN 12118** (Tue/Thu
  9:30–10:50 AM). The chat label reads `Couldn't honor: some classes
  start before 1200` even though a 12:30 PM section is open.

## What the trace showed

Captured from the thinking-panel "rank breakdown (debug)" block. Key
numbers:

- `totalCandidates: 2000` — solver hit the `SOLVER_MAX_RESULTS` cap.
- **All 20 top schedules across all three archetypes** (`affinity`,
  `online`, `balanced`) use the same `CS 4371 CRN: 12118`.
- Per-schedule breakdown on "Best for your goals":
  - `morningPen: 0.375` (= 2.5 hours × 0.15 per-hour × weight 1.0)
  - `softAvoidPen: 0` (Friday successfully avoided)
  - total: `-0.0573`
- The variation across ranks 1–20 is only the BIO 1131 lab CRN — CS 4371
  is locked to 12118 in every single one.

## Why this is a solver bug, not a scorer bug

The Build-mode panel confirms CS 4371 has four sections:

| Section | Days       | Time            | Seats |
|---------|------------|-----------------|------:|
| 001     | Tue/Thu    | 9:30–10:50 AM   |    11 |
| 002     | Tue/Thu    | 12:30–1:50 PM   |    13 |
| 003     | Mon/Wed    | 12:30–1:50 PM   |     0 |
| R04     | Tue/Thu    | 9:30–10:50 AM   |    11 |

Section 002 has open seats and no conflict with any other course in the
generated schedules (CS 4398 is Tue/Thu 5:00 PM, MATH 3305 is Mon/Wed
2:00 PM, BIO 1331 is Mon/Wed 3:30 PM, CHEM 1341 is online, BIO 1131 is
Mon/Tue/Fri depending on section). A schedule that swaps CRN 12118 →
CRN for Section 002 would have `morningPen: 0` and score **+0.375
higher** on every archetype — guaranteed rank-1.

**None of those schedules exist in the 2000-candidate pool.** The solver
never generated one. Conclusion: `solveMulti` is exhausting its cap along
a prefix that commits to CRN 12118 before the 12:30 PM alternative is
ever attempted.

The scorer, ranker, archetype vectors, intent parser, and day-avoid logic
are all behaving correctly. Specifically:

- Intent: `noEarlierThan: 12:00`, `morningWeight: 1.0` (floor hit — the
  user said "no", not "preferably no"), `avoidDays: ["Fri"]`.
- Scorer: applies the 0.375 penalty exactly as designed.
- Ranker: would have placed a 12:30 PM schedule at rank 1 if one existed
  in the pool.

## Fix plan (two layers, ship both)

### 1. Preference-biased ordering (fast path)

In `extension/scheduleGenerator.js`, add a 5th ordering to `solveMulti`
alongside the existing MRV / reverse-MRV / 2 seeded shuffles. For each
course, sort its sections ascending by a **preference-distance score**:

```text
distance(section) =
  (hoursBefore(noEarlierThan) * morningWeight)
  + (hoursAfter(noLaterThan)  * lateWeight)
  + (avoidDays  ⊂ section.days ? softAvoidWeight : 0)
  + (preferInPerson && section.online ? onlineWeight : 0)
```

The solver then enumerates sections in ascending distance order per
course. The first schedules generated under this ordering use the
lowest-penalty sections, so even at the 2000 cap the ranker sees the
preference-honoring alternatives first.

Gate behind `bp_phase2_solver_prefordering` (default ON once shipped; a
flag is still required for D15 gate 2).

### 2. Weight-1.0 soft → solver hard (principled path)

When `calibrateIntentWeights` floors a soft weight at 1.0, the user used
a firm word ("no", "cannot", "never"). Treat that as a declarative
constraint, not a preference, and promote the corresponding field to a
solver hard constraint:

- `morningWeight == 1.0 && noEarlierThan != null` →
  `hardNoEarlierThan = noEarlierThan`, solver drops any section starting
  before it.
- `lateWeight == 1.0 && noLaterThan != null` → symmetric.
- `onlineWeight == 1.0 && preferInPerson` → drop online sections.

This makes the semantic match the user's own language: "no" means prune,
"preferably no" means penalize. Gate behind
`bp_phase2_solver_hardfloor`.

### Why both

Layer 1 covers the 70% case where the user said "preferably" but the
scorer weight is still high. Layer 2 covers the 30% case where the user
said "no" and the current behavior — surface a violator and apologize —
is worse than refusing to generate a violating schedule in the first
place. Together they close Bug 1 and Bug 3.

## Unit tests to add

- `preferenceOrdering.test.js`: synth fixture with two sections of the
  same course (9 AM vs 1 PM) and an active `noEarlierThan: 12:00`. Assert
  the 1 PM section appears in at least one of `solveMulti`'s orderings
  before the 2000-cap is hit.
- `hardFloor.test.js`: same fixture, `morningWeight: 1.0`. Assert the
  solver returns zero schedules that contain the 9 AM section.
- Flip the `expectedToFail` test in `scoring.test.js`
  (`preferInPerson should outrank online`) to `passing` once Layer 2
  ships, since hard-floor mode prunes online sections entirely.

## Trace artifact

Full `rankBreakdown` JSON from the capturing session is not committed
(60 KB, mostly repetition of the same CRNs), but the key extraction is
in this doc. If we need the raw dump for a regression fixture later,
Aidan can re-run with `bp_debug_audit: true` and paste it into a new
test fixture.
