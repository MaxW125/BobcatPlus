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

function applyPreFilter(compressed, registeredCourses, calendarBlocksList = []) {
  // Treat calendar blocks as additional locked time slots the AI must not schedule into.
  const blockSlots = calendarBlocksList.map((b) => ({
    crn: null, course: b.label, days: b.days, start: b.start, end: b.end,
  }));
  const allBlocked = [...registeredCourses, ...blockSlots];
  return {
    eligible: compressed.eligible.map((course) => {
      const filteredSections = course.sections.map((section) => {
        if (section.online || !section.days || !section.start) return { ...section, conflictsWith: [] };
        const conflicts = [];
        for (const blocked of allBlocked) {
          if (!blocked.days || !blocked.start) continue;
          const sharedDays = section.days.filter((d) => blocked.days.includes(d));
          if (sharedDays.length === 0) continue;
          if (timeStrToMinutes(section.start) < timeStrToMinutes(blocked.end) && timeStrToMinutes(blocked.start) < timeStrToMinutes(section.end))
            conflicts.push(blocked.crn ? blocked.crn + " (" + blocked.course + ")" : blocked.course);
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

// System prompt is now built dynamically per-request via buildSystemPrompt()
// in scheduleGenerator.js, which is loaded before this file in tab.html.

// ============================================================
// APP STATE
// ============================================================

const $ = (id) => document.getElementById(id);
function sendToBackground(message) { return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve)); }

let currentStudent = null;
let studentProfile = null;     // built by buildStudentProfile() when student data loads
let calendarBlocks = [];       // non-course time blocks (work, gym, etc.) — persisted
let avoidDays = [];            // days the user asked to keep class-free — persisted
let lastRejectedCandidates = new Map();   // CRN → candidate, for chip click direct-add
let chatGeneration = 0;        // bumped on each sendChat + term switch — stale turns bail
let currentTerm = null;
/** term code → Banner description (for empty-schedule hints). */
let termDescriptionsByCode = Object.create(null);
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

let autoLoginInFlight = false;
let lastAutoLoginAt = 0;
let autoLoginAttempts = 0;
function maybeAutoLogin(reason = "", termForProbe) {
  const now = Date.now();
  // Prevent login-popup thrash loops (open/close/open/close...).
  if (autoLoginInFlight) return;
  if (now - lastAutoLoginAt < 45_000) return; // cooldown
  if (autoLoginAttempts >= 2) return;         // hard cap per page load
  autoLoginInFlight = true;
  lastAutoLoginAt = now;
  autoLoginAttempts++;
  const t = termForProbe != null ? termForProbe : currentTerm;
  try {
    chrome.runtime.sendMessage({ action: "openLoginPopup", term: t || undefined }, () => {});
  } catch (_) {}
  const listener = (msg) => {
    if (msg.type === "loginSuccess") {
      chrome.runtime.onMessage.removeListener(listener);
      autoLoginInFlight = false;
      // After login, confirm session is actually valid before retrying,
      // otherwise we can loop endlessly on "loginSuccess" without auth.
      (async () => {
        const ok = await checkAuth();
        if (!ok) {
          $("statusBar").textContent = "Still signed out — click Import Schedule to log in.";
          return;
        }
        analysisResults = null; cachedRawData = null; cachedRegisteredCourses = []; cachedRegisteredTerm = null; conversationHistory = [];
        await waitWithChatCountdown(1);
        const result = await loadSchedule(currentTerm);
        if (result && result.authRequired) {
          $("statusBar").textContent = "Login didn't stick — open TXST in a normal tab, sign in, then click Import Schedule.";
          return;
        }
        autoLoadEligibleCourses({ forceRefresh: true });
      })().catch(() => {});
    }
    if (msg.type === "loginCancelled") {
      chrome.runtime.onMessage.removeListener(listener);
      autoLoginInFlight = false;
      $("statusBar").textContent = "Login cancelled — click Import Schedule to try again.";
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  if (reason) $("statusBar").textContent = reason;
}

const EMPTY_REG_RECOVER_KEY = "bpRegEmptyRecover:";
const SKIP_EMPTY_RECOVER_ONCE = "bpSkipEmptyRecoverOnce";

function clearEmptyRegistrationRecoverFlag(term) {
  try {
    sessionStorage.removeItem(EMPTY_REG_RECOVER_KEY + term);
  } catch (_) {}
}

/** When Banner returns JSON but zero events while DegreeWorks looks signed in — stale registration session. */
async function maybeRecoverEmptyRegistration(term, fromDiskCache) {
  if (fromDiskCache) return;
  try {
    if (sessionStorage.getItem(SKIP_EMPTY_RECOVER_ONCE)) {
      sessionStorage.removeItem(SKIP_EMPTY_RECOVER_ONCE);
      return;
    }
  } catch (_) {}
  try {
    if (sessionStorage.getItem(EMPTY_REG_RECOVER_KEY + term)) return;
  } catch (_) {}
  const ok = await checkAuth();
  if (!ok) return;
  try {
    sessionStorage.setItem(EMPTY_REG_RECOVER_KEY + term, "1");
  } catch (_) {}
  if (autoLoginInFlight) return;
  $("statusBar").textContent =
    "No registration rows from Banner — opening TXST sign-in to refresh…";
  try {
    chrome.runtime.sendMessage({ action: "openLoginPopup", term }, () => {});
  } catch (_) {}
  const listener = (msg) => {
    if (msg.type === "loginSuccess") {
      chrome.runtime.onMessage.removeListener(listener);
      (async () => {
        await waitWithChatCountdown(1);
        await loadSchedule(term);
      })().catch(() => {});
    }
    if (msg.type === "loginCancelled") {
      chrome.runtime.onMessage.removeListener(listener);
      $("statusBar").textContent =
        "Still empty — open TXST in a normal tab, sign in, then Import Schedule.";
    }
  };
  chrome.runtime.onMessage.addListener(listener);
}

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
let PX_PER_HOUR = 52;
const PX_STEPS = [30, 38, 52, 68]; // zoom levels: -2 → +1

// ── MODAL METADATA ────────────────────────────────────────
const calendarCourseMetaByCrn = new Map();
function clearCalendarCourseMeta() { calendarCourseMetaByCrn.clear(); }
function registerCourseMeta(crn, meta) { if (crn && meta) calendarCourseMetaByCrn.set(String(crn), meta); }


// ============================================================
// INIT
// ============================================================

(async () => {
  let loginFromToolbar = false;
  try {
    const p = new URLSearchParams(location.search);
    if (p.get("login") === "1") {
      loginFromToolbar = true;
      p.delete("login");
      const qs = p.toString();
      history.replaceState(
        {},
        "",
        location.pathname + (qs ? "?" + qs : "") + location.hash,
      );
    }
  } catch (_) {}

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

  chrome.storage.local.get(["savedSchedules", "calendarBlocks", "avoidDays"], (result) => {
    if (result.savedSchedules) savedSchedules = result.savedSchedules;
    if (result.calendarBlocks) calendarBlocks = result.calendarBlocks;
    if (Array.isArray(result.avoidDays)) avoidDays = result.avoidDays;
    renderSavedList();
  });

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
        if (startDate <= now) {
          currentIdx = i;
          break;
        }
      }
    }

    termDescriptionsByCode = Object.create(null);
    terms.forEach((t, i) => {
      termDescriptionsByCode[String(t.code)] = String(t.description || "");
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
      if (loginFromToolbar) {
        $("statusBar").textContent =
          "Complete TXST sign-in in the window — Bobcat Plus will load when registration is ready.";
        await new Promise((resolve) => {
          const listener = (msg) => {
            if (
              msg.type === "loginSuccess" ||
              msg.type === "loginCancelled"
            ) {
              chrome.runtime.onMessage.removeListener(listener);
              resolve();
            }
          };
          chrome.runtime.onMessage.addListener(listener);
          chrome.runtime.sendMessage(
            { action: "openLoginPopup", term: currentTerm },
            () => {},
          );
        });
        try {
          sessionStorage.setItem(SKIP_EMPTY_RECOVER_ONCE, "1");
        } catch (_) {}
      }
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
  // Also bump chatGeneration so any in-flight handleUserTurn goes stale
  // and bails before dispatching actions to the now-invalid term context.
  chatGeneration++;
  currentTerm = e.target.value;
  // Cancel any in-flight analysis immediately — otherwise the old term keeps
  // firing searchCourse calls for 2-3s until the new runAnalysis message lands.
  chrome.runtime.sendMessage({ action: "cancelAnalysis" }).catch(() => {});
  analysisResults = null; cachedRawData = null; cachedRegisteredCourses = []; cachedRegisteredTerm = null;
  conversationHistory = []; lastRejectedCandidates = new Map(); bannerPlans = []; registeredScheduleCache = {};
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
    if (!authed) { importBtn.textContent = "Waiting for login..."; addMessage("system", "Opening TXST login — sign in and the import will start automatically."); chrome.runtime.sendMessage({ action: "openLoginPopup", term: currentTerm }); attachImportLoginListener(importBtn, importSvg); return; }
    importBtn.textContent = "Importing..."; $("statusBar").textContent = "Importing schedule...";
    analysisResults = null; cachedRawData = null; cachedRegisteredCourses = []; cachedRegisteredTerm = null; conversationHistory = [];
    let resetBtn = true;
    try {
      const result = await loadSchedule(currentTerm);
      if (result.stale) return;
      if (result.authRequired || (!result.hadRegistrationRows && !result.fromDiskCache)) { resetBtn = false; importBtn.textContent = "Waiting for login..."; addMessage("system", "Opening TXST login — sign in to load your registration."); chrome.runtime.sendMessage({ action: "openLoginPopup", term: currentTerm }); attachImportLoginListener(importBtn, importSvg); return; }
    } finally { if (resetBtn) { importBtn.disabled = false; importBtn.classList.remove("loading"); importBtn.innerHTML = importSvg; } }
  });
}

// ============================================================
// CALENDAR ZOOM (Fix 6)
// ============================================================
function applyZoom() {
  document.documentElement.style.setProperty("--cell-h", PX_PER_HOUR + "px");
  renderCalendarFromWorkingCourses();
  const zoomOut = document.getElementById("zoomOut");
  const zoomIn = document.getElementById("zoomIn");
  if (zoomOut) zoomOut.disabled = PX_STEPS.indexOf(PX_PER_HOUR) <= 0;
  if (zoomIn) zoomIn.disabled = PX_STEPS.indexOf(PX_PER_HOUR) >= PX_STEPS.length - 1;
}
const zoomOut = document.getElementById("zoomOut");
const zoomIn = document.getElementById("zoomIn");
if (zoomOut) zoomOut.addEventListener("click", () => { const i = PX_STEPS.indexOf(PX_PER_HOUR); if (i > 0) { PX_PER_HOUR = PX_STEPS[i - 1]; applyZoom(); } });
if (zoomIn) zoomIn.addEventListener("click", () => { const i = PX_STEPS.indexOf(PX_PER_HOUR); if (i < PX_STEPS.length - 1) { PX_PER_HOUR = PX_STEPS[i + 1]; applyZoom(); } });

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
  let authRequired = false;
  while (!registrationResponseLooksLikeJson(text) && samlHops < 8) {
    const next = await submitFirstFormFromHtml(text, baseHref);
    if (next === null) {
      // A failed hop while inside a SAML chain means the session is expired and
      // the IdP/SP POST was blocked in the extension context. Flag auth required
      // so callers can immediately open the login popup instead of retrying.
      if (samlHops > 0 || /SAMLRequest|SAMLResponse|RelayState/i.test(text)) {
        authRequired = true;
      }
      break;
    }
    text = next;
    samlHops++;
  }
  return { text, samlHops, authRequired };
}

let registrationFetchQueue = Promise.resolve();
function queueRegistrationFetch(fn) {
  const task = registrationFetchQueue.then(fn, fn);
  registrationFetchQueue = task.then(() => {}, () => {});
  return task;
}

// Sentinel error thrown (not returned) so the retry loop in loadSchedule can
// distinguish "auth expired" from a transient Banner session warmup failure.
class AuthRequiredError extends Error {
  constructor() { super("AUTH_REQUIRED"); this.name = "AuthRequiredError"; }
}

const TXST_REG_SCHEDULE_BASE =
  "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";

const TXST_REG_HISTORY_PAGE =
  TXST_REG_SCHEDULE_BASE + "/ssb/registrationHistory/registrationHistory";

let tabRegHistorySyncCache = { token: "", ts: 0 };
const TAB_REG_HISTORY_SYNC_TTL_MS = 10 * 60 * 1000;

async function getRegistrationHistorySynchronizerTokenTab() {
  const now = Date.now();
  if (
    tabRegHistorySyncCache.token &&
    now - tabRegHistorySyncCache.ts < TAB_REG_HISTORY_SYNC_TTL_MS
  ) {
    return tabRegHistorySyncCache.token;
  }
  const r = await fetch(TXST_REG_HISTORY_PAGE, {
    credentials: "include",
    redirect: "follow",
  });
  const html = await r.text();
  const m = html.match(
    /<meta\s+name="synchronizerToken"\s+content="([^"]*)"/i,
  );
  const token = m && m[1] ? m[1] : "";
  tabRegHistorySyncCache = { token, ts: now };
  return token;
}

async function fetchGetRegistrationEventsPayloadTab(extraHeaders) {
  const response = await fetch(
    TXST_REG_SCHEDULE_BASE +
      "/ssb/classRegistration/getRegistrationEvents?termFilter=",
    { credentials: "include", headers: extraHeaders || {} },
  );
  let text = await response.text();
  const eventsBase =
    TXST_REG_SCHEDULE_BASE +
    "/ssb/classRegistration/getRegistrationEvents";
  const resolved = await resolveRegistrationHtmlToJson(text, eventsBase);
  if (resolved.authRequired) throw new AuthRequiredError();
  text = resolved.text;
  if (!registrationResponseLooksLikeJson(text)) return null;
  return normalizeRegistrationEventsPayload(JSON.parse(text));
}

/**
 * Same handshake as background `fetchRegistrationEventsHandshake`:
 * registration mode vs class-search mode (past / closed registration terms).
 */
async function fetchRegistrationEventsHandshakeTab(term, registrationMode) {
  const t = String(term);
  if (registrationMode) {
    await fetch(
      TXST_REG_SCHEDULE_BASE + "/ssb/term/search?mode=registration",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ term: t }).toString(),
      },
    );
  } else {
    await fetch(TXST_REG_SCHEDULE_BASE + "/ssb/classSearch/resetDataForm", {
      method: "POST",
      credentials: "include",
    });
    await fetch(TXST_REG_SCHEDULE_BASE + "/ssb/term/search?mode=search", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        term: t,
        studyPath: "",
        studyPathText: "",
        startDatepicker: "",
        endDatepicker: "",
      }).toString(),
    });
  }
  await fetch(
    TXST_REG_SCHEDULE_BASE + "/ssb/classRegistration/classRegistration",
    { credentials: "include" },
  );
  return fetchGetRegistrationEventsPayloadTab({});
}

async function fetchRegistrationEventsViaHistoryResetTab(term) {
  const sync = await getRegistrationHistorySynchronizerTokenTab();
  const ajax = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    ...(sync ? { "X-Synchronizer-Token": sync } : {}),
    Referer: TXST_REG_HISTORY_PAGE,
  };
  await fetch(
    TXST_REG_SCHEDULE_BASE +
      "/ssb/registrationHistory/reset?term=" +
      encodeURIComponent(String(term)),
    { credentials: "include", headers: ajax },
  );
  return fetchGetRegistrationEventsPayloadTab(ajax);
}

function getCurrentSchedule(term) {
  return queueRegistrationFetch(async () => {
    const runHandshake = async (registrationMode) => {
      try {
        return await fetchRegistrationEventsHandshakeTab(term, registrationMode);
      } catch (e) {
        if (e instanceof AuthRequiredError) throw e;
        return null;
      }
    };
    const runHistory = async () => {
      try {
        return await fetchRegistrationEventsViaHistoryResetTab(term);
      } catch (e) {
        if (e instanceof AuthRequiredError) throw e;
        return null;
      }
    };
    try {
      let primary = await runHandshake(true);
      if (primary !== null && primary.length > 0) return primary;
      const fallback = await runHandshake(false);
      if (fallback !== null && fallback.length > 0) return fallback;
      const history = await runHistory();
      if (history !== null && history.length > 0) return history;
      return primary !== null ? primary : fallback !== null ? fallback : history;
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      return null;
    }
  });
}

// ============================================================
// LOAD SCHEDULE
// ============================================================

function registrationCrnKey(ev) {
  return String(ev.crn ?? ev.courseReferenceNumber ?? "").trim();
}

function buildRegisteredCoursesFromEvents(data) {
  const seen = new Set(), registered = [], locks = new Set();
  const rows = normalizeRegistrationEventsPayload(data);
  if (!rows.length) return { registered, locks };
  const expanded = rows.map(expandRegistrationEvent);
  for (const event of expanded) {
    const ck = registrationCrnKey(event);
    if (!ck || seen.has(ck)) continue;
    seen.add(ck);
    const start = new Date(event.start), end = new Date(event.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const days = [];
    for (const ev2 of expanded) {
      if (registrationCrnKey(ev2) !== ck) continue;
      const d = new Date(ev2.start).getDay() - 1;
      if (d >= 0 && d <= 4 && !days.includes(dayNames[d])) days.push(dayNames[d]);
    }
    const bh = start.getHours(), bm = start.getMinutes();
    const eh = end.getHours(), em = end.getMinutes();
    registered.push({ crn: ck, subject: event.subject, courseNumber: event.courseNumber, title: event.title, days, beginTime: String(bh).padStart(2,"0") + ":" + String(bm).padStart(2,"0"), endTime: String(eh).padStart(2,"0") + ":" + String(em).padStart(2,"0"), source: "registered", online: false });
    locks.add(ck);
  }
  return { registered, locks };
}

function emptyScheduleStatusMessage(term) {
  const d = termDescriptionsByCode[String(term)] || "";
  if (/\(view only\)/i.test(d)) {
    return "No meetings for this term — open Banner registration, select this View Only term, then Import Schedule.";
  }
  return "No registered courses for this term — if Banner closed registration, try the View Only row for Spring or Summer/Fall.";
}

async function loadSchedule(term) {
  const fetchGen = bumpScheduleFetchGeneration();
  registeredFetchCompleted = false;
  $("statusBar").textContent = "Loading schedule...";

  let fromDiskCache = false;
  let authRequired = false;
  let data = null;
  try {
    data = await getCurrentSchedule(term);
  } catch (e) {
    if (e instanceof AuthRequiredError) authRequired = true;
  }
  if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
  // Retry up to 2×  for legitimate Banner session-warmup failures (not auth expiry).
  // The old loop was 16 iterations: on expired auth each call triggered the full
  // SAML chain, producing 17+ identical IdP POST requests before surfacing the
  // login prompt. We now bail immediately on AuthRequiredError.
  if (!authRequired && data === null) {
    for (let i = 0; i < 2; i++) {
      await waitAnimationFrames(2);
      if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
      try {
        data = await getCurrentSchedule(term);
      } catch (e) {
        if (e instanceof AuthRequiredError) { authRequired = true; break; }
      }
      if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
      if (data !== null) break;
    }
  }
  if (data === null) { const cached = await loadCachedRegistrationEvents(term); if (cached) { data = cached; fromDiskCache = true; } }

  if (fetchGen !== scheduleFetchGeneration) return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };

  if (data != null) data = normalizeRegistrationEventsPayload(data);

  registeredFetchOk = data !== null;
  registeredFetchCompleted = true;
  if (data && data.length > 0) {
    clearEmptyRegistrationRecoverFlag(term);
    removeExistingScheduleRefreshPrompts();
    registeredScheduleCache[term] = data;
    cachedRegisteredCourses = compressRegisteredForLLM(data.map(expandRegistrationEvent));
    cachedRegisteredTerm = term;
    const { registered, locks } = buildRegisteredCoursesFromEvents(data);
    lockedCrns = locks;
    // Viewing a Banner plan: switch back to registered view and don't merge plan courses in
    if (activeScheduleKey.startsWith("banner:")) activeScheduleKey = "registered";
    workingCourses = [...registered, ...workingCourses.filter((c) => c.source !== "registered" && c.source !== "banner")];

    // Register modal metadata for registered courses
    const mergedByCrn = groupRegistrationEventsByCrn(data);
    mergedByCrn.forEach((mergedEv, crn) => {
      const meta = extractMetaFromRegistrationEvent(mergedEv);
      // meetingTimeDisplay filled on block render
      registerCourseMeta(crn, meta);
    });

    renderCalendarFromWorkingCourses();
    renderSavedList();
    updateWeekHours(data);
    updateOverviewFromEvents(data);
    const unique = new Set(data.map((e) => e.crn));
    if (!fromDiskCache) persistRegistrationEvents(term, data);
    $("statusBar").textContent = fromDiskCache ? unique.size + " registered courses (saved copy — use Import Schedule to refresh)" : unique.size + " registered courses";
    updateSaveBtn();
    return { stale: false, hadRegistrationRows: true, fromDiskCache, fetchOk: true };
  } else if (data === null) {
    cachedRegisteredCourses = []; cachedRegisteredTerm = term;
    buildEmptyCalendar();
    $("statusBar").textContent = authRequired
      ? "Session expired — click Import Schedule to log back in."
      : "Could not reach registration data. Try Import Schedule again.";
    if (authRequired) {
      maybeAutoLogin("Session expired — opening login…", term);
    }
    if (!authRequired) addScheduleRefreshPrompt();
    return { stale: false, hadRegistrationRows: false, fromDiskCache, fetchOk: false, authRequired };
  } else {
    removeExistingScheduleRefreshPrompts();
    cachedRegisteredCourses = []; cachedRegisteredTerm = term;
    buildEmptyCalendar(); $("statusBar").textContent = emptyScheduleStatusMessage(term);
    void maybeRecoverEmptyRegistration(term, fromDiskCache);
    return { stale: false, hadRegistrationRows: false, fromDiskCache: false, fetchOk: true, authRequired: false };
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
  updateWeekHoursFromWorking();
  updateSaveBtn();
}

function removeFromWorkingSchedule(crn) {
  const k = String(crn);
  workingCourses = workingCourses.filter((c) => String(c.crn) !== k);
  lockedCrns.delete(k);
  renderCalendarFromWorkingCourses();
  updateWeekHoursFromWorking();
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
  const shortDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const avoidSet = new Set(avoidDays || []);
  let html = '<tr><th class="time-col">Time</th>';
  DAYS.forEach((d, i) => {
    const short = shortDays[i];
    const isAvoid = avoidSet.has(short);
    const avoidCls = isAvoid ? " avoid-day-header" : "";
    const tag = isAvoid
      ? '<span class="avoid-day-tag">Kept clear<button class="avoid-day-remove" data-day="' + short + '" title="Remove this block" aria-label="Remove ' + short + ' from kept-clear days">×</button></span>'
      : "";
    html += '<th class="' + avoidCls.trim() + '">' + d + tag + "</th>";
  });
  html += "</tr>";
  for (let h = START_HOUR; h < END_HOUR; h++) {
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

  // ── Calendar blocks (work, gym, etc.) — rendered after course blocks.
  // z-index 0 keeps them behind course blocks; the X button overrides pointer-events.
  const dayMapB = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
  for (const block of calendarBlocks) {
    const startH = parseInt((block.start || "0000").slice(0, 2), 10);
    const startM = parseInt((block.start || "0000").slice(2, 4), 10);
    const endH   = parseInt((block.end   || "0000").slice(0, 2), 10);
    const endM   = parseInt((block.end   || "0000").slice(2, 4), 10);
    const topOffset = (startM / 60) * PX_PER_HOUR;
    const blockH    = (endH + endM / 60 - (startH + startM / 60)) * PX_PER_HOUR;
    if (blockH <= 0) continue;
    // Only the first day column gets the X button so there's no duplicate click target.
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
        xBtn.addEventListener("click", (e) => { e.stopPropagation(); removeCalendarBlock(block.label); });
        el.appendChild(xBtn);
      }
      cell.appendChild(el);
    });
  }

  renderOnlineCoursesBar();
  // Keep AI toolbar lock count in sync
  renderAIToolbar();
  // Conflict check deferred so it always wins over any status messages set by callers
  setTimeout(updateConflictStatus, 0);
}

function renderOnlineCoursesBar() {
  const bar = $("onlineCoursesBar");
  const list = $("onlineCoursesList");
  const countEl = $("onlineCoursesCount");
  if (!bar || !list) return;
  const onlineCourses = workingCourses.filter((c) => c.online || !c.days || !c.days.length);
  if (!onlineCourses.length) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "";
  if (countEl) countEl.textContent = onlineCourses.length + " course" + (onlineCourses.length !== 1 ? "s" : "");
  list.innerHTML = "";
  for (const c of onlineCourses) {
    const crnKey = String(c.crn ?? "");
    const isLocked = lockedCrns.has(crnKey);
    const chipClass = getChipForCourse(c.subject + c.courseNumber);
    const card = document.createElement("div");
    card.className = "online-course-card " + chipClass + (isLocked ? " locked" : "");
    card.setAttribute("data-crn", crnKey);
    card.innerHTML =
      '<div class="online-course-main">' +
        '<div class="online-course-code">' + escapeHtml(c.subject + " " + c.courseNumber) + (isLocked ? ' <span class="online-course-lock">🔒</span>' : "") + "</div>" +
        '<div class="online-course-title">' + escapeHtml(c.title || "") + "</div>" +
      "</div>" +
      (isLocked
        ? ""
        : '<button class="online-course-remove" title="Remove" aria-label="Remove ' + escapeHtml(c.subject + " " + c.courseNumber) + '">✕</button>');
    const removeBtn = card.querySelector(".online-course-remove");
    if (removeBtn) removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeFromWorkingSchedule(crnKey); });
    list.appendChild(card);
  }
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

  // openSection can be true even when seatsAvailable === 0 (admin-open, waitlisted, etc.)
  // Require both flags so only sections with actual seats pass the filter.
  const hasRealOpenSeat = (s) => s.openSection && (s.seatsAvailable == null || s.seatsAvailable > 0);
  const filteredCourses = showOpenSeatsOnly
    ? dedupedCourses.filter((course) => (course.sections || []).some(hasRealOpenSeat))
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
    const openCount = (course.sections || []).filter(hasRealOpenSeat).length;
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
      let sections = (course.sections || []).filter((s) => { const crn = String(s.courseReferenceNumber || ""); if (!crn || seenCrns.has(crn)) return false; seenCrns.add(crn); return true; });
      // Only show sections with actual open seats (openSection alone isn't enough)
      if (showOpenSeatsOnly) sections = sections.filter(hasRealOpenSeat);
      if (!sections.length) { expandedCourseKey = null; }
      else {
        sections.forEach((s) => {
          const crn = String(s.courseReferenceNumber || "");
          const isOnCalendar = workingCourses.some((c) => String(c.crn) === crn);
          // Fix 3: click-to-toggle row — no radio buttons, no Add button
          const row = document.createElement("div");
          row.className = "section-toggle-row" + (isOnCalendar ? " on-calendar" : "") + (!hasRealOpenSeat(s) ? " no-seats" : "");
          const check = document.createElement("span");
          check.className = "section-check";
          check.textContent = isOnCalendar ? "✓" : "";
          const info = document.createElement("span");
          info.textContent = formatSectionOneLine(s);
          row.appendChild(check); row.appendChild(info);
          row.addEventListener("click", () => {
            if (isOnCalendar) {
              removeFromWorkingSchedule(crn);
            } else {
              const mt = s.meetingsFaculty?.[0]?.meetingTime;
              const days = [];
              if (mt?.monday) days.push("Mon"); if (mt?.tuesday) days.push("Tue"); if (mt?.wednesday) days.push("Wed"); if (mt?.thursday) days.push("Thu"); if (mt?.friday) days.push("Fri");
              const beginTime = mt?.beginTime ? mt.beginTime.slice(0, 2) + ":" + mt.beginTime.slice(2) : null;
              const endTime = mt?.endTime ? mt.endTime.slice(0, 2) + ":" + mt.endTime.slice(2) : null;
              addToWorkingSchedule({ crn, subject: course.subject, courseNumber: course.courseNumber, title: s.courseTitle || course.sections[0]?.courseTitle || "", days, beginTime, endTime, source: "manual", online: s.instructionalMethod === "INT" });
              expandedCourseKey = null;
            }
            renderEligibleList(); updateSaveBtn();
          });
          body.appendChild(row);
        });
        item.appendChild(body);
      }
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
          let day = null, beginTime = "", endTime = "";
          if (event.start && event.end) {
            const start = new Date(event.start), dayIdx = start.getDay() - 1;
            day = dayIdx >= 0 && dayIdx <= 4 ? dayNames[dayIdx] : null;
            const bh = start.getHours(), bm = start.getMinutes();
            const end = new Date(event.end), eh = end.getHours(), em = end.getMinutes();
            beginTime = String(bh).padStart(2,"0") + ":" + String(bm).padStart(2,"0");
            endTime = String(eh).padStart(2,"0") + ":" + String(em).padStart(2,"0");
          }
          const isOnline = !!(event.online || !event.start);
          if (existing) { if (day && !existing.days.includes(day)) existing.days.push(day); }
          else acc.push({ crn, subject: event.subject || "", courseNumber: event.courseNumber || "", title: event.title || "", days: day ? [day] : [], beginTime, endTime, source: "banner", online: isOnline });
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
  const clearBtn = $("aiClearAllBtn");
  if (!hintEl || !btn) return;

  const total = workingCourses.length;
  const locked = workingCourses.filter((c) => lockedCrns.has(String(c.crn))).length;
  const unlocked = total - locked;
  const allLocked = total > 0 && locked === total;

  if (total === 0) {
    hintEl.textContent = "Add courses in Build mode first so the AI has something to work around";
    btn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
  } else if (allLocked) {
    hintEl.textContent = "All " + total + " course" + (total !== 1 ? "s" : "") + " locked — AI will build around them";
    btn.disabled = true;
    if (clearBtn) clearBtn.disabled = false;
  } else {
    hintEl.textContent = locked > 0
      ? locked + " of " + total + " locked · AI may replace the other " + unlocked
      : unlocked + " course" + (unlocked !== 1 ? "s" : "") + " unlocked · AI may replace " + (unlocked !== 1 ? "them" : "it");
    btn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
  }
}

$("aiLockAllBtn")?.addEventListener("click", () => {
  for (const c of workingCourses) lockedCrns.add(String(c.crn));
  renderCalendarFromWorkingCourses();
});

$("aiClearAllBtn")?.addEventListener("click", () => {
  const removable = workingCourses.filter((c) => c.source !== "registered");
  if (!removable.length) return;
  workingCourses = workingCourses.filter((c) => c.source === "registered");
  lockedCrns = new Set([...lockedCrns].filter((crn) => workingCourses.some((c) => String(c.crn) === crn)));
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
});

// ============================================================
// CHAT (AI mode)
// ============================================================

$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });

// Estimate total credits for locked courses.
// Most TXST courses are 3 credits; we default to 3 for any locked course whose
// section data isn't in cachedRawData, then correct if we find the exact value.
function getLockedCredits(lockedList) {
  let total = 0;
  for (const locked of lockedList) {
    let found = false;
    if (cachedRawData && cachedRawData.eligible) {
      for (const course of cachedRawData.eligible) {
        const sec = (course.sections || []).find((s) => String(s.courseReferenceNumber) === String(locked.crn));
        if (sec) { total += sec.creditHourLow ?? 3; found = true; break; }
      }
    }
    if (!found) total += 3;
  }
  return total;
}

// Persist and re-render calendar blocks whenever they change.
function applyNewCalendarBlocks(incoming) {
  if (!incoming || !incoming.length) return;
  calendarBlocks = mergeCalendarBlocks(calendarBlocks, incoming);
  chrome.storage.local.set({ calendarBlocks });
  // Keep student profile in sync so the next AI call sees the updated blocks.
  if (studentProfile) studentProfile.calendarBlocks = calendarBlocks;
  renderCalendarFromWorkingCourses();
}

// Remove a single calendar block by label and re-render.
function removeCalendarBlock(label) {
  calendarBlocks = calendarBlocks.filter((b) => b.label.toLowerCase() !== (label || "").toLowerCase());
  chrome.storage.local.set({ calendarBlocks });
  if (studentProfile) studentProfile.calendarBlocks = calendarBlocks;
  renderCalendarFromWorkingCourses();
}

// Persist a new avoid-day and keep profile in sync.
function applyNewAvoidDay(day) {
  if (!day || avoidDays.includes(day)) return;
  avoidDays = [...avoidDays, day];
  chrome.storage.local.set({ avoidDays });
  if (studentProfile) studentProfile.avoidDays = avoidDays;
  renderCalendarFromWorkingCourses();
}

// Remove an avoid-day and keep profile + storage in sync.
function removeAvoidDay(day) {
  if (!day || !avoidDays.includes(day)) return;
  avoidDays = avoidDays.filter((d) => d !== day);
  chrome.storage.local.set({ avoidDays });
  if (studentProfile) studentProfile.avoidDays = avoidDays;
  renderCalendarFromWorkingCourses();
}

// Look up the credit value for a CRN in the cached eligible data.
// Defaults to 3 (most TXST courses) when unknown.
function getCreditsForCrn(crn) {
  if (cachedRawData?.eligible) {
    for (const course of cachedRawData.eligible) {
      const sec = (course.sections || []).find((s) => String(s.courseReferenceNumber) === String(crn));
      if (sec) return sec.creditHourLow ?? 3;
    }
  }
  return 3;
}

// Direct-add a rejected candidate by CRN. Bypasses the accept_suggestion
// LLM roundtrip — the chip click is unambiguous.
function addCandidateByCrn(crn) {
  const cand = lastRejectedCandidates.get(String(crn));
  if (!cand) {
    addMessage("system", "That suggestion is no longer available — try asking again.");
    return;
  }
  let title = cand.course;
  let subject = (cand.course.split(" ")[0] || "").trim();
  let courseNumber = (cand.course.split(" ")[1] || "").trim();
  let credits = 3;
  let online = false;
  if (cachedRawData?.eligible) {
    for (const course of cachedRawData.eligible) {
      const sec = (course.sections || []).find((s) => String(s.courseReferenceNumber) === String(crn));
      if (sec) {
        title = course.sections[0]?.courseTitle || title;
        subject = course.subject;
        courseNumber = course.courseNumber;
        credits = sec.creditHourLow ?? 3;
        online = sec.instructionalMethod === "INT";
        break;
      }
    }
  }
  addToWorkingSchedule({
    crn: cand.crn,
    subject,
    courseNumber,
    title,
    days: cand.days || [],
    beginTime: cand.start ? cand.start.slice(0, 2) + ":" + cand.start.slice(2) : null,
    endTime: cand.end ? cand.end.slice(0, 2) + ":" + cand.end.slice(2) : null,
    source: "ai",
    online,
    credits,
  });
  addMessage("system", `Added ${cand.course} to your working calendar.`);
  updateSaveBtn();
}

// Resolve a free-text course reference ("GEO 2342") from the accept_suggestion
// intent path back to the most recent matching rejected candidate.
function addSuggestedByReference(ref) {
  if (!ref) return;
  for (const cand of lastRejectedCandidates.values()) {
    if (cand.course === ref) { addCandidateByCrn(cand.crn); return; }
  }
  addMessage("system", `Couldn't find "${ref}" in recent suggestions. Click the Add button on the candidate chip instead.`);
}

// Render "Also considered" chips below a schedule response. Each chip
// directly adds its course to the working calendar on click — no LLM roundtrip.
function renderRejectedCandidates(candidates) {
  if (!candidates || !candidates.length) return;
  candidates.forEach((c) => { if (c.crn) lastRejectedCandidates.set(String(c.crn), c); });

  const div = document.createElement("div");
  div.className = "chat-message ai";
  const details = candidates.map((c) => {
    const time = c.days?.length ? c.days.join("/") + " " + formatChatTime(c.start) + "–" + formatChatTime(c.end) : "Online";
    return '<div style="font-size:11px;margin:4px 0;opacity:0.85"><strong>' + c.course + "</strong> · CRN " + c.crn + " · " + time
      + (c.wouldSatisfy ? ' · <em>' + c.wouldSatisfy + "</em>" : "")
      + (c.reason ? '<br><span style="opacity:0.75">' + c.reason + "</span>" : "")
      + "</div>";
  }).join("");
  const buttons = candidates.map((c) =>
    '<button class="save-schedule-btn add-candidate-btn" data-crn="' + c.crn + '" style="margin:4px 4px 0 0">Add ' + c.course + '</button>'
  ).join("");
  div.innerHTML =
    '<div class="sender">Also considered</div>' +
    details +
    '<div style="margin-top:6px">' + buttons + '</div>';
  div.querySelectorAll(".add-candidate-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const crn = btn.getAttribute("data-crn");
      addCandidateByCrn(crn);
      btn.disabled = true;
      btn.textContent = "Added";
    });
  });
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

// ─── Thinking panel ─────────────────────────────────────────────
// Live trace of the hybrid pipeline. Appended before the AI's reply so
// users can see what stage is running. Collapsible after it finishes.
const STAGE_LABELS = {
  intent: "Understanding request",
  affinity: "Scoring career fit",
  solve: "Building schedules",
  relaxation: "Relaxing soft constraints",
  rank: "Ranking tradeoffs",
  validate: "Verifying no conflicts",
  rationale: "Writing rationales",
  advisor: "Drafting answer",
};

function createThinkingPanel() {
  const div = document.createElement("div");
  div.className = "chat-message system thinking-panel";
  div.innerHTML =
    '<div class="sender">Thinking…</div>' +
    '<div class="thinking-steps" style="font-size:11px;line-height:1.5;opacity:0.85"></div>';
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;

  const stepsEl = div.querySelector(".thinking-steps");
  const rows = new Map(); // stage → row element

  function statusGlyph(status) {
    if (status === "running") return "⋯";
    if (status === "done") return "✓";
    if (status === "error") return "✗";
    return "•";
  }

  function update(entry) {
    const label = STAGE_LABELS[entry.stage] || entry.stage;
    const summary = entry.summary ? " — " + entry.summary : "";
    const dur = entry.duration != null ? ` (${entry.duration}ms)` : "";
    let html = '<span style="display:inline-block;width:14px">' + statusGlyph(entry.status) + "</span>"
      + "<strong>" + label + "</strong>" + summary + dur
      + (entry.error ? '<br><span style="color:#c44">' + entry.error + "</span>" : "");

    // Phase 0 debug pane: when the rank stage reports a scoreBreakdown payload,
    // expose the top-20 candidates and per-vector term weights under a collapsed
    // <details> block. Intentionally raw — this is a debug surface for diagnosing
    // why Top-1 beat Top-2, not a polished UI.
    if (entry.rankBreakdown) {
      const body = escapeHtml(JSON.stringify(entry.rankBreakdown, null, 2));
      html += '<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;opacity:0.75">rank breakdown (debug)</summary>'
        + '<pre style="font-size:10px;max-height:320px;overflow:auto;background:#111;color:#ddd;padding:6px;border-radius:4px;white-space:pre-wrap">'
        + body + "</pre></details>";
    }

    let row = rows.get(entry.stage);
    if (!row) {
      row = document.createElement("div");
      rows.set(entry.stage, row);
      stepsEl.appendChild(row);
    }
    row.innerHTML = html;
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function finalize() {
    const senderEl = div.querySelector(".sender");
    const total = Array.from(rows.values()).length;
    senderEl.textContent = "Thinking · " + total + " steps (click to toggle)";
    senderEl.style.cursor = "pointer";
    stepsEl.style.display = "none";
    senderEl.addEventListener("click", () => {
      stepsEl.style.display = stepsEl.style.display === "none" ? "block" : "none";
    });
  }

  return { update, finalize };
}

// Apply one action from handleUserTurn. Returns a short plain-text summary
// suitable for pushing to conversation history (never raw JSON — the intent
// call on turn 2 chokes on JSON embedded in user-facing history).
function applyAction(action) {
  switch (action.type) {
    case "show_message": {
      if (action.text?.trim()) addMessage("ai", action.text.trim());
      if (action.followUp?.trim()) addMessage("ai", action.followUp.trim());
      return [action.text, action.followUp].filter(Boolean).join(" ");
    }
    case "show_context_recap": {
      renderContextRecap(action);
      return action.recap ? "[Recap: " + action.recap + "]" : "";
    }
    case "show_schedules": {
      if (action.summary?.trim()) addMessage("ai", action.summary.trim());
      (action.schedules || []).forEach((s) => addScheduleOption(s));
      if (action.followUp?.trim()) addMessage("ai", action.followUp.trim());
      const names = (action.schedules || []).map((s) => s.label || s.name).join(", ");
      return "[Proposed " + (action.schedules || []).length + " schedules: " + names + "]";
    }
    case "show_relaxation_notice": {
      renderRelaxationNotice(action.relaxations || []);
      return "[Relaxed: " + (action.relaxations || []).join("; ") + "]";
    }
    case "show_infeasible": {
      renderInfeasible(action);
      return "[Infeasible] " + (action.message || "");
    }
    case "show_rejected_candidates": {
      renderRejectedCandidates(action.candidates || []);
      const list = (action.candidates || []).map((c) => c.course + " (CRN " + c.crn + ")").join("; ");
      return "[Also considered: " + list + "]";
    }
    case "add_calendar_block": {
      applyNewCalendarBlocks([action.block]);
      const b = action.block;
      addMessage("system", "Calendar block saved: " + b.label + " " + (b.days || []).join("/") + " " + b.start + "–" + b.end);
      return "[Added block " + b.label + "]";
    }
    case "add_avoid_day": {
      applyNewAvoidDay(action.day);
      addMessage("system", "Marked " + action.day + " as a day to keep class-free.");
      return "[Marked " + action.day + " as avoid day]";
    }
    case "remove_avoid_day": {
      removeAvoidDay(action.day);
      addMessage("system", "Cleared " + action.day + " — classes allowed again.");
      return "[Cleared avoid day " + action.day + "]";
    }
    case "reset_avoid_days": {
      const prior = avoidDays.slice();
      avoidDays = [];
      chrome.storage.local.set({ avoidDays });
      if (studentProfile) studentProfile.avoidDays = avoidDays;
      renderCalendarFromWorkingCourses();
      if (prior.length) addMessage("system", "Reset kept-clear days (was " + prior.join(", ") + ").");
      return "[Reset avoid days]";
    }
    case "lock_course": {
      lockedCrns.add(String(action.crn));
      renderCalendarFromWorkingCourses();
      return "[Locked CRN " + action.crn + "]";
    }
    case "unlock_course": {
      lockedCrns.delete(String(action.crn));
      renderCalendarFromWorkingCourses();
      return "[Unlocked CRN " + action.crn + "]";
    }
    case "add_suggested_course": {
      addSuggestedByReference(action.reference);
      return "[Accepted suggestion " + action.reference + "]";
    }
    default:
      return "";
  }
}

// Show the intent's recap so the student can catch misreads early.
// Low-confidence recaps surface ambiguities inline.
function renderContextRecap(action) {
  if (!action.recap?.trim()) return;
  const conf = typeof action.confidence === "number" ? action.confidence : 1;
  const ambig = action.ambiguities || [];
  const div = document.createElement("div");
  div.className = "chat-message system";
  let html = '<div class="sender">Got it — here\'s what I heard</div>'
    + '<div style="font-size:12px;line-height:1.4">' + escapeHtml(action.recap) + "</div>";
  if (conf < 0.7 || ambig.length) {
    const items = ambig.length ? ambig.map((a) => "<li>" + escapeHtml(a) + "</li>").join("") : "";
    html += '<div style="font-size:11px;margin-top:6px;opacity:0.8">'
      + (items ? "Not sure about:<ul style=\"margin:4px 0 0 16px\">" + items + "</ul>" : "")
      + (conf < 0.7 ? "<em>Correct me if any of that is off.</em>" : "")
      + "</div>";
  }
  div.innerHTML = html;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function renderRelaxationNotice(relaxations) {
  if (!relaxations.length) return;
  const items = relaxations.map((r) => "<li>" + escapeHtml(r) + "</li>").join("");
  const div = document.createElement("div");
  div.className = "chat-message system";
  div.innerHTML = '<div class="sender">Had to relax some preferences</div>'
    + '<div style="font-size:11px">Couldn\'t satisfy every soft preference at once — here\'s what I gave on:</div>'
    + '<ul style="margin:4px 0 0 16px;font-size:11px">' + items + "</ul>";
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function renderInfeasible(action) {
  const suggestions = action.suggestions || [];
  const items = suggestions.map((s) => "<li>" + escapeHtml(s) + "</li>").join("");
  const diag = action.diagnostics;

  let diagHtml = "";
  if (diag && Array.isArray(diag.attempts) && diag.attempts.length) {
    const rows = diag.attempts.map((a, i) => {
      const c = a.constraints || {};
      const cons = [
        `credits ${c.minCredits}–${c.maxCredits}`,
        c.hardAvoidDays?.length ? `hardAvoid ${c.hardAvoidDays.join("/")}` : null,
        c.calendarBlocks ? `${c.calendarBlocks} block${c.calendarBlocks !== 1 ? "s" : ""}` : null,
        c.noEarlierThan ? `after ${c.noEarlierThan}` : null,
      ].filter(Boolean).join(" · ");
      const elim = (a.eliminatedCourses || []).map((e) => {
        const r = e.dropReasons || {};
        const parts = [];
        if (r.missingData) parts.push(`TBA×${r.missingData}`);
        if (r.fixedConflict) parts.push(`block×${r.fixedConflict}`);
        if (r.hardAvoidDay) parts.push(`avoidDay×${r.hardAvoidDay}`);
        return escapeHtml(e.course) + " (" + parts.join(" ") + ")";
      }).join(", ");
      const perCourseTable = (a.perCourseCounts || []).map((pc) => {
        const r = pc.dropReasons || {};
        const drops = [];
        if (r.missingData) drops.push(`TBA${r.missingData}`);
        if (r.fixedConflict) drops.push(`block${r.fixedConflict}`);
        if (r.hardAvoidDay) drops.push(`avoid${r.hardAvoidDay}`);
        const dropStr = drops.length ? " [-" + drops.join(",-") + "]" : "";
        return escapeHtml(pc.course) + ": " + pc.viable + "/" + pc.original + dropStr;
      }).join(" · ");
      const nodeInfo = a.nodesExplored != null
        ? a.nodesExplored + " nodes" + (a.capHit ? " (CAP HIT)" : "")
        : "";
      return "<div style=\"font-size:11px;margin:6px 0;border-left:2px solid var(--border);padding-left:6px\">"
        + "<strong>" + (i + 1) + ". " + escapeHtml(a.label) + "</strong> — "
        + a.viableCourses + " courses viable · " + a.viableSections + " sections · "
        + a.results + " schedules · " + nodeInfo
        + "<br><span style=\"opacity:0.7\">" + escapeHtml(cons) + "</span>"
        + (elim ? "<br><span style=\"opacity:0.7\">fully eliminated: " + elim + "</span>" : "")
        + (perCourseTable ? "<br><span style=\"opacity:0.7;font-family:monospace;font-size:10px\">" + perCourseTable + "</span>" : "")
        + "</div>";
    }).join("");
    diagHtml = "<details style=\"margin-top:8px;font-size:11px\"><summary style=\"cursor:pointer;opacity:0.8\">Diagnostics — "
      + diag.attempts.length + " attempt" + (diag.attempts.length !== 1 ? "s" : "") + " across "
      + diag.eligibleCount + " eligible courses</summary>" + rows + "</details>";
  }

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML = '<div class="sender">No feasible schedule</div>'
    + '<div style="font-size:12px">' + escapeHtml(action.message || "I couldn't find a schedule.") + "</div>"
    + (items ? '<ul style="margin:6px 0 0 16px;font-size:11px">' + items + "</ul>" : "")
    + diagHtml;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
    if (!analysisResults.eligible || !analysisResults.eligible.length) {
      addMessage("system", "No eligible courses were found for this term. This usually means your DegreeWorks audit hasn't loaded yet, or every remaining requirement is already satisfied. Try refreshing the Build panel.");
      $("statusBar").textContent = "No eligible courses found";
      return;
    }
    addMessage("system", `Found ${analysisResults.eligible.length} eligible courses. Sending to AI...`);
  }

  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  if (!openaiKey) {
    addMessage("system", "No OpenAI API key is configured for this extension. Open the browser console on this page and run:\n\nchrome.storage.local.set({ openaiKey: \"sk-...\" })\n\nThen reload the page and try again.");
    return;
  }

  // Generation counter: if a later sendChat starts OR the term changes while
  // this turn is in flight, bail before dispatching any actions so we never
  // mutate the UI for a stale term.
  const myGen = ++chatGeneration;
  const termAtStart = currentTerm;
  const stale = () => chatGeneration !== myGen || currentTerm !== termAtStart;

  $("statusBar").textContent = "Thinking…";

  const thinking = createThinkingPanel();

  try {
    const lockedList = getLockedForLLM();
    // Attach credits so handleUserTurn can enforce the 18-credit budget.
    const lockedCourses = lockedList.map((c) => ({ ...c, credits: getCreditsForCrn(c.crn) }));

    const profile = studentProfile || buildStudentProfile({
      name: currentStudent?.name || "Student",
      major: (currentStudent?.major || "") + (currentStudent?.degree ? " — " + currentStudent.degree : ""),
      classification: currentStudent?.classification || "Unknown",
      catalogYear: new Date().getFullYear(),
      completedHours: null, remainingHours: null,
      calendarBlocks,
      avoidDays,
    });
    // Always sync with the latest persisted state.
    profile.calendarBlocks = calendarBlocks;
    profile.avoidDays = avoidDays;

    const { actions, updatedProfile } = await handleUserTurn({
      userMessage: input,
      rawData: cachedRawData,
      studentProfile: profile,
      conversationHistory,
      lockedCourses,
      ragChunks: [],
      apiKey: openaiKey,
      onTrace: (entry) => { if (!stale()) thinking.update(entry); },
    });

    thinking.finalize();
    if (stale()) return;

    // Record the user turn now that we know it completed without a stale bail.
    conversationHistory.push({ role: "user", content: input });

    // Dispatch actions; collect a short plain-text assistant summary for history.
    const assistantParts = [];
    for (const action of actions) {
      if (stale()) return;
      const summary = applyAction(action);
      if (summary) assistantParts.push(summary);
    }
    if (assistantParts.length) {
      conversationHistory.push({ role: "assistant", content: assistantParts.join("\n") });
    }

    // Keep the global profile aligned with the merged state so the next turn
    // sees accurate calendarBlocks / avoidDays.
    if (studentProfile) {
      studentProfile.calendarBlocks = updatedProfile.calendarBlocks;
      studentProfile.avoidDays = updatedProfile.avoidDays;
    }
    $("statusBar").textContent = "Ready";
  } catch (err) {
    thinking.finalize();
    if (stale()) return;
    console.error(err);
    const msg = String(err?.message || err);
    let friendly;
    if (/api key|401|unauthorized|invalid_api_key/i.test(msg)) {
      friendly = "OpenAI rejected the API key. Reset it with: chrome.storage.local.set({ openaiKey: \"sk-...\" })";
    } else if (/rate limit|429/i.test(msg)) {
      friendly = "OpenAI rate-limited the request. Wait a few seconds and try again.";
    } else if (/fetch|NetworkError|Failed to fetch/i.test(msg)) {
      friendly = "Couldn't reach OpenAI. Check your internet connection and try again.";
    } else {
      friendly = "Something went wrong: " + msg;
    }
    addMessage("system", friendly);
    $("statusBar").textContent = "Error";
  }
}

function addScheduleOption(schedule) {
  // v3 shape: label (e.g. "Career-focused"), tagline, rationale, courses, honoredPreferences
  // v2 shape: name, rationale, courses — still handled for backwards-compat
  const label = schedule.label || schedule.name || "Schedule";
  const tagline = schedule.tagline || "";
  const rationale = schedule.rationale || "";
  const courses = schedule.courses || [];
  const honored = schedule.honoredPreferences || [];
  const unhonored = schedule.unhonoredPreferences || [];
  const lockedList = getLockedForLLM();

  // Compute credits ourselves — the AI's totalCredits has proven inaccurate.
  const lockedCr = getLockedCredits(lockedList);
  const newCr    = courses.reduce((sum, c) => sum + (typeof c.credits === "number" ? c.credits : 3), 0);
  const displayCredits = lockedCr + newCr;

  const lockedLines = lockedList.map((r) => {
    const time = r.days?.length ? r.days.join("/") + " " + formatChatTime(r.start) + "–" + formatChatTime(r.end) : "Online";
    return '<div style="margin:4px 0;opacity:0.6;border-left:2px solid var(--border);padding-left:6px"><strong>' + escapeHtml(r.course) + "</strong> — " + escapeHtml(r.title || "") + '<br><span style="font-size:11px">Locked · ' + escapeHtml(time) + "</span></div>";
  }).join("");
  const courseLines = courses.map((c) => {
    const time = c.online ? "Online" : (c.days?.join("/") + " " + formatChatTime(c.start) + "–" + formatChatTime(c.end));
    const affinityBadge = typeof c.affinity === "number" && c.affinity >= 0.7
      ? ' <span style="font-size:10px;padding:1px 4px;border-radius:3px;background:var(--accent-soft,#e8f0ff);opacity:0.9" title="' + escapeHtml(c.affinityReason || "") + '">★ ' + c.affinity.toFixed(2) + "</span>"
      : "";
    return '<div style="margin:4px 0"><strong>' + escapeHtml(c.course) + "</strong> — " + escapeHtml(c.title || "") + affinityBadge + '<br><span style="font-size:11px;opacity:0.8">CRN: ' + escapeHtml(String(c.crn)) + " · " + escapeHtml(time) + (c.requirementSatisfied ? " · " + escapeHtml(c.requirementSatisfied) : "") + "</span></div>";
  }).join("");
  const honoredHtml = honored.length
    ? '<div style="font-size:11px;margin:6px 0;opacity:0.85"><strong>Honored:</strong> ' + honored.map(escapeHtml).join(" · ") + "</div>"
    : "";
  const unhonoredHtml = unhonored.length
    ? '<div style="font-size:11px;margin:6px 0;color:var(--warn,#b07500)"><strong>Couldn\'t honor:</strong> ' + unhonored.map(escapeHtml).join(" · ") + "</div>"
    : "";
  const taglineHtml = tagline
    ? '<div style="font-size:11px;font-style:italic;opacity:0.75;margin-bottom:4px">' + escapeHtml(tagline) + "</div>"
    : "";

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML =
    '<div class="sender">' + escapeHtml(label) + " · " + displayCredits + " credits</div>" +
    taglineHtml +
    '<div style="font-size:12px;margin-bottom:6px">' + escapeHtml(rationale) + "</div>" +
    honoredHtml +
    unhonoredHtml +
    lockedLines + courseLines + "<br>" +
    '<button class="save-schedule-btn add-to-calendar-btn">Add to Calendar</button>' +
    '<button class="save-schedule-btn lock-all-btn" style="margin-left:6px">Lock All</button>';
  div.querySelector(".add-to-calendar-btn").addEventListener("click", (e) => {
    for (const c of courses) {
      addToWorkingSchedule({ crn: c.crn, subject: c.course.split(" ")[0], courseNumber: c.course.split(" ")[1], title: c.title, days: c.days || [], beginTime: c.start ? c.start.slice(0, 2) + ":" + c.start.slice(2) : null, endTime: c.end ? c.end.slice(0, 2) + ":" + c.end.slice(2) : null, source: "ai", online: c.online || false });
    }
    updateSaveBtn();
    // Ack the action on the button itself so the user sees confirmation
    // without bloating the chat log or yanking the scroll position.
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = "Added";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  });
  div.querySelector(".lock-all-btn").addEventListener("click", (e) => {
    for (const c of courses) lockedCrns.add(c.crn);
    renderCalendarFromWorkingCourses();
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = "Locked";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
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

  // Build rich student profile for the AI advisor.
  // Fields not available at this point (completedCourses, holds, careerGoals,
  // advisingNotes) default to placeholders and can be populated later.
  const earnedH = student.creditsEarnedMajorMinor ?? null;
  const reqH    = student.creditsRequiredMajorMinor ?? null;
  studentProfile = buildStudentProfile({
    name:             student.name,
    major:            student.major + (student.minor ? " (Minor: " + student.minor + ")" : "")
                        + (student.degree ? " — " + student.degree : ""),
    classification:   student.classification || "Unknown",
    catalogYear:      student.catalogYear    || new Date().getFullYear(),
    completedHours:   earnedH,
    remainingHours:   (earnedH != null && reqH != null) ? reqH - earnedH : null,
    gpa:              student.gpaOverall ?? student.gpaTexasState ?? null,
    completedCourses: [],   // not available from this endpoint
    holds:            [],   // not available from this endpoint
    calendarBlocks,         // loaded from chrome.storage earlier
    avoidDays,              // loaded from chrome.storage earlier
    careerGoals:      null, // populated when the student tells the AI
    advisingNotes:    null,
  });
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

// Update the credit-hour counter from workingCourses (called after manual add/remove in Build mode).
function updateWeekHoursFromWorking() {
  const seen = new Set();
  let total = 0;
  for (const c of workingCourses) {
    const crn = String(c.crn || "");
    if (!crn || seen.has(crn)) continue;
    seen.add(crn);
    let credits = typeof c.credits === "number" ? c.credits : (typeof c.creditHours === "number" ? c.creditHours : null);
    if (credits == null && cachedRawData?.eligible) {
      for (const course of cachedRawData.eligible) {
        const sec = (course.sections || []).find((s) => String(s.courseReferenceNumber) === crn);
        if (sec) { credits = sec.creditHourLow ?? 3; break; }
      }
    }
    total += credits ?? 3;
  }
  const el = $("weekHours");
  if (!el) return;
  el.innerHTML = total > 0 ? "<strong>" + total + " credit hours</strong> this semester" : "";
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
 * Delegates to BP.findOverlapPair (scheduleGenerator.js) so the solver's
 * validator and the UI's status bar share one implementation. That helper
 * correctly skips entries with `online: true` even when Banner left phantom
 * meeting data on the section (Bug 5, 2026-04-21).
 */
function detectWorkingConflict() {
  const BP = window.BP || {};
  if (typeof BP.findOverlapPair === "function") {
    return BP.findOverlapPair(workingCourses);
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

// ============================================================
// BLOCK CREATION MODAL
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const bOverlay = $("blockModalOverlay");
  const bModal   = $("blockModal");
  const bClose   = $("blockModalClose");
  const bSave    = $("blockSaveBtn");
  const bAdd     = $("addBlockBtn");

  function openBlockModal() {
    if (!bModal || !bOverlay) return;
    // Reset fields
    const label = $("blockLabelInput");
    if (label) { label.value = ""; label.focus(); }
    bModal.querySelectorAll(".block-day input[type='checkbox']").forEach((cb) => { cb.checked = false; });
    const startEl = $("blockStartInput"), endEl = $("blockEndInput");
    if (startEl) startEl.value = "17:00";
    if (endEl)   endEl.value   = "21:00";
    bModal.classList.add("active");
    bOverlay.classList.add("active");
  }

  function closeBlockModal() {
    if (!bModal || !bOverlay) return;
    bModal.classList.remove("active");
    bOverlay.classList.remove("active");
  }

  if (bAdd)    bAdd.addEventListener("click", openBlockModal);
  if (bClose)  bClose.addEventListener("click", closeBlockModal);
  if (bOverlay) bOverlay.addEventListener("click", closeBlockModal);

  if (bSave) {
    bSave.addEventListener("click", () => {
      const label = ($("blockLabelInput")?.value || "").trim();
      if (!label) { $("blockLabelInput")?.focus(); return; }
      const days = [];
      bModal.querySelectorAll(".block-day input[type='checkbox']:checked").forEach((cb) => days.push(cb.value));
      if (!days.length) return;
      const rawStart = ($("blockStartInput")?.value || "17:00").replace(":", "");
      const rawEnd   = ($("blockEndInput")?.value   || "21:00").replace(":", "");
      if (parseInt(rawStart, 10) >= parseInt(rawEnd, 10)) return;
      applyNewCalendarBlocks([{ label, days, start: rawStart, end: rawEnd }]);
      closeBlockModal();
    });
  }

  // Allow Enter key to save from label input
  const labelInput = $("blockLabelInput");
  if (labelInput) {
    labelInput.addEventListener("keydown", (e) => { if (e.key === "Enter") bSave?.click(); });
  }
});
