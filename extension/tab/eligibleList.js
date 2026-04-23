// ============================================================
// ELIGIBLE LIST — background-analysis runner plus the left-panel
// "eligible courses" list (click-to-toggle sections, open-seats
// filter, cache-age chip). Lives apart from schedule.js so the
// runAnalysisAndWait Chrome listener has a clear home.
// ============================================================

import * as State from "./state.js";
import { $ } from "./state.js";
import { formatTime24to12 } from "./calendar.js";
import {
  addToWorkingSchedule, removeFromWorkingSchedule, updateSaveBtn,
} from "./schedule.js";

let eligibleAnalysisSeq = 0;

// ── background analysis runner ───────────────────────────

export function runAnalysisAndWait({ forceRefresh = false } = {}) {
  const mySeq = ++eligibleAnalysisSeq;
  const termAtStart = State.currentTerm;
  return new Promise((resolve) => {
    const stale = () => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ eligible: [], blocked: [], notOffered: [], needed: [], _skippedStaleTerm: true });
    };
    const results = { eligible: [], blocked: [], notOffered: [], needed: [] };
    const listener = (message) => {
      if (eligibleAnalysisSeq !== mySeq || State.currentTerm !== termAtStart) {
        stale();
        return;
      }
      if (message._term !== undefined && message._term !== termAtStart) {
        stale();
        return;
      }
      if (message.type === "status") $("statusBar").textContent = message.message;
      if (message.type === "eligible") results.eligible.push(message.data);
      if (message.type === "done") {
        chrome.runtime.onMessage.removeListener(listener);
        results.notOffered = message.data.notOffered;
        results.needed = message.data.needed;
        results.cacheTs = message.data.cacheTs || null;
        resolve(results);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({
      action: "runAnalysis",
      term: State.currentTerm,
      forceRefresh,
    });
  });
}

export async function autoLoadEligibleCourses({ forceRefresh = false } = {}) {
  if (
    !forceRefresh &&
    State.analysisResults &&
    (State.analysisResults.eligible || []).length > 0
  ) {
    State.setEligibleCourses(State.analysisResults.eligible);
    renderEligibleList();
    return;
  }
  const statusEl = $("eligibleStatus");
  if (statusEl) statusEl.textContent = "Loading your eligible courses…";
  const analysisResults = await runAnalysisAndWait({ forceRefresh });
  State.setAnalysisResults(analysisResults);
  if (analysisResults._skippedStaleTerm) return;
  State.setCachedRawData(analysisResults);
  State.setEligibleCourses(analysisResults.eligible || []);
  renderEligibleList();
  renderCacheAge(analysisResults.cacheTs);
}

export function renderCacheAge(cacheTs) {
  const el = $("eligibleCacheAge");
  if (!el) return;
  if (!cacheTs) { el.textContent = ""; return; }
  const ageMs = Date.now() - cacheTs;
  const mins = Math.floor(ageMs / 60000);
  const label = mins < 1 ? "just now"
    : mins < 60 ? mins + "m ago"
    : Math.floor(mins / 60) + "h ago";
  el.innerHTML =
    "<span>Seat data from cache · " + label + "</span>" +
    "<button id='refreshEligibleBtn' class='bp-icon-btn'>" +
    "<svg width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' " +
    "stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'>" +
    "<polyline points='23 4 23 10 17 10'/>" +
    "<path d='M20.49 15a9 9 0 1 1-2.12-9.36L23 10'/></svg>Refresh</button>";
  const btn = document.getElementById("refreshEligibleBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      State.setAnalysisResults(null);
      autoLoadEligibleCourses({ forceRefresh: true });
    });
  }
}

// ── one-line section formatter ───────────────────────────

export function formatSectionOneLine(section) {
  const sn = String(
    section.sequenceNumber ?? section.sectionNumber ?? section.section ?? "?",
  );
  const mt = section.meetingsFaculty?.[0]?.meetingTime;
  let timeStr = "";
  if (mt && mt.beginTime) {
    const days = [];
    if (mt.monday) days.push("Mon");
    if (mt.tuesday) days.push("Tue");
    if (mt.wednesday) days.push("Wed");
    if (mt.thursday) days.push("Thu");
    if (mt.friday) days.push("Fri");
    const bh = parseInt(mt.beginTime.slice(0, 2));
    const bm = parseInt(mt.beginTime.slice(2));
    const eh = parseInt(mt.endTime.slice(0, 2));
    const em = parseInt(mt.endTime.slice(2));
    if (days.length) {
      timeStr = " · " + days.join("/") + " " +
        formatTime24to12(bh, bm) + "–" + formatTime24to12(eh, em);
    }
  }
  const online = section.instructionalMethod === "INT" ? " · Online" : "";
  const seats = section.seatsAvailable != null
    ? " · " + section.seatsAvailable + " seats"
    : "";
  return "Section " + sn + timeStr + online + seats;
}

// ── list renderer ────────────────────────────────────────

export function renderEligibleList() {
  const list = $("eligibleList");
  const status = $("eligibleStatus");
  if (!list) return;
  const eligibleCourses = State.eligibleCourses || [];
  if (!eligibleCourses.length) {
    list.innerHTML = "";
    if (status) {
      status.textContent = !State.analysisResults
        ? "Loading eligible courses…"
        : "No eligible courses found for this term.";
    }
    return;
  }
  const seenKeys = new Set();
  const dedupedCourses = eligibleCourses.filter((course) => {
    const k = course.subject + "-" + course.courseNumber;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });

  // openSection can be true even when seatsAvailable === 0 (admin-open,
  // waitlisted, etc.). Require both so the filter only shows real seats.
  const hasRealOpenSeat = (s) => s.openSection && (s.seatsAvailable == null || s.seatsAvailable > 0);
  const filteredCourses = State.showOpenSeatsOnly
    ? dedupedCourses.filter((course) => (course.sections || []).some(hasRealOpenSeat))
    : dedupedCourses;

  if (status) {
    const chipClass = "bp-chip" + (State.showOpenSeatsOnly ? " active" : "");
    status.innerHTML =
      "<span>" + filteredCourses.length + " eligible courses</span>" +
      "<button id='seatsToggleBtn' class='" + chipClass + "'>" +
      (State.showOpenSeatsOnly ? "✓ Open only" : "Open only") + "</button>";
    const toggleBtnEl = document.getElementById("seatsToggleBtn");
    if (toggleBtnEl) {
      toggleBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        State.setShowOpenSeatsOnly(!State.showOpenSeatsOnly);
        renderEligibleList();
      });
    }
  }
  list.innerHTML = "";

  if (!filteredCourses.length) {
    list.innerHTML = '<div class="saved-empty">No courses with open seats for this term.</div>';
    return;
  }

  filteredCourses.forEach((course) => {
    const key = course.subject + "-" + course.courseNumber;
    const openCount = (course.sections || []).filter(hasRealOpenSeat).length;
    const totalCount = (course.sections || []).length;
    const alreadyAdded = State.workingCourses.some(
      (c) => c.subject === course.subject &&
             c.courseNumber === course.courseNumber &&
             c.source !== "registered",
    );
    const item = document.createElement("div");
    item.className = "eligible-course" + (alreadyAdded ? " added" : "");
    const header = document.createElement("div");
    header.className = "eligible-course-header";
    header.innerHTML =
      '<span class="eligible-name">' + course.subject + " " + course.courseNumber +
      '<span class="eligible-req"> — ' + (course.label || "") + "</span></span>" +
      '<span class="eligible-meta">' + openCount + "/" + totalCount + " open</span>";
    header.addEventListener("click", () => {
      State.setExpandedCourseKey(State.expandedCourseKey === key ? null : key);
      renderEligibleList();
    });
    item.appendChild(header);

    if (State.expandedCourseKey === key) {
      const body = document.createElement("div");
      body.className = "eligible-course-body";
      const courseTitle = course.sections[0]?.courseTitle
        ?.replace(/&amp;/g, "&")
        ?.replace(/&#39;/g, "'") || "";
      if (courseTitle) {
        const titleEl = document.createElement("div");
        titleEl.className = "eligible-course-title";
        titleEl.textContent = courseTitle;
        body.appendChild(titleEl);
      }
      const seenCrns = new Set();
      let sections = (course.sections || []).filter((s) => {
        const crn = String(s.courseReferenceNumber || "");
        if (!crn || seenCrns.has(crn)) return false;
        seenCrns.add(crn);
        return true;
      });
      if (State.showOpenSeatsOnly) sections = sections.filter(hasRealOpenSeat);
      if (!sections.length) {
        State.setExpandedCourseKey(null);
      } else {
        sections.forEach((s) => {
          const crn = String(s.courseReferenceNumber || "");
          const isOnCalendar = State.workingCourses.some((c) => String(c.crn) === crn);
          const row = document.createElement("div");
          row.className = "section-toggle-row" +
            (isOnCalendar ? " on-calendar" : "") +
            (!hasRealOpenSeat(s) ? " no-seats" : "");
          const check = document.createElement("span");
          check.className = "section-check";
          check.textContent = isOnCalendar ? "✓" : "";
          const info = document.createElement("span");
          info.textContent = formatSectionOneLine(s);
          row.appendChild(check);
          row.appendChild(info);
          row.addEventListener("click", () => {
            if (isOnCalendar) {
              removeFromWorkingSchedule(crn);
            } else {
              const mt = s.meetingsFaculty?.[0]?.meetingTime;
              const days = [];
              if (mt?.monday) days.push("Mon");
              if (mt?.tuesday) days.push("Tue");
              if (mt?.wednesday) days.push("Wed");
              if (mt?.thursday) days.push("Thu");
              if (mt?.friday) days.push("Fri");
              const beginTime = mt?.beginTime
                ? mt.beginTime.slice(0, 2) + ":" + mt.beginTime.slice(2)
                : null;
              const endTime = mt?.endTime
                ? mt.endTime.slice(0, 2) + ":" + mt.endTime.slice(2)
                : null;
              addToWorkingSchedule({
                crn,
                subject: course.subject,
                courseNumber: course.courseNumber,
                title: s.courseTitle || course.sections[0]?.courseTitle || "",
                days, beginTime, endTime,
                source: "manual",
                online: s.instructionalMethod === "INT",
              });
              State.setExpandedCourseKey(null);
            }
            renderEligibleList();
            updateSaveBtn();
          });
          body.appendChild(row);
        });
        item.appendChild(body);
      }
    }
    list.appendChild(item);
  });
}
