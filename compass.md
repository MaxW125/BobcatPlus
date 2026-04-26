# Bobcat Plus — compass

Where the project is right now, what we're working on, and the one open
question worth thinking about. Anyone on the team updates this when a
milestone merges or the open question changes. **If you push something
that makes this file wrong, fix it in the same PR.**

For the long context: read [`CLAUDE.md`](CLAUDE.md) (router) and
[`docs/decisions.md`](docs/decisions.md) (ADR log, tiebreaker).

---

## Where we are

The scheduler refactor (`scheduleGenerator.js` → `extension/scheduler/*`)
is merged. Tab page CSS is split into per-section files. The extension
runs end-to-end on real DegreeWorks audits with the v3 hybrid pipeline:
deterministic CSP solver framed by LLM intent / affinity / rationale
stages.

The next big push is **multi-semester awareness**: a real model of a
student's path to graduation, not just one term at a time. Plan docs
landed 2026-04-25 — see *Tracks* below.

We are four people. Ship small, ship often. Target ship window for the
multi-semester surface: late summer / early fall 2026.

## Tracks

Replaces the old `Phase 1.5 / 2 / 2.5 / …` numbering. Same work, named
clearly. Track buckets are coarse — order within a bucket is flexible.

| Track | Theme | Status | Plan |
| --- | --- | --- | --- |
| **Now** | Graduation Tracker MVP — header strip, pure function | ⬜ ships independent | [`docs/plans/grad-tracker.md`](docs/plans/grad-tracker.md) |
| **Now** | Prereq schema sweep — 15 `courseInformation` fixtures | ⬜ unblocks Catalog | — |
| **Foundation** | Course Catalog (L2) — bundled prereq DAG + seasonality + refresh | ⬜ unblocks everything below | [`docs/plans/course-catalog.md`](docs/plans/course-catalog.md) |
| **Foundation** | Graph-aware Scheduler — solver consumes Catalog + ChooseN + many-to-many UX | ⬜ ([SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35); branch `rule-shape-discovery` is the precursor — [PR #12](https://github.com/BobcatPlus/BobcatPlus/pull/12)) | [`docs/plans/requirement-graph.md`](docs/plans/requirement-graph.md) |
| **Foundation** | Build Schedule button — non-AI path on build view | ⬜ small parallel ship | [`docs/plans/forward-planner.md`](docs/plans/forward-planner.md) §12 |
| **Multi-semester** | Forward Planner v1 — pace slider + read-only plan | ⬜ depends on Catalog + Graph-aware | [`docs/plans/forward-planner.md`](docs/plans/forward-planner.md) |
| **Multi-semester** | Per-term overrides (v1.5) — slate-level credit cap, skip terms | ⬜ extends v1 | [`docs/plans/forward-planner.md`](docs/plans/forward-planner.md) §5 |
| **Later** | Advising flow — pre-advising questions, advisor brief | ⬜ | [`docs/plans/advising-flow.md`](docs/plans/advising-flow.md) |
| **Later** | Scorer fidelity / schedule variety — `penaltyEffectiveness === 1`, archetype-seeded ranking | ⬜ post-Catalog | — |
| **Later** | Drag-and-replan (v2) — pin a course, watch cascade | ⬜ deferred until v1.5 user signal | [`docs/plans/forward-planner.md`](docs/plans/forward-planner.md) §6 |
| **Speculative** | Tree-style requirement visualization | ⬜ | — |
| **Speculative** | Catalog-year switching, "what-if I changed major" | ⬜ post-advising-flow | [`docs/plans/forward-planner.md`](docs/plans/forward-planner.md) §11 |

The schedule-builder LLM (intent → affinity → rationale) stays in the
codebase and shipped product. It is no longer the *primary* push — the
priority is multi-semester awareness on a deterministic foundation, with
AI as additive surfaces (ambient, not front-door — see *Resolved
question* below).

## Resolved question

**AI placement: ambient, not front-door.** Confirmed 2026-04-25. The
deterministic surfaces (eligible list, Build Schedule button, Forward
Planner) are primary. AI is additive — pre-advising flow, advisor brief,
"ask about your degree" — and gates on the deterministic baseline being
trustworthy. See `docs/decisions.md` D27.

## Open question

**Catalog manifest hosting.** Where does the Course Catalog refresh
manifest live (GitHub raw URL, Cloudflare Pages, dedicated CDN)? Cheap
to revisit; see [`docs/plans/course-catalog.md`](docs/plans/course-catalog.md)
§5 + §11.

## Active sprint + tracker

Tasks live in Jira, not here:

- [SCRUM project board](https://aidanavickers.atlassian.net/browse/SCRUM) — all open work.
- [Open issues](https://aidanavickers.atlassian.net/issues/?jql=project%20%3D%20SCRUM%20AND%20statusCategory%20!%3D%20Done%20ORDER%20BY%20updated%20DESC).

PR / branch state:

- `main` ships to the Chrome Web Store.
- `Demo` for external demos.
- `rule-shape-discovery` is the live feature branch ([PR #12](https://github.com/BobcatPlus/BobcatPlus/pull/12)).

---

## One-time git remote rename (recommended for everyone)

If your `origin` still points at a personal fork instead of the
BobcatPlus org, run this once:

```sh
git remote rename origin maxw125-fork              # if you have a fork remote
git remote rename github-desktop-BobcatPlus origin # org becomes default
git branch --set-upstream-to=origin/main main
```

Skip step 1 if you don't have the fork remote. After this, `git push`
goes to the org by default.
