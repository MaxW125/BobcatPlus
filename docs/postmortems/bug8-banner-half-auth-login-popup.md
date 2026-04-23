# Bug 8 — Login popup stuck on Banner “half-auth” hub instead of SSO

**Status:** ✅ **Closed** (2026-04-22). Architectural decision: `docs/decisions.md` **D19**.

---

## Symptoms

Opening the TXST login popup (from the planner tab when Banner registration
data is missing or stale) showed Ellucian’s anonymous **“What would you like
to do?”** landing — browse / catalog / plan — instead of redirecting to
**TXST SSO** (`authentic.txstate.edu`). The URL still looked like
registration, so the extension assumed progress and verification could spin
until timeouts.

Session cookie clearing via `**fetch`** to `/saml/logout?local=true` alone
did not reliably replace that state when the popup first loaded
`/ssb/…/registration/registration`.

---

## Fix (summary)

Treat **SP-initiated SAML** as the entry URL for the popup:
`StudentRegistrationSsb/saml/login` (see **D19**). Recovery paths that used
to reload plain registration now bounce through the same endpoint; IdP pages
still pause verification; `/saml/login` is **not** treated like the IdP for
timer cancellation so programmatic recovery does not abort the probe loop.

---

## Historical record only

Do not revert to “open `/ssb/registration/registration` first” without
re-reading **D19** — that pattern regresses straight back to the hub.