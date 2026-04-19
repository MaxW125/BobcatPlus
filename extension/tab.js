// ============================================================
// COMPRESSION + PROMPT
// ============================================================

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .split("Section Description:")[0]
    .trim();
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
    const startStr =
      String(start.getHours()).padStart(2, "0") +
      String(start.getMinutes()).padStart(2, "0");
    const endStr =
      String(end.getHours()).padStart(2, "0") +
      String(end.getMinutes()).padStart(2, "0");
    const existing = courses.find((c) => c.crn === String(event.crn));
    if (existing) {
      if (!existing.days.includes(dayNames[dayIdx]))
        existing.days.push(dayNames[dayIdx]);
    } else {
      courses.push({
        crn: String(event.crn),
        course: event.subject + " " + event.courseNumber,
        title: event.title,
        days: [dayNames[dayIdx]],
        start: startStr,
        end: endStr,
      });
    }
  }
  return courses;
}

function applyPreFilter(compressed, registeredCourses) {
  return {
    eligible: compressed.eligible
      .map((course) => {
        const filteredSections = course.sections
          .map((section) => {
            if (section.online || !section.days || !section.start)
              return { ...section, conflictsWith: [] };
            const conflicts = [];
            for (const reg of registeredCourses) {
              if (!reg.days || !reg.start) continue;
              const sharedDays = section.days.filter((d) =>
                reg.days.includes(d),
              );
              if (sharedDays.length === 0) continue;
              const secStart = timeStrToMinutes(section.start),
                secEnd = timeStrToMinutes(section.end);
              const regStart = timeStrToMinutes(reg.start),
                regEnd = timeStrToMinutes(reg.end);
              if (secStart < regEnd && regStart < secEnd)
                conflicts.push(reg.crn + " (" + reg.course + ")");
            }
            return { ...section, conflictsWith: conflicts };
          })
          .filter((s) => s.conflictsWith.length === 0);
        return { ...course, sections: filteredSections };
      })
      .filter((c) => c.sections.length > 0),
  };
}

function compressForLLM(data) {
  return {
    eligible: data.eligible
      .map((course) => {
        const description = stripHtml(course.sections[0]?.courseDescription);
        const openSections = course.sections
          .filter((s) => s.openSection)
          .map((s) => {
            const mt = s.meetingsFaculty[0]?.meetingTime;
            const days = [];
            if (mt?.monday) days.push("Mon");
            if (mt?.tuesday) days.push("Tue");
            if (mt?.wednesday) days.push("Wed");
            if (mt?.thursday) days.push("Thu");
            if (mt?.friday) days.push("Fri");
            return {
              crn: s.courseReferenceNumber,
              online: s.instructionalMethod === "INT",
              days: days.length ? days : null,
              start: mt?.beginTime || null,
              end: mt?.endTime || null,
              seatsAvailable: s.seatsAvailable,
              instructor:
                s.faculty[0]?.displayName !== "Faculty, Unassigned"
                  ? s.faculty[0]?.displayName
                  : null,
              credits: s.creditHourLow ?? 3,
            };
          });
        return {
          course: `${course.subject} ${course.courseNumber}`,
          title: course.sections[0]?.courseTitle
            ?.replace(/&amp;/g, "&")
            ?.replace(/&#39;/g, "'"),
          requirementLabel: course.label,
          description,
          sections: openSections,
        };
      })
      .filter((c) => c.sections.length > 0),
  };
}

const SCHEDULE_SYSTEM_PROMPT = `
You are an academic schedule planning assistant helping students at Texas State University 
build optimal course schedules for an upcoming semester.

You will receive:
1. ALREADY LOCKED: courses the student has locked in (registered or manually chosen). These are FIXED —
   you must never conflict with them, never include them in your output schedules, and only output the NEW courses being added.
   Treat their time slots as completely blocked.
2. ELIGIBLE COURSES: courses available to add, each with open sections. Each section may 
   include a conflictsWith[] field — if it is non-empty, that section has already been 
   flagged as conflicting with a locked course and must NOT be selected.
3. The student's preferences in natural language.

═══════════════════════════════════════════
HARD RULES — never violate these
═══════════════════════════════════════════
1. No time conflicts. Two sections cannot overlap on the same day. 
   Times are 24-hour strings (e.g. "1230" = 12:30 PM, "1400" = 2:00 PM).
2. Only select sections where seatsAvailable > 0, unless the student explicitly says 
   they are okay with waitlisting.
3. Never select two courses that satisfy the same requirementLabel unless the student 
   explicitly asks to double up on a category.
4. Respect all explicit timing constraints from the student.
5. Only use sections from the provided eligible list. Do not invent CRNs or courses.

═══════════════════════════════════════════
SOFT PREFERENCES
═══════════════════════════════════════════
- Career goals: favor courses most relevant to the student's stated career interests.
- Day/time preferences: prefer lighter days or specific time ranges if mentioned.
- Topic interests: favor courses matching stated interests when multiple options satisfy the same requirement.
- Online vs in-person: default to in-person unless the student prefers online.
- Unassigned faculty is a mild negative but not a disqualifier.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════
Always respond with valid JSON only — no markdown, no preamble.

{
  "schedules": [
    {
      "name": "Schedule A — <short evocative label>",
      "rationale": "<2-4 sentences>",
      "totalCredits": 12,
      "courses": [
        {
          "course": "SOCI 3363",
          "title": "MEDICAL SOCI",
          "crn": "19272",
          "days": ["Mon", "Wed"],
          "start": "1230",
          "end": "1350",
          "online": false,
          "requirementSatisfied": "Sociology Requirement",
          "instructor": "Zhang, Yan"
        }
      ]
    }
  ],
  "followUpQuestion": "<short friendly question>"
}

Generate exactly 3 meaningfully distinct schedules.

═══════════════════════════════════════════
ITERATION & LOCKING
═══════════════════════════════════════════
If the student's message includes locked courses, those exact CRNs must appear in all 3 schedules unchanged.
Always regenerate all 3 schedules on each turn.
`.trim();

// ============================================================
// APP STATE
// ============================================================

const $ = (id) => document.getElementById(id);

function sendToBackground(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let currentStudent = null;
let currentTerm = null;
let analysisResults = null;
let savedSchedules = [];
let conversationHistory = [];
let cachedRawData = null;
let cachedRegisteredCourses = []; // LLM conflict avoidance
let cachedRegisteredTerm = null;

// Mi's auth/fetch state
let registeredFetchCompleted = false;
let registeredFetchOk = false;

// Max's plan state
let bannerPlans = [];
let registeredScheduleCache = {};

// Eligible courses (shared between Build and AI)
let eligibleCourses = [];
let expandedCourseKey = null;
let selectedSectionByCourse = {};

// ── UNIFIED WORKING SCHEDULE ──────────────────────────────
// workingCourses: array of course entries on the calendar right now
// Each entry: { crn, subject, courseNumber, title, days, beginTime, endTime, source, online }
// source: "registered" | "manual" | "ai"
let workingCourses = [];

// lockedCrns: Set of CRNs the user has locked. Registered courses locked by default.
let lockedCrns = new Set();

// ── UI MODE ───────────────────────────────────────────────
// "build" or "ai"
let panelMode = "build";

// Schedules section collapsed state
let schedulesCollapsed = false;

// Which schedule is currently selected in the list
let activeScheduleKey = "registered"; // "registered" | "new" | "saved:N" | "banner:N"

// Calendar constants — declared here so buildEmptyCalendar() can use them at any call time
const START_HOUR = 7;
const END_HOUR = 22;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// ============================================================
// DEBUG LOGGER (fails silently — strip before production)
// ============================================================
function dbgLog(location, message, data, hypothesisId) {
  fetch("http://127.0.0.1:7750/ingest/853901e6-d4c8-4b6b-b2a7-9b1a93c88eb5", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "782a56",
    },
    body: JSON.stringify({
      sessionId: "782a56",
      location,
      message,
      data: data || {},
      timestamp: Date.now(),
      hypothesisId,
    }),
  }).catch(() => {});
}

// ============================================================
// INIT
// ============================================================

(async () => {
  const reloadMark = sessionStorage.getItem("bobcat_dbg_post_login_reload");
  if (reloadMark) {
    sessionStorage.removeItem("bobcat_dbg_post_login_reload");
    dbgLog(
      "tab.js:init",
      "tab loaded after post-login location.reload",
      { reloadMark },
      "H2-verify",
    );
  }

  chrome.runtime.sendMessage({ action: "getStudentInfo" }, (student) => {
    if (student) applyStudentInfoToUI(student);
    else $("studentName").textContent = "Not logged in";
  });

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
    setPanelMode("build");

    (async () => {
      const ok = await checkAuth();
      if (ok) {
        await loadSchedule(currentTerm);
        await loadBannerPlans(currentTerm);
        // Only start eligible course fetch AFTER schedule is loaded and session is warm
        autoLoadEligibleCourses();
      } else {
        $("statusBar").textContent =
          "Use Import Schedule to sign in and load your registration.";
        await loadBannerPlans(currentTerm);
      }
    })();
  });
})();

// ============================================================
// TERM CHANGE
// ============================================================

$("termSelect").addEventListener("change", async (e) => {
  currentTerm = e.target.value;
  analysisResults = null;
  cachedRawData = null;
  cachedRegisteredCourses = [];
  cachedRegisteredTerm = null;
  conversationHistory = [];
  bannerPlans = [];
  registeredScheduleCache = {};
  eligibleCourses = [];
  expandedCourseKey = null;
  selectedSectionByCourse = {};
  workingCourses = [];
  lockedCrns = new Set();
  buildEmptyCalendar();
  setPanelMode("build");
  if (await checkAuth()) {
    await loadSchedule(currentTerm);
    await loadBannerPlans(currentTerm);
    autoLoadEligibleCourses();
  } else {
    $("statusBar").textContent =
      "Use Import Schedule to sign in and load your registration.";
    await loadBannerPlans(currentTerm);
  }
});

// ============================================================
// BUILD / AI TOGGLE
// ============================================================

function setPanelMode(mode) {
  panelMode = mode;
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

document.addEventListener("DOMContentLoaded", () => {
  const buildTab = $("tabBuild");
  const aiTab = $("tabAI");
  if (buildTab) buildTab.addEventListener("click", () => setPanelMode("build"));
  if (aiTab) aiTab.addEventListener("click", () => setPanelMode("ai"));

  // Schedules collapsible
  const schedulesToggle = $("schedulesToggle");
  if (schedulesToggle) {
    schedulesToggle.addEventListener("click", () => {
      schedulesCollapsed = !schedulesCollapsed;
      const chevron = $("schedulesChevron");
      const body = $("schedulesBody");
      if (chevron) chevron.textContent = schedulesCollapsed ? "›" : "›";
      if (body) body.style.display = schedulesCollapsed ? "none" : "block";
      if (schedulesToggle)
        schedulesToggle.classList.toggle("collapsed", schedulesCollapsed);
    });
  }
});

async function autoLoadEligibleCourses() {
  if (analysisResults && (analysisResults.eligible || []).length > 0) {
    eligibleCourses = analysisResults.eligible;
    renderEligibleList();
    return;
  }
  const statusEl = $("eligibleStatus");
  if (statusEl) statusEl.textContent = "Loading your eligible courses…";
  analysisResults = await runAnalysisAndWait();
  cachedRawData = analysisResults;
  eligibleCourses = analysisResults.eligible || [];
  renderEligibleList();
}

// ============================================================
// AUTH + IMPORT (Mi)
// ============================================================

async function checkAuth() {
  try {
    const [dwRes, regRes] = await Promise.all([
      fetch(
        "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself",
        { credentials: "include" },
      ),
      fetch(
        "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=1",
        { credentials: "include" },
      ),
    ]);
    return dwRes.ok && regRes.ok;
  } catch (e) {
    return false;
  }
}

const importBtn = document.getElementById("importBtn");
if (importBtn) {
  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true;
    importBtn.classList.add("loading");
    importBtn.textContent = "Checking session...";
    const authed = await checkAuth();
    const importSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Import Schedule`;

    if (!authed) {
      importBtn.textContent = "Waiting for login...";
      addMessage(
        "system",
        "Opening TXST login — sign in and the import will start automatically.",
      );
      chrome.runtime.sendMessage({ action: "openLoginPopup" });

      const loginListener = (msg) => {
        if (msg.type === "loginSuccess") {
          chrome.runtime.onMessage.removeListener(loginListener);
          addMessage("system", "Login successful! Loading your schedule next…");
          (async () => {
            dbgLog(
              "tab.js:loginSuccess",
              "post-login async started",
              { currentTerm },
              "H2",
            );
            importBtn.textContent = "Importing...";
            importBtn.classList.add("loading");
            const authed2 = await checkAuth();
            if (!authed2) {
              addMessage(
                "system",
                "TXST session not ready yet. Wait a few seconds and click Import Schedule again.",
              );
              importBtn.disabled = false;
              importBtn.classList.remove("loading");
              importBtn.innerHTML = importSvg;
              return;
            }
            await waitWithChatCountdown(1);
            analysisResults = null;
            cachedRawData = null;
            cachedRegisteredCourses = [];
            cachedRegisteredTerm = null;
            conversationHistory = [];
            $("statusBar").textContent = "Importing schedule...";
            await loadSchedule(currentTerm);
            sessionStorage.setItem(
              "bobcat_dbg_post_login_reload",
              String(Date.now()),
            );
            location.reload();
          })().catch((err) => {
            console.error("[BobcatPlus] post-login import:", err);
            addMessage(
              "system",
              "Could not finish loading your schedule. Use Refresh in the chat or Import Schedule again.",
            );
            importBtn.disabled = false;
            importBtn.classList.remove("loading");
            importBtn.innerHTML = importSvg;
          });
        }
        if (msg.type === "loginCancelled") {
          chrome.runtime.onMessage.removeListener(loginListener);
          addMessage("system", "Login cancelled. Click Import to try again.");
          importBtn.disabled = false;
          importBtn.classList.remove("loading");
          importBtn.innerHTML = importSvg;
        }
      };
      chrome.runtime.onMessage.addListener(loginListener);
      return;
    }

    importBtn.textContent = "Importing...";
    $("statusBar").textContent = "Importing schedule...";
    analysisResults = null;
    cachedRawData = null;
    cachedRegisteredCourses = [];
    cachedRegisteredTerm = null;
    conversationHistory = [];
    await loadSchedule(currentTerm);
    importBtn.disabled = false;
    importBtn.classList.remove("loading");
    importBtn.innerHTML = importSvg;
  });
}

// ============================================================
// SAML / getCurrentSchedule (Mi — page context, DOMParser)
// ============================================================

function waitAnimationFrames(n) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++)
    p = p.then(() => new Promise((r) => requestAnimationFrame(r)));
  return p;
}

function registrationResponseLooksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("[") || t.startsWith("{");
}

function pickSamlPostForm(doc) {
  const forms = [...doc.querySelectorAll("form")];
  if (forms.length === 0) return null;
  const hasRelay = (f) =>
    f.querySelector(
      'input[name="SAMLResponse"],input[name="SAMLRequest"],input[name="RelayState"]',
    );
  const withSaml = forms.find(hasRelay);
  if (withSaml) return withSaml;
  const outsideNoscript = forms.find((f) => !f.closest("noscript"));
  return outsideNoscript || forms[0];
}

async function submitFirstFormFromHtml(htmlText, baseHref) {
  try {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const form = pickSamlPostForm(doc);
    if (!form) return null;
    const rawAction = form.getAttribute("action");
    if (rawAction && rawAction.trim().toLowerCase().startsWith("javascript:"))
      return null;
    const url =
      !rawAction || rawAction.trim() === ""
        ? new URL(baseHref)
        : new URL(rawAction, baseHref);
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    const params = new URLSearchParams();
    form.querySelectorAll("input[name]").forEach((input) => {
      const n = input.getAttribute("name");
      if (n) params.append(n, input.value);
    });
    form.querySelectorAll("select[name]").forEach((sel) => {
      const n = sel.getAttribute("name");
      if (n) params.append(n, sel.value);
    });
    form.querySelectorAll("textarea[name]").forEach((ta) => {
      const n = ta.getAttribute("name");
      if (n) params.append(n, ta.value);
    });
    const init = { credentials: "include", redirect: "follow" };
    if (method === "GET") {
      url.search = params.toString();
      const r = await fetch(url.href, init);
      return await r.text();
    }
    const r = await fetch(url.href, {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    return await r.text();
  } catch (e) {
    console.log("[BobcatPlus] submitFirstFormFromHtml:", e);
    return null;
  }
}

async function resolveRegistrationHtmlToJson(initialText, baseHref) {
  let text = initialText,
    samlHops = 0;
  while (!registrationResponseLooksLikeJson(text) && samlHops < 8) {
    const next = await submitFirstFormFromHtml(text, baseHref);
    if (next === null) break;
    text = next;
    samlHops++;
  }
  return { text, samlHops };
}

async function getCurrentSchedule(term) {
  try {
    await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/term/search?mode=registration",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ term }).toString(),
      },
    );
    await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration",
      { credentials: "include" },
    );
    const response = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents?termFilter=",
      { credentials: "include" },
    );
    let text = await response.text();
    const eventsBase =
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents";
    const resolved = await resolveRegistrationHtmlToJson(text, eventsBase);
    text = resolved.text;
    if (!registrationResponseLooksLikeJson(text)) {
      console.log(
        "[BobcatPlus] getRegistrationEvents returned non-JSON:",
        text.slice(0, 100),
      );
      return null;
    }
    return JSON.parse(text);
  } catch (e) {
    console.log("[BobcatPlus] getCurrentSchedule error:", e);
    return null;
  }
}

// ============================================================
// LOAD SCHEDULE — populates workingCourses from registered events
// ============================================================

// viewRegistered listener wired in DOMContentLoaded to avoid null ref at parse time

async function loadSchedule(term) {
  registeredFetchCompleted = false;
  $("statusBar").textContent = "Loading schedule...";

  let data = await getCurrentSchedule(term);
  if (data === null) {
    for (let i = 0; i < 8; i++) {
      await waitAnimationFrames(2);
      data = await getCurrentSchedule(term);
      if (data !== null) break;
    }
  }

  registeredFetchOk = data !== null;
  registeredFetchCompleted = true;
  dbgLog(
    "tab.js:loadSchedule",
    "fetch settled",
    {
      term,
      registeredFetchOk,
      dataNull: data === null,
      dataLen: Array.isArray(data) ? data.length : -1,
    },
    "H4",
  );

  if (data && data.length > 0) {
    removeExistingScheduleRefreshPrompts();
    registeredScheduleCache[term] = data;
    cachedRegisteredCourses = compressRegisteredForLLM(data);
    cachedRegisteredTerm = term;

    // Build working courses from registered events — deduplicate by CRN
    const seen = new Set();
    const registered = [];
    for (const event of data) {
      if (seen.has(event.crn)) continue;
      seen.add(event.crn);
      const start = new Date(event.start);
      const end = new Date(event.end);
      const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
      // Collect all days for this CRN
      const days = [];
      for (const ev2 of data) {
        if (String(ev2.crn) !== String(event.crn)) continue;
        const d = new Date(ev2.start).getDay() - 1;
        if (d >= 0 && d <= 4 && !days.includes(dayNames[d]))
          days.push(dayNames[d]);
      }
      const bh = start.getHours(),
        bm = start.getMinutes();
      const eh = end.getHours(),
        em = end.getMinutes();
      registered.push({
        crn: String(event.crn),
        subject: event.subject,
        courseNumber: event.courseNumber,
        title: event.title,
        days,
        beginTime:
          String(bh).padStart(2, "0") + ":" + String(bm).padStart(2, "0"),
        endTime:
          String(eh).padStart(2, "0") + ":" + String(em).padStart(2, "0"),
        source: "registered",
        online: false,
      });
      // Registered courses default to locked
      lockedCrns.add(String(event.crn));
    }

    // Preserve any manual/AI courses added since last load
    workingCourses = [
      ...registered,
      ...workingCourses.filter((c) => c.source !== "registered"),
    ];

    renderCalendarFromWorkingCourses();
    updateWeekHours(data);
    updateOverviewFromEvents(data);
    const unique = new Set(data.map((e) => e.crn));
    $("statusBar").textContent = unique.size + " registered courses";
    updateSaveBtn();
  } else if (data === null) {
    cachedRegisteredCourses = [];
    cachedRegisteredTerm = term;
    buildEmptyCalendar();
    $("statusBar").textContent =
      "Could not reach registration data. Try Import Schedule again.";
    addScheduleRefreshPrompt();
  } else {
    removeExistingScheduleRefreshPrompts();
    cachedRegisteredCourses = [];
    cachedRegisteredTerm = term;
    buildEmptyCalendar();
    $("statusBar").textContent = "No registered courses for this term";
  }
}

// ============================================================
// WORKING SCHEDULE — add/remove/lock
// ============================================================

function addToWorkingSchedule(entry) {
  // Remove existing entry with same CRN if present
  workingCourses = workingCourses.filter((c) => c.crn !== entry.crn);
  workingCourses.push(entry);
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
}

function removeFromWorkingSchedule(crn) {
  workingCourses = workingCourses.filter((c) => c.crn !== crn);
  lockedCrns.delete(crn);
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
}

function toggleLock(crn) {
  if (lockedCrns.has(crn)) {
    lockedCrns.delete(crn);
  } else {
    lockedCrns.add(crn);
  }
  renderCalendarFromWorkingCourses();
}

function updateSaveBtn() {
  const saveBtn = $("saveTxstBtn");
  if (!saveBtn) return;
  const hasNonRegistered = workingCourses.some(
    (c) => c.source !== "registered",
  );
  saveBtn.classList.toggle("txst-save-btn--dim", !hasNonRegistered);
  saveBtn.disabled = !hasNonRegistered;
}

// ============================================================
// CALENDAR RENDERING — unified from workingCourses
// ============================================================

function buildEmptyCalendar() {
  let html = '<tr><th class="time-col">Time</th>';
  DAYS.forEach((d) => {
    html += "<th>" + d + "</th>";
  });
  html += "</tr>";
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const label = (h > 12 ? h - 12 : h) + ":00 " + (h >= 12 ? "PM" : "AM");
    html += '<tr><td class="time-label">' + label + "</td>";
    for (let d = 0; d < 5; d++) {
      html += '<td id="cell-' + d + "-" + h + '"></td>';
    }
    html += "</tr>";
  }
  $("calendar").innerHTML = html;
}

function renderCalendarFromWorkingCourses() {
  buildEmptyCalendar();
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };

  for (const course of workingCourses) {
    if (!course.days || !course.beginTime || !course.endTime) continue;
    const [bh, bm] = course.beginTime.split(":").map(Number);
    const [eh, em] = course.endTime.split(":").map(Number);
    const startOffset = (bm / 60) * 40;
    const height = (eh + em / 60 - (bh + bm / 60)) * 40;
    const timeStr = formatTime24to12(bh, bm) + " – " + formatTime24to12(eh, em);
    const isLocked = lockedCrns.has(course.crn);
    const courseKey = course.subject + course.courseNumber;
    const chipClass = getChipForCourse(courseKey);

    for (const day of course.days) {
      const dayIdx = dayMap[day];
      if (dayIdx === undefined) continue;
      const cell = $("cell-" + dayIdx + "-" + bh);
      if (!cell) continue;

      const block = document.createElement("div");
      block.className =
        "course-block " + chipClass + (isLocked ? " locked" : "");
      block.setAttribute("data-crn", course.crn);
      block.style.top = startOffset + "px";
      block.style.height = height + "px";

      // Lock icon — filled when locked, outline when not
      const lockSvg = isLocked
        ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
        : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

      block.innerHTML =
        '<div class="block-info">' +
        '<div class="course-title">' +
        course.subject +
        " " +
        course.courseNumber +
        "</div>" +
        '<div class="course-time">' +
        timeStr +
        "</div>" +
        '<div class="course-time">' +
        (course.title || "") +
        "</div>" +
        "</div>" +
        '<div class="block-actions">' +
        '<button class="block-remove-btn" title="Remove" style="' +
        (isLocked ? "visibility:hidden;" : "") +
        '">✕</button>' +
        '<button class="block-lock-btn" title="' +
        (isLocked ? "Unlock" : "Lock") +
        '">' +
        lockSvg +
        "</button>" +
        "</div>";

      // Remove button
      const removeBtn = block.querySelector(".block-remove-btn");
      if (removeBtn) {
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeFromWorkingSchedule(course.crn);
        });
      }

      // Lock button
      const lockBtn = block.querySelector(".block-lock-btn");
      if (lockBtn) {
        lockBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleLock(course.crn);
        });
      }

      cell.appendChild(block);
    }
  }
}

// Legacy: still used by renderSavedScheduleOnCalendar when viewing a saved snapshot
function renderCoursesOnCalendar(events) {
  buildEmptyCalendar();
  updateWeekHours(events);
  updateOverviewFromEvents(events);
  const seen = new Set();
  for (const event of events) {
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
    const startOffset = (bm / 60) * 40;
    const height = (eh + em / 60 - (bh + bm / 60)) * 40;
    const timeStr = formatTime24to12(bh, bm) + " – " + formatTime24to12(eh, em);
    const cell = $("cell-" + dayIdx + "-" + bh);
    if (!cell) continue;
    const courseKey = event.subject + event.courseNumber;
    const block = document.createElement("div");
    block.className = "course-block " + getChipForCourse(courseKey);
    block.setAttribute("data-crn", event.crn || "");
    block.style.top = startOffset + "px";
    block.style.height = height + "px";
    block.innerHTML =
      '<div class="block-info">' +
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
      "</div>" +
      "</div>";
    cell.appendChild(block);
  }
}

function formatTime24to12(h, m) {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
}
function formatChatTime(t) {
  if (!t) return "";
  return formatTime24to12(parseInt(t.slice(0, 2)), parseInt(t.slice(2)));
}
function timeStrToMinutes(t) {
  if (!t) return null;
  return parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(2));
}
function sectionsConflict(a, b) {
  if (!a.days || !b.days || !a.start || !b.start) return false;
  const sharedDays = a.days.filter((d) => b.days.includes(d));
  if (sharedDays.length === 0) return false;
  return (
    timeStrToMinutes(a.start) < timeStrToMinutes(b.end) &&
    timeStrToMinutes(b.start) < timeStrToMinutes(a.end)
  );
}
function findFirstConflict(courses) {
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      if (sectionsConflict(courses[i], courses[j]))
        return { a: courses[i], b: courses[j] };
    }
  }
  const lockedList = getLockedForLLM();
  for (const proposed of courses) {
    if (lockedList.some((r) => r.crn === proposed.crn)) continue;
    for (const locked of lockedList) {
      if (sectionsConflict(proposed, locked))
        return {
          a: proposed,
          b: { ...locked, course: locked.course + " (locked)" },
        };
    }
  }
  return null;
}

// ============================================================
// LOCKED COURSES → LLM format
// ============================================================

function getLockedForLLM() {
  // Returns all locked courses in the LLM-compatible format
  return workingCourses
    .filter((c) => lockedCrns.has(c.crn))
    .map((c) => {
      const startStr = c.beginTime ? c.beginTime.replace(":", "") : null;
      const endStr = c.endTime ? c.endTime.replace(":", "") : null;
      return {
        crn: c.crn,
        course: c.subject + " " + c.courseNumber,
        title: c.title || "",
        days: c.days || [],
        start: startStr,
        end: endStr,
      };
    });
}

// ============================================================
// BUILD PANEL — eligible courses picker
// ============================================================

function formatSectionOneLine(section) {
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
    if (days.length)
      timeStr =
        " · " +
        days.join("/") +
        " " +
        formatTime24to12(bh, bm) +
        "–" +
        formatTime24to12(eh, em);
  }
  const online = section.instructionalMethod === "INT" ? " · Online" : "";
  const seats =
    section.seatsAvailable != null
      ? " · " + section.seatsAvailable + " seats"
      : "";
  return "Section " + sn + timeStr + online + seats;
}

function renderEligibleList() {
  const list = $("eligibleList");
  const status = $("eligibleStatus");
  if (!list) return;

  if (!eligibleCourses || eligibleCourses.length === 0) {
    list.innerHTML = "";
    if (status && !analysisResults)
      status.textContent = "Loading eligible courses…";
    else if (status)
      status.textContent = "No eligible courses found for this term.";
    return;
  }

  const seenKeys = new Set();
  const dedupedCourses = eligibleCourses.filter((course) => {
    const k = course.subject + "-" + course.courseNumber;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });

  if (status) status.textContent = dedupedCourses.length + " eligible courses";
  list.innerHTML = "";

  dedupedCourses.forEach((course) => {
    const key = course.subject + "-" + course.courseNumber;
    const openCount = (course.sections || []).filter(
      (s) => s.openSection,
    ).length;
    const totalCount = (course.sections || []).length;
    const alreadyAdded = workingCourses.some(
      (c) =>
        c.subject === course.subject &&
        c.courseNumber === course.courseNumber &&
        c.source !== "registered",
    );

    const item = document.createElement("div");
    item.className = "eligible-course" + (alreadyAdded ? " added" : "");

    const header = document.createElement("div");
    header.className = "eligible-course-header";
    header.innerHTML =
      '<span class="eligible-name">' +
      course.subject +
      " " +
      course.courseNumber +
      '<span class="eligible-req"> — ' +
      (course.label || "") +
      "</span></span>" +
      '<span class="eligible-meta">' +
      openCount +
      "/" +
      totalCount +
      " open</span>";

    header.addEventListener("click", () => {
      expandedCourseKey = expandedCourseKey === key ? null : key;
      renderEligibleList();
    });
    item.appendChild(header);

    if (expandedCourseKey === key) {
      const body = document.createElement("div");
      body.className = "eligible-course-body";

      // Course title header
      const courseTitle =
        course.sections[0]?.courseTitle
          ?.replace(/&amp;/g, "&")
          ?.replace(/&#39;/g, "'") || "";
      if (courseTitle) {
        const titleEl = document.createElement("div");
        titleEl.className = "eligible-course-title";
        titleEl.textContent = courseTitle;
        body.appendChild(titleEl);
      }

      const seenCrns = new Set();
      const sections = (course.sections || []).filter((s) => {
        const crn = String(s.courseReferenceNumber || "");
        if (!crn || seenCrns.has(crn)) return false;
        seenCrns.add(crn);
        return true;
      });
      const currentIdx = selectedSectionByCourse[key] ?? 0;

      sections.forEach((s, i) => {
        const lbl = document.createElement("label");
        lbl.className = "manual-result-row";
        lbl.innerHTML =
          '<input type="radio" name="sec-' +
          key +
          '" data-idx="' +
          i +
          '" ' +
          (i === currentIdx ? "checked" : "") +
          "> " +
          formatSectionOneLine(s);
        lbl.querySelector("input").addEventListener("change", () => {
          selectedSectionByCourse[key] = i;
        });
        body.appendChild(lbl);
      });

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "manual-small-btn";
      addBtn.style.marginTop = "4px";
      addBtn.textContent = alreadyAdded
        ? "Replace on calendar"
        : "Add to calendar";
      addBtn.addEventListener("click", () => {
        const idx = selectedSectionByCourse[key] ?? 0;
        const section = sections[idx];
        if (!section) return;
        const crn = String(section.courseReferenceNumber || "");
        if (!crn) {
          $("statusBar").textContent = "Section has no CRN.";
          return;
        }

        const mt = section.meetingsFaculty?.[0]?.meetingTime;
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
          title: section.courseTitle || course.sections[0]?.courseTitle || "",
          days,
          beginTime,
          endTime,
          source: "manual",
          online: section.instructionalMethod === "INT",
        });

        expandedCourseKey = null;
        $("statusBar").textContent =
          "Added " +
          course.subject +
          " " +
          course.courseNumber +
          " to calendar.";
        renderEligibleList();
        updateSaveBtn();
      });

      body.appendChild(addBtn);
      item.appendChild(body);
    }
    list.appendChild(item);
  });
}

// ============================================================
// SAVE TO TXST BUTTON (explicit, not automatic)
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  const saveTxstBtn = $("saveTxstBtn");
  const planNameInput = $("txstPlanName");
  if (saveTxstBtn) {
    saveTxstBtn.addEventListener("click", async () => {
      if (saveTxstBtn.disabled) return;

      // Get plan name — from the New Plan item's stored name or prompt
      const newPlanItems = document.querySelectorAll(".saved-item-new-plan");
      let planName = "";
      newPlanItems.forEach((el) => {
        if (el.dataset.planName) planName = el.dataset.planName.trim();
      });

      if (!planName) {
        // Prompt inline — highlight the New Plan item
        const newPlanLabel = document.querySelector(".new-plan-label");
        if (newPlanLabel) {
          newPlanLabel.style.color = "var(--maroon)";
          newPlanLabel.textContent =
            "Double-click New Plan to set a name first";
          setTimeout(() => {
            newPlanLabel.style.color = "";
            newPlanLabel.textContent = "+ New Plan";
          }, 2500);
        }
        $("statusBar").textContent = "Double-click New Plan to enter a name.";
        return;
      }

      const nonRegistered = workingCourses.filter(
        (c) => c.source !== "registered",
      );
      if (nonRegistered.length === 0) {
        $("statusBar").textContent = "Add courses before saving.";
        return;
      }

      $("statusBar").textContent = "Saving to TXST…";
      saveTxstBtn.disabled = true;

      const rows = nonRegistered.map((c) => {
        const courseMatch = (eligibleCourses || []).find(
          (ec) =>
            ec.subject === c.subject && ec.courseNumber === c.courseNumber,
        );
        const section = courseMatch?.sections?.find(
          (s) => String(s.courseReferenceNumber) === c.crn,
        );
        return {
          section: section || {
            courseReferenceNumber: c.crn,
            courseTitle: c.title,
          },
          subject: c.subject,
          courseNumber: c.courseNumber,
        };
      });

      const resp = await sendToBackground({
        action: "saveTxstPlan",
        term: currentTerm,
        planName,
        rows,
      });
      saveTxstBtn.disabled = false;
      updateSaveBtn();
      if (!resp.ok) {
        $("statusBar").textContent = resp.error || "Save failed.";
        return;
      }
      $("statusBar").textContent = "Saved to TXST: " + planName;

      // Reset the New Plan item name
      document.querySelectorAll(".saved-item-new-plan").forEach((el) => {
        el.dataset.planName = "";
        const lbl = el.querySelector(".new-plan-label");
        if (lbl) lbl.textContent = "+ New Plan";
      });
      if (saveTxstBtn) saveTxstBtn.dataset.planName = "";

      await loadBannerPlans(currentTerm);
      renderSavedList();
    });
  }
});

// ============================================================
// SAVED SCHEDULES + BANNER PLANS
// ============================================================

async function loadBannerPlans(term) {
  const plans = await sendToBackground({ action: "getAllBannerPlans", term });
  if (Array.isArray(plans)) {
    bannerPlans = plans;
    renderSavedList();
  }
  $("statusBar").textContent = "Ready";
}

function renderSavedList() {
  const list = $("savedList");
  if (!list) return;
  const termSchedules = savedSchedules.filter((s) => s.term === currentTerm);
  list.innerHTML = "";

  // ── Current Registered Schedule ──
  const regItem = document.createElement("div");
  regItem.className =
    "saved-item saved-item-registered" +
    (activeScheduleKey === "registered" ? " active" : "");
  regItem.innerHTML = '<span class="name">Current Registered Schedule</span>';
  regItem.addEventListener("click", () => {
    activeScheduleKey = "registered";
    workingCourses = workingCourses.filter((c) => c.source === "registered");
    renderCalendarFromWorkingCourses();
    renderSavedList();
    $("statusBar").textContent = "Viewing registered schedule";
    updateSaveBtn();
  });
  list.appendChild(regItem);

  // ── Locally saved AI schedules ──
  termSchedules.forEach((schedule, i) => {
    const key = "saved:" + i;
    const item = document.createElement("div");
    item.className =
      "saved-item" + (activeScheduleKey === key ? " active" : "");
    item.innerHTML =
      '<span class="name">' +
      schedule.name +
      "</span>" +
      '<span class="info">' +
      schedule.courses.length +
      " courses</span>" +
      '<span class="delete-btn" data-key="' +
      key +
      '" data-idx="' +
      i +
      '">×</span>';
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      activeScheduleKey = key;
      renderSavedScheduleOnCalendar(schedule);
      renderSavedList();
    });
    list.appendChild(item);
  });

  // ── TXST Banner plans ──
  bannerPlans.forEach((plan, pi) => {
    const key = "banner:" + pi;
    const item = document.createElement("div");
    item.className =
      "saved-item" + (activeScheduleKey === key ? " active" : "");
    item.innerHTML =
      '<span class="banner-badge">TXST</span>' +
      '<span class="name">' +
      plan.name +
      "</span>" +
      '<span class="delete-btn txst-delete" title="Delete from TXST">×</span>';

    item.querySelector(".txst-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + plan.name + '" from TXST?')) return;
      $("statusBar").textContent = "Deleting " + plan.name + "…";
      const resp = await sendToBackground({
        action: "deleteTxstPlan",
        term: currentTerm,
        planIndex: plan.txstPlanIndex,
      });
      if (!resp.ok) {
        $("statusBar").textContent =
          "Delete failed: " + (resp.error || "unknown");
        return;
      }
      bannerPlans.splice(pi, 1);
      if (activeScheduleKey === key) {
        activeScheduleKey = "registered";
        workingCourses = workingCourses.filter(
          (c) => c.source === "registered",
        );
        renderCalendarFromWorkingCourses();
      }
      renderSavedList();
      $("statusBar").textContent = plan.name + " deleted.";
      setTimeout(() => loadBannerPlans(currentTerm), 1500);
    });

    item.addEventListener("click", async (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      activeScheduleKey = key;
      renderSavedList();

      // Fetch events if not cached yet
      if (!plan.events || plan.events.length === 0) {
        $("statusBar").textContent = "Loading " + plan.name + "…";
        buildEmptyCalendar();
        const events = await sendToBackground({
          action: "fetchPlanCalendar",
          term: currentTerm,
          planCourses: plan.planCourses || [],
        });
        plan.events = events || [];
        if (!plan.events.length) {
          buildEmptyCalendar();
          $("statusBar").textContent = plan.name + ": no meeting times found.";
          return;
        }
      }

      // Load into workingCourses so lock/remove buttons render correctly
      const planCourses = plan.events.reduce((acc, event) => {
        const crn = String(event.crn || "");
        const existing = acc.find((c) => c.crn === crn);
        const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
        const start = new Date(event.start);
        const dayIdx = start.getDay() - 1;
        const day = dayIdx >= 0 && dayIdx <= 4 ? dayNames[dayIdx] : null;
        const bh = start.getHours(),
          bm = start.getMinutes();
        const end = new Date(event.end);
        const eh = end.getHours(),
          em = end.getMinutes();
        if (existing) {
          if (day && !existing.days.includes(day)) existing.days.push(day);
        } else {
          acc.push({
            crn,
            subject: event.subject || "",
            courseNumber: event.courseNumber || "",
            title: event.title || "",
            days: day ? [day] : [],
            beginTime:
              String(bh).padStart(2, "0") + ":" + String(bm).padStart(2, "0"),
            endTime:
              String(eh).padStart(2, "0") + ":" + String(em).padStart(2, "0"),
            source: "registered", // treat as registered so they default locked
            online: false,
          });
          lockedCrns.add(crn); // lock all plan courses by default
        }
        return acc;
      }, []);

      // Replace non-registered working courses with this plan's courses
      workingCourses = [
        ...workingCourses.filter((c) => c.source === "registered"),
        ...planCourses.filter(
          (c) => !workingCourses.some((w) => w.crn === c.crn),
        ),
      ];

      renderCalendarFromWorkingCourses();
      updateWeekHours(plan.events);
      $("statusBar").textContent = "Viewing: " + plan.name;
    });

    list.appendChild(item);
  });

  // ── + New Plan — always last ──
  const newPlanItem = document.createElement("div");
  newPlanItem.className =
    "saved-item saved-item-new-plan" +
    (activeScheduleKey === "new" ? " active" : "");

  const newPlanSpan = document.createElement("span");
  newPlanSpan.className = "new-plan-label";
  newPlanSpan.textContent = newPlanItem._savedName || "+ New Plan";
  newPlanItem.appendChild(newPlanSpan);

  let newPlanName = ""; // persists between renders via closure — reset on term change

  function enterNewPlanEditMode() {
    if (newPlanItem.querySelector(".new-plan-input")) return; // already editing
    activeScheduleKey = "new";
    workingCourses = workingCourses.filter((c) => c.source === "registered");
    renderCalendarFromWorkingCourses();
    updateSaveBtn();

    newPlanSpan.style.display = "none";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "new-plan-input";
    input.placeholder = "Enter plan name…";
    input.value = newPlanName;
    newPlanItem.appendChild(input);
    // Use requestAnimationFrame to ensure DOM is ready before focus
    requestAnimationFrame(() => input.focus());

    const commit = () => {
      newPlanName = input.value.trim();
      newPlanSpan.textContent = newPlanName || "+ New Plan";
      newPlanSpan.style.display = "";
      input.remove();
      // Store name on save button dataset for the save handler
      const saveBtn = $("saveTxstBtn");
      if (saveBtn) saveBtn.dataset.planName = newPlanName;
      renderSavedList();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      }
      if (ev.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });
  }

  // Single click — activate new plan mode AND open edit
  newPlanItem.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    enterNewPlanEditMode();
  });

  list.appendChild(newPlanItem);

  // Wire delete buttons for local saved schedules
  list.querySelectorAll(".delete-btn:not(.txst-delete)").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      savedSchedules.splice(idx, 1);
      chrome.storage.local.set({ savedSchedules });
      if (activeScheduleKey === btn.dataset.key) {
        activeScheduleKey = "registered";
        workingCourses = workingCourses.filter(
          (c) => c.source === "registered",
        );
        renderCalendarFromWorkingCourses();
      }
      renderSavedList();
    });
  });
}

function renderSavedScheduleOnCalendar(schedule) {
  buildEmptyCalendar();
  const dayMap = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    mon: 0,
    tue: 1,
    wed: 2,
    thu: 3,
    fri: 4,
  };
  for (const course of schedule.courses) {
    if (!course.days || !course.beginTime || !course.endTime) continue;
    const [bh, bm] = course.beginTime.split(":").map(Number);
    const [eh, em] = course.endTime.split(":").map(Number);
    const startOffset = (bm / 60) * 40;
    const height = (eh + em / 60 - (bh + bm / 60)) * 40;
    const timeStr = formatTime24to12(bh, bm) + " – " + formatTime24to12(eh, em);
    for (const day of course.days) {
      const dayIdx = dayMap[day];
      if (dayIdx === undefined) continue;
      const cell = $("cell-" + dayIdx + "-" + bh);
      if (!cell) continue;
      const courseKey = (course.subject || "") + (course.courseNumber || "");
      const block = document.createElement("div");
      block.className = "course-block " + getChipForCourse(courseKey);
      block.style.top = startOffset + "px";
      block.style.height = height + "px";
      block.innerHTML =
        '<div class="block-info">' +
        '<div class="course-title">' +
        (course.subject || "") +
        " " +
        (course.courseNumber || "") +
        "</div>" +
        '<div class="course-time">' +
        timeStr +
        "</div>" +
        '<div class="course-time">CRN: ' +
        (course.crn || "") +
        "</div>" +
        "</div>";
      cell.appendChild(block);
    }
  }
  $("statusBar").textContent = "Viewing: " + schedule.name;
}

// ============================================================
// CHAT (AI mode)
// ============================================================

$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

async function sendChat() {
  const input = $("chatInput").value.trim();
  if (!input) return;

  // Auto-switch to AI mode if user types in chat while in Build mode
  if (panelMode !== "ai") setPanelMode("ai");

  addMessage("user", input);
  $("chatInput").value = "";

  if (!analysisResults) {
    addMessage(
      "system",
      "Analyzing your degree audit and finding eligible courses. This may take a minute...",
    );
    $("statusBar").textContent = "Running analysis...";
    analysisResults = await runAnalysisAndWait();
    cachedRawData = analysisResults;
    eligibleCourses = analysisResults.eligible || [];
    if (!analysisResults.eligible || analysisResults.eligible.length === 0) {
      addMessage("system", "No eligible courses found for this term.");
      $("statusBar").textContent = "No eligible courses found";
      return;
    }
    addMessage(
      "system",
      `Found ${analysisResults.eligible.length} eligible courses. Sending to AI...`,
    );
  }

  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  if (!openaiKey) {
    addMessage(
      "system",
      'No OpenAI API key found. Run this once in your browser console:\n\nchrome.storage.local.set({ openaiKey: "sk-..." })',
    );
    return;
  }

  $("statusBar").textContent = "Thinking...";

  try {
    const isFirstTurn = conversationHistory.length === 0;
    let userMessage;

    if (isFirstTurn) {
      const compressed = compressForLLM(cachedRawData);
      const lockedList = getLockedForLLM();

      // Pre-filter removes sections conflicting with locked courses
      const preFiltered = applyPreFilter(compressed, lockedList);

      const lockedBlock =
        lockedList.length > 0
          ? `ALREADY LOCKED (treat as fixed — build around these, never conflict with them):\n${JSON.stringify(lockedList)}\n\n`
          : "";

      console.log(
        "[BobcatPlus] Locked courses:",
        lockedList.length,
        "| Eligible after filter:",
        preFiltered.eligible
          .map((c) => c.course + "(" + c.sections.length + ")")
          .join(", "),
      );

      userMessage = `${lockedBlock}ELIGIBLE COURSES TO SCHEDULE:\n${JSON.stringify(preFiltered)}\n\nMy preferences: ${input}`;
    } else {
      // On subsequent turns, re-inject locked courses so the AI stays aware
      const lockedList = getLockedForLLM();
      const lockedNote =
        lockedList.length > 0
          ? `[Still locked: ${lockedList.map((c) => c.course + " CRN " + c.crn).join(", ")}]\n\n`
          : "";
      userMessage = lockedNote + input;
    }

    conversationHistory.push({ role: "user", content: userMessage });

    let validSchedules = [],
      attempts = 0;
    const MAX_ATTEMPTS = 3;
    let lastConflictDetails = [];

    while (validSchedules.length === 0 && attempts < MAX_ATTEMPTS) {
      attempts++;
      if (attempts > 1) {
        const conflictDetails = lastConflictDetails
          .map(
            (d) =>
              `"${d.name}": ${d.course1} (${d.days1} ${d.start1}-${d.end1}) conflicts with ${d.course2} (${d.days2} ${d.start2}-${d.end2})`,
          )
          .join("; ");
        conversationHistory.push({
          role: "user",
          content: `Your previous schedules had time conflicts. Regenerate all 3 fixing: ${conflictDetails}. Double-check every pair of in-person sections that share any day.`,
        });
        $("statusBar").textContent =
          `Fixing conflicts (attempt ${attempts})...`;
      }

      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SCHEDULE_SYSTEM_PROMPT },
              ...conversationHistory,
            ],
          }),
        },
      );

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const result = JSON.parse(data.choices[0].message.content);
      conversationHistory.push({
        role: "assistant",
        content: data.choices[0].message.content,
      });

      const conflicted = [];
      lastConflictDetails = [];
      for (const schedule of result.schedules) {
        const conflict = findFirstConflict(schedule.courses);
        if (conflict) {
          conflicted.push(schedule.name);
          lastConflictDetails.push({
            name: schedule.name,
            course1: conflict.a.course,
            days1: conflict.a.days?.join("/"),
            start1: conflict.a.start,
            end1: conflict.a.end,
            course2: conflict.b.course,
            days2: conflict.b.days?.join("/"),
            start2: conflict.b.start,
            end2: conflict.b.end,
          });
        } else {
          validSchedules.push(schedule);
        }
      }

      if (
        conflicted.length > 0 &&
        validSchedules.length === 0 &&
        attempts < MAX_ATTEMPTS
      ) {
        $("statusBar").textContent = "Conflicts found, retrying...";
        continue;
      }
      if (conflicted.length > 0)
        addMessage(
          "system",
          `⚠️ ${conflicted.join(", ")} had time conflicts and were removed. Showing ${validSchedules.length} valid schedule(s).`,
        );
      validSchedules.forEach((s) => addScheduleOption(s));
      if (validSchedules.length === 0)
        addMessage(
          "system",
          "Could not generate conflict-free schedules. Try simplifying your preferences.",
        );
      if (result.followUpQuestion && validSchedules.length > 0)
        addMessage("ai", result.followUpQuestion);
      break;
    }

    $("statusBar").textContent = "Ready";
  } catch (err) {
    console.error(err);
    addMessage("system", "Something went wrong: " + err.message);
    $("statusBar").textContent = "Error";
  }
}

function addScheduleOption(schedule) {
  const { name, rationale, totalCredits, courses } = schedule;
  const lockedList = getLockedForLLM();

  const lockedLines = lockedList
    .map((r) => {
      const time = r.days?.length
        ? r.days.join("/") +
          " " +
          formatChatTime(r.start) +
          "–" +
          formatChatTime(r.end)
        : "Online";
      return (
        '<div style="margin:4px 0;opacity:0.6;border-left:2px solid var(--border);padding-left:6px"><strong>' +
        r.course +
        "</strong> — " +
        (r.title || "") +
        '<br><span style="font-size:11px">Locked · ' +
        time +
        "</span></div>"
      );
    })
    .join("");

  const courseLines = courses
    .map((c) => {
      const time = c.online
        ? "Online"
        : c.days?.join("/") +
          " " +
          formatChatTime(c.start) +
          "–" +
          formatChatTime(c.end);
      return (
        '<div style="margin:4px 0"><strong>' +
        c.course +
        "</strong> — " +
        c.title +
        '<br><span style="font-size:11px;opacity:0.8">CRN: ' +
        c.crn +
        " · " +
        time +
        " · " +
        c.requirementSatisfied +
        "</span></div>"
      );
    })
    .join("");

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML =
    '<div class="sender">' +
    name +
    " · " +
    totalCredits +
    " credits</div>" +
    '<div style="font-size:11px;margin-bottom:8px;opacity:0.85">' +
    rationale +
    "</div>" +
    lockedLines +
    courseLines +
    "<br>" +
    '<button class="save-schedule-btn add-to-calendar-btn">Add to Calendar</button>' +
    '<button class="save-schedule-btn lock-all-btn" style="margin-left:6px">Lock All</button>';

  // Add to Calendar — merges AI courses into workingCourses
  div.querySelector(".add-to-calendar-btn").addEventListener("click", () => {
    for (const c of courses) {
      addToWorkingSchedule({
        crn: c.crn,
        subject: c.course.split(" ")[0],
        courseNumber: c.course.split(" ")[1],
        title: c.title,
        days: c.days || [],
        beginTime: c.start
          ? c.start.slice(0, 2) + ":" + c.start.slice(2)
          : null,
        endTime: c.end ? c.end.slice(0, 2) + ":" + c.end.slice(2) : null,
        source: "ai",
        online: c.online || false,
      });
    }
    addMessage(
      "system",
      name +
        " added to calendar. Switch to Build mode to lock, remove, or modify individual courses.",
    );
    updateSaveBtn();
  });

  // Lock All — locks every course in this schedule
  div.querySelector(".lock-all-btn").addEventListener("click", () => {
    for (const c of courses) {
      lockedCrns.add(c.crn);
    }
    renderCalendarFromWorkingCourses();
    addMessage("system", "All courses in " + name + " locked.");
  });

  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

// ============================================================
// ANALYSIS RUNNER
// ============================================================

function runAnalysisAndWait() {
  return new Promise((resolve) => {
    const results = { eligible: [], blocked: [], notOffered: [], needed: [] };
    const listener = (message) => {
      if (message.type === "status")
        $("statusBar").textContent = message.message;
      if (message.type === "eligible") results.eligible.push(message.data);
      if (message.type === "blocked") results.blocked.push(message.data);
      if (message.type === "done") {
        chrome.runtime.onMessage.removeListener(listener);
        results.notOffered = message.data.notOffered;
        results.needed = message.data.needed;
        resolve(results);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ action: "runAnalysis", term: currentTerm });
  });
}

// ============================================================
// CHAT HELPERS
// ============================================================

function addMessage(type, text) {
  const div = document.createElement("div");
  div.className = "chat-message " + type;
  const sender =
    type === "user" ? "You" : type === "ai" ? "Bobcat Plus" : "System";
  div.innerHTML =
    '<div class="sender">' + sender + "</div>" + text.replace(/\n/g, "<br>");
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function removeExistingScheduleRefreshPrompts() {
  document
    .querySelectorAll("[data-schedule-refresh-prompt]")
    .forEach((el) => el.remove());
}

function createCountdownSystemMessage() {
  const div = document.createElement("div");
  div.className = "chat-message system";
  div.innerHTML =
    '<div class="sender">System</div><div class="countdown-body"></div>';
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  const body = div.querySelector(".countdown-body");
  return {
    setHtml(html) {
      body.innerHTML = html;
      $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
    },
    remove() {
      div.remove();
    },
  };
}

async function waitWithChatCountdown(totalSeconds) {
  const msg = createCountdownSystemMessage();
  for (let i = totalSeconds; i >= 1; i--) {
    msg.setHtml(
      "Waiting for your TXST session to settle… <strong>" + i + "</strong>s",
    );
    await sleep(1000);
  }
  msg.remove();
}

function addScheduleRefreshPrompt() {
  removeExistingScheduleRefreshPrompts();
  const div = document.createElement("div");
  div.className = "chat-message system";
  div.setAttribute("data-schedule-refresh-prompt", "1");
  div.innerHTML =
    '<div class="sender">System</div><div>Schedule didn\u2019t load. Click Refresh to retry.</div><button type="button" class="save-schedule-btn">Refresh</button>';
  const btn = div.querySelector("button");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Loading…";
    await loadSchedule(currentTerm);
    btn.textContent = "Refresh";
    btn.disabled = false;
    if (registeredFetchOk) {
      div.remove();
      addMessage("system", "Schedule loaded.");
    }
  });
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function applyStudentInfoToUI(student) {
  if (!student) return;
  currentStudent = student;
  $("studentName").textContent =
    student.name + " | " + student.major + " | " + student.degree;
  const ss = document.getElementById("sidebarStudent");
  if (ss)
    ss.innerHTML =
      "<strong>" +
      student.name +
      "</strong><br>" +
      student.major +
      " | " +
      student.degree;
}

// ============================================================
// COURSE COLOR SYSTEM
// ============================================================
const TXST_CHIPS = [
  "chip-0",
  "chip-1",
  "chip-2",
  "chip-3",
  "chip-4",
  "chip-5",
  "chip-6",
  "chip-7",
];
function getCourseColors() {
  try {
    return JSON.parse(localStorage.getItem("bobcat_course_colors") || "{}");
  } catch (e) {
    return {};
  }
}
function saveCourseColors(map) {
  try {
    localStorage.setItem("bobcat_course_colors", JSON.stringify(map));
  } catch (e) {}
}
function getChipForCourse(courseKey) {
  const map = getCourseColors();
  if (!map[courseKey]) {
    const used = Object.values(map);
    const available = TXST_CHIPS.filter((c) => !used.includes(c));
    const pool = available.length > 0 ? available : TXST_CHIPS;
    map[courseKey] = pool[Math.floor(Math.random() * pool.length)];
    saveCourseColors(map);
  }
  return map[courseKey];
}

// ============================================================
// WEEK HOURS + OVERVIEW
// ============================================================
function updateWeekHours(events) {
  const seen = new Set();
  let totalHours = 0;
  for (const ev of events) {
    if (!ev.crn || seen.has(ev.crn)) continue;
    seen.add(ev.crn);
    totalHours += ev.creditHours || ev.credits || 3;
  }
  const el = document.getElementById("weekHours");
  if (el && totalHours > 0)
    el.innerHTML =
      "<strong>" + totalHours + " credit hours</strong> this semester";
}

function updateOverviewFromEvents(events) {
  const seen = new Set(),
    courses = [],
    waitlisted = [];
  for (const ev of events) {
    if (seen.has(ev.crn)) continue;
    seen.add(ev.crn);
    if (
      ev.registrationStatus &&
      ev.registrationStatus.toLowerCase().includes("wait")
    )
      waitlisted.push(ev);
    else courses.push(ev);
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
  const panel = document.getElementById("overviewPanel");
  if (!panel) return;
  panel.innerHTML = `<div class="ov-row"><div class="ov-stat"><div class="ov-val">${totalCourses}</div><div class="ov-label">Courses registered</div><div class="ov-sub">${totalHours} credit hours ${onTrackLabel}</div></div>${waitlisted.length > 0 ? `<div class="ov-stat"><div class="ov-val ov-red">${waitlisted.length}</div><div class="ov-label">Waitlisted</div></div>` : ""}</div><div class="ov-divider"></div><div class="ov-row"><div class="ov-stat" style="width:100%"><div class="ov-sub" style="font-size:11px;color:var(--text3)">GPA & credits load after degree audit runs</div></div></div>`;
}

function toggleOverview() {
  const body = document.getElementById("overviewPanel");
  const chevron = document.getElementById("overviewChevron");
  if (!body || !chevron) return;
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "block" : "none";
  chevron.textContent = collapsed ? "\u25be" : "\u25b8";
}

// ============================================================
// SIDEBAR + EVENT WIRING
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const hamburger = document.getElementById("hamburgerBtn");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const closeBtn = document.getElementById("sidebarClose");

  function openSidebar() {
    if (sidebar) sidebar.classList.add("open");
    if (overlay) overlay.classList.add("active");
  }
  function closeSidebar() {
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
  }

  if (hamburger) hamburger.addEventListener("click", openSidebar);
  if (closeBtn) closeBtn.addEventListener("click", closeSidebar);
  if (overlay) overlay.addEventListener("click", closeSidebar);

  const navRegister = document.getElementById("navRegister");
  const navAudit = document.getElementById("navAudit");
  if (navRegister)
    navRegister.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({
        url: "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration",
      });
      closeSidebar();
    });
  if (navAudit)
    navAudit.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({
        url: "https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/WEB31",
      });
      closeSidebar();
    });

  const toggle = document.getElementById("overviewToggle");
  if (toggle) toggle.addEventListener("click", toggleOverview);

  // viewRegistered — reset to registered-only view
  const viewRegistered = document.getElementById("viewRegistered");
  if (viewRegistered) {
    viewRegistered.addEventListener("click", async () => {
      workingCourses = workingCourses.filter((c) => c.source === "registered");
      renderCalendarFromWorkingCourses();
      renderSavedList();
      if (await checkAuth()) await loadSchedule(currentTerm);
      else
        $("statusBar").textContent =
          "Use Import Schedule to sign in and load your registration.";
    });
  }
});

// ============================================================
// RIGHT PANEL RESIZE (Simone)
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const handle = document.getElementById("resizeHandle");
  const panel = document.getElementById("rightPanel");
  if (!handle || !panel) return;
  let dragging = false,
    startX = 0,
    startWidth = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    panel.style.width = Math.min(600, Math.max(200, startWidth + delta)) + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
});
