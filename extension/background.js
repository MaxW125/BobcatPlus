// Bobcat Plus service worker entry point.
//
// ES-module service worker (manifest.json: background.type = "module").
//
// ## Side-effect imports (populate self.BPReq / self.BPPerf)
//
// The four legacy pure-module imports below run IIFE bodies that attach
// to `globalThis` (self.BPReq, self.BPPerf). They are dual-use modules —
// importable in Node unit tests and in the SW — so they don't use real
// ES exports. The post-import assertions turn any "loaded but didn't
// populate" case into a loud startup error instead of a silent regression
// (see D20 in docs/decisions.md when it lands, and the rationale in
// commit 021e87a). Inline fallback copies of mapPool / fetchWithTimeout
// are intentionally NOT kept — if these imports fail the extension is
// broken in a way that must be visible, not papered over.
//
// ## Named imports from bg/* (the real refactor target)
//
// The bg/* modules are browser-only and use standard ES exports. They
// were split out of this file to keep `background.js` under ~150 lines
// as a message router + runAnalysis orchestrator. Dependencies between
// them flow only downstream:
//
//   constants.js  → cache.js / session.js
//                 → bannerApi.js, prereqs.js, registration.js
//                 → studentInfo.js, plans.js
//                 → runAnalysis (still here; commit 7 moves it)
import "./requirements/graph.js";
import "./requirements/txstFromAudit.js";
import "./requirements/wildcardExpansion.js";
import "./performance/concurrencyPool.js";

import { cacheSet } from "./bg/cache.js";
import {
  getTerms,
  getCurrentTerm,
  searchCourse,
  searchCoursesBySubjects,
} from "./bg/bannerApi.js";
import { checkPrereqs, getCourseDescription } from "./bg/prereqs.js";
import {
  getStudentInfo,
  getDegreeAuditOverview,
  getAuditData,
  fetchCourseLinkFromDW,
} from "./bg/studentInfo.js";
import {
  getCurrentSchedule,
  openLoginPopup,
} from "./bg/registration.js";
import {
  saveManualPlanToTxst,
  getBannerPlanItems,
  getAllBannerPlans,
  fetchPlanCalendar,
  deleteTxstPlan,
  getBannerPlanEvents,
} from "./bg/plans.js";

if (!self.BPReq || typeof self.BPReq.buildGraphFromAudit !== "function") {
  throw new Error(
    "[BobcatPlus] extension/requirements/*.js imported but self.BPReq is not populated. " +
      "Reload the extension and check chrome://extensions for load errors.",
  );
}
if (
  !self.BPPerf ||
  typeof self.BPPerf.mapPool !== "function" ||
  typeof self.BPPerf.fetchWithTimeout !== "function"
) {
  throw new Error(
    "[BobcatPlus] extension/performance/concurrencyPool.js imported but self.BPPerf is " +
      "missing mapPool or fetchWithTimeout. Reload the extension and check chrome://extensions.",
  );
}


// Session mutex, cache helpers, Banner section-search, prereq parsing,
// course-description fetching, student + audit fetch (incl. the
// RequirementGraph wiring + fetchCourseLinkFromDW wildcard expansion
// fetcher), and the registered-schedule + SAML login popup flow were
// extracted into extension/bg/*.js in the refactor-on-main commit 4 and
// commit 5 splits. The ES imports at the top of this file bring the
// entry points into scope for runAnalysis and the onMessage router.
// Plan CRUD is in `bg/plans.js` (commit 6). `runAnalysis` is still here;
// commit 7 moves it.

// --- Main analysis function ---
// isCurrent is an optional predicate — when it returns false the caller has
// started a newer analysis, so this run bails early to stop spamming the queue.
async function runAnalysis(sendUpdate, termCodeOverride, isCurrent, { forceRefresh = false } = {}) {
  const current = typeof isCurrent === "function" ? isCurrent : () => true;
  const bail = () => !current();

  sendUpdate({ type: "status", message: "Detecting student info..." });
  const student = await getStudentInfo();
  if (bail()) return;
  sendUpdate({ type: "student", data: student });

  sendUpdate({ type: "status", message: "Loading degree audit..." });
  const {
    completed,
    inProgress,
    needed,
    auditDiagnostics,
    graph,
    wildcards,
  } = await getAuditData(student.id, student.school, student.degree);
  if (bail()) return;
  sendUpdate({
    type: "audit",
    data: {
      completed: completed.length,
      inProgress: inProgress.length,
      needed: needed.length,
    },
  });

  // NOTE: the "bail out if needed is empty" check used to live here, but
  // wildcard expansion (Bug 4 Layer B) can turn an empty concrete pool
  // into a populated one. Moved below, after expansion runs.

  sendUpdate({
    type: "status",
    message: "Resolving semester for section search...",
  });
  let term;
  if (termCodeOverride) {
    const terms = await getTerms();
    if (bail()) return;
    const found = terms.find((t) => t.code === termCodeOverride);
    term = found
      ? { code: found.code, description: found.description }
      : { code: termCodeOverride, description: termCodeOverride };
  } else {
    term = await getCurrentTerm();
    if (bail()) return;
  }
  sendUpdate({ type: "term", data: term });

  // --- Step 2.5: wildcard expansion (Bug 4 Layer B + C) ---
  //
  // RequirementGraph surfaces wildcards separately from concrete
  // `needed[]` entries. Resolve each one via DegreeWorks' course-link
  // endpoint and fold the results back into `needed[]` so they flow
  // through the same section-search → eligibility pipeline as concrete
  // courses. Layer C (honoring `except`) is free — the orchestrator
  // passes `exceptionKeysFromWildcard(w)` into the normalizer's
  // `excludeKeys` option.
  //
  // Failure modes degrade gracefully: if the fetcher returns null for a
  // given wildcard, that requirement just contributes nothing (logged in
  // the console). We never throw here — eligibility is best-effort.
  const bpReqExpandReady =
    typeof self !== "undefined" &&
    self.BPReq &&
    typeof self.BPReq.expandAuditWildcards === "function";

  if (bpReqExpandReady && Array.isArray(wildcards) && wildcards.length > 0) {
    sendUpdate({
      type: "status",
      message:
        "Expanding " +
        wildcards.length +
        " wildcard requirement" +
        (wildcards.length === 1 ? "" : "s") +
        "...",
    });
    try {
      const expansion = await self.BPReq.expandAuditWildcards(
        { wildcards, needed, completed, inProgress },
        { fetchCourseLink: fetchCourseLinkFromDW, termCode: term.code },
      );
      if (bail()) return;
      for (const entry of expansion.added) needed.push(entry);

      if (expansion.failures && expansion.failures.length) {
        console.warn(
          "[BobcatPlus] wildcard expansion: " +
            expansion.failures.length +
            " of " +
            wildcards.length +
            " wildcard(s) failed; those requirements will have no expanded candidates",
          expansion.failures.slice(0, 10).map((f) => ({
            label: f.wildcard && f.wildcard.ruleLabel,
            disc: f.wildcard && f.wildcard.discipline,
            prefix: f.wildcard && f.wildcard.numberPrefix,
            error: f.error,
          })),
        );
      }
      if (expansion.skipped && expansion.skipped.length) {
        console.info(
          "[BobcatPlus] wildcard expansion: " +
            expansion.skipped.length +
            " attribute-only wildcard(s) skipped (Layer D — hideFromAdvice siblings already in needed)",
        );
      }

      sendUpdate({
        type: "audit",
        data: {
          completed: completed.length,
          inProgress: inProgress.length,
          needed: needed.length,
        },
      });
    } catch (e) {
      console.warn(
        "[BobcatPlus] wildcard expansion threw; continuing with concrete needed[] only:",
        e,
      );
    }
  }

  if (needed.length === 0) {
    sendUpdate({
      type: "done",
      data: { eligible: [], blocked: [], notOffered: [], needed: [] },
    });
    return;
  }

  const eligible = [];
  const blocked = [];
  const notOffered = [];
  let oldestCacheTs = null; // track when course data was last fetched from Banner

  // Batch section search by subject (see searchCoursesBySubjects above).
  // We group `needed[]` by subject, make one paginated Banner call per
  // subject, and then index the returned sections back onto each course
  // entry by "${subject}|${courseNumber}". This collapses O(needed) round
  // trips to O(distinct subjects), which is the dominant speedup for this
  // phase.
  const uniqueSubjects = Array.from(
    new Set(
      needed
        .map((c) => (c && typeof c.subject === "string" ? c.subject.trim() : ""))
        .filter(Boolean),
    ),
  );
  sendUpdate({
    type: "status",
    message:
      "Searching " +
      uniqueSubjects.length +
      " subject" +
      (uniqueSubjects.length === 1 ? "" : "s") +
      " (" +
      needed.length +
      " course" +
      (needed.length === 1 ? "" : "s") +
      ")...",
  });
  let subjectSections;
  try {
    subjectSections = await searchCoursesBySubjects(
      uniqueSubjects,
      term.code,
      { forceRefresh },
    );
  } catch (e) {
    console.warn(
      "[BobcatPlus] searchCoursesBySubjects threw; marking all needed as notOffered:",
      e,
    );
    subjectSections = new Map();
  }
  if (bail()) return;

  if (subjectSections && subjectSections.__oldestTs) {
    oldestCacheTs = subjectSections.__oldestTs;
  }

  // Index returned sections by "SUBJECT|COURSENUMBER" for O(1) lookup.
  const sectionsIndex = new Map();
  for (const [, sections] of subjectSections) {
    if (!Array.isArray(sections)) continue;
    for (const s of sections) {
      if (!s) continue;
      const key = (s.subject || "") + "|" + (s.courseNumber || "");
      if (!sectionsIndex.has(key)) sectionsIndex.set(key, []);
      sectionsIndex.get(key).push(s);
    }
  }

  for (const course of needed) {
    if (bail()) return;
    const key = (course.subject || "") + "|" + (course.courseNumber || "");
    const matched = sectionsIndex.get(key);
    if (matched && matched.length > 0) {
      course.crn = matched[0].courseReferenceNumber;
      course.sections = matched;
      // Backfill the legacy per-course cache so the `getCourseSections`
      // UI message handler (which still uses single-course searchCourse)
      // sees a warm cache after an analysis run. Fire-and-forget; cache
      // write failures are non-fatal.
      const perCourseKey =
        `course|${term.code}|${course.subject}|${course.courseNumber}`;
      cacheSet(perCourseKey, matched).catch(() => {});
    } else {
      notOffered.push(course);
    }
  }

  if (bail()) return;

  // Check prereqs and fetch descriptions with bounded concurrency.
  //
  // Previously this fanned out a `Promise.all` over ~120+ courses, which
  // queued against Chrome's 6-sockets-per-origin cap and could wedge the
  // entire analysis if any single socket stalled (no per-request timeout).
  // `mapPool` caps in-flight requests at PREREQ_POOL_CONCURRENCY, and
  // `checkPrereqs` / `getCourseDescription` both use fetchWithTimeout
  // internally. Together that makes this phase bounded in both throughput
  // and worst-case latency. See docs/bug4-eligible-diagnosis.md.
  const coursesWithSections = needed.filter((c) => c.sections);
  const descCache = {};
  const PREREQ_POOL_CONCURRENCY = 6;
  const prereqTotal = coursesWithSections.length;
  let prereqDone = 0;
  // Throttled status tick-down — every 5 completions or every 400ms, whichever
  // comes first. Without this the status line sits on "Checking prerequisites
  // for N courses..." for the whole phase and makes slow runs look hung even
  // when they're making progress.
  let lastTickAt = 0;
  const tickStatus = () => {
    const now = Date.now();
    if (prereqDone === prereqTotal || prereqDone % 5 === 0 || now - lastTickAt > 400) {
      lastTickAt = now;
      sendUpdate({
        type: "status",
        message:
          "Checking prerequisites " + prereqDone + "/" + prereqTotal + "...",
      });
    }
  };
  sendUpdate({
    type: "status",
    message: "Checking prerequisites 0/" + prereqTotal + "...",
  });
  await self.BPPerf.mapPool(
    coursesWithSections,
    PREREQ_POOL_CONCURRENCY,
    async (course) => {
      if (bail()) return;
      try {
        const result = await checkPrereqs(
          course.crn,
          term.code,
          completed,
          inProgress,
        );
        if (bail()) return;
        if (result.met) {
          const cacheKey = course.subject + course.courseNumber;
          if (!descCache[cacheKey]) {
            descCache[cacheKey] = await getCourseDescription(
              course.crn,
              term.code,
            );
          }
          if (bail()) return;
          course.sections.forEach(
            (s) => (s.courseDescription = descCache[cacheKey]),
          );
          eligible.push(course);
          sendUpdate({ type: "eligible", data: course });
        } else {
          course.missingPrereqs = result.missing;
          blocked.push(course);
          sendUpdate({ type: "blocked", data: course });
        }
      } catch (e) {
        if (bail()) return;
        // Prereq check failed (network / timeout / parse error) — show the
        // course but flag it so the UI doesn't silently lie about
        // eligibility. AbortError from fetchWithTimeout lands here too.
        console.warn("[BobcatPlus] prereq check failed for", course.subject, course.courseNumber, e);
        course.prereqCheckFailed = true;
        eligible.push(course);
        sendUpdate({ type: "eligible", data: course });
      } finally {
        prereqDone++;
        tickStatus();
      }
    },
  );

  if (bail()) return;
  sendUpdate({
    type: "done",
    data: {
      eligible,
      blocked,
      notOffered,
      needed,
      cacheTs: oldestCacheTs,
      auditDiagnostics,
      // Phase 1: graph + wildcards flow through but are not yet consumed by
      // the solver. Populated whenever the BPReq modules loaded; null only
      // when the parse failed.
      graph,
      wildcards,
    },
  });
}


// Every new runAnalysis request bumps this. In-flight stale analyses check
// their captured generation against the current one and bail, so concurrent
// runs for different terms collapse to just the latest request.
let analysisGeneration = 0;

// --- Listen for messages from popup and full tab ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runAnalysis") {
    const analysisTerm = message.term || null;
    const myGen = ++analysisGeneration;
    const isCurrent = () => myGen === analysisGeneration;
    runAnalysis((update) => {
      if (!isCurrent()) return;
      chrome.runtime.sendMessage({ ...update, _term: analysisTerm }).catch(() => {});
    }, analysisTerm, isCurrent, { forceRefresh: !!message.forceRefresh });
    sendResponse({ started: true });
  }

  // tab.js fires this at the very top of a term change so stale analyses bail
  // within ~1 searchCourse instead of waiting for the new runAnalysis message
  // (which currently doesn't land until loadSchedule + loadBannerPlans finish).
  if (message.action === "cancelAnalysis") {
    analysisGeneration++;
    sendResponse({ cancelled: true });
  }

  if (message.action === "openFullTab") {
    const q = message.openLogin ? "?login=1" : "";
    chrome.tabs.create({ url: chrome.runtime.getURL("tab.html" + q) });
    sendResponse({ opened: true });
  }

  if (message.action === "openLoginPopup") {
    openLoginPopup(sendResponse, message.term || null);
    return true; // keep channel open for async response
  }

  if (message.action === "getStudentInfo") {
    getStudentInfo()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getDegreeAuditOverview") {
    getDegreeAuditOverview()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getTerms") {
    getTerms()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "getSchedule") {
    getCurrentSchedule(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "runAnalysisForTerm") {
    const myGen = ++analysisGeneration;
    const isCurrent = () => myGen === analysisGeneration;
    runAnalysis((update) => {
      if (!isCurrent()) return;
      chrome.runtime.sendMessage(update).catch(() => {});
    }, message.term || null, isCurrent);
    sendResponse({ started: true });
  }

  if (message.action === "getCourseSections") {
    searchCourse(message.subject, message.courseNumber, message.term)
      .then((data) =>
        sendResponse({
          sections: data && Array.isArray(data) ? data : [],
          found: !!(data && data.length),
        }),
      )
      .catch((e) =>
        sendResponse({
          sections: [],
          found: false,
          error: e.message || String(e),
        }),
      );
    return true;
  }

  if (message.action === "getBannerPlanItems") {
    getBannerPlanItems(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "getBannerPlanEvents") {
    getBannerPlanEvents(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getAllBannerPlans") {
    getAllBannerPlans(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "fetchPlanCalendar") {
    fetchPlanCalendar(message.term, message.planCourses || [])
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "deleteTxstPlan") {
    deleteTxstPlan(message.term, message.planIndex)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  if (message.action === "saveTxstPlan") {
    saveManualPlanToTxst(
      message.term,
      String(message.planName || "").trim(),
      message.rows || [],
      message.uniqueSessionId,
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  return true;
});
