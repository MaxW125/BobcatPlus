# Scheduler Metrics

Precise, testable definitions. Anything added to the scheduler from here on is judged
against these numbers. Anything that can't be measured by one of these (or a new metric
added to this file first) is not a feature, it's a guess.

Every metric has:

- **Inputs** — what it consumes, named exactly as in code.
- **Formula** — how it's computed. No hand-waving.
- **Range** — the guaranteed output range.
- **When undefined** — cases where the metric returns `null` / has no meaningful value.
- **Unit-testable** — true if the metric can be computed without an OpenAI key.

---

## 1. `honoredRate(schedule, preferences)`

How much of what the student asked for was actually respected.

**Inputs:**

- `schedule.honoredPreferences: string[]` — from `buildRationaleFacts` in
`scheduleGenerator.js`.
- `schedule.unhonoredPreferences: string[]` — same source.

**Formula:**

```
h = schedule.honoredPreferences.length
u = schedule.unhonoredPreferences.length
honoredRate = (h + u === 0) ? null : h / (h + u)
```

**Range:** `[0, 1]` or `null`.

**When `null`:** student stated no preferences. There's nothing to honor. The UX should
not display the number in this case.

**Unit-testable:** yes (`buildRationaleFacts` is pure).

**Rationale for the denominator choice:** `(h + u)` counts distinct stated preferences,
not terms in the score function. We count semantic asks, not weights.

---

## 2. `archetypeVector(schedule)`

A 5-dimensional fingerprint of schedule shape. Used as the input to
`archetypeDistance`.

**Inputs:**

- `schedule.courses[]` with fields `days[], start, end, online, credits`.

**Formula (pure function of the schedule):**

```
morningHours      = Σ over in-person courses of max(0, min(end, 12:00) - start)    / 60
afternoonHours    = Σ over in-person courses of max(0, min(end, 17:00) - max(start, 12:00)) / 60
eveningHours      = Σ over in-person courses of max(0, end - max(start, 17:00))    / 60
activeDays        = |{ d ∈ {Mon..Fri} : ≥1 in-person course meets on d }|
onlineCount       = count of courses with online = true
```

Times use 24-hour `HHMM`-as-minutes math (already standard in the code; see
`toMinutes`).

**Range:**

- morningHours: `[0, 4·(#classes)]` hours
- afternoonHours: `[0, 5·(#classes)]` hours
- eveningHours: `[0, 8·(#classes)]` hours
- activeDays: `[0, 5]`
- onlineCount: `[0, #classes]`

**When undefined:** never — empty schedule yields the zero vector.

**Unit-testable:** yes.

---

## 3. `archetypeDistance(topK)`

How different, in shape, the returned top-K schedules are from one another. Our
current target is K=3.

**Inputs:**

- `topK: Schedule[]` — usually the 3 returned picks.

**Formula:**

```
V_i = archetypeVector(topK[i])

# Normalize each axis by the observed max across the batch, defaulting to 1 to
# avoid divide-by-zero when all schedules have identical value on that axis.
max_j = max_i V_i[j]   for j in 0..4
denom_j = max(1, max_j)
V_i_norm[j] = V_i[j] / denom_j

# Mean pairwise L1 distance in the normalized space, averaged over axes too.
pairs = all (i, j) with i < j in 0..K-1
archetypeDistance = mean over pairs of  mean over j in 0..4 of  |V_i_norm[j] - V_j_norm[j]|
```

**Range:** `[0, 1]`.

**When undefined:** fewer than 2 schedules returned.

**Unit-testable:** yes.

**Target thresholds (for acceptance tests, not hard SLOs):**

- Silent-preference fixture ("just build me a schedule") — `archetypeDistance ≥ 0.25`.
Today's value on the fixture is likely <0.1 (three near-identical schedules).
- Preference-constrained fixtures — no target; the metric is informational, not a
requirement.

---

## 4. `requirementGraphValidity(schedule, graph)`

Does this schedule respect the degree's structural rules?

**Inputs:**

- `schedule.courses[]` with `{subject, courseNumber}`.
- `graph: RequirementGraph` (see `plans/requirement-graph.md`).

**Formula (binary per schedule):**

```
let violations = []
for each ChooseNGroupsNode g in graph:
   satisfiedChildren = { c ∈ g.children : c is fully satisfied by schedule + applied }
   if |satisfiedChildren| > g.n: violations.push({kind: "chooseN-exceeded", node: g.id})
   # Note: we permit partial progress toward a child. The constraint is only
   # violated if the schedule contributes to > g.n distinct children.
   contributedChildren = { c ∈ g.children : schedule has ≥1 course assigned to c }
   if |contributedChildren| > g.n: violations.push({kind: "chooseN-spread", node: g.id})

for each CourseQuantifiedNode c in graph:
   for each course picked in schedule assigned to c:
     if course matches an entry in c.exceptCourses: violations.push({kind: "except", node: c.id, course})

requirementGraphValidity = (violations.length === 0) ? 1 : 0
```

**Range:** `{0, 1}`.

**When undefined:** graph not yet built (pre-Phase 1). In that case the metric reports
`null` and CI does not gate on it. Post-Phase 1, the metric must be `1` for every
returned schedule or the run fails.

**Unit-testable:** yes (pure function of schedule + graph).

**Secondary output:** when `0`, the `violations[]` array itself is also exposed so the
failure is actionable.

---

## 5. `penaltyEffectiveness(run)`

Did the user's stated soft preferences actually change what they got? I.e. is the
scorer doing its job?

**Inputs:**

- `run.topSchedules[]` — the 3 returned schedules with their `scoreBreakdown`.
- `run.allScored[]` — the top-K (K=20 for Phase 0) candidates with breakdowns.
- `run.preferences` — stated preferences from `intent.statedPreferences`.

**Formula:**

```
# Recompute scores without any stated soft preference.
zeroedPrefs = { ...preferences, morningCutoffWeight: 0, lateCutoffWeight: 0,
                avoidDayWeight: 0, onlineWeight: 0, careerAffinityWeight: 0 }
rescored = allScored.map(s => applyVector(s.metrics, vec, zeroedPrefs))
# for whichever vector was chosen for top-1 of the actual run

topWithoutPrefs = argmax(rescored)
topWithPrefs    = argmax(allScored, by actual score)

# Schedule course-set difference. Set of (subject, courseNumber) tuples.
diff = symmetricDifference(courseSet(topWithoutPrefs), courseSet(topWithPrefs))

penaltyEffectiveness = (diff.size > 0) ? 1 : 0
```

**Range:** `{0, 1}`.

**When undefined:** no stated soft preferences (`preferences.morningCutoffWeight == null && preferences.lateCutoffWeight == null && ...`). In that case `null`.

**Unit-testable:** yes, given `applyVector` is already pure.

**Interpretation:** `0` when at least one soft preference was stated AND removing them
all wouldn't change the pick. That's the "penalties are drowned" failure mode from Bug 1.
`1` means the stated preferences demonstrably moved the needle. This is the most direct
measure of scorer correctness we have.

---

## Phase gating

These metrics are what determines whether each phase is "done":


| Phase                 | Gate                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 (instrumentation)   | All four metrics computable and exposed on every schedule run. Unit tests present.                                                                              |
| 1 (requirement graph) | `requirementGraphValidity === 1` for every returned schedule on the fixtures. No regression in `honoredRate` on the other fixtures.                             |
| 2 (scorer fidelity)   | `penaltyEffectiveness === 1` on a new "prefer afternoons with afternoon alternatives" fixture. `honoredRate` improvement on morning / online fixtures.          |
| 3 (archetype ranking) | `archetypeDistance ≥ 0.25` on the silent-preference fixture. No regression on others.                                                                           |
| Bug 4                 | Eligible count on English-CW fixture rises from today's value (measured in Phase 0) to ≥ ~150 per term. (Specific threshold TBD after we measure the baseline.) |


---

## Where these are computed

Phase 0 will add these as exports on `window.BP` so they can be called from the trace
payload and from unit tests:

- `BP.computeHonoredRate(scheduleAction)` — reads `honoredPreferences` / `unhonoredPreferences`.
- `BP.computeArchetypeVector(scheduleAction)` — reads `courses[]`.
- `BP.computeArchetypeDistance(scheduleActions)` — takes an array.
- `BP.computePenaltyEffectiveness(rankBreakdown, preferences, vector)` — uses the new
Phase 0 `rankBreakdown` payload.
- `BP.computeRequirementGraphValidity` — stub in Phase 0, real in Phase 1.

All are pure functions with no OpenAI dependency.