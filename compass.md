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

We are four people. Ship small, ship often.

## Phase + theme

| Phase | Theme | Status |
| ----- | ----- | ------ |
| 1.5 | Graph-native solver — `RequirementGraph` + many-to-many UX | ⬜ next ([SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35), branch `rule-shape-discovery`) |
| 2   | Scorer fidelity | ⬜ |
| 2.5 | Prereq-in-term in solver | ⬜ |
| 3   | Archetype-seeded ranking | ⬜ |
| 4   | Advising flow | ⬜ ([`docs/plans/advising-flow.md`](docs/plans/advising-flow.md)) |
| 5   | Graduation tracker | ⬜ |
| 6+  | Tree-style requirement visualization | ⬜ |

## Open architectural question

**Is the AI front door or ambient?** I.e. does a student land in a chat
that drives the schedule, or do they land in the schedule with the AI
available on the side? Both have been prototyped in conversation; we
haven't picked. Discuss before Phase 4 work starts.

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
