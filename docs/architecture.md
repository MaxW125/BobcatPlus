# Architecture

Bobcat Plus is a Chrome extension (Manifest V3) with **two JavaScript
execution contexts** that must not import each other’s code:


| Context        | Entry                        | Network role                                                                                                                                                |
| -------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker | `extension/background.js`    | DegreeWorks API, Banner SSB, `chrome.storage.local` (via `bg/cache.js`).                                                                                    |
| Tab page       | `extension/tab.js` → `tab/`* | UI; **OpenAI** Chat Completions for the v3 pipeline (`extension/scheduler/`*, user-supplied key); `chrome.runtime.sendMessage` to the worker only. |


**Hard rule:** never import `tab/`* from `background.js` or vice versa. The
contexts share TXST session cookies in the browser profile but run in
separate isolates. All cross-context work is message-based.

**Refactor (2026):** `main`+`refactor-on-main` split the former monoliths into
`extension/bg/`* (service worker) and `extension/tab/`* (page). Entry files
stay thin: `background.js` (~~224 lines) is the `onMessage` router + analysis
generation counter; `tab.js` (~~212 lines) boots the page and handles term
change. Browse `extension/` directly for module layout — every module has a
top-of-file comment explaining its role.

---

## Eligible-course pipeline (background)

High-level data path from audit to UI (details live in `bg/studentInfo.js`,
`bg/analysis.js`, `bg/bannerApi.js`, `bg/prereqs.js`):

```
getStudentInfo        → { id, school, degree }
getAuditData          → { completed, inProgress, needed, graph, wildcards }
       │
       ▼
BPReq.expandAuditWildcards (DW course-link, except subtraction)
       │
       ▼
searchCoursesBySubjects  → Map<subject, sections[]>
       │
       ▼
index by "subject|courseNumber"  → sections on each needed[] row
       │
       ▼
BPPerf.mapPool (≤6)   → per course-with-sections: checkPrereqs, getCourseDescription
                          (BPPerf.fetchWithTimeout, ≥12s)
       │
       ▼
eligible | blocked | notOffered
       │
       ▼
sendUpdate({ type: "done" })  → tab renders; solver consumes eligible list
```

Source of truth for *which* courses are needed: `BPReq.deriveEligible` /
RequirementGraph path in `requirements/txstFromAudit.js` (legacy `findNeeded`
is fallback only — see `docs/decisions.md` D17).

---

## AI scheduler (v3 hybrid)

One entry point: `handleUserTurn(...)` in `extension/scheduler/index.js` (imported directly by `tab/ai.js`).

1. **Intent LLM** — `callIntent()`; frozen IntentSchema v1.
2. **Calibrator** — `calibrateIntentWeights()`; hedges / hard phrasing near weight fields.
3. **Context recap** — UI surfaces parsed intent for quick correction.
4. **Affinity LLM** — `callAffinity()`; cache wiped at the start of each user turn.
5. **CSP solver** — `solveMulti()` + `solveWithRelaxation()`; hard constraints never violated.
6. **Ranker** — `pickTop3()` with tiered Jaccard dedup on course sets.
7. **Rationale LLM** — `callRationales()`; facts only, no invention.

*Why this shape:* LLM for language; deterministic core for conflicts and
credits; `validateSchedule()` is defense in depth (if it fails, fix the
solver). Invariants: `[invariants.md](invariants.md)`.

### v3 pipeline (reference diagram)

```
[ userMessage ]
      │
      ▼
┌────────────────────────┐
│ 1. Intent LLM          │  gpt-4o-mini, temp 0 — `callIntent()`
│    (frozen schema v1)  │
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 1b. calibrateIntent    │  Deterministic: hedge/hard language near weights
│     Weights()          │
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 2. Context recap       │  Surfaces in UI for fast misread correction
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 3. Affinity LLM        │  `callAffinity()`; cache cleared each turn
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 4. CSP solver          │  `solveMulti` + `solveWithRelaxation`
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 5. Ranker              │  `pickTop3` — tiered Jaccard on course sets
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 6. Rationale LLM       │  `callRationales()` — structured facts in only
└──────────┬─────────────┘
           ▼
     [ actions[] → tab / calendar ]
```

---

## External systems


| System              | Base (typical)                                                                                   | Auth / notes            |
| ------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| DegreeWorks         | `https://dw-prod.ec.txstate.edu/responsiveDashboard/api`                                         | TXST session cookie     |
| Banner registration | `https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb`                                     | TXST session cookie     |
| OpenAI              | `https://api.openai.com/v1/chat/completions` (called from `scheduler/llm/openai.js` in the **tab**) | API key in page context |
| Rate My Professor   | GraphQL (via `facultyScraper.js`)                                                                | None (public)           |


`manifest.json` also lists `https://ml3392.app.n8n.cloud/`* — there is **no
current in-repo call site** to that host; the shipped LLM path is direct OpenAI.
If a webhook path is reintroduced, document it here and in `decisions.md`.

**Login:** Banner’s anonymous hub is easy to hit without IdP. The extension
uses **SP-initiated SAML** at `StudentRegistrationSsb/saml/login` for the login
popup and related recovery — see `docs/decisions.md` D19 and
`docs/postmortems/bug8-banner-half-auth-login-popup.md`. Post–SAML DW warm-up
in the popup: D22 / D23 / `docs/postmortems/bug11-post-saml-degreeworks-warmup.md`.

---

## Cache contract (`chrome.storage.local`)

All reads: `cacheGet(key, ttl)`. All writes: `cacheSet(key, data)`. Never
write raw objects without the wrapper (TTL + `{ data, ts }` envelope).


| Key family (pattern) | TTL (indicative) | Notes     |
| -------------------- | ---------------- | --------- |
| `course              | {term}           | …`        |
| `subjectSearch       | v2               | …`        |
| `prereq              | {term}           | {crn}`    |
| `desc                | {term}           | {crn}`    |
| `courseLink          | …`               | 1 h       |
| `terms`              | 24 h             | Term list |


Version or bump key shapes when semantics change (e.g. `subjectSearch\|v2\|`).