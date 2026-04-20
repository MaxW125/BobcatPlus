// ============================================================
// COMPRESSION + PROMPT
// ============================================================

function stripHtml(html) {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&rsquo;/g, "'").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim().split("Section Description:")[0].trim();
}

function compressRegisteredForLLM(events) {
  const seen = new Set();
  const courses = [];
  for (const event of events) {
    const start = new Date(event.start);
    const end = new Date(event.end);
    const dayIdx = start.getDay() - 1;
    if (dayIdx < 0 || dayIdx > 4) continue;
    const key = event.crn + "-" + dayIdx;
    if (seen.has(key)) continue;
    seen.add(key);
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const startStr = String(start.getHours()).padStart(2, "0") + String(start.getMinutes()).padStart(2, "0");
    const endStr = String(end.getHours()).padStart(2, "0") + String(end.getMinutes()).padStart(2, "0");
    const existing = courses.find((c) => c.crn === String(event.crn));
    if (existing) { if (!existing.days.includes(dayNames[dayIdx])) existing.days.push(dayNames[dayIdx]); }
    else courses.push({ crn: String(event.crn), course: event.subject + " " + event.courseNumber, title: event.title, days: [dayNames[dayIdx]], start: startStr, end: endStr });
  }
  return courses;
}

function applyPreFilter(compressed, registeredCourses) {
  return {
    eligible: compressed.eligible.map((course) => {
      const filteredSections = course.sections.map((section) => {
        if (section.online || !section.days || !section.start) return { ...section, conflictsWith: [] };
        const conflicts = [];
        for (const reg of registeredCourses) {
          if (!reg.days || !reg.start) continue;
          const sharedDays = section.days.filter((d) => reg.days.includes(d));
          if (sharedDays.length === 0) continue;
          if (timeStrToMinutes(section.start) < timeStrToMinutes(reg.end) && timeStrToMinutes(reg.start) < timeStrToMinutes(section.end))
            conflicts.push(reg.crn + " (" + reg.course + ")");
        }
        return { ...section, conflictsWith: conflicts };
      }).filter((s) => s.conflictsWith.length === 0);
      return { ...course, sections: filteredSections };
    }).filter((c) => c.sections.length > 0),
  };
}

function compressForLLM(data) {
  return {
    eligible: data.eligible.map((course) => {
      const description = stripHtml(course.sections[0]?.courseDescription);
      const openSections = course.sections.filter((s) => s.openSection).map((s) => {
        const mt = s.meetingsFaculty[0]?.meetingTime;
        const days = [];
        if (mt?.monday) days.push("Mon");
        if (mt?.tuesday) days.push("Tue");
        if (mt?.wednesday) days.push("Wed");
        if (mt?.thursday) days.push("Thu");
        if (mt?.friday) days.push("Fri");
        return { crn: s.courseReferenceNumber, online: s.instructionalMethod === "INT", days: days.length ? days : null, start: mt?.beginTime || null, end: mt?.endTime || null, seatsAvailable: s.seatsAvailable, instructor: s.faculty[0]?.displayName !== "Faculty, Unassigned" ? s.faculty[0]?.displayName : null, credits: s.creditHourLow ?? 3 };
      });
      return { course: `${course.subject} ${course.courseNumber}`, title: course.sections[0]?.courseTitle?.replace(/&amp;/g, "&")?.replace(/&#39;/g, "'"), requirementLabel: course.label, description, sections: openSections };
    }).filter((c) => c.sections.length > 0),
  };
}

const SCHEDULE_SYSTEM_PROMPT = `
You are an academic schedule planning assistant helping students at Texas State University 
build optimal course schedules for an upcoming semester.

You will receive:
1. ALREADY LOCKED: courses the student has locked in. These are FIXED — never conflict with them, never include them in output, only output NEW courses. Treat their time slots as completely blocked.
2. ELIGIBLE COURSES: courses available to add, each with open sections. Each section may include a conflictsWith[] field — if non-empty, that section conflicts with a locked course and must NOT be selected.
3. The student's preferences in natural language.

HARD RULES:
1. No time conflicts between any two sections on the same day.
2. Only select sections where seatsAvailable > 0 unless student says otherwise.
3. Never select two courses satisfying the same requirementLabel unless student asks.
4. Respect all explicit timing constraints.
5. Only use sections from the provided eligible list.

OUTPUT FORMAT — valid JSON only, no markdown:
{
  "schedules": [
    {
      "name": "Schedule A — <label>",
      "rationale": "<2-4 sentences>",
      "totalCredits": 12,
      "courses": [
        { "course": "SOCI 3363", "title": "MEDICAL SOCI", "crn": "19272", "days": ["Mon","Wed"], "start": "1230", "end": "1350", "online": false, "requirementSatisfied": "Sociology Requirement", "instructor": "Zhang, Yan" }
      ]
    }
  ],
  "followUpQuestion": "<short friendly question>"
}

Generate exactly 3 meaningfully distinct schedules. Always regenerate all 3 on each turn.
`.trim();

// ============================================================
// APP STATE
// ============================================================

const $ = (id) => document.getElementById(id);
function sendToBackground(message) { return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve)); }

let currentStudent = null;
let currentTerm = null;
let analysisResults = null;
let eligibleAnalysisSeq = 0;
let savedSchedules = [];
let conversationHistory = [];
let cachedOverviewEvents = [];
let degreeAuditSnapshot = null;
let cachedRawData = null;
let cachedRegisteredCourses = [];
let cachedRegisteredTerm = null;
let registeredFetchCompleted = false;
let registeredFetchOk = false;
let bannerPlans = [];
let registeredScheduleCache = {};

const REG_EVENTS_STORAGE_KEY = "bobcatRegEventsCache";
function persistRegistrationEvents(term, events) {
  if (!term || !Array.isArray(events) || !events.length) return;
  try { chrome.storage.local.set({ [REG_EVENTS_STORAGE_KEY]: { term: String(term), events, savedAt: Date.now() } }); } catch (_) {}
}
function loadCachedRegistrationEvents(term) {
  return new Promise((resolve) => {
    chrome.storage.local.get(REG_EVENTS_STORAGE_KEY, (obj) => {
      const c = obj[REG_EVENTS_STORAGE_KEY];
      if (c && String(c.term) === String(term) && Array.isArray(c.events) && c.events.length) { resolve(c.events); return; }
      resolve(null);
    });
  });
}

let eligibleCourses = [];
let showOpenSeatsOnly = false;
let expandedCourseKey = null;
let selectedSectionByCourse = {};

// ── UNIFIED WORKING SCHEDULE ──────────────────────────────
let workingCourses = [];
let lockedCrns = new Set();

let scheduleFetchGeneration = 0;
function bumpScheduleFetchGeneration() { return ++scheduleFetchGeneration; }
let scheduleViewGeneration = 0;
function bumpScheduleViewGeneration() { return ++scheduleViewGeneration; }
let termChangeGeneration = 0;

// ── UI MODE ───────────────────────────────────────────────
let panelMode = "build";
let schedulesCollapsed = false;
let activeScheduleKey = "registered";
let activeView = -1; // index into savedSchedules, or -1 when none selected
let newPlanDisplayName = "";
let newPlanSingleClickOpensEdit = true;
let newPlanClickTimer = null;

// Calendar constants
const START_HOUR = 7;
const END_HOUR = 22;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const PX_PER_HOUR = 52;

// ── MODAL METADATA ────────────────────────────────────────
const calendarCourseMetaByCrn = new Map();
function clearCalendarCourseMeta() { calendarCourseMetaByCrn.clear(); }
function registerCourseMeta(crn, meta) { if (crn && meta) calendarCourseMetaByCrn.set(String(crn), meta); }


// ============================================================
// INIT
// ============================================================

(async () => {
  chrome.runtime.sendMessage(
    { action: "getDegreeAuditOverview" },
    (auditData) => {
      if (auditData && auditData.name) {
        applyStudentInfoToUI(auditData);
        degreeAuditSnapshot = auditData;
        updateOverviewFromEvents([]);
      } else {
        chrome.runtime.sendMessage({ action: "getStudentInfo" }, (student) => {
          if (student) {
            applyStudentInfoToUI(student);
            degreeAuditSnapshot = null;
          } else {
            $("studentName").textContent = "Not logged in";
            degreeAuditSnapshot = null;
          }
          updateOverviewFromEvents([]);
        });
      }
    },
  );

  chrome.storage.local.get("savedSchedules", (result) => {
    if (result.savedSchedules) savedSchedules = result.savedSchedules;
    renderSavedList();
  });

  chrome.runtime.sendMessage({ action: "getTerms" }, (terms) => {
    if (!terms || terms.length === 0) return;
    const select = $("termSelect");

    const now = new Date();
    let currentIdx = 0;
    for (let i = 0; i < terms.length; i++) {
      const dateMatch = terms[i].description.match(/(\d{2}-[A-Z]{3}-\d{4})/);
      if (dateMatch) {
        const startDate = new Date(dateMatch[1]);
        if (startDate <= now) {
          currentIdx = i;
          break;
        }
      }
    }

    terms.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = t.code;
      opt.textContent = t.description;
      if (i === currentIdx) opt.selected = true;
      select.appendChild(opt);
    });

    currentTerm = terms[currentIdx].code;
    buildEmptyCalendar();
    renderManualDraft();

    (async () => {
      const gen = ++termChangeGeneration;
      const ok = await checkAuth();
      if (gen !== termChangeGeneration) return;
      if (ok) {
        await loadSchedule(currentTerm);
        if (gen !== termChangeGeneration) return;
        await loadBannerPlans(currentTerm); // session is warm after loadSchedule
        if (gen !== termChangeGeneration) return;
        autoLoadEligibleCourses();
      } else {
        $("statusBar").textContent =
          "Use Import Schedule to sign in and load your registration.";
        await loadBannerPlans(currentTerm); // still try — plans don't need registration session
      }
    })();
  });
})();

// ============================================================
// TERM CHANGE
// ============================================================

$("termSelect").addEventListener("change", async (e) => {
  const gen = ++termChangeGeneration;
  currentTerm = e.target.value;
  // Cancel any in-flight analysis immediately — otherwise the old term keeps
  // firing searchCourse calls for 2-3s until the new runAnalysis message lands.
  chrome.runtime.sendMessage({ action: "cancelAnalysis" }).catch(() => {});
  analysisResults = null; cachedRawData = null; cachedRegisteredCourses = []; cachedRegisteredTerm = null;
  conversationHistory = []; bannerPlans = []; registeredScheduleCache = {};
  eligibleCourses = []; showOpenSeatsOnly = false; expandedCourseKey = null; selectedSectionByCourse = {};
  workingCourses = []; lockedCrns = new Set();
  newPlanDisplayName = ""; newPlanSingleClickOpensEdit = true;
  if (newPlanClickTimer) { clearTimeout(newPlanClickTimer); newPlanClickTimer = null; }
  buildEmptyCalendar();
  updateWeekHours([]);
  setPanelMode("build");
  const ok = await checkAuth();
  if (gen !== termChangeGeneration) return;
  if (ok) {
    await loadSchedule(currentTerm);
    if (gen !== termChangeGeneration) return;
    await loadBannerPlans(currentTerm);
    if (gen !== termChangeGeneration) return;
    autoLoadEligibleCourses();
  } else {
    $("statusBar").textContent = "Use Import Schedule to sign in and load your registration.";
    await loadBannerPlans(currentTerm);
  }
});

// ============================================================
// BUILD / AI TOGGLE
// ============================================================

function setPanelMode(mode) {
  panelMode = mode;
  const buildTab = $("tabBuild"), aiTab = $("tabAI");
  const buildPanel = $("buildPanel"), aiPanel = $("aiPanel");
  if (buildTab) buildTab.classList.toggle("active", mode === "build");
  if (aiTab) aiTab.classList.toggle("active", mode === "ai");
  if (buildPanel) buildPanel.style.display = mode === "build" ? "flex" : "none";
  if (aiPanel) aiPanel.style.display = mode === "ai" ? "flex" : "none";
  renderEligibleList();
  renderSavedList();
}



// ============================================================
// SIMONE'S FEATURES — overview panel, draft render, metadata helpers
// ============================================================

function extractMetaFromDraftRow(row) {
  const sec = row.section;
  const crn = String(row.key || "");
  const subject = row.subject || "";
  const courseNumber = row.courseNumber || "";
  const courseCode = (subject + " " + courseNumber).trim();
  const sn =
    sec?.sequenceNumber ?? sec?.sectionNumber ?? sec?.section ?? "?";

  let prof = "";
  const f0 = sec?.faculty?.[0];
  if (f0?.displayName && f0.displayName !== "Faculty, Unassigned")
    prof = f0.displayName;

  const im = sec?.instructionalMethod || "";
  const mt = sec?.meetingsFaculty?.[0]?.meetingTime;
  let location = "—";
  if (mt) {
    const bits = [
      mt.buildingDescription,
      mt.building,
      mt.room,
      mt.campusDescription,
    ].filter(Boolean);
    if (bits.length) location = bits.join(" · ");
  }
  if (
    (im === "INT" || String(im).toUpperCase() === "INT") &&
    location === "—"
  )
    location = "Online";

  return {
    crn,
    courseCode,
    subject,
    courseNumber,
    title: sec?.courseTitle || sec?.courseDescription || "—",
    section: String(sn),
    professor: prof || "—",
    location,
    instructionalMethod: formatInstructionalMethodLabel(im),
    meetingTimeDisplay: "",
  };
}

function extractMetaFromSavedCourse(course) {
  return {
    crn: String(course.crn || ""),
    courseCode: (
      String(course.subject || "").trim() +
      " " +
      String(course.courseNumber || "").trim()
    ).trim(),
    subject: course.subject || "",
    courseNumber: course.courseNumber || "",
    title: course.title || "—",
    section:
      course.section != null && course.section !== ""
        ? String(course.section)
        : "—",
    professor: course.instructor || "—",
    location: course.location || "—",
    instructionalMethod:
      course.instructionalMethod ||
      formatInstructionalMethodLabel(course.method) ||
      "—",
    meetingTimeDisplay: "",
  };
}

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
    v =
      raw.value ??
      raw.amount ??
      raw.numericValue ??
      raw.gpa ??
      raw.number;
    if (v == null || v === "") return "—";
  }
  const x = parseFloat(
    String(v)
      .replace(/,/g, "")
      .replace(/\u00a0|\u202f/g, "")
      .trim(),
  );
  return Number.isFinite(x) ? x.toFixed(2) : "—";
}

function normalizeInstructionalMethodRaw(ev, imVal) {
  if (imVal != null && typeof imVal === "object") {
    return (
      imVal.description ||
      imVal.longDescription ||
      imVal.label ||
      imVal.code ||
      imVal.key ||
      ""
    );
  }
  return (
    imVal ||
    pickFirstStr(
      ev.scheduleTypeDescription,
      ev.scheduleType,
      ev.partOfTermDescription,
      ev.courseInstructionalMethodDescription,
    )
  );
}

function normalizeRegistrationEventsPayload(payload) {
  if (payload == null) return [];
  const root = unwrapExtDirectTabPayload(payload);
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.events)) return root.events;
  if (Array.isArray(root?.registrationEvents)) return root.registrationEvents;
  if (Array.isArray(root?.rows)) return root.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function refreshDegreeAuditOverview() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDegreeAuditOverview" }, (data) => {
      if (data && data.name) {
        degreeAuditSnapshot = data;
        currentStudent = data;
        applyStudentInfoToUI(data);
      }
      renderOverviewPanel();
      resolve();
    });
  });
}

function renderCoursesOnCalendar(events) {
  buildEmptyCalendar();
  const expandedEvents = (events || []).map(expandRegistrationEvent);
  updateWeekHours(expandedEvents);
  updateOverviewFromEvents(expandedEvents);
  const mergedByCrn = groupRegistrationEventsByCrn(expandedEvents);
  const seen = new Set();
  for (const event of expandedEvents) {
    const startDate = new Date(event.start);
    const endDate = new Date(event.end);
    const dayIdx = startDate.getDay() - 1;
    if (dayIdx < 0 || dayIdx > 4) continue;

    const key = event.crn + "-" + dayIdx;
    if (seen.has(key)) continue;
    seen.add(key);

    const bh = startDate.getHours(),
      bm = startDate.getMinutes();
    const eh = endDate.getHours(),
      em = endDate.getMinutes();
    const startOffset = (bm / 60) * 52;
    const height = (eh + em / 60 - (bh + bm / 60)) * 52;
    const timeStr = formatTime24to12(bh, bm) + " - " + formatTime24to12(eh, em);

    const cell = $("cell-" + dayIdx + "-" + bh);
    if (!cell) continue;

    const courseKey = event.subject + event.courseNumber;
    const block = document.createElement("div");
    block.className = "course-block " + getChipForCourse(courseKey);
    block.setAttribute("data-course-key", courseKey);
    const crnKey = String(
      event.crn ?? event.courseReferenceNumber ?? "",
    ).trim();
    block.setAttribute("data-crn", crnKey);
    block.style.top = startOffset + "px";
    block.style.height = height + "px";
    block.innerHTML =
      '<div class="course-title">' +
      event.subject +
      " " +
      event.courseNumber +
      "</div>" +
      '<div class="course-time">' +
      timeStr +
      "</div>" +
      '<div class="course-time">' +
      event.title +
      "</div>";
    const mergedEv =
      (crnKey && mergedByCrn.get(crnKey)) || event;
    const meta = extractMetaFromRegistrationEvent(mergedEv);
    meta.meetingTimeDisplay = timeStr;
    if (crnKey) registerCourseMeta(crnKey, meta);
    cell.appendChild(block);
  }
}

function renderDraftOnCalendar() {
  buildEmptyCalendar();
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
  for (const row of manualDraft) {
    const mt = row.section?.meetingsFaculty?.[0]?.meetingTime;
    if (!mt) continue;
    const days = [];
    if (mt.monday) days.push("Mon");
    if (mt.tuesday) days.push("Tue");
    if (mt.wednesday) days.push("Wed");
    if (mt.thursday) days.push("Thu");
    if (mt.friday) days.push("Fri");
    if (!days.length || !mt.beginTime || !mt.endTime) continue;
    const beginTime = mt.beginTime.slice(0, 2) + ":" + mt.beginTime.slice(2);
    const endTime = mt.endTime.slice(0, 2) + ":" + mt.endTime.slice(2);
    const [bh, bm] = beginTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    const startOffset = (bm / 60) * 52;
    const height = (eh + em / 60 - (bh + bm / 60)) * 52;
    const timeStr = formatTime24to12(bh, bm) + " - " + formatTime24to12(eh, em);
    for (const day of days) {
      const dayIdx = dayMap[day];
      if (dayIdx === undefined) continue;
      const cell = $("cell-" + dayIdx + "-" + bh);
      if (!cell) continue;
      const block = document.createElement("div");
      block.className = "course-block";
      block.style.top = startOffset + "px";
      block.style.height = height + "px";
      block.innerHTML =
        '<div class="course-title">' +
        row.subject +
        " " +
        row.courseNumber +
        "</div>" +
        '<div class="course-time">' +
        timeStr +
        "</div>" +
        '<div class="course-time">CRN: ' +
        row.key +
        "</div>";
      const meta = extractMetaFromDraftRow(row);
      meta.meetingTimeDisplay = timeStr;
      registerCourseMeta(row.key, meta);
      block.setAttribute("data-crn", row.key);
      cell.appendChild(block);
    }
  }
  $("statusBar").textContent = manualDraft.length
    ? "Draft: " + manualDraft.length + " course(s) — add more or save."
    : "Draft is empty — pick courses from the list below.";
}

function saveSchedule(name, courses, txstPlanNumber) {
  const schedule = {
    name,
    term: currentTerm,
    courses,
    created: Date.now(),
    txstPlanNumber: txstPlanNumber ?? null,
  };
  savedSchedules.push(schedule);
  chrome.storage.local.set({ savedSchedules });
  activeView = savedSchedules.length - 1;
  renderSavedList();
  renderSavedScheduleOnCalendar(schedule);
}

function scanSnapshotForOverallGpa(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  let cum;
  const take = (k, v) => {
    if (v == null || v === "" || typeof v === "object") return;
    if (!/gpa/i.test(k)) return;
    const x = parseFloat(
      String(v)
        .replace(/,/g, "")
        .replace(/\u00a0|\u202f/g, "")
        .trim(),
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
      for (const [k2, v2] of Object.entries(v)) {
        take(k + "." + k2, v2);
      }
    }
  }
  if (cum === undefined) {
    for (const [k, v] of Object.entries(obj)) {
      if (/\bgpa\b/i.test(k) && v != null && v !== "" && typeof v !== "object") {
        const x = parseFloat(String(v).replace(/,/g, "").trim());
        if (Number.isFinite(x) && x >= 0 && x <= 4.5) {
          cum = v;
          break;
        }
      }
    }
  }
  return cum;
}

function setManualVisible(visible) {
  const el = document.querySelector(".manual-section");
  if (el) el.classList.toggle("visible", visible);
}

function unwrapExtDirectTabPayload(payload) {
  if (payload != null && typeof payload === "object" && "result" in payload) {
    return payload.result;
  }
  return payload;
}



// ============================================================
// SIMONE'S FEATURES — overview panel, draft render, metadata helpers
// ============================================================

function closeSidebar() {
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
  }

function openSidebar() {
    if (sidebar) sidebar.classList.add("open");
    if (overlay) overlay.classList.add("active");
  }

function renderManualDraft() {
  const ul = $("manualDraft");
  if (!ul) return;
  if (manualDraft.length === 0) {
    ul.innerHTML =
      '<li class="manual-hint" style="border:none;padding:2px 0">No sections yet.</li>';
    return;
  }
  ul.innerHTML = "";
  manualDraft.forEach((row) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = formatSectionOneLine(
      row.section,
      row.subject,
      row.courseNumber,
    );
    const rm = document.createElement("span");
    rm.className = "rm";
    rm.textContent = "remove";
    const crnKey = row.key;
    rm.addEventListener("click", () => {
      manualDraft = manualDraft.filter((d) => d.key !== crnKey);
      renderManualDraft();
      if (activeView === "draft") {
        renderDraftOnCalendar();
        renderSavedList();
      }
    });
    li.appendChild(span);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

function renderOverviewPanel() {
  const events = cachedOverviewEvents;
  const seen = new Set();
  const courses = [];
  const waitlisted = [];
  for (const ev of events) {
    if (seen.has(ev.crn)) continue;
    seen.add(ev.crn);
    if (
      ev.registrationStatus &&
      ev.registrationStatus.toLowerCase().includes("wait")
    ) {
      waitlisted.push(ev);
    } else {
      courses.push(ev);
    }
  }
  const totalCourses = courses.length + waitlisted.length;
  const totalHours = [...courses, ...waitlisted].reduce(
    (sum, c) => sum + (c.creditHours || c.credits || 3),
    0,
  );

  let onTrackLabel = "";
  if (totalHours >= 15)
    onTrackLabel = '<span class="ov-badge ov-green">Ahead of pace</span>';
  else if (totalHours >= 12)
    onTrackLabel = '<span class="ov-badge ov-blue">On track</span>';
  else if (totalHours > 0)
    onTrackLabel = '<span class="ov-badge ov-amber">Light semester</span>';

  const snap = degreeAuditSnapshot;
  let pct =
    snap && snap.progressPercent != null
      ? Math.min(100, Math.max(0, Number(snap.progressPercent)))
      : null;
  if (pct != null && !Number.isFinite(pct)) pct = null;

  const circumference = 2 * Math.PI * 20;
  const dash =
    pct != null ? (pct / 100) * circumference : 0;

  const classification =
    (snap && snap.classification && String(snap.classification).trim()) ||
    (currentStudent &&
      String(currentStudent.classification || "").trim()) ||
    "";

  const req =
    snap && snap.creditsRequiredMajorMinor != null
      ? snap.creditsRequiredMajorMinor
      : null;
  const earned =
    snap && snap.creditsEarnedMajorMinor != null
      ? snap.creditsEarnedMajorMinor
      : null;
  const hasMinor = !!(snap && snap.hasMinor);

  let progressCaption = "";
  if (pct != null) {
    progressCaption =
      earned != null && req != null
        ? earned +
          " / " +
          req +
          " cr toward degree" +
          (hasMinor ? " · minor on record" : "")
        : "Degree Works requirement totals";
  } else {
    progressCaption = "Degree progress unavailable (open Degree Works)";
  }

  let rawOv = firstOverviewGpaField(snap, currentStudent, [
    "gpaOverall",
    "cumulativeGPA",
    "cumulativeGpa",
    "overallGPA",
    "overallGpa",
    "gpaTexasState",
    "institutionalGPA",
    "gpa",
  ]);
  if (rawOv == null) {
    rawOv = scanSnapshotForOverallGpa(snap);
  }
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
        <div class="ov-classification">${
          classification ? classification : "—"
        }</div>
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

document.addEventListener("DOMContentLoaded", () => {
  const buildTab = $("tabBuild"), aiTab = $("tabAI");
  if (buildTab) buildTab.addEventListener("click", () => setPanelMode("build"));
  if (aiTab) aiTab.addEventListener("click", () => setPanelMode("ai"));

  const schedulesToggle = $("schedulesToggle");
  if (schedulesToggle) {
    schedulesToggle.addEventListener("click", () => {
      schedulesCollapsed = !schedulesCollapsed;
      const body = $("schedulesBody");
      if (body) body.style.display = schedulesCollapsed ? "none" : "block";
      schedulesToggle.classList.toggle("collapsed", schedulesCollapsed);
    });
  }
});

async function autoLoadEligibleCourses({ forceRefresh = false } = {}) {
  if (!forceRefresh && analysisResults && (analysisResults.eligible || []).length > 0) { eligibleCourses = analysisResults.eligible; renderEligibleList(); return; }
  const statusEl = $("eligibleStatus");
  if (statusEl) statusEl.textContent = "Loading your eligible courses…";
  analysisResults = await runAnalysisAndWait({ forceRefresh });
  if (analysisResults._skippedStaleTerm) return;
  cachedRawData = analysisResults;
  eligibleCourses = analysisResults.eligible || [];
  renderEligibleList();
  renderCacheAge(analysisResults.cacheTs);
}

function renderCacheAge(cacheTs) {
  const el = $("eligibleCacheAge");
  if (!el) return;
  if (!cacheTs) { el.textContent = ""; return; }
  const ageMs = Date.now() - cacheTs;
  const mins = Math.floor(ageMs / 60000);
  const label = mins < 1 ? "just now" : mins < 60 ? mins + "m ago" : Math.floor(mins / 60) + "h ago";
  el.innerHTML = "<span>Seat data from cache · " + label + "</span><button id='refreshEligibleBtn' class='bp-icon-btn'><svg width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='23 4 23 10 17 10'/><path d='M20.49 15a9 9 0 1 1-2.12-9.36L23 10'/></svg>Refresh</button>";
  const btn = document.getElementById("refreshEligibleBtn");
  if (btn) btn.addEventListener("click", () => { analysisResults = null; autoLoadEligibleCourses({ forceRefresh: true }); });
}

// ============================================================
// AUTH + IMPORT
// ============================================================

async function checkAuth() {
  try {
    const [dwRes, regRes] = await Promise.all([
      fetch("https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself", { credentials: "include" }),
      fetch("https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=1", { credentials: "include" }),
    ]);
    return dwRes.ok && regRes.ok;
  } catch (e) { return false; }
}

let importLoginListener = null;
function attachImportLoginListener(importBtn, importSvg) {
  if (importLoginListener) { chrome.runtime.onMessage.removeListener(importLoginListener); importLoginListener = null; }
  importLoginListener = (msg) => {
    if (msg.type === "loginSuccess") {
      chrome.runtime.onMessage.removeListener(importLoginListener); importLoginListener = null;
      addMessage("system", "Login successful! Loading your schedule next…");
      (async () => {
        importBtn.textContent = "Importing..."; importBtn.classList.add("loading");
        const authed2 = await checkAuth();
        if (!authed2) { addMessage("system", "TXST session not ready yet. Try Import Schedule again."); importBtn.disabled = false; importBtn.classList.remove("loading"); importBtn.innerHTML = importSvg; return; }
        await waitWithChatCountdown(1);
        analysisResults = null; cachedRawData = null; cachedRegisteredCourses = []; cachedRegisteredTerm = null; conversationHistory = [];
        $("statusBar").textContent = "Importing schedule...";
        await loadSchedule(currentTerm);
        location.reload();
      })().catch((err) => { console.error("[BobcatPlus] post-login import:", err); addMessage("system", "Could not finish loading. Try Import Schedule again."); importBtn.disabled = false; importBtn.classList.remove("loading"); importBtn.innerHTML = importSvg; });
    }
    if (msg.type === "loginCancelled") { chrome.runtime.onMessage.removeListener(importLoginListener); importLoginListener = null; addMessage("system", "Login cancelled. Click Import to try again."); importBtn.disabled = false; importBtn.classList.remove("loading"); importBtn.innerHTML = importSvg; }
  };
  chrome.runtime.onMessage.addListener(importLoginListener);
}

const importBtn = document.getElementById("importBtn");
if (importBtn) {
  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true; importBtn.classList.add("loading"); importBtn.textContent = "Checking session...";
    const authed = await checkAuth();
    const importSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Import Schedule`;
    if (!authed) { importBtn.textContent = "Waiting for login..."; addMessage("system", "Opening TXST login — sign in and the import will start automatically."); chrome.runtime.sendMessage({ action: "openLoginPopup" }); attachImportLoginListener(importBtn, importSvg); return; }
    importBtn.textContent = "Importing..."; $("statusBar").textContent = "Importing schedule...";
    analysisResults = null; cachedRawData = null; cachedRegisteredCourses = []; cachedRegisteredTerm = null; conversationHistory = [];
    let resetBtn = true;
    try {
      const result = await loadSchedule(currentTerm);
      if (result.stale) return;
      if (!result.hadRegistrationRows && !result.fromDiskCache) { resetBtn = false; importBtn.textContent = "Waiting for login..."; addMessage("system", "Opening TXST login — sign in to load your registration."); chrome.runtime.sendMessage({ action: "openLoginPopup" }); attachImportLoginListener(importBtn, importSvg); return; }
    } finally { if (resetBtn) { importBtn.disabled = false; importBtn.classList.remove("loading"); importBtn.innerHTML = importSvg; } }
  });
}

// ============================================================
// SAML / getCurrentSchedule
// ============================================================

function waitAnimationFrames(n) { let p = Promise.resolve(); for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => requestAnimationFrame(r))); return p; }
function registrationResponseLooksLikeJson(text) { const t = text.trim(); return t.startsWith("[") || t.startsWith("{"); }

function pickSamlPostForm(doc) {
  const forms = [...doc.querySelectorAll("form")];
  if (!forms.length) return null;
  const hasRelay = (f) => f.querySelector('input[name="SAMLResponse"],input[name="SAMLRequest"],input[name="RelayState"]');
  return forms.find(hasRelay) || forms.find((f) => !f.closest("noscript")) || forms[0];
}

async function submitFirstFormFromHtml(htmlText, baseHref) {
  try {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const form = pickSamlPostForm(doc);
    if (!form) return null;
    const rawAction = form.getAttribute("action");
    if (rawAction && rawAction.trim().toLowerCase().startsWith("javascript:")) return null;
    const url = (!rawAction || rawAction.trim() === "") ? new URL(baseHref) : new URL(rawAction, baseHref);
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    const params = new URLSearchParams();
    form.querySelectorAll("input[name]").forEach((i) => { const n = i.getAttribute("name"); if (n) params.append(n, i.value); });
    form.querySelectorAll("select[name]").forEach((s) => { const n = s.getAttribute("name"); if (n) params.append(n, s.value); });
    const init = { credentials: "include", redirect: "follow" };
    if (method === "GET") { url.search = params.toString(); return await (await fetch(url.href, init)).text(); }
    return await (await fetch(url.href, { ...init, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() })).text();
  } catch (e) { return null; }
}

async function resolveRegistrationHtmlToJson(initialText, baseHref) {
  let text = initialText, samlHops = 0;
  while (!registrationResponseLooksLikeJson(text) && samlHops < 8) { const next = await submitFirstFormFromHtml(text, baseHref); if (!next) break; text = next; samlHops++; }
  return { text, samlHops };
}

let registrationFetchQueue = Promise.resolve();
function queueRegistrationFetch(fn) {
  const task = registrationFetchQueue.then(fn, fn);
  registrationFetchQueue = task.then(() => {}, () => {});
  return task;
}

function getCurrentSchedule(term) {
  return queueRegistrationFetch(async () => {
    try {
      await fetch("https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/term/search?mode=registration", { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ term }).toString() });
      await fetch("https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration", { credentials: "include" });
      const response = await fetch("https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents?termFilter=", { credentials: "include" });
      let text = await response.text();
      const eventsBase = "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents";
      const resolved = await resolveRegistrationHtmlToJson(text, eventsBase);
      text = resolved.text;
      if (!registrationResponseLooksLikeJson(text)) return null;
      return JSON.parse(text);
    } catch (e) { return null; }
  });
}

// ============================================================
// LOAD SCHEDULE
// ============================================================

function buildRegisteredCoursesFromEvents(data) {
  const seen = new Set(), registered = [], locks = new Set();
  if (!data || !data.length) return { registered, locks };
  for (const event of data) {
    if (seen.has(event.crn)) continue;
    seen.add(event.crn);
    const start = new Date(event.start), end = new Date(event.end);
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const days = [];
    for (const ev2 of data) {
      if (String(ev2.crn) !== String(event.crn)) continue;
      const d = new Date(ev2.start).getDay() - 1;
      if (d >= 0 && d <= 4 && !days.includes(dayNames[d])) days.push(dayNames[d]);
    }
    const bh = start.getHours(), bm = start.getMinutes();
    const eh = end.getHours(), em = end.getMinutes();
    registered.push({ crn: String(event.crn), subject: event.subject, courseNumber: event.courseNumber, title: event.title, days, beginTime: String(bh).padStart(2,"0") + ":" + String(bm).padStart(2,"0"), endTime: String(eh).padStart(2,"0") + ":" + String(em).padStart(2,"0"), source: "registered", online: false });
    locks.add(String(event.crn));
  }
  return { registered, locks };
}

async function loadSchedule(term) {
  const fetchGen = bumpScheduleFetchGeneration();
  registeredFetchCompleted = false;
  $("statusBar").textContent = "Loading schedule...";

  let fromDiskCache = false;
  let data = await getCurrentSchedule(term);
  if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
  if (data === null) {
    for (let i = 0; i < 16; i++) {
      await waitAnimationFrames(2);
      if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
      data = await getCurrentSchedule(term);
      if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
      if (data !== null) break;
    }
  }
  if (data === null) { const cached = await loadCachedRegistrationEvents(term); if (cached) { data = cached; fromDiskCache = true; } }

  if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };

  registeredFetchOk = data !== null;
  registeredFetchCompleted = true;
  if (data && data.length > 0) {
    removeExistingScheduleRefreshPrompts();
    registeredScheduleCache[term] = data;
    cachedRegisteredCourses = compressRegisteredForLLM(data);
    cachedRegisteredTerm = term;
    const { registered, locks } = buildRegisteredCoursesFromEvents(data);
    lockedCrns = locks;
    workingCourses = [...registered, ...workingCourses.filter((c) => c.source !== "registered")];

    // Register modal metadata for registered courses
    const mergedByCrn = groupRegistrationEventsByCrn(data);
    mergedByCrn.forEach((mergedEv, crn) => {
      const meta = extractMetaFromRegistrationEvent(mergedEv);
      // meetingTimeDisplay filled on block render
      registerCourseMeta(crn, meta);
    });

    renderCalendarFromWorkingCourses();
    updateWeekHours(data);
    updateOverviewFromEvents(data);
    const unique = new Set(data.map((e) => e.crn));
    if (!fromDiskCache) persistRegistrationEvents(term, data);
    $("statusBar").textContent = fromDiskCache ? unique.size + " registered courses (saved copy — use Import Schedule to refresh)" : unique.size + " registered courses";
    updateSaveBtn();
    return { stale: false, hadRegistrationRows: true, fromDiskCache, fetchOk: true };
  } else if (data === null) {
    cachedRegisteredCourses = []; cachedRegisteredTerm = term;
    buildEmptyCalendar(); $("statusBar").textContent = "Could not reach registration data. Try Import Schedule again.";
    addScheduleRefreshPrompt();
    return { stale: false, hadRegistrationRows: false, fromDiskCache, fetchOk: false };
  } else {
    removeExistingScheduleRefreshPrompts();
    cachedRegisteredCourses = []; cachedRegisteredTerm = term;
    buildEmptyCalendar(); $("statusBar").textContent = "No registered courses for this term";
    return { stale: false, hadRegistrationRows: false, fromDiskCache: false, fetchOk: true };
  }
}

// ============================================================
// WORKING SCHEDULE — add/remove/lock
// ============================================================

function addToWorkingSchedule(entry) {
  const crn = String(entry.crn);
  // If replacing a section of the same course (different CRN), transfer the lock
  // so "Replace on calendar" doesn't silently drop a lock the user set.
  const displaced = workingCourses.find(
    (c) => c.subject === entry.subject && c.courseNumber === entry.courseNumber && String(c.crn) !== crn
  );
  if (displaced && lockedCrns.has(String(displaced.crn))) {
    lockedCrns.delete(String(displaced.crn));
    lockedCrns.add(crn);
  }
  workingCourses = workingCourses.filter((c) => String(c.crn) !== crn);
  workingCourses.push({ ...entry, crn });
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
}

function removeFromWorkingSchedule(crn) {
  const k = String(crn);
  workingCourses = workingCourses.filter((c) => String(c.crn) !== k);
  lockedCrns.delete(k);
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
}

function toggleLock(crn) {
  const k = String(crn);
  if (lockedCrns.has(k)) lockedCrns.delete(k); else lockedCrns.add(k);
  renderCalendarFromWorkingCourses();
}

function updateSaveBtn() {
  const saveBtn = $("saveTxstBtn");
  if (!saveBtn) return;
  const hasNonRegistered = workingCourses.some((c) => c.source !== "registered");
  saveBtn.classList.toggle("txst-save-btn--dim", !hasNonRegistered);
  saveBtn.disabled = !hasNonRegistered;
}

function activateNewPlanRow() {
  if (activeScheduleKey === "new") return;
  bumpScheduleViewGeneration();
  activeScheduleKey = "new";
  workingCourses = []; lockedCrns = new Set();
  renderCalendarFromWorkingCourses(); updateSaveBtn(); renderSavedList();
}

function enterNewPlanEditMode() {
  const row = document.querySelector(".saved-item-new-plan");
  if (!row || row.querySelector(".new-plan-input")) return;
  if (activeScheduleKey !== "new") { bumpScheduleViewGeneration(); activeScheduleKey = "new"; workingCourses = []; lockedCrns = new Set(); renderCalendarFromWorkingCourses(); updateSaveBtn(); }
  document.querySelectorAll("#savedList .saved-item").forEach((el) => el.classList.toggle("active", el.classList.contains("saved-item-new-plan")));
  const span = row.querySelector(".new-plan-label");
  if (!span) return;
  span.style.display = "none";
  const input = document.createElement("input");
  input.type = "text"; input.className = "new-plan-input"; input.autocomplete = "off"; input.value = newPlanDisplayName;
  row.appendChild(input);
  requestAnimationFrame(() => { input.focus(); input.select(); });
  const commit = () => {
    newPlanDisplayName = input.value.trim();
    span.textContent = newPlanDisplayName || "New Plan"; span.style.display = ""; input.remove();
    row.dataset.planName = newPlanDisplayName;
    const saveBtn = $("saveTxstBtn"); if (saveBtn) saveBtn.dataset.planName = newPlanDisplayName;
    newPlanSingleClickOpensEdit = false;
    renderSavedList();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); input.blur(); } if (ev.key === "Escape") { input.value = newPlanDisplayName; input.blur(); } });
}

// ============================================================
// CALENDAR CONSTANTS + BUILD EMPTY
// ============================================================

function buildEmptyCalendar() {
  clearCalendarCourseMeta();
  let html = '<tr><th class="time-col">Time</th>';
  DAYS.forEach((d) => { html += "<th>" + d + "</th>"; });
  html += "</tr>";
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const label = (h > 12 ? h - 12 : h) + ":00 " + (h >= 12 ? "PM" : "AM");
    html += '<tr><td class="time-label">' + label + "</td>";
    for (let d = 0; d < 5; d++) html += '<td id="cell-' + d + "-" + h + '"></td>';
    html += "</tr>";
  }
  $("calendar").innerHTML = html;
}

function assignOverlapColumns(cellItems) {
  cellItems.sort((a, b) => a.startOffset - b.startOffset || String(a.crnKey).localeCompare(String(b.crnKey)));
  const colEnd = [];
  for (const it of cellItems) {
    const end = it.startOffset + it.height;
    let c = 0;
    for (; c < colEnd.length; c++) { if (colEnd[c] <= it.startOffset + 0.5) break; }
    if (c === colEnd.length) colEnd.push(end); else colEnd[c] = end;
    it.col = c;
  }
  const n = colEnd.length;
  cellItems.forEach((it) => { it.colCount = n; });
}

// ============================================================
// CALENDAR RENDERING — unified from workingCourses (52px/hr)
// ============================================================

function renderCalendarFromWorkingCourses() {
  buildEmptyCalendar();
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
  const cellBuckets = new Map();

  for (const course of workingCourses) {
    if (!course.days || !course.beginTime || !course.endTime) continue;
    const [bh, bm] = course.beginTime.split(":").map(Number);
    const [eh, em] = course.endTime.split(":").map(Number);
    const startOffset = (bm / 60) * PX_PER_HOUR;
    const height = (eh + em / 60 - (bh + bm / 60)) * PX_PER_HOUR;
    const timeStr = formatTime24to12(bh, bm) + " – " + formatTime24to12(eh, em);
    const crnKey = String(course.crn ?? "");
    const isLocked = lockedCrns.has(crnKey);
    const courseKey = course.subject + course.courseNumber;
    const chipClass = getChipForCourse(courseKey);

    for (const day of course.days) {
      const dayIdx = dayMap[day];
      if (dayIdx === undefined) continue;
      const cellKey = dayIdx + "-" + bh;
      if (!cellBuckets.has(cellKey)) cellBuckets.set(cellKey, []);
      cellBuckets.get(cellKey).push({ course, dayIdx, bh, startOffset, height, timeStr, crnKey, isLocked, courseKey, chipClass });
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

      // Register meta for modal
      if (p.crnKey) {
        let meta = calendarCourseMetaByCrn.get(p.crnKey);
        if (!meta) {
          meta = { crn: p.crnKey, courseCode: p.course.subject + " " + p.course.courseNumber, subject: p.course.subject, courseNumber: p.course.courseNumber, title: p.course.title || "—", section: "—", professor: "—", location: "—", instructionalMethod: "—", meetingTimeDisplay: p.timeStr };
          registerCourseMeta(p.crnKey, meta);
        } else {
          meta.meetingTimeDisplay = meta.meetingTimeDisplay || p.timeStr;
        }
      }

      block.querySelector(".block-remove-btn")?.addEventListener("click", (e) => { e.stopPropagation(); removeFromWorkingSchedule(p.crnKey); });
      block.querySelector(".block-lock-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleLock(p.crnKey); });

      cell.appendChild(block);
    }
  }

  // Show or clear conflict warning after every calendar render
  updateConflictStatus();
  // Keep AI toolbar lock count in sync
  renderAIToolbar();
}

// ============================================================
// MODAL METADATA INFRASTRUCTURE (Simone)
// ============================================================

function pickFirstStr(...vals) {
  for (const v of vals) { if (v == null || v === "") continue; const s = typeof v === "number" ? String(v) : String(v).trim(); if (s) return s; } return "";
}

function formatInstructionalMethodLabel(code) {
  const u = String(code || "").trim().toUpperCase();
  if (!u) return "—";
  if (u === "INT" || u === "IN" || u === "INS" || u === "WEB") return "Internet (Online)";
  if (u === "TR" || u === "TRD") return "Traditional (in person)";
  if (u === "HYB" || u === "HY") return "Hybrid";
  return String(code).length > 48 ? String(code).slice(0, 45) + "…" : String(code);
}

function expandRegistrationEvent(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const xp = raw.extendedProps || raw.extendedProperties || raw.resource || raw.eventExtendedProps;
  const merged = xp && typeof xp === "object" ? { ...xp, ...raw } : { ...raw };
  const out = { ...merged };
  const mergeCo = (co) => {
    if (!co || typeof co !== "object") return;
    const crn = co.courseReferenceNumber ?? co.crn ?? co.courseRegistrationNumber;
    if (crn != null && String(crn).trim() && !pickFirstStr(out.crn, out.courseReferenceNumber)) { out.courseReferenceNumber = String(crn).trim(); out.crn = String(crn).trim(); }
    const subj = pickFirstStr(co.subject, co.subjectCode, co.courseSubject); if (subj && !pickFirstStr(out.subject, out.subjectCode)) out.subject = subj;
    const num = pickFirstStr(co.courseNumber, co.number, co.catalogNumber, co.courseNum); if (num && !pickFirstStr(out.courseNumber)) out.courseNumber = num;
    const seq = pickFirstStr(co.sequenceNumber, co.sectionNumber, co.section, co.sequence); if (seq && !pickFirstStr(out.sequenceNumber, out.sectionNumber, out.section)) out.sequenceNumber = seq;
    if (Array.isArray(co.meetingsFaculty) && (!Array.isArray(out.meetingsFaculty) || !out.meetingsFaculty.length)) out.meetingsFaculty = co.meetingsFaculty;
    const title = pickFirstStr(co.courseTitle, co.courseDescription, co.title); if (title && !pickFirstStr(out.title, out.courseTitle)) { out.title = title; out.courseTitle = title; }
    if (co.instructionalMethod != null && out.instructionalMethod == null) out.instructionalMethod = co.instructionalMethod;
  };
  mergeCo(out.courseOffering); mergeCo(out.sectionHeader); mergeCo(out.sectionInformation); mergeCo(out.section);
  const sc = out.subjectCourse;
  if (sc && typeof sc === "object") { const sj = pickFirstStr(sc.subject, sc.subjectCode); const nm = pickFirstStr(sc.courseNumber, sc.number); if (sj && !pickFirstStr(out.subject)) out.subject = sj; if (nm && !pickFirstStr(out.courseNumber)) out.courseNumber = nm; }
  return out;
}

function mergeRegistrationEventRows(rows) {
  if (!rows || !rows.length) return null;
  if (rows.length === 1) return { ...rows[0] };
  const out = { ...rows[0] };
  for (let i = 1; i < rows.length; i++) {
    const b = rows[i];
    for (const k of Object.keys(b)) {
      const bv = b[k]; if (bv == null || bv === "") continue;
      if (k === "meetingsFaculty" && Array.isArray(bv)) { out[k] = [...(out[k] || []), ...bv]; continue; }
      if (out[k] == null || out[k] === "") out[k] = bv;
    }
  }
  return out;
}

function groupRegistrationEventsByCrn(events) {
  const buckets = new Map();
  for (const ev of events || []) {
    const crn = String(ev.crn ?? ev.courseReferenceNumber ?? "").trim();
    if (!crn) continue;
    if (!buckets.has(crn)) buckets.set(crn, []);
    buckets.get(crn).push(ev);
  }
  const merged = new Map();
  buckets.forEach((rows, crn) => merged.set(crn, mergeRegistrationEventRows(rows)));
  return merged;
}

function extractFacultyName(ev) {
  const tryFac = (f) => { if (!f) return ""; const n = f.displayName || f.preferredName || f.fullName || f.sortName || f.name || (f.firstName && f.lastName ? f.lastName + ", " + f.firstName : "") || ""; if (!n || n === "Faculty, Unassigned") return ""; return String(n).trim(); };
  if (Array.isArray(ev.faculty)) { for (const f of ev.faculty) { const n = tryFac(f); if (n) return n; } }
  if (Array.isArray(ev.meetingsFaculty)) {
    for (const mf of ev.meetingsFaculty) {
      const direct = pickFirstStr(mf.facultyDisplayName, mf.displayName, mf.instructorName, typeof mf.faculty === "string" ? mf.faculty : ""); if (direct) return direct;
      const arr = mf.faculty || mf.instructors || mf.instructor;
      const list = Array.isArray(arr) ? arr : arr ? [arr] : [];
      for (const f of list) { const n = tryFac(f); if (n) return n; }
    }
  }
  return pickFirstStr(typeof ev.instructor === "string" ? ev.instructor : "", ev.instructorName, ev.primaryInstructor, ev.facultyDisplayName);
}

function extractMeetingLocation(ev) {
  const fromMt = (mt) => { if (!mt) return ""; const bits = [mt.buildingDescription, mt.buildingAndRoomDescription, mt.facilityDescription, mt.building, mt.room, mt.roomNumber, mt.campusDescription, mt.campus].filter(Boolean); return bits.length ? bits.join(" · ") : ""; };
  if (Array.isArray(ev.meetingsFaculty)) { for (const mf of ev.meetingsFaculty) { const mt = mf.meetingTime || mf.meetTime || mf.schedule || mf.classMeeting; const loc = fromMt(mt); if (loc) return loc; } }
  const loc = fromMt(ev.meetingTime || ev.schedule || ev.scheduledMeeting); if (loc) return loc;
  return pickFirstStr(ev.buildingDescription, ev.roomDescription, ev.room, ev.building, ev.campusDescription, ev.campus, ev.meetingSchedule, ev.location);
}

function extractMetaFromRegistrationEvent(rawEv) {
  const ev = expandRegistrationEvent(rawEv);
  const crn = String(ev.crn ?? ev.courseReferenceNumber ?? "").trim();
  const subject = pickFirstStr(ev.subject, ev.subjectCode, ev.courseSubject);
  const courseNumber = pickFirstStr(ev.courseNumber, ev.courseNum, ev.number, ev.catalogNumber);
  const courseCode = (subject + " " + courseNumber).trim();
  const title = pickFirstStr(ev.title, ev.courseTitle, ev.courseDescription, ev.scheduleDescription);
  const sectionRaw = pickFirstStr(ev.sequenceNumber, ev.sectionNumber, typeof ev.section === "string" || typeof ev.section === "number" ? ev.section : "", ev.sequence);
  const section = sectionRaw || "—";
  const prof = extractFacultyName(ev);
  const imRaw = ev.instructionalMethod;
  const imAlt = pickFirstStr(imRaw, ev.scheduleType, ev.courseInstructionalMethod, ev.courseInstructionalMethodDescription, ev.instructionalMethodDescription);
  let location = extractMeetingLocation(ev);
  let methodLabel = imAlt ? formatInstructionalMethodLabel(imAlt) : "—";
  if (!location && (String(imAlt || "").toUpperCase() === "INT" || methodLabel.includes("Online"))) location = "Online";
  return { crn, courseCode, subject, courseNumber, title: title || "—", section, professor: prof ? String(prof).trim() : "—", location: location || "—", instructionalMethod: methodLabel, meetingTimeDisplay: "" };
}

function isDashPlaceholder(val) { const s = String(val ?? "").trim(); return !s || s === "—"; }

function mergeRegistrationMetaForModal(existing, fresh) {
  const pick = (oldVal, newVal) => !isDashPlaceholder(newVal) ? newVal : oldVal;
  if (!fresh) return existing;
  const base = existing || {};
  return { crn: pick(base.crn, fresh.crn), courseCode: pick(base.courseCode, fresh.courseCode), subject: pick(base.subject, fresh.subject), courseNumber: pick(base.courseNumber, fresh.courseNumber), title: pick(base.title, fresh.title), section: pick(base.section, fresh.section), professor: pick(base.professor, fresh.professor), location: pick(base.location, fresh.location), instructionalMethod: pick(base.instructionalMethod, fresh.instructionalMethod), meetingTimeDisplay: base.meetingTimeDisplay || fresh.meetingTimeDisplay || "" };
}

function parseCourseCodeFromTitle(titleLine) {
  const m = String(titleLine || "").trim().match(/^([A-Za-z&]{2,12})\s+(\d{3,5}[A-Za-z]?)\b/);
  if (m) return { subject: m[1].toUpperCase(), courseNumber: m[2] };
  return { subject: "", courseNumber: "" };
}

const RMP_TXST_SCHOOL_ID = "938";
function professorNameForRateMyProfessorsQuery(displayName) {
  const raw = String(displayName || "").trim();
  if (!raw || raw === "—" || /unassigned|tba|^staff$/i.test(raw.toLowerCase())) return "";
  const comma = raw.indexOf(",");
  if (comma > 0) { const last = raw.slice(0, comma).trim(); const after = raw.slice(comma + 1).trim().replace(/\s+/g, " "); if (last && after) return (after.split(/\s+/)[0] + " " + last).trim(); return last; }
  return raw;
}
function buildRateMyProfessorsUrl(professorDisplayName) {
  const q = professorNameForRateMyProfessorsQuery(professorDisplayName);
  if (!q) return `https://www.ratemyprofessors.com/school/${RMP_TXST_SCHOOL_ID}`;
  return `https://www.ratemyprofessors.com/search/professors/${RMP_TXST_SCHOOL_ID}?q=${encodeURIComponent(q)}`;
}

const TXST_REG_BASE = "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";
async function fetchBannerSectionRowByCrn(term, crn, subject, courseNumber) {
  const crnStr = String(crn || "").trim(), sub = String(subject || "").trim(), num = String(courseNumber || "").trim();
  if (!crnStr || !term || !sub || !num) return null;
  try {
    await fetch(TXST_REG_BASE + "/ssb/classSearch/resetDataForm", { method: "POST", credentials: "include" });
    await fetch(TXST_REG_BASE + "/ssb/term/search?mode=search", { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ term, studyPath: "", studyPathText: "", startDatepicker: "", endDatepicker: "" }).toString() });
    const form = new FormData();
    form.append("txt_subject", sub); form.append("txt_courseNumber", num); form.append("txt_term", term);
    form.append("pageOffset", "0"); form.append("pageMaxSize", "500"); form.append("sortColumn", "subjectDescription"); form.append("sortDirection", "asc");
    form.append("startDatepicker", ""); form.append("endDatepicker", ""); form.append("uniqueSessionId", sub + num + "-bobcat-modal-" + Date.now());
    const res = await fetch(TXST_REG_BASE + "/ssb/searchResults/searchResults", { method: "POST", credentials: "include", body: form });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data?.success || !Array.isArray(data.data)) return null;
    return data.data.find((s) => String(s.courseReferenceNumber || "").trim() === crnStr) || null;
  } catch (e) { console.warn("[BobcatPlus] fetchBannerSectionRowByCrn:", e); return null; }
}

// ============================================================
// ELIGIBLE COURSES
// ============================================================

function formatSectionOneLine(section) {
  const sn = String(section.sequenceNumber ?? section.sectionNumber ?? section.section ?? "?");
  const mt = section.meetingsFaculty?.[0]?.meetingTime;
  let timeStr = "";
  if (mt && mt.beginTime) {
    const days = [];
    if (mt.monday) days.push("Mon"); if (mt.tuesday) days.push("Tue"); if (mt.wednesday) days.push("Wed"); if (mt.thursday) days.push("Thu"); if (mt.friday) days.push("Fri");
    const bh = parseInt(mt.beginTime.slice(0, 2)), bm = parseInt(mt.beginTime.slice(2));
    const eh = parseInt(mt.endTime.slice(0, 2)), em = parseInt(mt.endTime.slice(2));
    if (days.length) timeStr = " · " + days.join("/") + " " + formatTime24to12(bh, bm) + "–" + formatTime24to12(eh, em);
  }
  const online = section.instructionalMethod === "INT" ? " · Online" : "";
  const seats = section.seatsAvailable != null ? " · " + section.seatsAvailable + " seats" : "";
  return "Section " + sn + timeStr + online + seats;
}

function renderEligibleList() {
  const list = $("eligibleList"), status = $("eligibleStatus");
  if (!list) return;
  if (!eligibleCourses || !eligibleCourses.length) {
    list.innerHTML = "";
    if (status) status.textContent = !analysisResults ? "Loading eligible courses…" : "No eligible courses found for this term.";
    return;
  }
  const seenKeys = new Set();
  const dedupedCourses = eligibleCourses.filter((course) => { const k = course.subject + "-" + course.courseNumber; if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });

  const filteredCourses = showOpenSeatsOnly
    ? dedupedCourses.filter((course) => (course.sections || []).some((s) => s.openSection))
    : dedupedCourses;

  if (status) {
    const chipClass = "bp-chip" + (showOpenSeatsOnly ? " active" : "");
    status.innerHTML = "<span>" + filteredCourses.length + " eligible courses</span><button id='seatsToggleBtn' class='" + chipClass + "'>" + (showOpenSeatsOnly ? "✓ Open only" : "Open only") + "</button>";
    const toggleBtnEl = document.getElementById("seatsToggleBtn");
    if (toggleBtnEl) toggleBtnEl.addEventListener("click", (e) => { e.stopPropagation(); showOpenSeatsOnly = !showOpenSeatsOnly; renderEligibleList(); });
  }
  list.innerHTML = "";

  if (!filteredCourses.length) {
    list.innerHTML = '<div class="saved-empty">No courses with open seats for this term.</div>';
    return;
  }

  filteredCourses.forEach((course) => {
    const key = course.subject + "-" + course.courseNumber;
    const openCount = (course.sections || []).filter((s) => s.openSection).length;
    const totalCount = (course.sections || []).length;
    const alreadyAdded = workingCourses.some((c) => c.subject === course.subject && c.courseNumber === course.courseNumber && c.source !== "registered");
    const item = document.createElement("div");
    item.className = "eligible-course" + (alreadyAdded ? " added" : "");
    const header = document.createElement("div");
    header.className = "eligible-course-header";
    header.innerHTML = '<span class="eligible-name">' + course.subject + " " + course.courseNumber + '<span class="eligible-req"> — ' + (course.label || "") + "</span></span>" + '<span class="eligible-meta">' + openCount + "/" + totalCount + " open</span>";
    header.addEventListener("click", () => { expandedCourseKey = expandedCourseKey === key ? null : key; renderEligibleList(); });
    item.appendChild(header);

    if (expandedCourseKey === key) {
      const body = document.createElement("div");
      body.className = "eligible-course-body";
      const courseTitle = course.sections[0]?.courseTitle?.replace(/&amp;/g, "&")?.replace(/&#39;/g, "'") || "";
      if (courseTitle) { const titleEl = document.createElement("div"); titleEl.className = "eligible-course-title"; titleEl.textContent = courseTitle; body.appendChild(titleEl); }
      const seenCrns = new Set();
      const sections = (course.sections || []).filter((s) => { const crn = String(s.courseReferenceNumber || ""); if (!crn || seenCrns.has(crn)) return false; seenCrns.add(crn); return true; });
      const currentIdx = selectedSectionByCourse[key] ?? 0;
      sections.forEach((s, i) => {
        const lbl = document.createElement("label");
        lbl.className = "manual-result-row";
        lbl.innerHTML = '<input type="radio" name="sec-' + key + '" data-idx="' + i + '" ' + (i === currentIdx ? "checked" : "") + "> " + formatSectionOneLine(s);
        lbl.querySelector("input").addEventListener("change", () => { selectedSectionByCourse[key] = i; });
        body.appendChild(lbl);
      });
      const addBtn = document.createElement("button");
      addBtn.type = "button"; addBtn.className = "manual-small-btn"; addBtn.style.marginTop = "4px";
      addBtn.textContent = alreadyAdded ? "Replace on calendar" : "Add to calendar";
      addBtn.addEventListener("click", () => {
        const idx = selectedSectionByCourse[key] ?? 0, section = sections[idx];
        if (!section) return;
        const crn = String(section.courseReferenceNumber || "");
        if (!crn) { $("statusBar").textContent = "Section has no CRN."; return; }
        const mt = section.meetingsFaculty?.[0]?.meetingTime;
        const days = [];
        if (mt?.monday) days.push("Mon"); if (mt?.tuesday) days.push("Tue"); if (mt?.wednesday) days.push("Wed"); if (mt?.thursday) days.push("Thu"); if (mt?.friday) days.push("Fri");
        const beginTime = mt?.beginTime ? mt.beginTime.slice(0, 2) + ":" + mt.beginTime.slice(2) : null;
        const endTime = mt?.endTime ? mt.endTime.slice(0, 2) + ":" + mt.endTime.slice(2) : null;
        addToWorkingSchedule({ crn, subject: course.subject, courseNumber: course.courseNumber, title: section.courseTitle || course.sections[0]?.courseTitle || "", days, beginTime, endTime, source: "manual", online: section.instructionalMethod === "INT" });
        expandedCourseKey = null;
        $("statusBar").textContent = "Added " + course.subject + " " + course.courseNumber + " to calendar.";
        renderEligibleList(); updateSaveBtn();
      });
      body.appendChild(addBtn);
      item.appendChild(body);
    }
    list.appendChild(item);
  });
}

// ============================================================
// SAVE TO TXST
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  const saveTxstBtn = $("saveTxstBtn");
  if (saveTxstBtn) {
    saveTxstBtn.addEventListener("click", async () => {
      if (saveTxstBtn.disabled) return;
      const newPlanItems = document.querySelectorAll(".saved-item-new-plan");
      let planName = "";
      newPlanItems.forEach((el) => { if (el.dataset.planName) planName = el.dataset.planName.trim(); });
      if (!planName) planName = newPlanDisplayName;
      if (!planName) {
        const newPlanLabel = document.querySelector(".new-plan-label");
        if (newPlanLabel) { newPlanLabel.style.color = "var(--maroon)"; newPlanLabel.textContent = "Name your plan (click New Plan)"; setTimeout(() => { newPlanLabel.style.color = ""; newPlanLabel.textContent = newPlanDisplayName || "New Plan"; }, 2500); }
        $("statusBar").textContent = "Click New Plan to enter a name first."; return;
      }
      const nonRegistered = workingCourses.filter((c) => c.source !== "registered");
      if (!nonRegistered.length) { $("statusBar").textContent = "Add courses before saving."; return; }
      $("statusBar").textContent = "Saving to TXST…"; saveTxstBtn.disabled = true;
      const rows = nonRegistered.map((c) => { const courseMatch = (eligibleCourses || []).find((ec) => ec.subject === c.subject && ec.courseNumber === c.courseNumber); const section = courseMatch?.sections?.find((s) => String(s.courseReferenceNumber) === c.crn); return { section: section || { courseReferenceNumber: c.crn, courseTitle: c.title }, subject: c.subject, courseNumber: c.courseNumber }; });
      const resp = await sendToBackground({ action: "saveTxstPlan", term: currentTerm, planName, rows });
      saveTxstBtn.disabled = false; updateSaveBtn();
      if (!resp.ok) { $("statusBar").textContent = resp.error || "Save failed."; return; }
      $("statusBar").textContent = "Saved to TXST: " + planName;
      newPlanDisplayName = ""; newPlanSingleClickOpensEdit = true;
      document.querySelectorAll(".saved-item-new-plan").forEach((el) => { el.dataset.planName = ""; const lbl = el.querySelector(".new-plan-label"); if (lbl) lbl.textContent = "New Plan"; });
      if (saveTxstBtn) saveTxstBtn.dataset.planName = "";
      await loadBannerPlans(currentTerm); renderSavedList();
    });
  }
});

// ============================================================
// SAVED SCHEDULES + BANNER PLANS
// ============================================================

async function loadBannerPlans(term) {
  const plans = await sendToBackground({ action: "getAllBannerPlans", term });
  if (currentTerm !== term) return;
  if (Array.isArray(plans)) { bannerPlans = plans; renderSavedList(); }
  $("statusBar").textContent = "Ready";
}

function renderSavedList() {
  const list = $("savedList");
  if (!list) return;
  const termSchedules = savedSchedules.filter((s) => s.term === currentTerm);
  list.innerHTML = "";

  // Current Registered Schedule
  const regItem = document.createElement("div");
  regItem.className = "saved-item saved-item-registered" + (activeScheduleKey === "registered" ? " active" : "");
  regItem.innerHTML = '<span class="name">Current Registered Schedule</span>';
  regItem.addEventListener("click", () => {
    bumpScheduleViewGeneration(); activeScheduleKey = "registered";
    const cached = registeredScheduleCache[currentTerm];
    if (cached && cached.length) { const { registered, locks } = buildRegisteredCoursesFromEvents(cached); lockedCrns = locks; workingCourses = registered; updateWeekHours(cached); }
    else { workingCourses = workingCourses.filter((c) => c.source === "registered"); lockedCrns = new Set(workingCourses.map((c) => String(c.crn))); updateWeekHours(workingCourses); }
    renderCalendarFromWorkingCourses(); renderSavedList(); $("statusBar").textContent = "Viewing registered schedule"; updateSaveBtn();
  });
  list.appendChild(regItem);

  // Locally saved AI schedules
  termSchedules.forEach((schedule, i) => {
    const key = "saved:" + i;
    const item = document.createElement("div");
    item.className = "saved-item" + (activeScheduleKey === key ? " active" : "");
    const courses = schedule.courses || [];
    const totalCredits = courses.reduce((sum, c) => sum + (c.credits || 3), 0);
    const pillLabels = courses.slice(0, 3).map((c) => '<span class="sched-pill">' + (c.course || ((c.subject || "") + " " + (c.courseNumber || ""))).trim() + "</span>").join("");
    const overflowPill = courses.length > 3 ? '<span class="sched-pill-more">+' + (courses.length - 3) + "</span>" : "";
    item.innerHTML =
      '<div class="sched-item-top"><span class="name">' + schedule.name + '</span><div class="sched-item-actions"><span class="info">' + totalCredits + ' cr</span><span class="delete-btn" data-key="' + key + '" data-idx="' + i + '">×</span></div></div>' +
      (courses.length ? '<div class="sched-pills">' + pillLabels + overflowPill + "</div>" : "");
    item.addEventListener("click", (e) => { if (e.target.classList.contains("delete-btn")) return; bumpScheduleViewGeneration(); activeScheduleKey = key; renderSavedScheduleOnCalendar(schedule); renderSavedList(); });
    list.appendChild(item);
  });

  // TXST Banner plans
  bannerPlans.forEach((plan, pi) => {
    const key = "banner:" + pi;
    const item = document.createElement("div");
    item.className = "saved-item" + (activeScheduleKey === key ? " active" : "");
    const pc = plan.planCourses || [];
    const planPillLabels = pc.slice(0, 3).map((c) => '<span class="sched-pill">' + ((c.subject || "") + " " + (c.courseNumber || "")).trim() + "</span>").join("");
    const planOverflow = pc.length > 3 ? '<span class="sched-pill-more">+' + (pc.length - 3) + "</span>" : "";
    item.innerHTML =
      '<div class="sched-item-top"><span><span class="banner-badge">TXST</span><span class="name">' + plan.name + '</span></span><span class="delete-btn txst-delete" title="Delete from TXST">×</span></div>' +
      (pc.length ? '<div class="sched-pills">' + planPillLabels + planOverflow + "</div>" : "");
    item.querySelector(".txst-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + plan.name + '" from TXST?')) return;
      $("statusBar").textContent = "Deleting " + plan.name + "…";
      const resp = await sendToBackground({ action: "deleteTxstPlan", term: currentTerm, planIndex: plan.txstPlanIndex });
      if (!resp.ok) { $("statusBar").textContent = "Delete failed: " + (resp.error || "unknown"); return; }
      bannerPlans.splice(pi, 1);
      if (activeScheduleKey === key) { activeScheduleKey = "registered"; workingCourses = workingCourses.filter((c) => c.source === "registered"); renderCalendarFromWorkingCourses(); }
      renderSavedList(); $("statusBar").textContent = plan.name + " deleted.";
      setTimeout(() => loadBannerPlans(currentTerm), 1500);
    });
    item.addEventListener("click", async (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      const viewGen = bumpScheduleViewGeneration(); activeScheduleKey = key; renderSavedList();
      try {
        if (!plan.events || !plan.events.length) {
          $("statusBar").textContent = "Loading " + plan.name + "…";
          const events = await sendToBackground({ action: "fetchPlanCalendar", term: currentTerm, planCourses: plan.planCourses || [] });
          if (viewGen !== scheduleViewGeneration) return;
          plan.events = events || [];
          if (!plan.events.length) { buildEmptyCalendar(); $("statusBar").textContent = plan.name + ": no meeting times found."; return; }
        }
        if (viewGen !== scheduleViewGeneration) return;
        const planCourses = plan.events.reduce((acc, event) => {
          const crn = String(event.crn || "");
          const existing = acc.find((c) => c.crn === crn);
          const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
          const start = new Date(event.start), dayIdx = start.getDay() - 1;
          const day = dayIdx >= 0 && dayIdx <= 4 ? dayNames[dayIdx] : null;
          const bh = start.getHours(), bm = start.getMinutes();
          const end = new Date(event.end), eh = end.getHours(), em = end.getMinutes();
          if (existing) { if (day && !existing.days.includes(day)) existing.days.push(day); }
          else acc.push({ crn, subject: event.subject || "", courseNumber: event.courseNumber || "", title: event.title || "", days: day ? [day] : [], beginTime: String(bh).padStart(2,"0") + ":" + String(bm).padStart(2,"0"), endTime: String(eh).padStart(2,"0") + ":" + String(em).padStart(2,"0"), source: "banner", online: false });
          return acc;
        }, []);
        if (viewGen !== scheduleViewGeneration) return;
        workingCourses = planCourses; lockedCrns = new Set();
        renderCalendarFromWorkingCourses(); updateWeekHours(plan.events);
        $("statusBar").textContent = "Viewing: " + plan.name;
      } catch (err) { console.error("[BobcatPlus] banner plan load:", err); if (viewGen === scheduleViewGeneration) $("statusBar").textContent = "Could not load plan. Try again."; }
    });
    list.appendChild(item);
  });

  // + New Plan — always last
  const newPlanItem = document.createElement("div");
  newPlanItem.className = "saved-item saved-item-new-plan" + (activeScheduleKey === "new" ? " active" : "");
  newPlanItem.dataset.planName = newPlanDisplayName;
  const newPlanSpan = document.createElement("span");
  newPlanSpan.className = "new-plan-label";
  newPlanSpan.textContent = newPlanDisplayName || "New Plan";
  newPlanItem.appendChild(newPlanSpan);
  newPlanItem.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (newPlanSingleClickOpensEdit) { enterNewPlanEditMode(); return; }
    clearTimeout(newPlanClickTimer);
    newPlanClickTimer = setTimeout(() => { newPlanClickTimer = null; activateNewPlanRow(); }, 280);
  });
  newPlanItem.addEventListener("dblclick", (e) => { if (e.target.tagName === "INPUT") return; e.preventDefault(); clearTimeout(newPlanClickTimer); newPlanClickTimer = null; enterNewPlanEditMode(); });
  list.appendChild(newPlanItem);

  list.querySelectorAll(".delete-btn:not(.txst-delete)").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      savedSchedules.splice(idx, 1); chrome.storage.local.set({ savedSchedules });
      if (activeScheduleKey === btn.dataset.key) { activeScheduleKey = "registered"; workingCourses = workingCourses.filter((c) => c.source === "registered"); renderCalendarFromWorkingCourses(); }
      renderSavedList();
    });
  });
}

function renderSavedScheduleOnCalendar(schedule) {
  const fromSaved = (schedule.courses || []).map((c) => ({ ...c, crn: String(c.crn ?? ""), source: "saved" }));
  lockedCrns = new Set();
  workingCourses = [...workingCourses.filter((c) => c.source === "registered"), ...fromSaved.filter((c) => !workingCourses.some((w) => String(w.crn) === c.crn))];
  renderCalendarFromWorkingCourses(); updateWeekHours(workingCourses); updateSaveBtn();
  $("statusBar").textContent = "Viewing: " + schedule.name;
}

// ============================================================
// AI TOOLBAR — lock-all shortcut
// ============================================================

function renderAIToolbar() {
  const hintEl = $("aiToolbarHint");
  const btn = $("aiLockAllBtn");
  if (!hintEl || !btn) return;

  const total = workingCourses.length;
  const locked = workingCourses.filter((c) => lockedCrns.has(String(c.crn))).length;
  const allLocked = total > 0 && locked === total;

  if (total === 0) {
    hintEl.textContent = "Add courses in Build mode so the AI can see them";
    btn.disabled = true;
  } else if (allLocked) {
    hintEl.textContent = "All " + total + " course" + (total !== 1 ? "s" : "") + " locked — AI can see them";
    btn.disabled = true;
  } else {
    const unlocked = total - locked;
    hintEl.textContent = locked > 0 ? locked + "/" + total + " locked" : unlocked + " unlocked course" + (unlocked !== 1 ? "s" : "") + " — AI won't see them";
    btn.disabled = false;
  }
}

$("aiLockAllBtn")?.addEventListener("click", () => {
  for (const c of workingCourses) lockedCrns.add(String(c.crn));
  renderCalendarFromWorkingCourses();
  addMessage("system", lockedCrns.size + " course" + (lockedCrns.size !== 1 ? "s" : "") + " locked. The AI can now see your full schedule.");
});

// ============================================================
// CHAT (AI mode)
// ============================================================

$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });

async function sendChat() {
  const input = $("chatInput").value.trim();
  if (!input) return;
  if (panelMode !== "ai") setPanelMode("ai");
  addMessage("user", input);
  $("chatInput").value = "";

  if (!analysisResults) {
    addMessage("system", "Analyzing your degree audit and finding eligible courses. This may take a minute...");
    $("statusBar").textContent = "Running analysis...";
    analysisResults = await runAnalysisAndWait();
    if (analysisResults._skippedStaleTerm) { addMessage("system", "The term changed while loading. Send your message again."); $("statusBar").textContent = ""; return; }
    cachedRawData = analysisResults; eligibleCourses = analysisResults.eligible || [];
    if (!analysisResults.eligible || !analysisResults.eligible.length) { addMessage("system", "No eligible courses found for this term."); $("statusBar").textContent = "No eligible courses found"; return; }
    addMessage("system", `Found ${analysisResults.eligible.length} eligible courses. Sending to AI...`);
  }

  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  if (!openaiKey) { addMessage("system", 'No OpenAI API key found. Run this once in your browser console:\n\nchrome.storage.local.set({ openaiKey: "sk-..." })'); return; }

  $("statusBar").textContent = "Thinking...";
  try {
    const isFirstTurn = conversationHistory.length === 0;
    let userMessage;
    if (isFirstTurn) {
      const compressed = compressForLLM(cachedRawData);
      const lockedList = getLockedForLLM();
      const preFiltered = applyPreFilter(compressed, lockedList);
      const lockedBlock = lockedList.length > 0 ? `ALREADY LOCKED (treat as fixed — build around these, never conflict with them):\n${JSON.stringify(lockedList)}\n\n` : "";
      userMessage = `${lockedBlock}ELIGIBLE COURSES TO SCHEDULE:\n${JSON.stringify(preFiltered)}\n\nMy preferences: ${input}`;
    } else {
      const lockedList = getLockedForLLM();
      const lockedNote = lockedList.length > 0 ? `[Still locked: ${lockedList.map((c) => c.course + " CRN " + c.crn).join(", ")}]\n\n` : "";
      userMessage = lockedNote + input;
    }
    conversationHistory.push({ role: "user", content: userMessage });

    let validSchedules = [], attempts = 0;
    const MAX_ATTEMPTS = 3;
    let lastConflictDetails = [];

    while (validSchedules.length === 0 && attempts < MAX_ATTEMPTS) {
      attempts++;
      if (attempts > 1) {
        const conflictDetails = lastConflictDetails.map((d) => `"${d.name}": ${d.course1} (${d.days1} ${d.start1}-${d.end1}) conflicts with ${d.course2} (${d.days2} ${d.start2}-${d.end2})`).join("; ");
        conversationHistory.push({ role: "user", content: `Your previous schedules had time conflicts. Regenerate all 3 fixing: ${conflictDetails}. Double-check every pair of in-person sections that share any day.` });
        $("statusBar").textContent = `Fixing conflicts (attempt ${attempts})...`;
      }
      const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` }, body: JSON.stringify({ model: "gpt-4o", response_format: { type: "json_object" }, messages: [{ role: "system", content: SCHEDULE_SYSTEM_PROMPT }, ...conversationHistory] }) });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const result = JSON.parse(data.choices[0].message.content);
      conversationHistory.push({ role: "assistant", content: data.choices[0].message.content });

      const conflicted = []; lastConflictDetails = [];
      for (const schedule of result.schedules) {
        const conflict = findFirstConflict(schedule.courses);
        if (conflict) { conflicted.push(schedule.name); lastConflictDetails.push({ name: schedule.name, course1: conflict.a.course, days1: conflict.a.days?.join("/"), start1: conflict.a.start, end1: conflict.a.end, course2: conflict.b.course, days2: conflict.b.days?.join("/"), start2: conflict.b.start, end2: conflict.b.end }); }
        else validSchedules.push(schedule);
      }
      if (conflicted.length > 0 && validSchedules.length === 0 && attempts < MAX_ATTEMPTS) { $("statusBar").textContent = "Conflicts found, retrying..."; continue; }
      if (conflicted.length > 0) addMessage("system", `⚠️ ${conflicted.join(", ")} had time conflicts and were removed. Showing ${validSchedules.length} valid schedule(s).`);
      validSchedules.forEach((s) => addScheduleOption(s));
      if (validSchedules.length === 0) addMessage("system", "Could not generate conflict-free schedules. Try simplifying your preferences.");
      if (result.followUpQuestion && validSchedules.length > 0) addMessage("ai", result.followUpQuestion);
      break;
    }
    $("statusBar").textContent = "Ready";
  } catch (err) { console.error(err); addMessage("system", "Something went wrong: " + err.message); $("statusBar").textContent = "Error"; }
}

function addScheduleOption(schedule) {
  const { name, rationale, totalCredits, courses } = schedule;
  const lockedList = getLockedForLLM();
  const lockedLines = lockedList.map((r) => { const time = r.days?.length ? r.days.join("/") + " " + formatChatTime(r.start) + "–" + formatChatTime(r.end) : "Online"; return '<div style="margin:4px 0;opacity:0.6;border-left:2px solid var(--border);padding-left:6px"><strong>' + r.course + "</strong> — " + (r.title || "") + '<br><span style="font-size:11px">Locked · ' + time + "</span></div>"; }).join("");
  const courseLines = courses.map((c) => { const time = c.online ? "Online" : (c.days?.join("/") + " " + formatChatTime(c.start) + "–" + formatChatTime(c.end)); return '<div style="margin:4px 0"><strong>' + c.course + "</strong> — " + c.title + '<br><span style="font-size:11px;opacity:0.8">CRN: ' + c.crn + " · " + time + " · " + c.requirementSatisfied + "</span></div>"; }).join("");
  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML = '<div class="sender">' + name + " · " + totalCredits + " credits</div>" + '<div style="font-size:11px;margin-bottom:8px;opacity:0.85">' + rationale + "</div>" + lockedLines + courseLines + "<br>" + '<button class="save-schedule-btn add-to-calendar-btn">Add to Calendar</button>' + '<button class="save-schedule-btn lock-all-btn" style="margin-left:6px">Lock All</button>';
  div.querySelector(".add-to-calendar-btn").addEventListener("click", () => {
    for (const c of courses) {
      addToWorkingSchedule({ crn: c.crn, subject: c.course.split(" ")[0], courseNumber: c.course.split(" ")[1], title: c.title, days: c.days || [], beginTime: c.start ? c.start.slice(0, 2) + ":" + c.start.slice(2) : null, endTime: c.end ? c.end.slice(0, 2) + ":" + c.end.slice(2) : null, source: "ai", online: c.online || false });
    }
    addMessage("system", name + " added to calendar. Switch to Build mode to lock, remove, or modify courses.");
    updateSaveBtn();
  });
  div.querySelector(".lock-all-btn").addEventListener("click", () => {
    for (const c of courses) lockedCrns.add(c.crn);
    renderCalendarFromWorkingCourses();
    addMessage("system", "All courses in " + name + " locked.");
  });
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

// ============================================================
// LOCKED COURSES → LLM
// ============================================================

function getLockedForLLM() {
  return workingCourses.filter((c) => lockedCrns.has(String(c.crn))).map((c) => ({ crn: c.crn, course: c.subject + " " + c.courseNumber, title: c.title || "", days: c.days || [], start: c.beginTime ? c.beginTime.replace(":", "") : null, end: c.endTime ? c.endTime.replace(":", "") : null }));
}

// ============================================================
// ANALYSIS RUNNER
// ============================================================

function runAnalysisAndWait({ forceRefresh = false } = {}) {
  const mySeq = ++eligibleAnalysisSeq;
  const termAtStart = currentTerm;
  return new Promise((resolve) => {
    const stale = () => { chrome.runtime.onMessage.removeListener(listener); resolve({ eligible: [], blocked: [], notOffered: [], needed: [], _skippedStaleTerm: true }); };
    const results = { eligible: [], blocked: [], notOffered: [], needed: [] };
    const listener = (message) => {
      if (eligibleAnalysisSeq !== mySeq || currentTerm !== termAtStart) { stale(); return; }
      if (message._term !== undefined && message._term !== termAtStart) { stale(); return; }
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
    chrome.runtime.sendMessage({ action: "runAnalysis", term: currentTerm, forceRefresh });
  });
}

// ============================================================
// CHAT HELPERS
// ============================================================

function addMessage(type, text) {
  const div = document.createElement("div");
  div.className = "chat-message " + type;
  const sender = type === "user" ? "You" : type === "ai" ? "Bobcat Plus" : "System";
  div.innerHTML = '<div class="sender">' + sender + "</div>" + text.replace(/\n/g, "<br>");
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function removeExistingScheduleRefreshPrompts() { document.querySelectorAll("[data-schedule-refresh-prompt]").forEach((el) => el.remove()); }
function createCountdownSystemMessage() {
  const div = document.createElement("div"); div.className = "chat-message system";
  div.innerHTML = '<div class="sender">System</div><div class="countdown-body"></div>';
  $("chatMessages").appendChild(div); $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  const body = div.querySelector(".countdown-body");
  return { setHtml(html) { body.innerHTML = html; $("chatMessages").scrollTop = $("chatMessages").scrollHeight; }, remove() { div.remove(); } };
}
async function waitWithChatCountdown(totalSeconds) {
  const msg = createCountdownSystemMessage();
  for (let i = totalSeconds; i >= 1; i--) { msg.setHtml("Waiting for your TXST session to settle… <strong>" + i + "</strong>s"); await sleep(1000); }
  msg.remove();
}
function addScheduleRefreshPrompt() {
  removeExistingScheduleRefreshPrompts();
  const div = document.createElement("div"); div.className = "chat-message system"; div.setAttribute("data-schedule-refresh-prompt", "1");
  div.innerHTML = '<div class="sender">System</div><div>Schedule didn\u2019t load. Click Refresh to retry.</div><button type="button" class="save-schedule-btn">Refresh</button>';
  const btn = div.querySelector("button");
  btn.addEventListener("click", async () => { btn.disabled = true; btn.textContent = "Loading…"; await loadSchedule(currentTerm); btn.textContent = "Refresh"; btn.disabled = false; if (registeredFetchOk) { div.remove(); addMessage("system", "Schedule loaded."); } });
  $("chatMessages").appendChild(div); $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function applyStudentInfoToUI(student) {
  if (!student) return;
  currentStudent = student;
  $("studentName").textContent = student.name + " | " + student.major + " | " + student.degree;
  const ss = document.getElementById("sidebarStudent");
  if (ss) ss.innerHTML = "<strong>" + student.name + "</strong><br>" + student.major + " | " + student.degree;
}

// ============================================================
// WEEK HOURS + OVERVIEW
// ============================================================
function updateWeekHours(events) {
  const seen = new Set(); let totalHours = 0;
  for (const ev of (events || [])) { if (!ev.crn || seen.has(ev.crn)) continue; seen.add(ev.crn); totalHours += ev.creditHours || ev.credits || 3; }
  const el = document.getElementById("weekHours");
  if (!el) return;
  el.innerHTML = totalHours > 0 ? "<strong>" + totalHours + " credit hours</strong> this semester" : "";
}
function updateOverviewFromEvents(events) {
  cachedOverviewEvents = events || [];
  renderOverviewPanel();
}
function toggleOverview() {
  const body = document.getElementById("overviewPanel"), chevron = document.getElementById("overviewChevron");
  if (!body || !chevron) return;
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "block" : "none";
  chevron.textContent = collapsed ? "\u25be" : "\u25b8";
}

// ============================================================
// CONFLICT DETECTION
// ============================================================

/**
 * Check workingCourses for any time overlap on shared days.
 * workingCourses use "HH:MM" colon format for beginTime/endTime
 * (different from LLM courses which use 4-char "HHMM" strings).
 */
function detectWorkingConflict() {
  function toMin(t) {
    if (!t) return null;
    const p = t.split(":");
    return p.length === 2 ? parseInt(p[0]) * 60 + parseInt(p[1]) : null;
  }
  for (let i = 0; i < workingCourses.length; i++) {
    const a = workingCourses[i];
    const aS = toMin(a.beginTime), aE = toMin(a.endTime);
    if (!a.days?.length || aS === null || aE === null) continue;
    for (let j = i + 1; j < workingCourses.length; j++) {
      const b = workingCourses[j];
      const bS = toMin(b.beginTime), bE = toMin(b.endTime);
      if (!b.days?.length || bS === null || bE === null) continue;
      if (!a.days.some((d) => b.days.includes(d))) continue;
      if (aS < bE && bS < aE) return { a, b };
    }
  }
  return null;
}

/** Update status bar with conflict warning, or clear it if no conflicts. */
function updateConflictStatus() {
  const bar = $("statusBar");
  if (!bar) return;
  const conflict = detectWorkingConflict();
  if (conflict) {
    const aCode = (conflict.a.subject || "") + " " + (conflict.a.courseNumber || "");
    const bCode = (conflict.b.subject || "") + " " + (conflict.b.courseNumber || "");
    const sharedDays = (conflict.a.days || []).filter((d) => (conflict.b.days || []).includes(d)).join("/");
    bar.textContent = "⚠ " + aCode.trim() + " overlaps with " + bCode.trim() + (sharedDays ? " on " + sharedDays : "");
    bar.dataset.conflict = "1";
  } else if (bar.dataset.conflict === "1") {
    bar.textContent = "Ready";
    delete bar.dataset.conflict;
  }
}

function timeStrToMinutes(t) { if (!t) return null; return parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(2)); }
function formatTime24to12(h, m) { const ampm = h >= 12 ? "PM" : "AM"; const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h; return h12 + ":" + String(m).padStart(2, "0") + " " + ampm; }
function formatChatTime(t) { if (!t) return ""; return formatTime24to12(parseInt(t.slice(0, 2)), parseInt(t.slice(2))); }
function sectionsConflict(a, b) {
  if (!a.days || !b.days || !a.start || !b.start) return false;
  const sharedDays = a.days.filter((d) => b.days.includes(d));
  if (!sharedDays.length) return false;
  return timeStrToMinutes(a.start) < timeStrToMinutes(b.end) && timeStrToMinutes(b.start) < timeStrToMinutes(a.end);
}
function findFirstConflict(courses) {
  for (let i = 0; i < courses.length; i++) for (let j = i + 1; j < courses.length; j++) if (sectionsConflict(courses[i], courses[j])) return { a: courses[i], b: courses[j] };
  const lockedList = getLockedForLLM();
  for (const proposed of courses) {
    if (lockedList.some((r) => r.crn === proposed.crn)) continue;
    for (const locked of lockedList) if (sectionsConflict(proposed, locked)) return { a: proposed, b: { ...locked, course: locked.course + " (locked)" } };
  }
  return null;
}

// ============================================================
// SIDEBAR + EVENT WIRING
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const hamburger = document.getElementById("hamburgerBtn"), sidebar = document.getElementById("sidebar"), overlay = document.getElementById("sidebarOverlay"), closeBtn = document.getElementById("sidebarClose");
  const openSidebar = () => { if (sidebar) sidebar.classList.add("open"); if (overlay) overlay.classList.add("active"); };
  const closeSidebar = () => { if (sidebar) sidebar.classList.remove("open"); if (overlay) overlay.classList.remove("active"); };
  if (hamburger) hamburger.addEventListener("click", openSidebar);
  if (closeBtn) closeBtn.addEventListener("click", closeSidebar);
  if (overlay) overlay.addEventListener("click", closeSidebar);
  const navRegister = document.getElementById("navRegister"), navAudit = document.getElementById("navAudit");
  if (navRegister) navRegister.addEventListener("click", (e) => { e.preventDefault(); chrome.tabs.create({ url: "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration" }); closeSidebar(); });
  if (navAudit) navAudit.addEventListener("click", (e) => { e.preventDefault(); chrome.tabs.create({ url: "https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/WEB31" }); closeSidebar(); });
  const overviewToggle = document.getElementById("overviewToggle");
  if (overviewToggle) overviewToggle.addEventListener("click", toggleOverview);
});

// ============================================================
// RIGHT PANEL RESIZE
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const handle = document.getElementById("resizeHandle"), panel = document.getElementById("rightPanel");
  if (!handle || !panel) return;
  let dragging = false, startX = 0, startWidth = 0;
  handle.addEventListener("mousedown", (e) => { dragging = true; startX = e.clientX; startWidth = panel.offsetWidth; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; });
  document.addEventListener("mousemove", (e) => { if (!dragging) return; panel.style.width = Math.min(600, Math.max(200, startWidth + (startX - e.clientX))) + "px"; });
  document.addEventListener("mouseup", () => { if (!dragging) return; dragging = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; });
});

// ============================================================
// COURSE DETAIL MODAL (Simone)
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("courseModal");
  const overlay = document.getElementById("modalOverlay");
  const closeBtn = document.getElementById("modalClose");
  const modalProfEmailEl = document.getElementById("modalProfEmail");
  const modalCopyEmailBtn = document.getElementById("modalCopyEmail");
  const modalEmailBtn = document.getElementById("modalEmail");
  const modalRMPBtn = document.getElementById("modalRMP");

  if (!modal || !overlay) return;

  let modalEmailGeneration = 0;
  let modalResolvedEmail = "";
  let currentModalMeta = null;

  function setModalResolvedEmail(email, showCopy) {
    modalResolvedEmail = email && showCopy ? email : "";
    if (modalProfEmailEl) modalProfEmailEl.textContent = email || "—";
    if (modalCopyEmailBtn) modalCopyEmailBtn.hidden = !showCopy;
    if (modalEmailBtn) { modalEmailBtn.toggleAttribute("disabled", !showCopy); modalEmailBtn.classList.toggle("disabled", !showCopy); }
  }

  async function resolveModalEmail(meta) {
    const gen = ++modalEmailGeneration;
    modalResolvedEmail = "";
    if (!meta || typeof window.BobcatFaculty === "undefined" || !meta.courseCode || meta.professor === "—") { setModalResolvedEmail("—", false); return; }
    setModalResolvedEmail("Looking up…", false);
    try {
      const hit = await window.BobcatFaculty.getInstructorEmail(meta.courseCode.trim(), meta.professor);
      if (gen !== modalEmailGeneration) return;
      if (hit && hit.email) setModalResolvedEmail(hit.email, true);
      else setModalResolvedEmail("Not in directory", false);
    } catch (err) { if (gen !== modalEmailGeneration) return; setModalResolvedEmail("—", false); }
  }

  async function openModal(block) {
    const crn = block.getAttribute("data-crn") || "";
    let meta = crn ? calendarCourseMetaByCrn.get(String(crn)) : null;
    const titleFromBlock = block.querySelector(".course-title")?.textContent?.trim() || "";
    const timeEls = block.querySelectorAll(".course-time");
    const timeFromBlock = timeEls[0]?.textContent?.trim() || "—";
    const secondLine = timeEls[1]?.textContent?.trim() || "";
    const termForSearch = (typeof currentTerm !== "undefined" && currentTerm) || document.getElementById("termSelect")?.value || "";

    function applyModalFields(m) {
      document.getElementById("modalTitle").textContent = m ? (m.subject || "") + " " + (m.courseNumber || "") : titleFromBlock;
      document.getElementById("modalSub").textContent = m?.title || secondLine || "";
      document.getElementById("modalSection").textContent = m?.section ?? "—";
      document.getElementById("modalCRN").textContent = crn || "—";
      document.getElementById("modalTime").textContent = m?.meetingTimeDisplay || timeFromBlock;
      document.getElementById("modalProf").textContent = m?.professor ?? "—";
      document.getElementById("modalLocation").textContent = m?.location ?? "—";
      document.getElementById("modalMethod").textContent = m?.instructionalMethod ?? "—";
    }

    applyModalFields(meta);

    const needsHydration = crn && termForSearch && (!meta || isDashPlaceholder(meta.section) || isDashPlaceholder(meta.professor) || isDashPlaceholder(meta.location) || isDashPlaceholder(meta.instructionalMethod));
    if (needsHydration) {
      let subj = meta?.subject || "", num = meta?.courseNumber || "";
      if (!subj || !num) { const parsed = parseCourseCodeFromTitle(titleFromBlock); subj = parsed.subject; num = parsed.courseNumber; }
      if (subj && num) {
        const row = await fetchBannerSectionRowByCrn(termForSearch, crn, subj, num);
        if (row) { const fresh = extractMetaFromRegistrationEvent(row); fresh.meetingTimeDisplay = meta?.meetingTimeDisplay || timeFromBlock; meta = mergeRegistrationMetaForModal(meta, fresh); if (crn) registerCourseMeta(String(crn), meta); applyModalFields(meta); }
      }
    }

    setModalResolvedEmail("…", false);
    modal.classList.add("active");
    overlay.classList.add("active");
    currentModalMeta = meta || null;
    if (meta) resolveModalEmail(meta); else setModalResolvedEmail("—", false);
  }

  function closeModal() { modal.classList.remove("active"); overlay.classList.remove("active"); modalEmailGeneration++; currentModalMeta = null; setModalResolvedEmail("—", false); }

  // Wire block clicks — calendar works in all modes
  document.getElementById("calendar").addEventListener("click", async (e) => {
    const block = e.target.closest(".course-block");
    if (block) await openModal(block);
  });

  if (modalCopyEmailBtn) modalCopyEmailBtn.addEventListener("click", (e) => { e.stopPropagation(); if (modalResolvedEmail && typeof window.BobcatFaculty !== "undefined") window.BobcatFaculty.copyText(modalResolvedEmail); });
  if (modalEmailBtn) modalEmailBtn.addEventListener("click", (e) => { if (!modalResolvedEmail) { e.preventDefault(); return; } e.preventDefault(); window.location.href = window.BobcatFaculty.buildMailtoUrl(modalResolvedEmail, "", ""); });
  if (modalRMPBtn) {
    modalRMPBtn.setAttribute("type", "button");
    modalRMPBtn.setAttribute("title", "Open Rate My Professor (Texas State)");
    modalRMPBtn.addEventListener("click", (e) => { e.preventDefault(); const prof = currentModalMeta?.professor || document.getElementById("modalProf")?.textContent?.trim(); chrome.tabs.create({ url: buildRateMyProfessorsUrl(prof) }); });
  }
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (overlay) overlay.addEventListener("click", closeModal);
});
