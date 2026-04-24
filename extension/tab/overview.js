// ============================================================
// OVERVIEW — student-info header, progress-ring overview panel,
// week-hour counters, build/AI tab toggle (setPanelMode), and
// the sidebar + right-panel-resize + overview-collapse wiring.
// Lives separately from Build/AI so tab.js can stay a thin shell.
// ============================================================

import * as State from "./state.js";
import { $ } from "./state.js";
import { renderSavedList } from "./schedule.js";
import { renderEligibleList } from "./eligibleList.js";
import { buildStudentProfile } from "../scheduler/profile.js";

// ── panel mode (Build ↔ AI) ──────────────────────────────

export function setPanelMode(mode) {
  State.setPanelModeState(mode);
  const buildTab = $("tabBuild");
  const aiTab = $("tabAI");
  const buildPanel = $("buildPanel");
  const aiPanel = $("aiPanel");
  if (buildTab) buildTab.classList.toggle("active", mode === "build");
  if (aiTab) aiTab.classList.toggle("active", mode === "ai");
  if (buildPanel) buildPanel.style.display = mode === "build" ? "flex" : "none";
  if (aiPanel) aiPanel.style.display = mode === "ai" ? "flex" : "none";
  renderEligibleList();
  renderSavedList();
}

// ── student header + profile ─────────────────────────────

export function applyStudentInfoToUI(student) {
  if (!student) return;
  State.setCurrentStudent(student);
  $("studentName").textContent =
    student.name + " | " + student.major + " | " + student.degree;
  const ss = document.getElementById("sidebarStudent");
  if (ss) {
    ss.innerHTML = "<strong>" + student.name + "</strong><br>" +
      student.major + " | " + student.degree;
  }

  // Build a rich profile for the AI advisor. Some fields (completedCourses,
  // holds, careerGoals, advisingNotes) aren't on this endpoint and default
  // to placeholders — they get populated later in chat turns.
  const earnedH = student.creditsEarnedMajorMinor ?? null;
  const reqH = student.creditsRequiredMajorMinor ?? null;
  State.setStudentProfile(buildStudentProfile({
    name: student.name,
    major: student.major +
      (student.minor ? " (Minor: " + student.minor + ")" : "") +
      (student.degree ? " — " + student.degree : ""),
    classification: student.classification || "Unknown",
    catalogYear: student.catalogYear || new Date().getFullYear(),
    completedHours: earnedH,
    remainingHours: (earnedH != null && reqH != null) ? reqH - earnedH : null,
    gpa: student.gpaOverall ?? student.gpaTexasState ?? null,
    completedCourses: [],
    holds: [],
    calendarBlocks: State.calendarBlocks,
    avoidDays: State.avoidDays,
    careerGoals: null,
    advisingNotes: null,
  }));
}

export function refreshDegreeAuditOverview() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDegreeAuditOverview" }, (data) => {
      if (data && data.name) {
        State.setDegreeAuditSnapshot(data);
        State.setCurrentStudent(data);
        applyStudentInfoToUI(data);
      }
      renderOverviewPanel();
      resolve();
    });
  });
}

// ── GPA helpers ──────────────────────────────────────────

function firstOverviewGpaField(snap, student, keys) {
  for (const k of keys) {
    if (snap && snap[k] != null && snap[k] !== "") return snap[k];
  }
  for (const k of keys) {
    if (student && student[k] != null && student[k] !== "") return student[k];
  }
  return undefined;
}

function fmtOverviewGpa(raw) {
  if (raw == null || raw === "") return "—";
  let v = raw;
  if (typeof raw === "object" && raw !== null) {
    v = raw.value ?? raw.amount ?? raw.numericValue ?? raw.gpa ?? raw.number;
    if (v == null || v === "") return "—";
  }
  const x = parseFloat(
    String(v).replace(/,/g, "").replace(/\u00a0|\u202f/g, "").trim(),
  );
  return Number.isFinite(x) ? x.toFixed(2) : "—";
}

function scanSnapshotForOverallGpa(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  let cum;
  const take = (k, v) => {
    if (v == null || v === "" || typeof v === "object") return;
    if (!/gpa/i.test(k)) return;
    const x = parseFloat(
      String(v).replace(/,/g, "").replace(/\u00a0|\u202f/g, "").trim(),
    );
    if (!Number.isFinite(x) || x < 0 || x > 4.5) return;
    const kl = k.toLowerCase();
    if (
      /overall|cumulative|career|degree|program|comb|total|^gpa$/i.test(kl) ||
      (/gpa/i.test(kl) && !/institut|txst|banner|resident|inst\.?\s*gpa/.test(kl))
    ) {
      if (cum === undefined) cum = v;
    }
  };
  for (const [k, v] of Object.entries(obj)) {
    take(k, v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) take(k + "." + k2, v2);
    }
  }
  if (cum === undefined) {
    for (const [k, v] of Object.entries(obj)) {
      if (/\bgpa\b/i.test(k) && v != null && v !== "" && typeof v !== "object") {
        const x = parseFloat(String(v).replace(/,/g, "").trim());
        if (Number.isFinite(x) && x >= 0 && x <= 4.5) { cum = v; break; }
      }
    }
  }
  return cum;
}

// ── overview panel ───────────────────────────────────────

export function renderOverviewPanel() {
  const events = State.cachedOverviewEvents;
  const seen = new Set();
  const courses = [];
  const waitlisted = [];
  for (const ev of events) {
    if (seen.has(ev.crn)) continue;
    seen.add(ev.crn);
    if (ev.registrationStatus && ev.registrationStatus.toLowerCase().includes("wait")) {
      waitlisted.push(ev);
    } else {
      courses.push(ev);
    }
  }
  const totalCourses = courses.length + waitlisted.length;
  const totalHours = [...courses, ...waitlisted].reduce(
    (sum, c) => sum + (c.creditHours || c.credits || 3), 0,
  );

  let onTrackLabel = "";
  if (totalHours >= 15) onTrackLabel = '<span class="ov-badge ov-green">Ahead of pace</span>';
  else if (totalHours >= 12) onTrackLabel = '<span class="ov-badge ov-blue">On track</span>';
  else if (totalHours > 0) onTrackLabel = '<span class="ov-badge ov-amber">Light semester</span>';

  const snap = State.degreeAuditSnapshot;
  let pct = snap && snap.progressPercent != null
    ? Math.min(100, Math.max(0, Number(snap.progressPercent)))
    : null;
  if (pct != null && !Number.isFinite(pct)) pct = null;

  const circumference = 2 * Math.PI * 20;
  const dash = pct != null ? (pct / 100) * circumference : 0;

  const classification =
    (snap && snap.classification && String(snap.classification).trim()) ||
    (State.currentStudent && String(State.currentStudent.classification || "").trim()) ||
    "";

  const req = snap && snap.creditsRequiredMajorMinor != null ? snap.creditsRequiredMajorMinor : null;
  const earned = snap && snap.creditsEarnedMajorMinor != null ? snap.creditsEarnedMajorMinor : null;
  const hasMinor = !!(snap && snap.hasMinor);

  let progressCaption = "";
  if (pct != null) {
    progressCaption = earned != null && req != null
      ? earned + " / " + req + " cr toward degree" + (hasMinor ? " · minor on record" : "")
      : "Degree Works requirement totals";
  } else {
    progressCaption = "Degree progress unavailable (open Degree Works)";
  }

  let rawOv = firstOverviewGpaField(snap, State.currentStudent, [
    "gpaOverall", "cumulativeGPA", "cumulativeGpa", "overallGPA", "overallGpa",
    "gpaTexasState", "institutionalGPA", "gpa",
  ]);
  if (rawOv == null) rawOv = scanSnapshotForOverallGpa(snap);
  const gpaOv = fmtOverviewGpa(rawOv);
  const ringCenter = pct != null ? pct + "%" : "—";

  const panel = document.getElementById("overviewPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="ov-row ov-overview-top" style="align-items:center;gap:12px;">
      <div class="ov-progress-ring">
        <svg width="52" height="52" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="20" fill="none" stroke="var(--border)" stroke-width="4"/>
          <circle cx="26" cy="26" r="20" fill="none" stroke="#501214" stroke-width="4"
            stroke-dasharray="${dash} ${circumference}"
            stroke-dashoffset="${circumference / 4}"
            stroke-linecap="round"
            transform="rotate(-90 26 26)"/>
        </svg>
        <div class="ov-ring-label">${ringCenter}</div>
      </div>
      <div class="ov-overview-text">
        <div class="ov-classification">${classification ? classification : "—"}</div>
        <div class="ov-sub" style="margin-top:2px">${progressCaption}</div>
      </div>
    </div>
    <div class="ov-gpa-strip" aria-label="Overall grade point average">
      <div class="ov-gpa-row">
        <span class="ov-gpa-label">Overall GPA</span>
        <span class="ov-gpa-val">${gpaOv}</span>
      </div>
    </div>
    <div class="ov-divider"></div>
    <div class="ov-row">
      <div class="ov-stat">
        <div class="ov-val">${totalCourses}</div>
        <div class="ov-label">This semester</div>
        <div class="ov-sub">${totalHours} hrs ${onTrackLabel}</div>
      </div>
      ${waitlisted.length > 0 ? `
      <div class="ov-stat">
        <div class="ov-val ov-red">${waitlisted.length}</div>
        <div class="ov-label">Waitlisted</div>
      </div>` : ""}
    </div>
    <div class="ov-divider"></div>
  `;
}

// ── week-hours + overview sync ───────────────────────────

export function updateWeekHours(events) {
  const seen = new Set();
  let totalHours = 0;
  for (const ev of (events || [])) {
    if (!ev.crn || seen.has(ev.crn)) continue;
    seen.add(ev.crn);
    totalHours += ev.creditHours || ev.credits || 3;
  }
  const el = document.getElementById("weekHours");
  if (!el) return;
  el.innerHTML = totalHours > 0
    ? "<strong>" + totalHours + " credit hours</strong> this semester"
    : "";
}

export function updateWeekHoursFromWorking() {
  const seen = new Set();
  let total = 0;
  for (const c of State.workingCourses) {
    const crn = String(c.crn || "");
    if (!crn || seen.has(crn)) continue;
    seen.add(crn);
    let credits = typeof c.credits === "number"
      ? c.credits
      : typeof c.creditHours === "number" ? c.creditHours : null;
    if (credits == null && State.cachedRawData?.eligible) {
      for (const course of State.cachedRawData.eligible) {
        const sec = (course.sections || []).find(
          (s) => String(s.courseReferenceNumber) === crn,
        );
        if (sec) { credits = sec.creditHourLow ?? 3; break; }
      }
    }
    total += credits ?? 3;
  }
  const el = $("weekHours");
  if (!el) return;
  el.innerHTML = total > 0
    ? "<strong>" + total + " credit hours</strong> this semester"
    : "";
}

export function updateOverviewFromEvents(events) {
  State.setCachedOverviewEvents(events || []);
  renderOverviewPanel();
}

export function toggleOverview() {
  const body = document.getElementById("overviewPanel");
  const chevron = document.getElementById("overviewChevron");
  if (!body || !chevron) return;
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "block" : "none";
  chevron.textContent = collapsed ? "\u25be" : "\u25b8";
}

// ── sidebar + resize + Build/AI tabs + schedules-toggle ──

document.addEventListener("DOMContentLoaded", () => {
  const buildTab = $("tabBuild");
  const aiTab = $("tabAI");
  if (buildTab) buildTab.addEventListener("click", () => setPanelMode("build"));
  if (aiTab) aiTab.addEventListener("click", () => setPanelMode("ai"));

  const schedulesToggle = $("schedulesToggle");
  if (schedulesToggle) {
    schedulesToggle.addEventListener("click", () => {
      const next = !State.schedulesCollapsed;
      State.setSchedulesCollapsed(next);
      const body = $("schedulesBody");
      if (body) body.style.display = next ? "none" : "block";
      schedulesToggle.classList.toggle("collapsed", next);
    });
  }

  const hamburger = document.getElementById("hamburgerBtn");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const closeBtn = document.getElementById("sidebarClose");
  const openSidebar = () => {
    if (sidebar) sidebar.classList.add("open");
    if (overlay) overlay.classList.add("active");
  };
  const closeSidebar = () => {
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
  };
  if (hamburger) hamburger.addEventListener("click", openSidebar);
  if (closeBtn) closeBtn.addEventListener("click", closeSidebar);
  if (overlay) overlay.addEventListener("click", closeSidebar);

  const navRegister = document.getElementById("navRegister");
  const navAudit = document.getElementById("navAudit");
  if (navRegister) {
    navRegister.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({
        url: "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration",
      });
      closeSidebar();
    });
  }
  if (navAudit) {
    navAudit.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({
        url: "https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/WEB31",
      });
      closeSidebar();
    });
  }

  const overviewToggle = document.getElementById("overviewToggle");
  if (overviewToggle) overviewToggle.addEventListener("click", toggleOverview);
});

document.addEventListener("DOMContentLoaded", () => {
  const handle = document.getElementById("resizeHandle");
  const panel = document.getElementById("rightPanel");
  if (!handle || !panel) return;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.width = Math.min(600, Math.max(200, startWidth + (startX - e.clientX))) + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
});
