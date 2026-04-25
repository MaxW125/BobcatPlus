# Bug 4 — Eligible list missing wildcard expansions

**Status:** 🟡 **A + B + C shipped; live-verify pending. D (attribute wildcards)
and E (many-to-many course→rule) still deferred.** Rollback is `git revert` on
the D18 commit.

Historical diagnosis + layered design rationale lives in `docs/decisions.md`
**D5, D13, D18**. This doc is now the *current open-items* view only. If
anything here contradicts those ADRs or code, code wins and this doc updates.

---

## What shipped


| Layer                                                        | Scope                                                                                           | Status                                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** — stop dropping `hideFromAdvice` concrete fallbacks    | Parser                                                                                          | ✅ `0cbceb6`                                                                                                                                               |
| **B** — subject-wildcard expansion via DW `/api/course-link` | `fetchCourseLinkFromDW` (SW HTTP + 1h cache) + `BPReq.expandAuditWildcards` (pure orchestrator) | ✅ D18 commit on `LLM-algorithm`; merged via `main`                                                                                                        |
| **C** — honor `except` clauses for concrete entries          | Orchestrator `excludeKeys`                                                                      | ✅ same commit. Wildcard-valued excepts (`CS 2@` as an except) still fall through; no-op in practice because expansions don't overlap in the known audits. |


Implementation lives in:

- `extension/bg/studentInfo.js` → `fetchCourseLinkFromDW`
- `extension/requirements/wildcardExpansion.js` → `expandAuditWildcards`
- `extension/bg/analysis.js` → calls expansion between term resolution and
`searchCoursesBySubjects`.

Tests: `tests/unit/wildcardExpansion.test.js` (11 cases incl. happy path,
Layer C except subtraction, URL pattern correctness, fetcher throw isolation,
attribute-wildcard skip).

## Still open

1. **Live verification after `refactor-on-main` merges** — reload the extension;
  eligible list on CS BS / English-CW audits should be **≥ 50 courses**
   (pre-fix baseline was ~10). If it is not, we reopen instead of closing.
2. **Layer D — attribute-only wildcards** (`@@ with ATTRIBUTE=xxx`). The
  orchestrator skips these with `result.skipped[]` + `reason: "Layer D"`.
   Math core currently leans on Layer A's `hideFromAdvice` concrete siblings,
   which is usually enough. Escalate to Layer D1 (`/api/course-link`
   with `attribute` param — shape TBD via DevTools capture) only if a real audit
   produces a measurably short pool for attribute-heavy cores.
3. **Layer E — many-to-many course→rule mapping.** Still deferred; blocks the
  Phase 1.5 graph-native solver and the "ENG 4358 covers 3 boxes" UX (D9).
4. **Wildcard-valued excepts** (e.g. `CS 2@` as an except). Follow-up only if a
  real audit produces a conflicting overlap between a positive wildcard
   (`CS 4@`) and an except wildcard with overlapping range.
5. **Sections-in-response optimization.** DW's `/api/course-link` response
  includes Banner-shaped `sections[]` inline; we currently ignore them and
   still call `searchCoursesBySubjects`. Latency-only, correctness-neutral; see
   D18 for the "why deferred" rationale (shape-parity risk vs. Banner).

## Verification protocol (when someone picks up live-verify)

1. Build extension; reload in Chrome on CS BS or English-CW audit.
2. Open the full tab; let analysis run. Eligible count should be
  **≥ 50 courses** for a typical Fall term.
3. `console.log` of `result.failures[]` / `result.skipped[]` from
  `expandAuditWildcards` — empty `failures[]` is required; `skipped[]`
   entries for attribute wildcards are expected and OK.
4. If eligible count < 50: capture the failure in a new comment here;
  re-open Jira ticket.

## Links

- `docs/decisions.md` — **D5** (DW is the wildcard resolver), **D13** (Phase 1
wiring postmortem-in-advance), **D18** (fetcher/orchestrator split +
sections-in-response deferral).
- `extension/bg/studentInfo.js`, `extension/requirements/wildcardExpansion.js`,
`extension/bg/analysis.js`.