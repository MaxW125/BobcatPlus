# Bug 11 — Login popup ping-pongs between Banner and DegreeWorks, never completes

**Status:** ✅ **Closed** (2026-04-23 late). Architectural decisions:
`docs/decisions.md` **D22** (correct fix) supersedes **D21** (reverted).

---

## Symptoms

After clearing cookies and completing SAML login through the extension's
login popup (entered at `/saml/login` per D19), the popup tab "goes
between Banner and DW really slowly then just stops on a weird Banner
page" (user report). The planner tab and toolbar popup both render
"Not logged in" throughout. Reproducible on both `main` and
`refactor-on-main` — not a refactor regression.

---

## Original (wrong) theory — D21

The first hypothesis was that Banner's SAML only warms the Banner SP
cookie on `reg-prod.ec.txstate.edu`, leaving DegreeWorks's SP on
`dw-prod.ec.txstate.edu` cold. We added a silent SW fetch to
`/responsiveDashboard/api/students/myself` on the theory that the IdP
session was already warm and DW's SP-initiated SAML would complete
silently via `resolveRegistrationHtmlToJsonSw`. `probeLoginReady`
AND-gated Banner + DW before firing `loginSuccess`.

This was **architecturally impossible** — see HAR analysis below.

---

## Actual root causes (three, two independent)

The HAR from a reproducing run (`bugged-login.har`, 503 entries, 60s
window) proved three things:

### 1. DW's `/api/students/myself` is API-aware — it returns 401, never redirects

Eleven DW hits in the HAR, all `401 Unauthorized`, `0b` body, **zero
SAML redirects**. DW's API surface does not initiate SAML for unauthed
requests — it just 401s the caller. There is no auto-post HTML chain
for `resolveRegistrationHtmlToJsonSw` to follow. A silent SW fetch
cannot warm the DW SP cookie through this endpoint. Warming
Shibboleth SPs silently requires hitting a URL that redirects to the
SAML flow — UI endpoints like `/responsiveDashboard/worksheets/WEB31`,
not API endpoints. (And even those would hit bug 11.3 below.)

### 2. D21's DW gate caused a death spiral in the verify loop

With `probeDegreeWorksReady()` stuck returning `false`,
`probeLoginReady` stayed `false`. The verify loop fell through to
`softRefreshRegistrationTab`, which calls
`/saml/logout?local=true` to "reset Banner for another SSO attempt".
That logout **nuked the Banner session the user had just completed**.
HAR evidence:

- `08:22:04.534` — `getRegistrationEvents` `200 application/json 3629b`
(Banner authenticated, session good).
- `08:22:06.218`, `08:22:09.138`, `08:22:13.728` — `saml/logout?local=true`
fires repeatedly, each time breaking Banner again.
- Each logout is followed by another round of `https&` POSTs as the
newly-broken Banner session tries to re-SAML.

This is the "bouncing between Banner and DW" the user saw. The visible
popup tab was flipping between Banner's `/ssb/` family and
`restartFromDegreeWorks` → DW worksheet → bounce-back-to-Banner. Ended
on "a weird Banner page" — the Banner `/saml/login` page after
`restartCount >= 4` killed the loop and fired `loginCancelled`.

### 3. Pre-existing parser bug — entity-encoded SAML form action

160 POSTs to `/ssb/classRegistration/https&` in the HAR. Root cause:
`extractHtmlAttr` in `extension/bg/registration.js` returned the raw
regex capture without decoding HTML entities. Banner's current
`/saml/login` AuthnRequest form uses an entity-encoded action:

```
<form action="https://eis-prod.ec.txstate.edu:443/samlsso" method="post">
```

`new URL("https:/...", base)` sees `https&...` as a
relative path (doesn't match scheme syntax), resolves it to
`https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/https&`,
which 302s back to `/saml/login` (invalid registration path), which
we re-parse, which POSTs to `https&` again, ad infinitum until the
resolver's 8-hop budget runs out. Then we retry the whole chain.

`tab.js`'s parser is immune because it uses `DOMParser`, which
decodes entities natively. This is the "split-brain SW vs tab parser"
Composer's earlier notes flagged — and it's the likely reason the
user feels the flow "used to just work": Banner probably started
entity-encoding the form action recently (Shibboleth library update,
server-side).

---

## Fix (D22)

1. **Revert D21.** Restore `probeBannerRegistration` (the D19-era
  Banner-only probe). Delete `probeDegreeWorksReady` /
   `probeLoginReady`. This removes the death spiral.
2. **Decode HTML entities in `extractHtmlAttr`.** Add
  `decodeHtmlEntities(s)` covering numeric (`&#x…;`, `&#…;`) and
   named (`&`, `<`, `>`, `"`, `'`) entities.
   Apply the decode to the regex capture before returning. Fixes the
   `https&` loop permanently for any SAML-aware SW fetch.
3. **Accept clear-cookies half-auth as a known limitation.** Per user
  feedback: *"clear cookies bug can be averted by logging into
   DegreeWorks and registration portal anyways."* `tab.js` `checkAuth`
   still gates on both SPs, so when DW is cold the tab correctly asks
   the user to re-auth — user's workaround (open DW in a tab once) is
   cheap and effective.

Net diff: ~30 lines changed in `extension/bg/registration.js`. No
changes to `background.js`, `tab.js`, `popup.js`, or the manifest.

---

## Deferred follow-ups

- **Happy-path DW warm-up in the popup.** **Done (2026-04-23, D23).**
After `probeBannerRegistration` succeeds, the popup tab navigates to
the DW worksheet URL; when the worksheet loads (`DW_SUCCESS`),
`finishLoginSuccess` runs instead of bouncing back through Banner SAML
(flag `awaitingDwWorksheetAfterBanner` distinguishes recovery vs happy
path).
- **Shared SAML parser across SW + tab.** D22's entity-decode closes
the current divergence, but a DOM-parser-lite shared module would
prevent future drift. Not urgent.

---

## Historical record

- **D21** (reverted) — silent DW warm-up via SW fetch. Impossible by
the API's own design.
- **D22** (landed) — Banner-only probe + entity-decode in SAML parser.
- **Composer-2 notes** (`bug11-auth-session-notes-2026-04-23`, local)
— correctly identified SW-vs-tab parser split-brain and
half-auth UI asymmetry; proposed fix was larger than necessary.
The parser call-out was the actionable insight.
- `**bugged-login.har`** (local) — HAR from the failing D21 run;
contains the evidence for all three root causes above.

