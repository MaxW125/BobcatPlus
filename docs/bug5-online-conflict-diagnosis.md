# Bug 5 — Conflict detector flags online courses against in-person courses

**Status:** ✅ **Closed.** Shipped 2026-04-21 AM in commit `fda436e`
(`phase0: instrument scheduler + ship test harness + fix Bug 5`).
`detectWorkingConflict()` now delegates to the shared `BP.findOverlapPair()`
helper in `scheduleGenerator.js`, which authoritatively skips
`online: true` entries regardless of populated meeting fields. 10
regression tests landed in `tests/unit/overlap.test.js`.

The data-normalization sustainable fix (zero out `days` / `beginTime` /
`endTime` at ingestion when `online: true`) is deferred to Phase 1
wiring, per D11.

This document is kept as the **historical record** of the failure mode.

---

## Symptom

Screenshot: the working schedule contains MATH 3305 (MW 3:20–4:50 PM)
and CS 4371 CRN 35071 (`Online - Computer System Security`). The status
bar fires `⚠ MATH 3305 overlaps with CS 4371 on Wed`. CS 4371 is
labeled online in the schedule summary *and* appears in the bottom
"online / asynchronous" bar — yet the conflict detector flags it.

## Root cause (two parts)

1. **Banner returns meeting-time data for sections whose
  `instructionalMethod === "INT"`.** The ingest code in `tab.js`
   (around lines 1658 and 1801) sets `online: true` on the course object
   but keeps the meeting-time fields (`days`, `beginTime`, `endTime`)
   populated. Result: data inconsistency — the course is logically
   online but has times.
2. **`detectWorkingConflict()` only short-circuited on empty times, not
  the `online` flag.** In `tab.js` (line 2652 at time of writing), the
   loop short-circuited when `days` was empty or `beginTime` / `endTime`
   was null. It did not check `online`, so it treated the phantom Banner
   times as real meeting times.

## Short fix (shipped)

In `detectWorkingConflict`, skip entries whose `online` flag is set, and
route both sides of the comparison through `BP.findOverlapPair()` so
the logic lives in one place:

```js
for (let i = 0; i < workingCourses.length; i++) {
  const a = workingCourses[i];
  if (a.online) continue;
  for (let j = i + 1; j < workingCourses.length; j++) {
    const b = workingCourses[j];
    if (b.online) continue;
    // ...
  }
}
```

## Sustainable fix (deferred to Phase 1 wiring, per D11)

Normalize online sections at ingestion: when `online: true` is set on a
`workingCourses` entry, also zero out `days`, `beginTime`, `endTime`.
That way every downstream consumer stays correct without having to
remember the invariant.

Candidates to update when this phase lands:

- `tab.js:68`
- `tab.js:1031` (already OK)
- `tab.js:1658`
- `tab.js:1801`
- `tab.js:2473`

## Defense in depth

`tests/unit/overlap.test.js` includes a `workingCourses`-shape scenario
with a registered MWF 3 PM course + a CS 4371 "online but days=[Wed],
begin/end populated" course, asserting `detectWorkingConflict()`
returns null. Add any new ingestion paths to this test when the
Phase-1 normalization lands.