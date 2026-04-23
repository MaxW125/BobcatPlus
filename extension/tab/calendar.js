// ============================================================
// CALENDAR — empty-grid build, unified working-course render,
// overlap column assignment, online-courses bar, zoom, and
// conflict detection (delegates to BP.findOverlapPair).
// ============================================================

import * as State from "./state.js";
import {
  $, registerCourseMeta, calendarCourseMetaByCrn,
  setPxPerHour,
} from "./state.js";
import {
  removeFromWorkingSchedule, toggleLock, updateSaveBtn,
} from "./schedule.js";
import { removeCalendarBlock, removeAvoidDay, renderAIToolbar } from "./ai.js";

// ── time helpers ─────────────────────────────────────────

export function timeStrToMinutes(t) {
  if (!t) return null;
  return parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(2));
}

export function formatTime24to12(h, m) {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
}

export function formatChatTime(t) {
  if (!t) return "";
  return formatTime24to12(parseInt(t.slice(0, 2)), parseInt(t.slice(2)));
}

// ── empty grid ───────────────────────────────────────────

export function buildEmptyCalendar() {
  State.clearCalendarCourseMeta();
  const shortDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const avoidSet = new Set(State.avoidDays || []);
  let html = '<tr><th class="time-col">Time</th>';
  State.DAYS.forEach((d, i) => {
    const short = shortDays[i];
    const isAvoid = avoidSet.has(short);
    const avoidCls = isAvoid ? " avoid-day-header" : "";
    const tag = isAvoid
      ? '<span class="avoid-day-tag">Kept clear<button class="avoid-day-remove" data-day="' + short + '" title="Remove this block" aria-label="Remove ' + short + ' from kept-clear days">×</button></span>'
      : "";
    html += '<th class="' + avoidCls.trim() + '">' + d + tag + "</th>";
  });
  html += "</tr>";
  for (let h = State.START_HOUR; h < State.END_HOUR; h++) {
    const label = (h > 12 ? h - 12 : h) + ":00 " + (h >= 12 ? "PM" : "AM");
    html += '<tr><td class="time-label">' + label + "</td>";
    for (let d = 0; d < 5; d++) {
      const avoidCls = avoidSet.has(shortDays[d]) ? " avoid-day-cell" : "";
      html += '<td id="cell-' + d + "-" + h + '" class="' + avoidCls.trim() + '"></td>';
    }
    html += "</tr>";
  }
  $("calendar").innerHTML = html;
  $("calendar").querySelectorAll(".avoid-day-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAvoidDay(btn.dataset.day);
    });
  });
}

// ── overlap column assignment ────────────────────────────

export function assignOverlapColumns(cellItems) {
  cellItems.sort(
    (a, b) => a.startOffset - b.startOffset || String(a.crnKey).localeCompare(String(b.crnKey)),
  );
  const colEnd = [];
  for (const it of cellItems) {
    const end = it.startOffset + it.height;
    let c = 0;
    for (; c < colEnd.length; c++) {
      if (colEnd[c] <= it.startOffset + 0.5) break;
    }
    if (c === colEnd.length) colEnd.push(end);
    else colEnd[c] = end;
    it.col = c;
  }
  const n = colEnd.length;
  cellItems.forEach((it) => { it.colCount = n; });
}

// ── working-schedule render ──────────────────────────────

export function renderCalendarFromWorkingCourses() {
  buildEmptyCalendar();
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
  const cellBuckets = new Map();

  for (const course of State.workingCourses) {
    if (!course.days || !course.beginTime || !course.endTime) continue;
    const [bh, bm] = course.beginTime.split(":").map(Number);
    const [eh, em] = course.endTime.split(":").map(Number);
    const startOffset = (bm / 60) * State.PX_PER_HOUR;
    const height = (eh + em / 60 - (bh + bm / 60)) * State.PX_PER_HOUR;
    const timeStr = formatTime24to12(bh, bm) + " – " + formatTime24to12(eh, em);
    const crnKey = String(course.crn ?? "");
    const isLocked = State.lockedCrns.has(crnKey);
    const courseKey = course.subject + course.courseNumber;
    const chipClass = getChipForCourse(courseKey);

    for (const day of course.days) {
      const dayIdx = dayMap[day];
      if (dayIdx === undefined) continue;
      const cellKey = dayIdx + "-" + bh;
      if (!cellBuckets.has(cellKey)) cellBuckets.set(cellKey, []);
      cellBuckets.get(cellKey).push({
        course, dayIdx, bh, startOffset, height, timeStr,
        crnKey, isLocked, courseKey, chipClass,
      });
    }
  }

  for (const [, items] of cellBuckets) assignOverlapColumns(items);

  for (const [, items] of cellBuckets) {
    for (const p of items) {
      const cell = $("cell-" + p.dayIdx + "-" + p.bh);
      if (!cell) continue;

      const block = document.createElement("div");
      block.className = "course-block " + p.chipClass + (p.isLocked ? " locked" : "");
      block.setAttribute("data-crn", p.crnKey);
      block.style.top = p.startOffset + "px";
      block.style.height = p.height + "px";
      if (p.colCount > 1) {
        const n = p.colCount, col = p.col;
        block.style.left = "calc(3px + " + col + " * ((100% - 6px) / " + n + "))";
        block.style.width = "calc((100% - 6px) / " + n + " - 2px)";
        block.style.right = "auto";
        block.style.zIndex = String(1 + col);
      }

      const lockSvg = p.isLocked
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" fill="currentColor" fill-opacity="0.35"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V5a5 5 0 0 1 9.9-1.5"/></svg>`;

      block.innerHTML =
        '<div class="block-info">' +
          '<div class="course-title">' + p.course.subject + " " + p.course.courseNumber + "</div>" +
          '<div class="course-time">' + p.timeStr + "</div>" +
          '<div class="course-time">' + (p.course.title || "") + "</div>" +
        "</div>" +
        '<div class="block-actions">' +
          '<button class="block-remove-btn" title="Remove" style="' + (p.isLocked ? "visibility:hidden;" : "") + '">✕</button>' +
          '<button class="block-lock-btn" title="' + (p.isLocked ? "Unlock" : "Lock") + '">' + lockSvg + "</button>" +
        "</div>";

      if (p.crnKey) {
        let meta = calendarCourseMetaByCrn.get(p.crnKey);
        if (!meta) {
          meta = {
            crn: p.crnKey,
            courseCode: p.course.subject + " " + p.course.courseNumber,
            subject: p.course.subject,
            courseNumber: p.course.courseNumber,
            title: p.course.title || "—",
            section: "—", professor: "—", location: "—", instructionalMethod: "—",
            meetingTimeDisplay: p.timeStr,
          };
          registerCourseMeta(p.crnKey, meta);
        } else {
          meta.meetingTimeDisplay = meta.meetingTimeDisplay || p.timeStr;
        }
      }

      block.querySelector(".block-remove-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromWorkingSchedule(p.crnKey);
      });
      block.querySelector(".block-lock-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLock(p.crnKey);
      });

      cell.appendChild(block);
    }
  }

  // Calendar blocks (work, gym, etc.) — rendered after course blocks.
  // z-index 0 keeps them behind course blocks; the X button overrides pointer-events.
  const dayMapB = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
  for (const block of State.calendarBlocks) {
    const startH = parseInt((block.start || "0000").slice(0, 2), 10);
    const startM = parseInt((block.start || "0000").slice(2, 4), 10);
    const endH   = parseInt((block.end   || "0000").slice(0, 2), 10);
    const endM   = parseInt((block.end   || "0000").slice(2, 4), 10);
    const topOffset = (startM / 60) * State.PX_PER_HOUR;
    const blockH    = (endH + endM / 60 - (startH + startM / 60)) * State.PX_PER_HOUR;
    if (blockH <= 0) continue;
    const days = (block.days || []);
    days.forEach((day, dayLoopIdx) => {
      const dayIdx = dayMapB[day];
      if (dayIdx === undefined) return;
      const cell = $("cell-" + dayIdx + "-" + startH);
      if (!cell) return;
      const el = document.createElement("div");
      el.className = "calendar-block";
      el.style.top    = topOffset + "px";
      el.style.height = blockH    + "px";
      const labelSpan = document.createElement("span");
      labelSpan.className = "block-label-text";
      labelSpan.textContent = block.label || "";
      el.appendChild(labelSpan);
      if (dayLoopIdx === 0) {
        const xBtn = document.createElement("button");
        xBtn.className = "block-remove-x";
        xBtn.setAttribute("aria-label", "Remove " + (block.label || "block"));
        xBtn.textContent = "×";
        xBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeCalendarBlock(block.label);
        });
        el.appendChild(xBtn);
      }
      cell.appendChild(el);
    });
  }

  renderOnlineCoursesBar();
  renderAIToolbar();
  setTimeout(updateConflictStatus, 0);
}

export function renderOnlineCoursesBar() {
  const bar = $("onlineCoursesBar");
  const list = $("onlineCoursesList");
  const countEl = $("onlineCoursesCount");
  if (!bar || !list) return;
  const onlineCourses = State.workingCourses.filter(
    (c) => c.online || !c.days || !c.days.length,
  );
  if (!onlineCourses.length) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "";
  if (countEl) {
    countEl.textContent =
      onlineCourses.length + " course" + (onlineCourses.length !== 1 ? "s" : "");
  }
  list.innerHTML = "";
  for (const c of onlineCourses) {
    const crnKey = String(c.crn ?? "");
    const isLocked = State.lockedCrns.has(crnKey);
    const chipClass = getChipForCourse(c.subject + c.courseNumber);
    const card = document.createElement("div");
    card.className = "online-course-card " + chipClass + (isLocked ? " locked" : "");
    card.setAttribute("data-crn", crnKey);
    card.innerHTML =
      '<div class="online-course-main">' +
        '<div class="online-course-code">' +
          escapeHtml(c.subject + " " + c.courseNumber) +
          (isLocked ? ' <span class="online-course-lock">🔒</span>' : "") +
        "</div>" +
        '<div class="online-course-title">' + escapeHtml(c.title || "") + "</div>" +
      "</div>" +
      (isLocked
        ? ""
        : '<button class="online-course-remove" title="Remove" aria-label="Remove ' +
          escapeHtml(c.subject + " " + c.courseNumber) + '">✕</button>');
    const removeBtn = card.querySelector(".online-course-remove");
    if (removeBtn) {
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromWorkingSchedule(crnKey);
      });
    }
    list.appendChild(card);
  }
}

// Local escape for the online bar; kept here to avoid circular imports
// through tab/chat.js during early module initialization.
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ── conflict detection ───────────────────────────────────

/**
 * Delegates to BP.findOverlapPair (scheduleGenerator.js) so the solver's
 * validator and the UI status bar share one implementation. That helper
 * correctly skips entries with `online: true` even when Banner left phantom
 * meeting data on the section (Bug 5, 2026-04-21).
 */
export function detectWorkingConflict() {
  const BP = window.BP || {};
  if (typeof BP.findOverlapPair === "function") {
    return BP.findOverlapPair(State.workingCourses);
  }
  return null;
}

export function updateConflictStatus() {
  const bar = $("statusBar");
  if (!bar) return;
  const conflict = detectWorkingConflict();
  if (conflict) {
    const aCode = (conflict.a.subject || "") + " " + (conflict.a.courseNumber || "");
    const bCode = (conflict.b.subject || "") + " " + (conflict.b.courseNumber || "");
    const sharedDays = (conflict.a.days || [])
      .filter((d) => (conflict.b.days || []).includes(d))
      .join("/");
    bar.textContent =
      "⚠ " + aCode.trim() + " overlaps with " + bCode.trim() + (sharedDays ? " on " + sharedDays : "");
    bar.dataset.conflict = "1";
  } else if (bar.dataset.conflict === "1") {
    bar.textContent = "Ready";
    delete bar.dataset.conflict;
  }
}

// ── zoom ─────────────────────────────────────────────────

export function applyZoom() {
  document.documentElement.style.setProperty("--cell-h", State.PX_PER_HOUR + "px");
  renderCalendarFromWorkingCourses();
  const zoomOut = document.getElementById("zoomOut");
  const zoomIn = document.getElementById("zoomIn");
  if (zoomOut) zoomOut.disabled = State.PX_STEPS.indexOf(State.PX_PER_HOUR) <= 0;
  if (zoomIn)  zoomIn.disabled  = State.PX_STEPS.indexOf(State.PX_PER_HOUR) >= State.PX_STEPS.length - 1;
}

// Zoom-button wiring lives in the module load so it runs once.
const _zoomOut = document.getElementById("zoomOut");
const _zoomIn = document.getElementById("zoomIn");
if (_zoomOut) {
  _zoomOut.addEventListener("click", () => {
    const i = State.PX_STEPS.indexOf(State.PX_PER_HOUR);
    if (i > 0) { setPxPerHour(State.PX_STEPS[i - 1]); applyZoom(); }
  });
}
if (_zoomIn) {
  _zoomIn.addEventListener("click", () => {
    const i = State.PX_STEPS.indexOf(State.PX_PER_HOUR);
    if (i < State.PX_STEPS.length - 1) { setPxPerHour(State.PX_STEPS[i + 1]); applyZoom(); }
  });
}
