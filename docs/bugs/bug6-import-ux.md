# Bug 6 — Import button UX + auth-expiry handling

**Status:** 🟡 **Deferred.** Fix after Phase 2 / before any refactor to
`background.js`. Tracked in `docs/decisions.md` D11 (deferral rationale).

Scheduler bugs (Bug 1, Bug 4) affect every interaction. The import UX is
a first-use / stale-state annoyance. Aidan explicitly said "probably best
to focus on what we got right now" — correct call.

---

## Symptoms

**Symptom A.** Clicking `Import` does not load the current schedule by
default. The student has to manually interact to see anything.

**Symptom B.** When the extension is opened after SSO auth has expired,
the behavior is confusing: the UI shows stale data with no clear prompt
to re-authenticate.

## Desired end state

No Import button at all. Opening the extension kicks off a background
fetch of the latest data:

- **Auth valid:** the current schedule loads silently within ~1s.
- **Auth invalid:** the user sees a clear "you've been signed out,
 re-authenticate here" banner with a direct link to the SSO flow.

This is the "everything just loads" UX.

## Investigation TODO (when we pick this up)

- Read `extension/background.js` login / SAML / session-expired paths.
Popup entry URL is `**/saml/login`** per **D19** (see `docs/decisions.md`);
Bug 8 diagnosis for the half-auth hub regression is
`docs/postmortems/bug8-banner-half-auth-login-popup.md`.
- Decide whether the "no auth" banner lives in the popup, the tab view,
 or both. The tab is where the full scheduler UI lives, but the popup
is the fastest place to catch the signal.
- Shared session-mutex interaction: does auto-load race with manual
 user interaction? `withSessionLock` (see `CLAUDE.md` § load-bearing
invariants) should already serialize this, but verify no deadlock
paths exist when the session is dead.
- Cache behavior on auth failure: confirm we don't serve stale
 `subjectSearch|v2|…` or `course|…` entries from a previous session
without a visible "last updated" indicator.

## Sibling concern (separate bug, not Bug 6)

"Current schedule doesn't pop up on the calendar when the extension
first loads." Reported by Aidan on 2026-04-21 PM. Likely related to the
same auto-load gap. File its own diagnosis doc when we start
investigating.