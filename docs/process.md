# Process notes

Meta-decisions about *how we work* (as opposed to architecture/product
decisions, which live in `docs/decisions.md`). Extracted from the ADR log
during the 2026-04-23 doc restructure so the ADR log is not buried in
working-rhythm entries.

The **authoritative quick rules** for fresh AI sessions live in
`[../CLAUDE.md](../CLAUDE.md)` under *Documentation rules (short)* and
*Session hygiene*; this file is the longer rationale.

---

## P1 — Plan-doc-driven workflow with grumpy critique gates *(ex-D1)*

**Context.** How we work together.

**Decision.** Every substantive change gets (a) an RFC or diagnosis doc
*before* code, (b) a grumpy-senior-engineer critique pass, (c) unit tests
that can run in Node without OpenAI, (d) fixture-grounded assertions where
possible, and (e) a postmortem-in-advance per phase.

**Rationale.** Caught every architectural mistake we would otherwise have
made early in the project.

**Reversible by.** For small, local changes (a button, a color, a typo),
this overhead is skipped. Use judgment.

---

## P2 — Process gates (trimmed to 3 essentials) *(ex-D10, D15)*

**Context.** The original 6 gates patterned on a multi-person team were too
heavy for a limited-budget, one-person project; documentation overhead had
eaten ~32% of a month's API quota in a single session.

**Decision (current, as of D15).** Keep three gates, fold the rest:

1. **Postmortem-in-advance** per phase. Before code lands, write "it's six
  months from now and we rolled this back — what happened?" and record the
   top two failure modes. Prompt-vs-code audit ("could this live in
   deterministic JS?") and "what would the LLM do wrong here?" fold in as
   required bullets when the change touches a prompt.
2. **Feature flag per phase** during the ship-to-verify window.
  `chrome.storage.local` keys like `bp_phaseN_`*. Post-verify, the flag is
   **stripped** (per D17) and `git revert` becomes the rollback. The flag
   is a temporary affordance, not a permanent interface.
3. **Metric baseline before merge.** Snapshot `honoredRate` /
  `archetypeDistance` / `penaltyEffectiveness` /
   `requirementGraphValidity` (see `METRICS.md`) into
   `docs/baselines/phaseN-*.json`. Phase N+1 cannot merge if any regresses
   without a written justification.

Dropped from the original D10 set: weekly status log (decoration for a
one-person project), standalone prompt-vs-code audit (folded into gate 1),
standalone "what would the LLM do wrong" checklist (also folded into 1).

**Reversible by.** Any maintainer; record the drop as a new entry here.

---

## P3 — Model routing + new-chat rules *(ex-D16)*

**Context.** API budget is ~$20/month. Long chats go quadratically
expensive because every turn re-ingests the transcript. Every AI session
should *proactively* say when to drop to a cheaper model or start a new
chat — not wait for a human to catch it.

**Decision.** Every AI response follows these rules:

1. **Recommend Auto** (Sonnet / GPT-4o-mini) when the task is
  pattern-following: tests, wiring to an existing spec, UI copy, doc
   edits, commits/PRs, fixes with an existing diagnosis doc.
2. **Stay on Opus / premium** when the task is design, new algorithm,
  undiagnosed debugging, prompt engineering, or a first-time phase.
3. **Recommend a new chat** when the chat crosses ~20 substantive turns,
  when switching phases, when a logical unit just wrapped, or when the
   model catches itself re-reading the same files. When recommending,
   supply the exact opener to paste.

**Honesty clause.** If the model does not actually know the token burn, it
says so instead of inventing a percentage.

**Rationale.** A contributor should not have to monitor token usage —
that's the assistant's job.

**Reversible by.** Edit the Session hygiene section in `CLAUDE.md`; this
entry stays as the audit trail.

---

## Where D11 went

The old D11 ("bug-fix order (post-screenshot triage)" from 2026-04-21) was
a one-shot sprint plan, not a process rule. It was deleted during the
2026-04-23 restructure because it was stale and duplicated `HANDOFF.md`'s
phase table. Anyone wanting the original prioritization can `git log -S "D11: Bug-fix order"` to find it in history.