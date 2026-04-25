# Bug 9 — Plans list empty or wrong after term switch

**Status:** 🟡 Open (deferred)  
**Filed:** 2026-04-23 (commit 9 doc pass, `refactor-on-main` series)  
**Replaces / tracks:** `Refactor` commit `d201844` ("load plans before schedule") was **not** merged into `main`’s port; we document the issue instead of silently diverging from the old branch’s ordering fix.

---

## Symptom

User switches the term in the full tab. The Banner Plan list sometimes appears
**empty** or **stale** until an extra refresh or navigation, or plans appear
**inconsistent** with the registered schedule the tab just showed.

## Hypothesis (engineering)

`main`’s boot / term pipeline runs **`loadSchedule` then `loadBannerPlans`**.
`loadSchedule` can touch `registrationHistory/reset` and other class-registration
handshake state that **shares the Banner SSB session** with Plan CRUD. If the
Plan session or synchronizer token is reset **after** plan fetch was expected,
the follow-up `getAllBannerPlans` / plan-items path can return an empty or
inconsistent set while the rest of the UI (calendar from registration events)
still looks valid.

**Contrast:** `Refactor` reordered to load plans in a way that reduced this
window. We have **not** ported that behavioral change on `refactor-on-main` —
this diagnosis captures the trade so a future change can re-order *safely* under
the session mutex (`bg/session.js` + `withSessionLock`) without racing two
Banner modes.

## What *not* to do

- Do not "fix" by duplicating fetches without understanding `withSessionLock`
  and `openLoginPopup`’s SSB handshakes.
- Do not add silent retries that mask 403 HTML pages from Banner.

## Verification (when someone picks this up)

1. Fresh extension load; log in; open full tab.  
2. Note plan count for term A; switch to term B and back to A.  
3. Compare plan list to TXST SSB in-browser for the same terms.  
4. Capture whether `getAllBannerPlans` / `getBannerPlanItems` return `[]` while
   `getRegistrationEvents` is non-empty.

## Links

- `docs/invariants.md` — Banner sessionmutex  
- `docs/postmortems/refactor-on-main-split.md` — deferred Refactor table  
- `extension/bg/plans.js`, `extension/tab/schedule.js`, `extension/tab/auth.js`
