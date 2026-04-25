# Decisions — Bobcat Plus AI Scheduler

A running, dated log of the **architectural and product** decisions that shape
the scheduler. Each entry is an ADR-lite record: *context → decision →
rationale → who can reverse it*. New entries go at the **top**. Do not rewrite
history — add a new entry that supersedes the old one if we change our minds.

This file is the single source of truth for "what did we agree on?" about
**system shape**. Older entries (D2–D14) live in
[`decisions-archive.md`](decisions-archive.md); the newer-date-wins
tiebreaker rule applies across both files. Process / workflow
meta-decisions (gates, model routing, new-chat heuristics) are no longer
ADRs — their substance now lives in
[`../.cursor/rules/process-gates.mdc`](../.cursor/rules/process-gates.mdc)
and the *Session hygiene* section of [`../CLAUDE.md`](../CLAUDE.md). If a
decision here contradicts a plan/RFC in `docs/plans/`, the newer date
wins and the plan must be updated.

---

## 2026-04-25 — D26: Repo + docs cleanup; `process.md` deleted, ADRs split into `decisions-archive.md`

**Context.** Four-person team, lots of accumulated solo-author docs. `process.md`
duplicated guidance that already lived in `CLAUDE.md` *Session hygiene* and was a
process-discipline doc nobody on the team read. ADR log was 50KB and most of
D1–D14 was historically interesting but not load-bearing for current work.

**Decision.** `docs/process.md` deleted. The substance (plan-doc workflow,
postmortem-in-advance, feature-flag-per-phase, metric baselines) moves into
[`../.cursor/rules/process-gates.mdc`](../.cursor/rules/process-gates.mdc)
where Cursor loads it automatically when editing plan / decision files —
the agents read it, humans don't have to memorize it. Model routing /
new-chat heuristics stay in `CLAUDE.md` *Session hygiene*. ADRs D2–D14
move to [`decisions-archive.md`](decisions-archive.md). Active log
becomes D17 onward.

**Rationale.** Doc discipline that depends on humans reading a long doc
fails by design at our scale. Pinning the rules to the files they apply
to (via `.cursor/rules/`) and shrinking the active ADR log is the
smaller-surface, lower-friction version of the same intent.

**Reversible by.** `git revert` of the cleanup commit. The deleted
`process.md` is recoverable via `git log --diff-filter=D --follow -- docs/process.md`.

---

## 2026-04-23 — D24: Refactor-branch follow-ups `a2583f6` and `832a155` closed without port

**Context.** The legacy `Refactor` branch (pre–`main` merge) had additional commits
after the module split. During `refactor-on-main` we explicitly **did not**
cherry-pick some of them because `main` already contains equivalent or strictly
better behavior.

**Decision.**

1. `**a2583f6` (10s `AbortController` on prereq fetch):** **Superseded** by
  `**e687ad6`** and the D20 path — all per-CRN work goes through
   `self.BPPerf.fetchWithTimeout` (12–15s) inside `self.BPPerf.mapPool` in
   `bg/prereqs.js` + `bg/analysis.js`. No separate timer layer is required.
2. `**832a155` (import popup "logged in" fix):** **Superseded** by **D19** and
  the merged registration/login flow — SP-initiated SAML at `/saml/login`, popup
  - `openLoginPopup` in `bg/registration.js` handle the half-auth class of bugs
   differently than the old patch.

**Rationale.** Prevents double-fix debt and documents why those commits do not
appear as separate SHAs on `refactor-on-main`.

**Reversible by.** N/A (informational close-out). If we ever revert `e687ad6` or
D19, reassess the old Refactor diffs in isolation.

**See also.** `docs/postmortems/refactor-on-main-split.md` (deferred from
the old `Refactor` branch); `docs/open-bugs.md` for Bug 9 / 10 pointers.

---

## 2026-04-23 (late) — D22: Revert D21 — popup probe stays Banner-only; fix SAML form parser entity decode instead

**Context.** D21 shipped as an uncommitted patch on `refactor-on-main`;
user smoke testing failed. HAR from the failing run
(`bugged-login.har`) showed two independent issues that D21 got
wrong:

1. **DW `/api/students/myself` is API-aware.** It returns `401` directly
  with no redirect to SAML (11 hits in the HAR, all `401`, zero
   `Location:` headers). A silent SW fetch cannot warm DW's SP cookie
   because there is no SAML chain for `resolveRegistrationHtmlToJsonSw`
   to follow. D21's `probeDegreeWorksReady` is architecturally
   impossible on that endpoint.
2. **Death spiral when DW probe fails forever.** With `probeLoginReady`
  stuck returning `false`, the verify loop falls through to
   `softRefreshRegistrationTab`, which calls `/saml/logout?local=true`
   and nukes the Banner session the user just completed. Banner then
   needs re-auth, probe fails again, another `saml/logout` fires, etc.
   Visible in the HAR as `getRegistrationEvents` 200-JSON at `08:22:04`
   followed by `saml/logout` fires at `08:22:06`, `:09`, `:13` — the
   exact "slowly bouncing between Banner and DW, stopped on a weird
   Banner page" the user described.
3. **Separate pre-existing parser bug surfaced.** 160 POSTs to
  `/ssb/classRegistration/https&` in the HAR are caused by
   `extractHtmlAttr` in `extension/bg/registration.js` not decoding
   HTML entities. Banner's current `/saml/login` AuthnRequest form
   ships with
   `action="https://eis-prod.ec.txstate.edu:443/samlsso"`.
   The regex captures the raw string, `new URL(rawAction, baseHref)`
   treats it as a relative path, we POST to garbage, Banner 302s back
   to `/saml/login`, loop. `tab.js` does not hit this because it uses
   `DOMParser`, which decodes entities for free. This is the
   "split-brain SW vs tab parser" Composer's earlier notes called out.

**Decision.**

1. Revert `probeLoginReady` + `probeDegreeWorksReady` in
  `extension/bg/registration.js`. Restore `probeBannerRegistration`
   (the D19-era single-channel probe).
2. Fix `extractHtmlAttr` to HTML-entity-decode its return value before
  handing it to `new URL(...)`. The SW's regex path now matches the
   tab's `DOMParser` path on this axis.
3. Accept DW half-auth after clear-cookies as a known limitation. The
  user has a working workaround (visit DW once manually to trigger
   DW's SAML). `tab.js` `checkAuth` still gates on both SPs, so the
   tab correctly asks the user to re-authenticate when DW is cold.

**Rationale.** D21's premise — that the SW could warm DW silently —
was wrong. DW's API endpoint does not redirect unauthed requests; it
401s. There is no silent path to set the DW SP cookie. The only
silent fetches that can warm a Shibboleth SP are those that hit a URL
which the SP itself redirects into SAML (i.e., UI endpoints, not
API endpoints). Even that path would have been stopped by the
pre-existing entity-decode bug in item 3 above. Fixing the real
pre-existing loop bug is the load-bearing change; the D21 probe was
cargo-culted architecture that caused more breakage than it fixed.

**Postmortem-in-advance.** *If we hit half-auth complaints again:*

1. **Preferred path:** have `openLoginPopup` navigate the popup tab
  through the DW worksheet URL once after `probeBannerRegistration`
   passes, and wait for the `DW_SUCCESS` URL before firing
   `loginSuccess`. That uses the real browser (with JavaScript) to
   execute the IdP's auto-post, which silent fetch cannot. Same
   mechanism `restartFromDegreeWorks` already uses — we'd just wire it
   into the happy path instead of the recovery path. Small change,
   ~20 lines, self-contained.
2. **Alternative:** loosen `checkAuth` in `tab.js` to require Banner
  only and lazy-warm DW on first DW-dependent action. Rejected
   today because DW is needed early in the planner flow (audit
   overview, degree requirements).

**Reversible by.** Revert this commit; D21's code still works for any
future environment where DW's API is re-fronted with an SP redirect.

**Landed.** `refactor-on-main`, 2026-04-23, after HAR-verified failure
of D21. See `docs/postmortems/bug11-post-saml-degreeworks-warmup.md`
(updated with correction notes).

Item **3** ("accept DW half-auth after clear-cookies") is **superseded
for the login-popup flow** by **D23** — users who complete SAML in the
popup now hit DW in the same tab before `loginSuccess`.

---

## 2026-04-23 — D23: Happy-path login popup navigates to DegreeWorks worksheet after Banner probe

**Context.** D22 treated post-clear-cookies DW coldness as acceptable
because the user could open DegreeWorks manually once. That still left
the planner tab on "Not logged in" after a successful Banner SAML in
the popup — bad UX for the common "clear all cookies" dev/test flow.

**Decision.** In `extension/bg/registration.js` `openLoginPopup`, after
`probeBannerRegistration` succeeds: set `awaitingDwWorksheetAfterBanner`
and `chrome.tabs.update` the popup tab to the DW worksheet URL (same
as `restartFromDegreeWorks`). When `chrome.tabs.onUpdated` sees a URL
containing `responsiveDashboard/worksheets` while that flag is set,
call `finishLoginSuccess()` — close the popup and send `loginSuccess`.
Do **not** redirect to Banner SAML in that case. When the flag is
clear (recovery path after a failed Banner probe), keep the existing
behavior: worksheet → `/saml/login?_dw=…`.

If Banner probe passes again while the flag is already set (user
navigated back to Banner SSB before the worksheet finished loading),
re-`update` the tab to the worksheet URL.

**Rationale.** DW's REST API does not initiate SAML (D22); only a real
document navigation can complete the DW SP handshake. This reuses the
same browser mechanism as recovery, wired into the happy path.

**Reversible by.** Deleting the flag and the first-branch navigation in
the probe success path; popup would again close on Banner-only readiness.

**Landed.** `refactor-on-main`, 2026-04-23.

---

## 2026-04-23 — D21: Login popup gates `loginSuccess` on BOTH Banner and DegreeWorks being ready

**Status (2026-04-23 late):** **Superseded by D22.** D21 never
committed — reverted before landing after HAR evidence showed the
premise (silent DW warm via SW fetch) was architecturally impossible.
Kept here as a decision record; see D22 for details and the correct
fix (entity-decode in the SAML form parser).

**Context.** After D19 fixed the popup landing page (`/saml/login`), a
second half-auth failure mode remained. The popup's verify tick only
probed Banner registration; once Banner returned schedule data the popup
fired `loginSuccess` and closed. But DegreeWorks is a distinct Shibboleth
SP on `dw-prod.ec.txstate.edu`, and Banner's SAML round-trip only warms
the Banner SP cookie jar on `reg-prod.ec.txstate.edu`. Result: popup
closed, tab.js `checkAuth` (which requires both endpoints) immediately
returned false, UI rendered "Not logged in" despite a successful SAML
login a moment earlier. Reproducible on cleared cookies on both `main`
and `refactor-on-main`. See `docs/postmortems/bug11-post-saml-degreeworks-warmup.md`.

**Decision.**

1. `openLoginPopup` in `extension/bg/registration.js` replaces the
  single-channel `probeBannerRegistration(term)` with a two-channel
   `probeLoginReady(term)` that AND-gates on:
  - `probeBannerReady(term)` — existing fast-then-slow schedule probe,
  unchanged.
  - `probeDegreeWorksReady()` — new silent fetch to
  `https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself`
  with `credentials: "include"` + `redirect: "follow"`. The IdP
  session is already warm from Banner's SAML, so DW's SP-initiated
  SAML completes silently via the auto-post HTML chain. Reuse the
  existing SP-agnostic `resolveRegistrationHtmlToJsonSw` to resolve
  the chain; accept only a body that parses to
  `{ _embedded: { students: [...] } }`.
2. `scheduleVerify`'s tick calls `probeLoginReady` — `loginSuccess`
  only fires once both SPs are authenticated.
3. The two-channel probe's AND-gate intentionally matches tab.js
  `checkAuth`'s AND-gate. If one side ever needs to change, both sides
   change together — they are a pair.

**Rationale.** The popup and the tab are describing the same concept
("is the user signed in?") on opposite sides of the extension wire. When
those two descriptions disagree, the user experiences a "popup closed
successfully, but the app says I'm not logged in" failure. The fix is
to align the two definitions. Since tab.js `checkAuth` has historically
been the authoritative consumer — it gates every action the tab takes —
the popup's probe moves to match it, not the other way around.

Probing DW inside the popup (in the SW) rather than asking the tab to
warm DW post-`loginSuccess` keeps session-warming ceremony in one place
(`openLoginPopup`), and keeps the popup closed until the user actually
has a working session to return to. The alternative — let the popup
close early and have the tab warm DW on its own — was rejected because
the tab is where users see the "Not logged in" message, and the bad UX
of seeing that message flash on after a successful login was the exact
symptom we were fixing.

**Postmortem-in-advance.** *Six months from now we rolled this back.*

1. **Failure mode:** DegreeWorks consolidates with Banner onto a single
  SP so the silent warm-up is redundant. **Mitigation:** collapse
   `probeLoginReady` back to Banner-only; delete `probeDegreeWorksReady`.
   Zero user-visible change.
2. **Failure mode:** A DW-side outage makes the silent probe fail
  persistently while Banner is healthy, stranding users in the popup
   until the 90s deadline. **Mitigation:** the popup already sends
   `loginCancelled` on deadline, and tab.js handles that gracefully.
   If the outage is long enough to be a real problem, loosen
   `probeDegreeWorksReady` to gate on `r.ok` only (accept 200-HTML) as
   a temporary degraded mode; that's one line.
3. **Failure mode:** DW changes `/api/students/myself` envelope shape
  and the `_embedded.students[0]` check stops matching. **Mitigation:**
   update the shape check to match the new response; this is the same
   fragility `getStudentInfo` already has, not a new one.

**Reversible by.** Reverting the `openLoginPopup` / probe changes in
`extension/bg/registration.js`. Symptom reproduces immediately on any
clear-cookies login flow.

**Landed.** `refactor-on-main`, 2026-04-23 (pending user browser smoke
before commit is pushed).

---

## 2026-04-23 — D20: Service worker runs as an ES module; no inline `BPPerf.`* fallback

**Context.** `extension/background.js` previously loaded
`extension/performance/concurrencyPool.js` + `extension/requirements/*.js`
via `importScripts()` inside a `try/catch`, and kept a hand-written copy
of `BPPerf.mapPool` + `BPPerf.fetchWithTimeout` inline (~80 lines) as a
"fallback" that would silently activate if the import failed. That copy
could drift from the canonical implementation unnoticed, and a failed
deploy would quietly run with the duplicate — the exact silent-
regression mode that reintroduced the prereq hang during Bug 4.

**Decision.**

1. `manifest.json` → `"background": { "type": "module" }`.
2. `background.js` replaces `importScripts(...)` with static ES
  side-effect imports of the same four modules
   (`requirements/graph.js`, `txstFromAudit.js`, `wildcardExpansion.js`,
   `performance/concurrencyPool.js`).
3. The inline `BPPerf.*` fallback block is **deleted**.
4. Post-import assertions throw loudly if `self.BPReq.buildGraphFromAudit`
  / `self.BPPerf.mapPool` / `self.BPPerf.fetchWithTimeout` are not
   populated after the imports. The service worker refuses to start
   rather than run in a partial-load state.

**Rationale.** ES-module static imports are all-or-nothing — if any
module can't be resolved or parsed, the SW fails to start at a visible
point (`chrome://extensions` shows the error). That's a stronger contract
than silent fallback. The inline duplicate could not be unit-tested
without becoming a second code path that itself needed tests; deleting
it removes a class of possible regressions (drift between canonical
and inline impl) that was never actually guarding against a real
failure mode.

The "Files NOT to touch carelessly" row in `CLAUDE.md` that previously
warned against weakening the inline fallback is superseded; the new
contract is the three-line assertion block in `background.js` lines
25–40.

**Reversible by.** A real MV3 regression where ES-module service workers
fail to load consistently across a Chrome channel we must support. At
that point we revert to classic SW + `importScripts`, and re-evaluate
whether to restore the fallback or accept hard failure.

**Landed.** `refactor-on-main` commit `021e87a`, 2026-04-23.

---

## 2026-04-22 — D19: Banner login popup opens SP-initiated SSO (`/saml/login`), not `/registration` alone

**Context.** The Chrome login popup (`openLoginPopup` in `extension/background.js`)
must drive students through **real TXST SSO** when registration session data is
missing or stale. Opening `**…/ssb/registration/registration` first** often
painted Banner’s **anonymous “What would you like to do?” hub** — same broad
URL family as a signed-in flow — while `**fetch`/logout priming** in the service
worker did not always clear enough **tab** cookie state to leave that hub.
Users sat on a half-session surface that never showed the IdP.

**Decision.**

1. **Initial popup URL** — `https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/saml/login`

(SP-initiated SAML; Ellucian standard path). Banner redirects to
`authentic.txstate.edu` when credentials are needed.
2. **Recovery after failed registration JSON probes** — navigate the popup tab to
the same `/saml/login` URL (with a cache-busting query param), after the
existing `**/saml/logout?local=true`** `fetch` that clears cookies in the
worker. Do **not** rely on reloading `/registration` alone.
3. **DegreeWorks fallback** (`restartFromDegreeWorks`) — after a worksheet load,
send the tab to `**/saml/login`**, not straight to `/registration`, so the
student does not fall back into the anonymous hub.
4. Tab update listener — pause JSON verification timers only on actual
IdP / SAML POST URLs (`authentic.txstate.edu`, `…/idp/profile/SAML2/POST/SSO`),
not on `/saml/login`. The extension sometimes navigates the tab to
`/saml/login` on purpose; treating it like “user is at IdP” cleared timers and
broke recovery.
5. `**scheduleVerify`** — allow rescheduling when the tab navigates again (clear
the previous timer) so a return from SSO starts a fresh probe cycle; drop the
`if (verifying) return` guard that could skip probes after IdP completion.
6. **Probe scope** — consider any `…/StudentRegistrationSsb/ssb/…` load (not only
URLs containing `registration/registration`) so post-login landings on e.g.
class registration still run verification.

**Rationale.** `/saml/login` is the stable **service-provider** entry that
Banner expects for a new login round-trip; `/registration` as a bookmark URL is
optimized for browsers that already hold a student session. The extension cannot
assume that shape.

**Postmortem-in-advance.** *Six months from now we rolled this back.*

1. **Failure mode:** TXST changes the SAML entry path (different path than

`/saml/login`). **Mitigation:** capture the new DevTools navigation from a
clean profile; one-line URL constant update in `openLoginPopup`.
2. **Failure mode:** `/saml/login` loops or 404s for a subset of accounts.
**Mitigation:** same — verify in browser; consider dual entry (logout **page**
in-tab was worse UX but forced SSO — documented in Bug 8 history).

**Reversible by.** Reverting the `openLoginPopup` commit(s) that introduced D19.
The UX regression is immediate if the popup again opens `/registration` without
`/saml/login`.

---

## 2026-04-21 PM — D18: Bug 4 Layer B + C ship with split fetcher/orchestrator; defer sections-in-response optimization

**Context.** Bug 4's Layer B (wildcard expansion) was blocked for a week
on capturing the DegreeWorks endpoint URL. A maintainer pulled it from a live
DevTools trace today: `GET /api/course-link?discipline=CS&number=4%40`,
session cookie auth, response wrapped in a `courseInformation.courses[]`
envelope. Layer A (concrete `hideFromAdvice` fallbacks) had already
shipped in `0cbceb6` and the pure normalizer + test fixture had been
living in `requirements/wildcardExpansion.js` since Phase 1; the only
missing piece was the HTTP layer + the dedup/except orchestration that
consumes the normalizer's output and folds results back into `needed[]`.

The shape of the work forced three architectural sub-decisions.

**Decision 1 — Split the HTTP fetcher from the pure orchestrator.** The
HTTP + `chrome.storage.local` cache lives in `background.js` as
`fetchCourseLinkFromDW(subject, numberPattern)`; the dedup / except /
termCode logic lives in `requirements/wildcardExpansion.js` as
`BPReq.expandAuditWildcards(input, { fetchCourseLink, termCode })`
with the fetcher **injected** so Node unit tests can drive the
orchestrator with a canned fetcher that replays `cs-4@.json`.

The alternative — a single monolithic function in `background.js` —
would have been testable only via a full-extension integration harness
(browser + DW session cookie + Banner login), which is exactly the kind
of test environment that doesn't exist in this project. The split cost
~30 LOC of injection plumbing and bought 11 unit tests that run in
200ms against real fixture data.

**Decision 2 — Layer C ships in the same wire as Layer B.** The bug4
diagnosis doc originally drew Layer C ("honor `except` clauses") as a
parser-only change. In practice the RequirementGraph parser already
attached each wildcard's `exceptOptions[]` (shipped with Phase 1); the
normalizer already supported an `excludeKeys` option (shipped with the
Phase 1 offline commit). Layer C's "work" was just routing
`exceptionKeysFromWildcard(w) → excludeKeys → normalizer` inside the
new orchestrator. Since the orchestrator was being written for Layer B
anyway, splitting them into two commits would have been artificial. They
ship together; the test suite covers the except-subtraction behavior
separately from the expansion behavior so regression bisection stays
clean.

**Decision 3 — Do NOT take the sections-in-response optimization.** The
`courseInformation` payload includes Banner-shaped `sections[]` inline
for each course. The bug4 doc's 2026-04-21 update calls this out as a
free latency win: for wildcard-expanded entries, we'd no longer need the
per-course `searchCourse` call against Banner. We deferred it for this
ship because:

- The inline sections aren't byte-for-byte identical to Banner's
`searchResults` response. Downstream scheduler code has hard
assumptions about specific Banner fields (meeting-time format,
enrollment counts, seat-remaining). An unverified shape switch is a
latent-bug generator.
- Unifying concrete and wildcard-sourced entries through the same
section-search path means one source of truth for
"offered-this-term / seats / meeting times". That's a correctness
benefit worth the latency cost.
- Correctness was the Bug 4 blocker. Layer B already solves it;
latency-tuning can come later without changing behavior.

The optimization remains on the table as a future phase once section
shape parity is explicitly verified; acceptance criterion #10 from the
bug4 diagnosis 2026-04-21 update is left open with that note.

**Scope deferred (unchanged from D13/bug4 doc):**

- **Layer D** (attribute-only `@@ with ATTRIBUTE=xxx` wildcards): the
orchestrator `skips[]` these with a logged reason naming Layer D.
The Math core path continues to rely on the `hideFromAdvice`
concrete siblings that RequirementGraph already surfaces (Layer A).
If a live verification shows a measurably short pool for
attribute-heavy cores, Layer D1 (attribute filter via the same
`/api/course-link` endpoint) becomes the follow-up; the bug4 doc
left that door open.
- **Wildcard-valued `except` entries** (e.g. `CS 2@` used as an
except): `exceptionKeysFromWildcard` only collects concrete excepts.
The CS fixture test confirms this is a no-op in practice (2xxx is
outside a 4@ expansion), but a contrived overlap could slip through.
Follow-up if a real audit produces a conflict.
- **Layer E** (many-to-many course → rule mapping): still deferred;
unrelated to this ship.

**Files touched in this ship:**

- `extension/background.js` — adds `CACHE_TTL.courseInfo`,
`fetchCourseLinkFromDW`, and the expansion call inside
`runAnalysis` between term resolution and the Banner section-search
loop. Moves the "empty needed → early return" check to after
expansion (wildcards can turn an empty concrete pool into a
populated one).
- `extension/requirements/wildcardExpansion.js` — adds
`expandAuditWildcards` async orchestrator; dual-exported via
`BPReq`. Top-of-file comment updated to reflect that Layer B is
no longer a stub.
- `tests/unit/wildcardExpansion.test.js` — adds 11 new async cases
covering happy path, fixture-derived expected set, Layer C except
subtraction, three-way dedup, URL-pattern correctness, null-fetcher
failures, fetcher-throw isolation, attribute-wildcard skipping,
validation on missing options, empty-wildcards no-op, and
termCode=null behavior. Total suite now 108 passing, 0 failing.
- `tests/unit/run.js` — minimal runner change to await `c.run()` when
it returns a promise, keeping all pre-existing sync tests unchanged.
- `docs/bugs/bug4-eligible.md` (now `bugs/scrum-63-eligible.md`) — status header updated; revised
strategy table marks A/B/C shipped, D/E/sections-optimization
deferred.
- `HANDOFF.md` — phase table row X rewritten; next-action #4 closed,
new #5 added ("live-verify Layer B/C"), subsequent steps renumbered.

**Rationale.** Eligibility is the floor of the product. A scheduler
that proposes four courses for a student who actually has fifty
options isn't an AI scheduler — it's a broken filter. Bug 4 was
blocking the AI scheduler's credibility at a foundational level (no
amount of ranking can fix a truncated candidate set) and also
blocking the manual schedule builder (same `needed[]` feeds the
eligible pool there). Layers B + C buy both surfaces out of that
hole in a single commit.

The split-fetcher pattern should become the default for any future
DW/Banner endpoint integration in this codebase: **HTTP + cache lives
in `background.js`; pure consumer logic lives in a
`requirements/*.js` module with an injected fetcher**. It's the only
pattern that survives the Node-unit-test constraint we adopted in
Phase 0.

**Postmortem-in-advance.** *Six months from now, we rolled part of
this back. What happened?*

1. **Failure mode:** The `/api/course-link` endpoint starts rate-
  limiting, or returns a new auth challenge, or DW changes the
   response envelope. Every wildcard expansion fails in production;
   students see the pre-Bug-4 ~10-course pool again.
   **Mitigation:** `fetchCourseLinkFromDW` degrades to `null` on any
   non-200 or malformed-envelope response (logged via
   `console.warn`). `expandAuditWildcards` records each failure in
   `result.failures[]` so `runAnalysis` can log which requirements
   lost their candidates and why. The concrete `needed[]` still flows
   through normally; the student gets the Layer-A pool back. The
   ship degrades, doesn't crash.
2. **Failure mode:** The 1h cache TTL proves too long — a student
  adds/drops something in DW and wildcard results go stale.
   **Mitigation:** Cache key is scoped to `(subject, numberPattern)`
   only, not to the student. The "stale" data is "what courses exist
   in this subject range" — that doesn't change within a semester,
   and between semesters the cache expires anyway. If it still
   matters, `forceRefresh` can be threaded through from
   `runAnalysis` the same way `searchCourse` already supports it
   (one-line change).
3. **Failure mode:** Attribute wildcards (Layer D) turn out to
  matter more than Layer A's hideFromAdvice siblings cover — e.g. a
   Math core prompt surfaces only 2 options instead of 15.
   **Mitigation:** The orchestrator's `result.skipped[]` makes this
   visible; `[BobcatPlus] wildcard expansion: N attribute-only  wildcard(s) skipped` is logged on every run. If N is high and
   eligible pools look short, Layer D1 (try
   `/api/course-link?discipline=@&number=@&attribute=020` or whatever
   DW's actual parametrization is) becomes the next ship, no
   architecture change.

**Reversible by.** `git revert` on the Layer B + C commit. The
normalizer, cache helpers, and RequirementGraph wildcards survive the
revert (they pre-existed); only the fetcher + orchestrator + runAnalysis
wiring unwind. Takes ~30 seconds. Tests go back to 97 passing.

---

## 2026-04-21 PM — D17: Strip `bp_phase1_`* + `bp_phase2_`* feature flags; commit revert is the rollback

**Context.** The scheduler grew five `chrome.storage.local` feature flags
across two phases (`bp_phase1_wiring`, `bp_phase1_shadow`,
`bp_phase1_wildcards`, `bp_phase2_solver_prefordering`,
`bp_phase2_solver_hardfloor`). Each was added to support D10/D15's
"feature flag per phase" gate — the idea being that rollback should be a
toggle in storage, never a revert. That gate made sense when we didn't
trust a phase enough to default it on. Both phases that actually
shipped are now live-verified:

- Phase 1 (`bp_phase1_wiring`) — shadow-mode parity run on CS BS audit
matched the baseline exactly (D13); HANDOFF said "flipping
`bp_phase1_wiring` ON is safe" on the day it shipped.
- Phase 2 precursor (`bp_phase2_solver_`*) — verified live against the
same "no classes before noon, no classes friday" prompt that produced
the original Bug 1 trace (D14 status update).

Maintainer call: keep the flags only while they're earning their keep. With
both phases green, the flag plumbing is pure cognitive overhead — every
fresh AI session has to re-explain what each flag gates, test harnesses
have to pass default-on objects through three function layers, and the
`chrome.storage` round-trip in the hot path is wasted work.

**Decision.** Remove all `bp_phase1_`* and `bp_phase2_`* flags from the
codebase. Collapse each gated branch to its default-on behavior. The
one remaining guard is the legacy-fallback path in `background.js`
(used only when `importScripts` fails to load the `BPReq` modules);
that's a runtime safety net, not a user-toggleable flag.

Concretely:

- `extension/scheduleGenerator.js`: delete `PHASE2_SOLVER_FLAG_KEYS` +
`getPhase2SolverFlags`; drop the `phase2Flags` param from
`buildConstraints` / `solveMulti` / `solveWithRelaxation`;
`pref-distance` ordering and hardfloor promotion are now
unconditional.
- `extension/background.js`: stop reading `bp_phase1_wiring` /
`bp_phase1_shadow`. RequirementGraph is the authoritative source for
`needed[]` whenever the BPReq modules loaded successfully; legacy
`findNeeded` is the fallback for the module-load-failure path only.
Drop `auditDiagnostics.phase1Flags` (no downstream consumers).
- Tests updated to match the simplified signatures; the "flag OFF" unit
cases were deleted (not rewritten, since a flag-OFF path no longer
exists) and one was replaced with a weight-gate equivalent
("hedged phrasing → no hard constraint").
- Comments in `wildcardExpansion.js` and `generate-phase1-baseline.js`
scrubbed of stale flag references.

**Rationale.** Flags aren't free. Every one is a public API surface
contract with the chrome.storage schema, a code-review tax, and a new
onboarding sentence in HANDOFF. They pay for themselves during the
uncertain window between "shipped" and "trusted"; after that window
they're overhead. D17 enshrines the lifecycle: **add flag → ship behind
it → verify live → strip the flag → commit-revert is the rollback.**
This supersedes the "rollback is a toggle, never a revert" line from
D15's Process gate #2 — that line got rewritten to reflect the new
shape ("commit-scoped rollback", flags optional during the ship-to-
verify window).

We retain the option of adding a new flag for a future phase if the
risk calculus warrants it — D17 doesn't forbid flags, it just stops
treating them as mandatory infrastructure and requires they get
removed once the feature has stabilized.

**Postmortem-in-advance.** *Six months from now, we rolled this back.
What happened?*

1. **Failure mode:** A regression slips in on a prompt shape we didn't
  test (e.g., "absolutely no Wednesdays, preferably no mornings") and
   the old flag-off escape hatch would've let us bisect "flag plumbing"
   vs "solver logic" in seconds. With flags removed, we have to bisect
   the whole commit.
   **Mitigation:** The commits are scoped (one for Fix A+B together,
   one for flag removal), so `git bisect` against the Bug 1/3 regression
   set still walks exactly two commits. The 98→97 unit-test harness
   covers declarative-no + hedged + negative cases; adding a new prompt
   shape to the harness costs one test, not a flag.
2. **Failure mode:** Live `chrome.storage.local` values set by beta
  testers before D17 are now silently ignored; if a tester flipped a
   flag OFF to work around a bug, their "fix" now stops working without
   any surface signal. **Mitigation:** There is currently no beta cohort.
   If one appears later,
   D17 itself (this entry) is the record to consult first when
   debugging "my flag stopped working".

**Reversible by.** `git revert` on the D17 commit, followed by
revisiting D15's Process gate #2. The decision is cheap to undo for
any one phase (re-add a flag to gate its new behavior), but D17's
guidance — "flags get stripped once verified" — stays in force even
if a single flag gets reintroduced elsewhere.

---

_(D2–D14 archived to [`decisions-archive.md`](decisions-archive.md) on 2026-04-25.)_

---

## 2026-04-23 — D25: ESM flip — `window.BP` removal, `scheduleGenerator.js` deletion, H1 harness, `package.json`

**Context.** `extension/scheduleGenerator.js` (2098 lines, IIFE, `window.BP` globals) was the
last monolith in the repo after the `refactor-on-main` bg/tab split. The scheduler refactor
(C1–C7, branch `scheduler-refactor`, Jira SCRUM-34) extracted it into 15 ESM modules under
`extension/scheduler/`. C6 completed the atomic ESM flip.

**Decisions made in this refactor:**

1. **`window.BP` surface deleted entirely** (Deviation S). Unlike the bg refactor which kept
   `self.BPReq` / `self.BPPerf` as side-effect globals (D20), the scheduler is consumed only
   from the tab runtime and Node tests — both of which have clean import access. Global aliases
   revive the wrong habit; named imports are the right habit. Any regression gets a missing-import
   error, not silent undefined.

2. **Classic script → ESM, tab-only** (`extension/scheduler/` is not cross-environment). The bg
   modules (`requirements/*`, `performance/*`) are cross-environment and stay global-attach.
   `scheduler/*` is tab-only; native `import` is the right primitive.

3. **H1 test harness** (dynamic `import()` in CJS `_harness.js`). H2 (full ESM test suite) would
   touch ~10 test files in what is supposed to be pure code motion. H1 isolates the ESM boundary
   to `_harness.js`. Follow-up ticket for H2 filed; H1's "temporary" must not become permanent.

4. **`package.json` added** (minimal, 5 fields, no scripts, no lockfile). `type: "commonjs"`
   documents H1's resolver contract; `engines.node` pins the silent Node ≥ 18 assumption;
   `private: true` prevents accidental publish. Adding scripts / deps is scope creep — separate PR.

**Reversible by.** `git revert` the C6 + C7 merge commits together. C5 back-compat shim was
never created (the classic-script constraint made it impossible); reverting C6 requires manually
re-adding the `scheduleGenerator.js` IIFE from `git show bfaf886^:extension/scheduleGenerator.js`.
