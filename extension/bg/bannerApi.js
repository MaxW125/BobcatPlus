// Bobcat Plus — Banner registration API (ES module).
//
// All calls that touch `term/search` or `searchResults/searchResults`
// route through `withSessionLock` (bg/session.js) — interleaving those
// calls across terms corrupts Banner's per-session "current term" state
// silently. See docs/invariants.md #1.
//
// Per-request socket safety is delegated to `self.BPPerf.fetchWithTimeout`
// (populated by the side-effect import of performance/concurrencyPool.js
// at SW boot). A single stalled TCP socket on Chrome's 6-per-origin cap
// used to wedge the whole analysis — see docs/bugs/bug4-eligible.md
// for the 4-minute-hang repro.
//
// Public surface:
//   - getTerms()                   → every non-Correspondence term code
//   - getCurrentTerm()             → the active (non-View-Only) term
//   - searchCourse(subject, num)   → sections for one course (UI message path)
//   - searchCoursesBySubjects(…)   → batched subject fan-out (runAnalysis path)

import { BANNER_BASE_URL } from "./constants.js";
import { cacheGet, cacheSet, cacheAge, CACHE_TTL } from "./cache.js";
import { withSessionLock } from "./session.js";

export async function getTerms() {
  const response = await fetch(
    BANNER_BASE_URL +
      "/classSearch/getTerms?searchTerm=&offset=1&max=25",
    { credentials: "include" },
  );
  const terms = await response.json();
  return terms.filter((t) => !t.description.includes("Correspondence"));
}

export async function getCurrentTerm() {
  const response = await fetch(
    BANNER_BASE_URL +
      "/classSearch/getTerms?searchTerm=&offset=1&max=25",
    { credentials: "include" },
  );
  const terms = await response.json();
  const active = terms.find(
    (t) =>
      !t.description.includes("View Only") &&
      !t.description.includes("Correspondence"),
  );
  return { code: active.code, description: active.description };
}

// --- Batch section search — one paginated Banner call per subject.
//
// This replaces the per-course call-pattern that used to drive runAnalysis
// and was the dominant bottleneck (see docs/bugs/bug4-eligible.md:
// "20-25s for 123 courses"). Each single-course searchCourse call does a
// 3-request handshake (resetDataForm + term/search + searchResults), all
// serialized behind the withSessionLock queue. Batching by subject collapses
// N courses across K subjects into a single session handshake plus one
// paginated searchResults call per subject — typically K≈10-15 vs N≈120.
//
// Results are cached under `subjectSearch|v2|${term}|${subject}` with the
// same 1h TTL as single-course search, and also fan out into the legacy
// per-course cache key (handled by the caller) so the `getCourseSections`
// UI message handler (which still uses the single-course searchCourse
// path) sees a warm cache after any analysis run.
export async function searchCoursesBySubjects(
  subjects,
  term,
  { forceRefresh = false } = {},
) {
  const unique = Array.from(
    new Set(
      (Array.isArray(subjects) ? subjects : [])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean),
    ),
  );
  const results = new Map();
  if (unique.length === 0) return results;

  // Cache key version suffix: bump whenever caching semantics change so
  // previously poisoned entries auto-expire rather than surviving their
  // 1h TTL. v1→v2: we no longer cache partial/failed subject searches
  // (see the `gotSuccessfulPage && fullyPaginated` guard below).
  const SUBJECT_CACHE_VERSION = "v2";
  const cacheKeyFor = (subject) =>
    `subjectSearch|${SUBJECT_CACHE_VERSION}|${term}|${subject}`;

  const toFetch = [];
  let oldestTs = null;
  for (const subject of unique) {
    const key = cacheKeyFor(subject);
    if (!forceRefresh) {
      const cached = await cacheGet(key, CACHE_TTL.course);
      // Defense in depth: even within v2, treat an empty cached array as
      // a miss. If a subject legitimately has zero sections this term
      // we'll refetch once per analysis (cheap — K subjects, not N
      // courses), which is the right trade vs silently masking every
      // course in the subject.
      if (cached && Array.isArray(cached) && cached.length > 0) {
        results.set(subject, cached);
        const ts = await cacheAge(key, CACHE_TTL.course);
        if (ts && (oldestTs === null || ts < oldestTs)) oldestTs = ts;
        continue;
      }
    }
    toFetch.push(subject);
  }
  if (toFetch.length === 0) {
    results.__oldestTs = oldestTs;
    return results;
  }

  await withSessionLock(async () => {
    // Single session handshake covers every subject we still need to
    // fetch. Banner's class-search mode is per-term, not per-subject —
    // once the term is selected, subsequent searchResults calls with
    // different `txt_subject` values all reuse the same session.
    await fetch(
      BANNER_BASE_URL + "/classSearch/resetDataForm",
      { method: "POST", credentials: "include" },
    );
    await fetch(
      BANNER_BASE_URL + "/term/search?mode=search",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          term: term,
          studyPath: "",
          studyPathText: "",
          startDatepicker: "",
          endDatepicker: "",
        }).toString(),
      },
    );

    const PAGE_MAX = 500; // Banner caps practical page size; we loop if needed
    const PAGE_CAP = 20;  // safety valve — no subject has 10k sections

    for (const subject of toFetch) {
      let pageOffset = 0;
      const all = [];
      let pageIdx = 0;
      // Track whether we ever received a well-formed successful response
      // for this subject. Without this, a timeout / 500 / malformed body
      // on the first page causes us to cache an empty array, which would
      // then mask every course in the subject as "not offered" for the
      // entire 1h cache TTL — the exact "eligible count keeps dropping
      // between runs" failure mode.
      let gotSuccessfulPage = false;
      let fullyPaginated = false;
      while (pageIdx < PAGE_CAP) {
        const form = new FormData();
        form.append("txt_subject", subject);
        form.append("txt_term", term);
        form.append("pageOffset", String(pageOffset));
        form.append("pageMaxSize", String(PAGE_MAX));
        form.append("sortColumn", "subjectDescription");
        form.append("sortDirection", "asc");
        form.append("startDatepicker", "");
        form.append("endDatepicker", "");
        form.append("uniqueSessionId", subject + "-" + Date.now());
        let result;
        try {
          const response = await self.BPPerf.fetchWithTimeout(
            BANNER_BASE_URL + "/searchResults/searchResults",
            { method: "POST", credentials: "include", body: form },
            20000,
          );
          result = await response.json();
        } catch (e) {
          console.warn(
            "[BobcatPlus] batch search failed for subject " +
              subject +
              " (page " +
              pageIdx +
              "): ",
            e,
          );
          break;
        }
        if (!result || !result.success || !Array.isArray(result.data)) break;
        gotSuccessfulPage = true;
        all.push(...result.data);
        const total = Number(result.totalCount);
        if (!Number.isFinite(total) || all.length >= total) {
          fullyPaginated = true;
          break;
        }
        pageOffset += PAGE_MAX;
        pageIdx++;
      }

      // Expose the current run's best-effort results regardless of cache
      // policy — `runAnalysis` should still get whatever we managed to
      // fetch this run.
      results.set(subject, all);

      // Only write to the 1h cache if we actually got a complete, valid
      // response. Partial pagination or hard failures stay uncached so
      // the next analysis re-tries with a fresh session instead of
      // inheriting a poisoned-empty subject.
      if (gotSuccessfulPage && fullyPaginated) {
        const key = cacheKeyFor(subject);
        await cacheSet(key, all);
        const ts = await cacheAge(key, CACHE_TTL.course);
        if (ts && (oldestTs === null || ts < oldestTs)) oldestTs = ts;
      } else {
        console.warn(
          "[BobcatPlus] subject " +
            subject +
            " search incomplete (pages=" +
            (pageIdx + (fullyPaginated ? 1 : 0)) +
            ", rows=" +
            all.length +
            "); not caching so the next run retries fresh",
        );
      }
    }
  });

  results.__oldestTs = oldestTs;
  return results;
}

// Single-course section search. Still used by the `getCourseSections`
// message handler (section-picker UI). After searchCoursesBySubjects
// runs, runAnalysis backfills the per-course cache for every needed
// course, so this hits a warm cache for the common path.
export async function searchCourse(subject, courseNumber, term, { forceRefresh = false } = {}) {
  const key = `course|${term}|${subject}|${courseNumber}`;
  if (!forceRefresh) {
    const cached = await cacheGet(key, CACHE_TTL.course);
    if (cached) return cached;
  }
  return withSessionLock(async () => {
    await fetch(
      BANNER_BASE_URL + "/classSearch/resetDataForm",
      { method: "POST", credentials: "include" },
    );
    await fetch(
      BANNER_BASE_URL + "/term/search?mode=search",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          term: term,
          studyPath: "",
          studyPathText: "",
          startDatepicker: "",
          endDatepicker: "",
        }).toString(),
      },
    );
    const searchForm = new FormData();
    searchForm.append("txt_subject", subject);
    searchForm.append("txt_courseNumber", courseNumber);
    searchForm.append("txt_term", term);
    searchForm.append("pageOffset", "0");
    searchForm.append("pageMaxSize", "50");
    searchForm.append("sortColumn", "subjectDescription");
    searchForm.append("sortDirection", "asc");
    searchForm.append("startDatepicker", "");
    searchForm.append("endDatepicker", "");
    searchForm.append(
      "uniqueSessionId",
      subject + courseNumber + "-" + Date.now(),
    );
    const response = await fetch(
      BANNER_BASE_URL + "/searchResults/searchResults",
      { method: "POST", credentials: "include", body: searchForm },
    );
    const result = await response.json();
    if (result.success && result.data && result.data.length > 0) {
      await cacheSet(key, result.data);
      return result.data;
    }
    return null;
  });
}
