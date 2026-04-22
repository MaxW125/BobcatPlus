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

Synthesized by a `callAdvisorBrief` LLM call (to be added in Phase 4b) that
takes as input:

- Requirement graph for the student's program.
- Completed/in-progress courses.
- Current semester's generated schedule + honored/unmet preferences.
- Student's five answers above.
- Multi-semester path plan (from Phase 5, when available).

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

| Capability                                       | Blocked on                                                   | Realistic timeline |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------ |
| 5-question conversational flow + progress bar    | UI work; LLM call with existing intent schema                | 2–3 wks after P1.5 |
| Pre-populated schedule from answers              | Existing scheduler, plus Q2 seeding calendar blocks          | Same as above      |
| Advisor brief draft (sections 1–4)               | Phases 2.5 + 4b                                              | Post Phase 2.5     |
| "Prereq risk" flagging in the brief              | Phase 2.5 (prereq awareness)                                 | Phase 2.5          |
| "How many semesters at 12/15 cr?" computation    | Phase 5 (multi-semester planner) + seasonality data          | Phase 5            |
| BA vs BS comparison                              | Run the parser on both audits; diff the graphs. Narrative = RAG (Phase 4b) | Phase 4b       |
| "You MUST take Calc 1 this term or you'll miss graduation" alert | Phase 5 forward-scheduling with prereq chains   | Phase 5            |
| Advisor login + portal                           | Non-AI product/infra work (auth, roles, student-advisor mapping) | Unscoped in this plan |
| Appointment booking integration                  | Likely institution-specific (TXST uses Navigate/EAB?)        | Post-MVP           |

## 5. Data gaps we must acknowledge

- **Course seasonality** (fall/spring/both/summer). Not in Banner per-term
  responses cleanly. Options: scrape 4–6 terms of history and infer; ask
  TXST for the official pattern; fall back to "offered this term =>
  assume offered every same-season term". Decision deferred to Phase 5
  kickoff.
- **Prereq strings**. DW `courseInformation` returns a `prerequisites` field
  whose shape we haven't fully inspected yet. First action in Phase 2.5:
  gather fixtures for 10–15 prereq strings across MATH/CS/ENG and confirm
  whether they're machine-parseable or whether we need a prereq-parser
  (another parser, another set of tests).
- **Co-requisites** (e.g. chem lecture + chem lab). Partially inferred
  today from the "missing lab" bug. DW should carry co-req in the rule
  text; needs a fixture sweep.
- **Program-specific rules that aren't in the audit JSON.** E.g. "honors
  students must take honors section of ENG 1310". This is the class of
  things we will *never* get perfect from parsing; the advisor brief is
  where these get surfaced via stressor-question routing.

## 6. What we will NOT build in Phase 4

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
