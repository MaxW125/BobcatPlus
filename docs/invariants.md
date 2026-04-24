# Load-bearing invariants

If you change code without understanding these, you will ship **silent** wrong-term
data, **multi-minute** UI hangs, or **LLM state bleed** between turns. When
`docs/decisions.md` disagrees with this file, **decisions win** and this file
updates.

---

## 1. Session mutex (Banner)

Every call path that touches `term/search` or `getResults` / `searchResults` must
go through `withSessionLock` (service worker, `bg/session.js`) or
`queueRegistrationFetch` (tab, `tab/auth.js`). Parallel calls corrupt Banner’s
per-session “current term” state **without a visible error**. New Banner fetch
work must join one of these queues.

**Manual check:** switch terms quickly; responses must match the selected term.

---

## 2. `bail()` in `runAnalysis` (`bg/analysis.js`)

After **every** `await`, the analysis loop must call `if (bail()) return` (or
equivalent) so a stale run cannot publish UI updates after the user switches
terms. `tests/unit/bailContract.test.js` pins the guard count against
`runAnalysis`’s source.

---

## 3. Bounded pool + timeout (per-CRN Banner work)

Prereq, description, and future restriction fetches run inside
`self.BPPerf.mapPool(…, ≤6, …)` and use `self.BPPerf.fetchWithTimeout(…, ≥12s)`.
D20: **no** inline fallback — if `requirements/*` and `performance/concurrencyPool.js`
do not populate `self.BPReq` / `self.BPPerf` at SW boot, the worker **throws** on
load. Unbounded `Promise.all` + raw `fetch` **reproduced a ~4 minute** eligible-list hang.

**Manual check:** eligible list completes in a few seconds on a typical audit.

---

## 4. Affinity cache wipe (`scheduler/llm/affinity.js` + `scheduler/index.js`)

`affinityCache` (module-local Map in `affinity.js`) must be cleared via
`clearAffinityCache()` as the first statement in `handleUserTurn`. Without it,
prior-turn career keywords bias the next turn.

**Test:** `tests/unit/affinityCache.test.js`.

---

## 5. Jaccard tiered dedup (`pickTop3`)

Do not reduce to “section signature only” deduplication. Tiered Jaccard on **course
sets** preserves “same courses, different lab”-style variety.

**Test:** `tests/unit/ranker.test.js`.

---

## 6. `validateSchedule()` is not the primary gate

The CSP path should already satisfy `calendarBlocks` and conflicts. If
`validateSchedule` fires, treat it as a **solver or data** bug, not something to
silence.

**Test:** `tests/unit/validator.test.js`.

---

## 7. `addToWorkingSchedule` (tab)

Replaces by CRN and transfers the section **lock** together. Do not split those
semantics.

**Manual check:** lock a section, save, reload, confirm lock + CRN consistent.

---

## High-risk areas (edit with care)

| Area | Risk |
| ---- | ---- |
| `bg/session.js` | Mutex bypass → cross-term races |
| `bg/analysis.js` | Missing `bail()` → stale term UI |
| `bg/bannerApi.js` + `bg/prereqs.js` + `runAnalysis` pool | Reverting pool/timeout → long hangs; cache key `subjectSearch\|v2\|` must match semantics |
| `extension/background.js` | Post-import `self.BPReq` / `self.BPPerf` assertions — do not weaken to `console.warn` |
| `tab/schedule.js` | `addToWorkingSchedule` lock/CRN rules |
| `scheduler/llm/affinity.js` | Affinity cache — module-local Map; `clearAffinityCache()` called at top of every `handleUserTurn` |
| `scheduler/solver/rank.js` | Tiered Jaccard dedup in `pickTop3`; `WEIGHT_VECTORS` |
| `scheduler/validate.js` | `validateSchedule` defense-in-depth gate |
| `scheduler/index.js` | `handleUserTurn` orchestrator — affinity wipe call site |
| `tab/auth.js` | `registrationFetchQueue` singleton; SAML `/saml/login` entry (D19) |
