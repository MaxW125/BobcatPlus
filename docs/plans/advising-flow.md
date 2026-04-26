# Advising Flow — Design Notes

Status: *draft, not yet implemented.* Owning decision: `docs/decisions.md` D6
("Advisor tool is an extension of the scheduler, not a parallel product").

This doc captures Aidan's product vision for the advisor-facing surface, the
5-question pre-advising flow, and a **reality check** on what's buildable when.

---

## 1. Product vision (verbatim intent)

Two surfaces of one pipeline:

1. **Student — pre-advising flow.** A "Begin pre-advising" button kicks off a
  short conversational flow (≤5 questions, visible progress bar) that
   collects career direction, constraints, workload tolerance, stressors, and
   anything else the student wants the advisor to know. The AI produces a
   schedule draft and — if possible — queues an advising appointment.
2. **Advisor — structured brief.** Before each appointment, the advisor opens
  a brief that synthesizes career goals, current schedule vs. degree fit,
   flagged academic risks (prereqs-about-to-miss, pace behind plan, holds),
   and AI-generated talking points tied to gaps between stated goals and
   current trajectory.

The sell: student gets real insight + a schedule, advisor walks in already
knowing the student, university gets better outcomes without more headcount.

## 2. Five-question draft (Aidan)

Recorded from the draft verbatim so we don't lose it:

1. *"What do you want to do after graduation — even if you're not sure yet,
  what direction are you leaning?"* — captures career goals without
   requiring certainty.
2. *"Are there any days or times that are completely off limits for
  classes — work, family, anything like that?"* — captures constraints,
   also seeds calendar blocks.
3. *"How heavy of a semester do you want? Be honest — are you trying to
  power through or do you need some breathing room?"* — captures credit
   hour preference and workload tolerance.
4. *"Is there anything about your major or your plan that's been stressing
  you out or that you've been confused about?"* — the GOLD question.
   Captures exactly what an advisor needs to address.
5. *"What's one thing you'd want your advisor to know about you before you
  walk in?"* — open-ended catcher; also signals to the student that a real
   human will read this.

Delivery notes: counter + progress bar, micro-copy reminding the student
that more info = better schedule + better appointment.

## 3. Brief contents (what the advisor sees)

Synthesized by a `callAdvisorBrief` LLM call (added when this Advising
flow track ships) that takes as input:

- Requirement graph for the student's program.
- Completed/in-progress courses.
- Current semester's generated schedule + honored/unmet preferences.
- Student's five answers above.
- Multi-semester path plan (from the Forward Planner, when available —
  see [`forward-planner.md`](forward-planner.md)).

Output sections:

1. **Who they are** — one paragraph, name, major, term, approximate credits
  remaining, stated career goal.
2. **Where they stand** — completed %, pace vs. 8-semester baseline,
  outstanding required course count, any at-risk prereq chains.
3. **What they asked for** — summarized answers to Q1-Q5, lightly edited.
4. **Recommended conversation starters** — 3 bullets tied to their
  stressors. Direct quote of Q4 is appended so the advisor sees their
   voice.
5. **The draft schedule** — deterministic, not LLM. Links to the same
  schedule the student saw.

## 4. Reality check — what's realistic when

Track names match the current `compass.md` *Tracks* table (D27 retired
the old `Phase 1.5 / 2.5 / 4 / 5` numbering).

| Capability | Blocked on | Realistic timing |
| --- | --- | --- |
| 5-question conversational flow + progress bar | UI work; LLM call with existing intent schema | After Graph-aware Scheduler |
| Pre-populated schedule from answers | Existing scheduler + Q2 seeding calendar blocks | Same as above |
| Advisor brief draft (sections 1–4) | Course Catalog (prereq awareness) + advisor LLM call | After Catalog ships |
| "Prereq risk" flagging in the brief | Course Catalog (prereq DAG) | After Catalog ships |
| "How many semesters at 12/15 cr?" computation | Forward Planner v1 + seasonality | After Forward Planner |
| BA vs BS comparison | What-If audit fetcher; diff two graphs; LLM RAG narrative | After Forward Planner (catalog-year switching path, [`forward-planner.md`](forward-planner.md) §11) |
| "You MUST take Calc 1 this term or you'll miss graduation" alert | Forward Planner with prereq chains + seasonality | Forward Planner v1 |
| Advisor login + portal | Non-AI product/infra work (auth, roles, student-advisor mapping) | Unscoped in this plan |
| Appointment booking integration | Likely institution-specific (TXST uses Navigate/EAB?) | Post-MVP |


## 5. Data gaps we must acknowledge

These are now substantially addressed by the Course Catalog (L2) plan
([`course-catalog.md`](course-catalog.md)) — the gap notes below are
preserved for historical context, with pointers to where each is
resolved.

- **Course seasonality** (fall/spring/both/summer). Resolved by
[`course-catalog.md`](course-catalog.md) §4 (empirical aggregation
from cached subject searches; confidence-tiered, disclaimer-heavy in
the UI).
- **Prereq strings**. Resolved by [`course-catalog.md`](course-catalog.md)
§6 (prereq-DAG migration off Banner-HTML regex onto DW
`courseInformation.prerequisites`); gated on a fixture sweep
(`tests/fixtures/courseInformation/`, ~15 courses across MATH/CS/ENG/
BIO/MUS/BUS) which is the first concrete deliverable in that plan.
- **Co-requisites** (e.g. chem lecture + chem lab). Resolved by
[`course-catalog.md`](course-catalog.md) §7 (`CourseFact.coRequisites`
modeled explicitly; replaces the hand-curated `pairedCourse` field in
the solver).
- **Program-specific rules that aren't in the audit JSON.** E.g. "honors
students must take honors section of ENG 1310". This is the class of
things we will *never* get perfect from parsing; the advisor brief is
where these get surfaced via stressor-question routing.

## 6. What we will NOT build in this track

- Two-way calendar sync with Google / Apple calendars (the "Add to
Calendar" button is enough for MVP).
- Real-time chat between student and advisor (email the brief, done).
- Automated appointment booking beyond a hand-off URL.
- Deep catalog-text understanding beyond what a RAG over the course
catalog can do.

## 7. The gold question, highlighted

> *"Is there anything about your major or your plan that's been stressing
> you out or that you've been confused about?"*

This question is the thing that makes this tool different from every other
"student planner" app. Everyone else collects schedule constraints.
Nobody collects stressors. Weight this answer highest in the brief and
make sure it appears verbatim (not paraphrased) to the advisor.