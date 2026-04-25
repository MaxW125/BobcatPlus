# Open bugs

**Authoritative tracker:** Jira. This file is a cached human/AI pointer
to bug *diagnosis docs* for non-obvious failure modes — status,
priority, and assignee live in Jira.

**Jira project:** [Bobcat Plus (SCRUM)](https://aidanavickers.atlassian.net/browse/SCRUM) ·
[open issues](https://aidanavickers.atlassian.net/issues/?jql=project%20%3D%20SCRUM%20AND%20statusCategory%20!%3D%20Done%20ORDER%20BY%20updated%20DESC).

**Active epics.**

- [SCRUM-34](https://aidanavickers.atlassian.net/browse/SCRUM-34) — **Scheduler refactor.** Merged.
- [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35) — **Phase 1.5** (graph-native solver + many-to-many UX). Branch `rule-shape-discovery` ([PR #12](https://github.com/BobcatPlus/BobcatPlus/pull/12)). RFC: [`plans/requirement-graph.md`](plans/requirement-graph.md).
- [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36) / [SCRUM-63](https://aidanavickers.atlassian.net/browse/SCRUM-63) — **Bug 4 live-verify.** Piggyback on next Chrome smoke. (These two tickets are duplicates; consolidate during the next Jira pass.)

If a doc and the ADR log disagree, [`decisions.md`](decisions.md) wins.
Closed postmortems live in [`postmortems/`](postmortems/).

---

## Has an in-repo diagnosis (read these first)

| Jira | Summary | Diagnosis |
| --- | --- | --- |
| [SCRUM-63](https://aidanavickers.atlassian.net/browse/SCRUM-63) | Eligible-list wildcard expansion. Layers A/B/C shipped; live-verify pending. Layer D/E deferred to Phase 1.5. | [`bugs/scrum-63-eligible.md`](bugs/scrum-63-eligible.md) |
| [SCRUM-79](https://aidanavickers.atlassian.net/browse/SCRUM-79) | Import button UX + auth-expiry. Deferred (low priority). | [`bugs/scrum-79-import-ux.md`](bugs/scrum-79-import-ux.md) |
| [SCRUM-47](https://aidanavickers.atlassian.net/browse/SCRUM-47) | Plans empty after term switch. Deferred from Refactor. | [`bugs/scrum-47-plans-empty.md`](bugs/scrum-47-plans-empty.md) |
| [SCRUM-80](https://aidanavickers.atlassian.net/browse/SCRUM-80) | Auth error not reflected in status bar. Deferred from Refactor. | [`bugs/scrum-80-session-expired-status-bar.md`](bugs/scrum-80-session-expired-status-bar.md) |

## Tracked in Jira only (no diagnosis doc yet)

- **Bug 7** — registration restrictions: filter sections the student
  cannot satisfy (major/minor/standing). File
  `docs/bugs/scrum-{N}-registration-restrictions.md` when work begins
  and a written theory of the fix is needed.
- Current schedule doesn't render on calendar on first load (sibling to
  SCRUM-79).
- Schedule variety too homogeneous when no user prefs (Phase 3
  archetypes).
- `removeAvoidDays` / `resetAvoidDays` reliability in intent parsing.
- Affinity over-generalizes ("science" → BIO) — tighten career
  expansion in `buildIntentPrompt()`.
- Advisor summary / multi-semester planner — see
  [`plans/advising-flow.md`](plans/advising-flow.md).

---

## Closed (postmortems only)

See [`postmortems/`](postmortems/) — `bug1-morning-preference.md`,
`bug5-online-conflict.md`, `bug8-banner-half-auth-login-popup.md`,
`bug11-post-saml-degreeworks-warmup.md`.
