# Bug 10 — Auth error not reflected in the status bar

**Status:** 🟡 Open (deferred, low priority)  
**Filed:** 2026-04-23 (commit 9 doc pass, `refactor-on-main` series)  
**Tracks:** `Refactor` commit `4f48968` ("preserve auth error in status bar") was **not** merged during the ES module port; behavior and DOM wiring on `main` + `refactor-on-main` may still drop or overwrite error strings in the student header / status area.

---

## Symptom

When DegreeWorks or Banner returns an auth or session error (or a recoverable
failure the tab surfaces as "try again"), the **inline status / header text**
does not show the same message the console or message handler produced — the
user sees a generic "Not logged in" or a stale success string.

## Why it matters (UX)

Students blame the extension for "random" logouts. A **specific** reason
(cookies cleared, session expired, DW 401) reduces support load and matches the
`checkAuth` AND-gate messaging already described in D19 / D22 / D23 work.

## Hypothesis

`tab/auth.js` and `tab/overview.js` have multiple code paths that call
`applyStudentInfoToUI` and friends; some paths reset `textContent` to a default
on **any** falsy response without passing through the error object from
`checkAuth`’s `Promise.all` results.

## Scope of fix (expected)

- Thread an optional `authError: string` (or reuse an existing field) from
`checkAuth` through the boot sequence and term-change handler.  
- Map known HTTP statuses / body shapes to a **short, student-safe** string
(no raw HTML).  
- Ensure the "logged in" fast path does not clobber a pending error for ~1 tick
(if a race is confirmed in repro).

## Verification

1. Force a DW 401 (clear DW cookie only, or revoke session server-side if
  available) while keeping Banner warm — or the converse.
2. Confirm the status bar shows **which** side failed, matching
  `checkAuth`’s logic.
3. After successful `loginSuccess`, confirm the error clears.

## Links

- `extension/tab/auth.js` — `checkAuth`, `loadSchedule`  
- `extension/tab/overview.js` — `applyStudentInfoToUI`  
- `docs/postmortems/bug8-banner-half-auth-login-popup.md` (closed — login *entry* UX)  
- `docs/bugs/bug6-import-ux.md` (related import flow)