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

import {
  getTerms,
  searchCourse,
} from "./bg/bannerApi.js";
import {
  getStudentInfo,
  getDegreeAuditOverview,
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
import { runAnalysis } from "./bg/analysis.js";

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
