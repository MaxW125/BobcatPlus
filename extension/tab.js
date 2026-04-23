// ============================================================
// TAB — thin ES-module entry point for the full-page Bobcat Plus
// UI. All feature logic lives in ./tab/*; this file only:
//   1. imports those modules (DOM wiring happens at module load)
//   2. boots the page once terms come back from the background
//   3. handles the term <select> change
// Anything else belongs in a ./tab/* module per
// docs/refactor-on-main-plan.md (Deviation B: direct imports for
// addMessage / waitWithChatCountdown — no callback injection).
// ============================================================

import * as State from "./tab/state.js";
import { $ } from "./tab/state.js";
import {
  applyStudentInfoToUI,
  updateOverviewFromEvents,
  setPanelMode,
} from "./tab/overview.js";
import {
  buildEmptyCalendar,
} from "./tab/calendar.js";
import {
  renderSavedList,
  loadBannerPlans,
} from "./tab/schedule.js";
import {
  checkAuth,
  loadSchedule,
} from "./tab/auth.js";
import {
  autoLoadEligibleCourses,
} from "./tab/eligibleList.js";
import {
  bumpChatGeneration,
  clearRejectedCandidates,
} from "./tab/ai.js";
// Side-effect imports — these modules register DOMContentLoaded /
// button / chrome.runtime listeners at evaluation time.
import "./tab/modal.js";
import "./tab/chat.js";

// ── BOOT ─────────────────────────────────────────────────

(async () => {
  // Toolbar "Login" URL hand-off: ?login=1 means we were opened so the
  // user can sign into TXST. Clean the query string and wait for
  // loginSuccess/loginCancelled before probing auth.
  let loginFromToolbar = false;
  try {
    const p = new URLSearchParams(location.search);
    if (p.get("login") === "1") {
      loginFromToolbar = true;
      p.delete("login");
      const qs = p.toString();
      history.replaceState({}, "",
        location.pathname + (qs ? "?" + qs : "") + location.hash);
    }
  } catch (_) {}

  // Student header + overview: prefer the cached DegreeWorks audit so we
  // can render progress/GPA immediately; fall back to plain student info.
  chrome.runtime.sendMessage({ action: "getDegreeAuditOverview" }, (auditData) => {
    if (auditData && auditData.name) {
      applyStudentInfoToUI(auditData);
      State.setDegreeAuditSnapshot(auditData);
      updateOverviewFromEvents([]);
    } else {
      chrome.runtime.sendMessage({ action: "getStudentInfo" }, (student) => {
        if (student) {
          applyStudentInfoToUI(student);
          State.setDegreeAuditSnapshot(null);
        } else {
          $("studentName").textContent = "Not logged in";
          State.setDegreeAuditSnapshot(null);
        }
        updateOverviewFromEvents([]);
      });
    }
  });

  chrome.storage.local.get(
    ["savedSchedules", "calendarBlocks", "avoidDays"],
    (result) => {
      if (result.savedSchedules) State.setSavedSchedules(result.savedSchedules);
      if (result.calendarBlocks) State.setCalendarBlocks(result.calendarBlocks);
      if (Array.isArray(result.avoidDays)) State.setAvoidDays(result.avoidDays);
      renderSavedList();
    },
  );

  chrome.runtime.sendMessage({ action: "getTerms" }, (terms) => {
    if (!terms || terms.length === 0) return;
    const select = $("termSelect");
    const now = new Date();
    let currentIdx = 0;
    for (let i = 0; i < terms.length; i++) {
      const desc = String(terms[i].description || "");
      if (/\(view only\)/i.test(desc)) continue;
      if (/correspondence/i.test(desc)) continue;
      const dateMatch = desc.match(/(\d{2}-[A-Z]{3}-\d{4})/);
      if (dateMatch) {
        const startDate = new Date(dateMatch[1]);
        if (startDate <= now) { currentIdx = i; break; }
      }
    }
    const descByCode = Object.create(null);
    terms.forEach((t, i) => {
      descByCode[String(t.code)] = String(t.description || "");
      const opt = document.createElement("option");
      opt.value = t.code;
      opt.textContent = t.description;
      if (i === currentIdx) opt.selected = true;
      select.appendChild(opt);
    });
    State.setTermDescriptionsByCode(descByCode);
    State.setCurrentTerm(terms[currentIdx].code);
    buildEmptyCalendar();

    (async () => {
      const gen = State.bumpTermChangeGeneration();
      if (loginFromToolbar) {
        $("statusBar").textContent =
          "Complete TXST sign-in in the window — Bobcat Plus will load when registration is ready.";
        await new Promise((resolve) => {
          const listener = (msg) => {
            if (msg.type === "loginSuccess" || msg.type === "loginCancelled") {
              chrome.runtime.onMessage.removeListener(listener);
              resolve();
            }
          };
          chrome.runtime.onMessage.addListener(listener);
          chrome.runtime.sendMessage(
            { action: "openLoginPopup", term: State.currentTerm }, () => {},
          );
        });
        // Skip the "stale session → re-open login" recovery once — we
        // just came back from a real login, empty results are legit.
        try {
          sessionStorage.setItem(State.SKIP_EMPTY_RECOVER_ONCE, "1");
        } catch (_) {}
      }
      const ok = await checkAuth();
      if (gen !== State.getTermChangeGeneration()) return;
      if (ok) {
        await loadSchedule(State.currentTerm);
        if (gen !== State.getTermChangeGeneration()) return;
        // Banner session is warm after loadSchedule, so plans fetch cheaply.
        await loadBannerPlans(State.currentTerm);
        if (gen !== State.getTermChangeGeneration()) return;
        autoLoadEligibleCourses();
      } else {
        $("statusBar").textContent =
          "Use Import Schedule to sign in and load your registration.";
        // Plans endpoint is session-independent, so still attempt it.
        await loadBannerPlans(State.currentTerm);
      }
    })();
  });
})();

// ── TERM CHANGE ──────────────────────────────────────────

$("termSelect").addEventListener("change", async (e) => {
  const gen = State.bumpTermChangeGeneration();
  // Bump chatGeneration so any in-flight handleUserTurn goes stale and
  // bails before dispatching actions to the now-invalid term context.
  bumpChatGeneration();
  State.setCurrentTerm(e.target.value);
  // Cancel any in-flight analysis immediately — otherwise the old term
  // keeps firing searchCourse calls for 2-3s until the new runAnalysis
  // message lands.
  try {
    chrome.runtime.sendMessage({ action: "cancelAnalysis" }, () => {});
  } catch (_) {}
  State.setAnalysisResults(null);
  State.setCachedRawData(null);
  State.setCachedRegisteredCourses([]);
  State.setCachedRegisteredTerm(null);
  State.setConversationHistory([]);
  clearRejectedCandidates();
  State.setBannerPlans([]);
  State.setRegisteredScheduleCache({});
  State.setEligibleCourses([]);
  State.setShowOpenSeatsOnly(false);
  State.setExpandedCourseKey(null);
  State.setWorkingCourses([]);
  State.setLockedCrns(new Set());
  State.setNewPlanDisplayName("");
  State.setNewPlanSingleClickOpensEdit(true);
  if (State.newPlanClickTimer) {
    clearTimeout(State.newPlanClickTimer);
    State.setNewPlanClickTimer(null);
  }
  buildEmptyCalendar();
  // Force "no meetings" counters so the header doesn't briefly show the
  // previous term's numbers while the new schedule loads.
  updateOverviewFromEvents([]);
  setPanelMode("build");
  const ok = await checkAuth();
  if (gen !== State.getTermChangeGeneration()) return;
  if (ok) {
    await loadSchedule(State.currentTerm);
    if (gen !== State.getTermChangeGeneration()) return;
    await loadBannerPlans(State.currentTerm);
    if (gen !== State.getTermChangeGeneration()) return;
    autoLoadEligibleCourses();
  } else {
    $("statusBar").textContent =
      "Use Import Schedule to sign in and load your registration.";
    await loadBannerPlans(State.currentTerm);
  }
});
