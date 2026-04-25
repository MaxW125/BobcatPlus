# Open bugs

**Authoritative tracker:** Jira. This file is a cached human/AI pointer — it
should stay short and only list bugs that need a written diagnosis doc in
`docs/bugs/` (non-obvious failure modes, deferred rationale, multi-phase fix
strategies). Everything else — status, priority, assignee, comments — lives in
Jira.

**Jira project:** [Bobcat Plus (SCRUM)](https://aidanavickers.atlassian.net/browse/SCRUM) ·
[open issues](https://aidanavickers.atlassian.net/issues/?jql=project%20%3D%20SCRUM%20AND%20statusCategory%20!%3D%20Done%20ORDER%20BY%20updated%20DESC).

**Active epics (2026-04-23).**

- [SCRUM-34](https://aidanavickers.atlassian.net/browse/SCRUM-34) — **Scheduler refactor**. Branch `scheduler-refactor`. Plan: [`plans/scheduler-refactor.md`](plans/scheduler-refactor.md). Commits C1–C7 = SCRUM-38..44.
- [SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35) — **Phase 1.5 (graph-native solver + many-to-many UX)**. Gated behind SCRUM-34. RFC: [`plans/requirement-graph.md`](plans/requirement-graph.md).
- [SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36) — **Bug 4 live-verify**. Piggyback on refactor Chrome smokes.
- [SCRUM-37](https://aidanavickers.atlassian.net/browse/SCRUM-37) — Harness H2 migration (deferred follow-up to C6).

Tiebreaker when an ADR and this file disagree: **`docs/decisions.md` wins**.
Closed postmortems live in `docs/postmortems/`.

---

## Has an in-repo diagnosis (read these first)

| # | Summary | Diagnosis |
| --- | --- | --- |
| 4 | Eligible list missing wildcard expansions — Layers A/B/C shipped; **live-verify pending** ([SCRUM-36](https://aidanavickers.atlassian.net/browse/SCRUM-36)). Layer D/E deferred to Phase 1.5 ([SCRUM-35](https://aidanavickers.atlassian.net/browse/SCRUM-35)). | [`bugs/bug4-eligible.md`](bugs/bug4-eligible.md) |
| 6 | Import-button UX + auth-expiry handling. Deferred (user-visible, low priority). | [`bugs/bug6-import-ux.md`](bugs/bug6-import-ux.md) |
| 9 | After term switch, Banner plans can load empty / out of order vs `loadSchedule`. Deferred from Refactor. | [`bugs/bug9-plans-empty-after-term-switch.md`](bugs/bug9-plans-empty-after-term-switch.md) |
| 10 | Auth error string not reflected in status bar (UX polish). Deferred from Refactor. | [`bugs/bug10-session-expired-status-bar.md`](bugs/bug10-session-expired-status-bar.md) |

## Tracked in Jira only (no doc needed yet)

- **Bug 7** — Registration restrictions: filter sections the student cannot
  satisfy (major/minor/standing). File `docs/bugs/bug7-registration-restrictions.md`
  when work begins and someone needs a written theory of the fix.
- Current schedule doesn't render on calendar on first load (sibling to Bug 6).
- Schedule variety too homogeneous when no user prefs (Phase 3 archetypes).
- `removeAvoidDays` / `resetAvoidDays` reliability in intent parsing.
- Affinity over-generalizes ("science" → BIO) — tighten career expansion in
  `buildIntentPrompt()`.
- Advisor summary / multi-semester planner — see
  [`plans/advising-flow.md`](plans/advising-flow.md).

---

## Closed (postmortems only)

Kept for context, not for triage. See [`postmortems/`](postmortems/) —
`bug1-morning-preference.md`, `bug5-online-conflict.md`,
`bug8-banner-half-auth-login-popup.md`,
`bug11-post-saml-degreeworks-warmup.md`.
