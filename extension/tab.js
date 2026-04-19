// ============================================================
// COMPRESSION + PROMPT (inlined from scheduleGenerator.js)
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

// ============================================================
// REGISTERED COURSES COMPRESSOR
// ============================================================

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

// ============================================================
// PRE-FILTER
// ============================================================

function applyPreFilter(compressed, registeredCourses) {
  return {
    eligible: compressed.eligible
      .map((course) => {
        const filteredSections = course.sections
          .map((section) => {
            if (section.online || !section.days || !section.start) {
              return { ...section, conflictsWith: [] };
            }
            const conflicts = [];
            for (const reg of registeredCourses) {
              if (!reg.days || !reg.start) continue;
              const sharedDays = section.days.filter((d) =>
                reg.days.includes(d),
              );
              if (sharedDays.length === 0) continue;
              const secStart = timeStrToMinutes(section.start);
              const secEnd = timeStrToMinutes(section.end);
              const regStart = timeStrToMinutes(reg.start);
              const regEnd = timeStrToMinutes(reg.end);
              if (secStart < regEnd && regStart < secEnd) {
                conflicts.push(reg.crn + " (" + reg.course + ")");
              }
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
1. ALREADY REGISTERED: courses the student is currently enrolled in. These are FIXED — 
   you must never conflict with them, never include them in your output schedules, and only output the NEW courses being added.
   Treat their time slots as completely blocked.
2. ELIGIBLE COURSES: courses available to add, each with open sections. Each section may 
   include a conflictsWith[] field — if it is non-empty, that section has already been 
   flagged as conflicting with a registered course and must NOT be selected.
3. The student's preferences in natural language.

═══════════════════════════════════════════
HARD RULES — never violate these
═══════════════════════════════════════════
1. No time conflicts. Two sections cannot overlap on the same day. 
   Compare start/end times carefully for any days they share.
   Times are 24-hour strings (e.g. "1230" = 12:30 PM, "1400" = 2:00 PM).
2. Only select sections where seatsAvailable > 0, unless the student explicitly says 
   they are okay with waitlisting.
3. Never select two courses that satisfy the same requirementLabel unless the student 
   explicitly asks to double up on a category.
4. Respect all explicit timing constraints from the student 
   (e.g. "nothing before 1100" means no section with start < "1100").
5. Only use sections from the provided eligible list. Do not invent CRNs or courses.

═══════════════════════════════════════════
SOFT PREFERENCES — use these to rank choices
═══════════════════════════════════════════
- Career goals: use course descriptions to favor courses most relevant to the 
  student's stated career interests.
- Day/time preferences: prefer lighter days or specific time ranges if mentioned.
- Topic interests: if the student mentions interest in a subject (e.g. history, ethics), 
  favor courses in that area when multiple options satisfy the same requirement.
- Online vs in-person: default to in-person unless the student prefers online or 
  no in-person option exists.
- Instructor availability: if an instructor name is null, note this as a mild negative 
  (unassigned faculty), but don't exclude the section on this basis alone.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════
Always respond with valid JSON only — no markdown, no preamble, no explanation outside 
the JSON. Use this exact schema:

{
  "schedules": [
    {
      "name": "Schedule A — <short evocative label>",
      "rationale": "<2-4 sentences explaining why this schedule was built this way, how it addresses the student's preferences, and any notable tradeoffs>",
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
  "followUpQuestion": "<a short, friendly question asking if the student wants to lock any courses or make adjustments>"
}

Generate exactly 3 schedules. They should be meaningfully distinct — vary the time 
distribution, course selection (where alternatives exist), or online/in-person mix 
so the student has genuinely different options to consider.

═══════════════════════════════════════════
ITERATION & LOCKING
═══════════════════════════════════════════
If the student's message includes locked courses (e.g. "lock in PHIL 4327 CRN 16707"), 
those exact CRNs must appear in all 3 schedules unchanged. Build the remaining slots 
around them.

If the student asks to adjust a specific schedule (e.g. "make Schedule B lighter on 
Tuesdays"), regenerate all 3 schedules with that constraint applied, keeping any 
previously locked courses locked.

Always regenerate all 3 schedules on each turn so the student can compare the full 
set after each change.
`.trim();

// ============================================================
// APP STATE
// ============================================================

const $ = (id) => document.getElementById(id);

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

let currentStudent = null;
let currentTerm = null;
let analysisResults = null;
let savedSchedules = [];
let activeView = "registered";
let conversationHistory = [];
let cachedRawData = null;
let cachedRegisteredCourses = [];
let cachedRegisteredTerm = null;

// Mi's auth/fetch state flags
let registeredFetchCompleted = false;
let registeredFetchOk = false;

// Max's manual builder state
let bannerPlans = [];
let registeredScheduleCache = {};
let eligibleCourses = [];
let expandedCourseKey = null;
let selectedSectionByCourse = {};
let manualDraft = [];

// ============================================================
// MI'S DEBUG LOGGER (fails silently — strip before production)
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
    if (student) {
      applyStudentInfoToUI(student);
    } else {
      $("studentName").textContent = "Not logged in";
    }
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
    renderManualDraft();

    (async () => {
      const ok = await checkAuth();
      if (ok) {
        await loadSchedule(currentTerm);
        await loadBannerPlans(currentTerm); // session is warm after loadSchedule
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
  currentTerm = e.target.value;
  analysisResults = null;
  cachedRawData = null;
  cachedRegisteredCourses = [];
  cachedRegisteredTerm = null;
  conversationHistory = [];
  activeView = "registered";
  // Reset Max's manual builder state
  bannerPlans = [];
  registeredScheduleCache = {};
  eligibleCourses = [];
  expandedCourseKey = null;
  selectedSectionByCourse = {};
  manualDraft = [];
  renderManualDraft();
  renderEligibleList();
  renderSavedList();
  buildEmptyCalendar();
  if (await checkAuth()) {
    await loadSchedule(currentTerm);
    await loadBannerPlans(currentTerm); // session is warm after loadSchedule
  } else {
    $("statusBar").textContent =
      "Use Import Schedule to sign in and load your registration.";
    await loadBannerPlans(currentTerm); // plans don't need the registration session
  }
});

// ============================================================
// MI'S AUTH + IMPORT FLOW
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
            dbgLog(
              "tab.js:loginSuccess",
              "checkAuth after loginSuccess",
              { authed: authed2 },
              "H1",
            );

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

            dbgLog(
              "tab.js:loginSuccess",
              "before waitWithChatCountdown",
              {},
              "H3",
            );
            await waitWithChatCountdown(1);
            dbgLog(
              "tab.js:loginSuccess",
              "after waitWithChatCountdown",
              {},
              "H3",
            );

            analysisResults = null;
            cachedRawData = null;
            cachedRegisteredCourses = [];
            cachedRegisteredTerm = null;
            conversationHistory = [];

            $("statusBar").textContent = "Importing schedule...";
            dbgLog(
              "tab.js:loginSuccess",
              "before loadSchedule(currentTerm)",
              { term: currentTerm },
              "H3",
            );
            await loadSchedule(currentTerm);
            dbgLog(
              "tab.js:loginSuccess",
              "after loadSchedule",
              {
                registeredFetchOk,
                registeredFetchCompleted,
                cachedCourses: cachedRegisteredCourses.length,
              },
              "H4",
            );

            sessionStorage.setItem(
              "bobcat_dbg_post_login_reload",
              String(Date.now()),
            );
            dbgLog(
              "tab.js:loginSuccess",
              "before location.reload (post-login)",
              {
                registeredFetchOk,
                cachedCourses: cachedRegisteredCourses.length,
              },
              "H2",
            );
            location.reload();
          })().catch((err) => {
            dbgLog(
              "tab.js:loginSuccess",
              "post-login async catch",
              { err: err && err.message ? err.message : String(err) },
              "H5",
            );
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

    // Auth is good — reload schedule fresh
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
// MI'S getCurrentSchedule — runs in tab.js (page context)
// Uses DOMParser to follow SAML redirect chains that fetch()
// won't execute as JS. Shares the browser's cookie jar.
// ============================================================

function waitAnimationFrames(n) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
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
      const name = input.getAttribute("name");
      if (name) params.append(name, input.value);
    });
    form.querySelectorAll("select[name]").forEach((sel) => {
      const name = sel.getAttribute("name");
      if (name) params.append(name, sel.value);
    });
    form.querySelectorAll("textarea[name]").forEach((ta) => {
      const name = ta.getAttribute("name");
      if (name) params.append(name, ta.value);
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
  let text = initialText;
  let samlHops = 0;
  const maxHops = 8;
  while (!registrationResponseLooksLikeJson(text) && samlHops < maxHops) {
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
        body: new URLSearchParams({ term: term }).toString(),
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
// REGISTERED SCHEDULE
// ============================================================

$("viewRegistered").addEventListener("click", async () => {
  activeView = "registered";
  renderSavedList();
  if (await checkAuth()) {
    await loadSchedule(currentTerm);
  } else {
    $("statusBar").textContent =
      "Use Import Schedule to sign in and load your registration.";
  }
});

async function loadSchedule(term) {
  registeredFetchCompleted = false;
  $("statusBar").textContent = "Loading schedule...";

  let data = await getCurrentSchedule(term);
  // Retry loop — Banner occasionally needs a moment to warm up
  if (data === null) {
    const maxExtra = 8;
    for (let i = 0; i < maxExtra; i++) {
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
    // Populate both the UI cache (Max) and the LLM conflict-avoidance cache (main)
    registeredScheduleCache[term] = data;
    cachedRegisteredCourses = compressRegisteredForLLM(data);
    cachedRegisteredTerm = term;
    renderCoursesOnCalendar(data);
    const unique = new Set(data.map((e) => e.crn));
    $("statusBar").textContent = unique.size + " registered courses";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      "Waiting for your TXST registration session to settle… <strong>" +
        i +
        "</strong>s until we load your schedule.",
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
    '<div class="sender">System</div><div>Your schedule didn\u2019t load (registration didn\u2019t respond yet). Use Refresh to try again without reloading the page.</div><button type="button" class="save-schedule-btn">Refresh</button>';
  const btn = div.querySelector("button");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Loading…";
    await loadSchedule(currentTerm);
    btn.textContent = prev;
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
// ELIGIBLE COURSES PICKER (Max's manual builder)
// ============================================================

function formatSectionOneLine(section, subject, courseNum) {
  const crn = section.courseReferenceNumber || "?";
  const sn = String(
    section.sequenceNumber ?? section.sectionNumber ?? section.section ?? "?",
  );
  const mt = section.meetingsFaculty?.[0]?.meetingTime;
  let timeStr = "";
  if (mt) {
    const days = [];
    if (mt.monday) days.push("M");
    if (mt.tuesday) days.push("T");
    if (mt.wednesday) days.push("W");
    if (mt.thursday) days.push("R");
    if (mt.friday) days.push("F");
    if (days.length && mt.beginTime)
      timeStr = " · " + days.join("") + " " + mt.beginTime + "-" + mt.endTime;
  }
  const online = section.instructionalMethod === "INT" ? " · Online" : "";
  const seats =
    section.seatsAvailable != null
      ? " · " + section.seatsAvailable + " seats"
      : "";
  return (
    subject.toUpperCase() +
    " " +
    courseNum +
    " §" +
    sn +
    " CRN " +
    crn +
    timeStr +
    online +
    seats
  );
}

function renderEligibleList() {
  const list = $("eligibleList");
  const status = $("eligibleStatus");
  if (!list) return;

  if (!eligibleCourses || eligibleCourses.length === 0) {
    list.innerHTML = "";
    if (status)
      status.textContent =
        "Click Find to load your eligible courses for this term.";
    return;
  }

  const seenKeys = new Set();
  const dedupedCourses = eligibleCourses.filter((course) => {
    const k = course.subject + "-" + course.courseNumber;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });

  if (status)
    status.textContent =
      dedupedCourses.length +
      " eligible courses — click one to pick a section.";
  list.innerHTML = "";

  dedupedCourses.forEach((course) => {
    const key = course.subject + "-" + course.courseNumber;
    const openCount = (course.sections || []).filter(
      (s) => s.openSection,
    ).length;
    const totalCount = (course.sections || []).length;

    const item = document.createElement("div");
    item.className = "eligible-course";

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
          formatSectionOneLine(s, course.subject, course.courseNumber);
        lbl.querySelector("input").addEventListener("change", () => {
          selectedSectionByCourse[key] = i;
        });
        body.appendChild(lbl);
      });

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "manual-small-btn";
      addBtn.style.marginTop = "4px";
      addBtn.textContent = "Add to draft";
      addBtn.addEventListener("click", () => {
        const idx = selectedSectionByCourse[key] ?? 0;
        const section = sections[idx];
        if (!section) return;
        const crn = String(section.courseReferenceNumber || "");
        if (!crn) {
          $("statusBar").textContent = "Section has no CRN.";
          return;
        }
        if (manualDraft.some((d) => d.key === crn)) {
          $("statusBar").textContent =
            "CRN " + crn + " is already in the draft.";
          return;
        }
        manualDraft.push({
          key: crn,
          subject: course.subject,
          courseNumber: course.courseNumber,
          section,
        });
        renderManualDraft();
        if (activeView === "draft") {
          renderDraftOnCalendar();
          renderSavedList();
        }
        $("statusBar").textContent =
          "Added " +
          course.subject +
          " " +
          course.courseNumber +
          " (CRN " +
          crn +
          ") to draft.";
      });

      body.appendChild(addBtn);
      item.appendChild(body);
    }

    list.appendChild(item);
  });
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

$("runAnalysisBtn").addEventListener("click", async () => {
  if (!currentTerm) {
    $("statusBar").textContent = "Select a term first.";
    return;
  }
  if (analysisResults && (analysisResults.eligible || []).length > 0) {
    eligibleCourses = analysisResults.eligible;
    renderEligibleList();
    return;
  }
  $("eligibleStatus").textContent =
    "Analyzing your degree audit and searching Banner…";
  $("eligibleList").innerHTML = "";
  analysisResults = await runAnalysisAndWait();
  cachedRawData = analysisResults;
  eligibleCourses = analysisResults.eligible || [];
  renderEligibleList();
});

$("manualSaveTxstBtn").addEventListener("click", async () => {
  const planName = ($("manualPlanName").value || "").trim();
  if (!planName) {
    $("statusBar").textContent = "Enter a plan name.";
    return;
  }
  if (!manualDraft.length) {
    $("statusBar").textContent = "Add at least one section to the draft.";
    return;
  }
  $("statusBar").textContent = "Saving to TXST…";
  const resp = await sendToBackground({
    action: "saveTxstPlan",
    term: currentTerm,
    planName,
    rows: manualDraft.map((d) => ({
      section: d.section,
      subject: d.subject,
      courseNumber: d.courseNumber,
    })),
  });
  if (!resp.ok) {
    $("statusBar").textContent = resp.error || "Save failed.";
    return;
  }
  manualDraft = [];
  expandedCourseKey = null;
  selectedSectionByCourse = {};
  $("manualPlanName").value = "";
  activeView = "registered";
  setManualVisible(false);
  renderManualDraft();
  $("statusBar").textContent = "Saved: " + planName + ".";
  await loadBannerPlans(currentTerm);
});

$("manualResetSessionBtn").addEventListener("click", () => {
  manualDraft = [];
  expandedCourseKey = null;
  selectedSectionByCourse = {};
  $("manualPlanName").value = "";
  activeView = "registered";
  setManualVisible(false);
  renderManualDraft();
  renderEligibleList();
  renderSavedList();
  loadSchedule(currentTerm);
  $("statusBar").textContent = "Draft cleared.";
});

function setManualVisible(visible) {
  const el = document.querySelector(".manual-section");
  if (el) el.classList.toggle("visible", visible);
}

$("newDraftBtn").addEventListener("click", () => {
  manualDraft = [];
  expandedCourseKey = null;
  selectedSectionByCourse = {};
  $("manualPlanName").value = "";
  activeView = "draft";
  setManualVisible(true);
  renderManualDraft();
  renderEligibleList();
  renderSavedList();
  renderDraftOnCalendar();
  $("manualPlanName").focus();
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
  const termSchedules = savedSchedules.filter((s) => s.term === currentTerm);

  $("viewRegistered").className =
    activeView === "registered" ? "view-registered active" : "view-registered";

  list.innerHTML = "";

  if (activeView === "draft") {
    const draftItem = document.createElement("div");
    draftItem.className = "saved-item active";
    draftItem.innerHTML =
      '<span class="name" style="font-style:italic">New Draft</span>' +
      '<span class="info">' +
      manualDraft.length +
      " courses</span>";
    list.appendChild(draftItem);
  }

  if (
    termSchedules.length === 0 &&
    bannerPlans.length === 0 &&
    activeView !== "draft"
  ) {
    list.innerHTML =
      '<div class="saved-empty" id="savedEmpty">No saved schedules for this term.</div>';
    return;
  }

  termSchedules.forEach((schedule) => {
    const idx = savedSchedules.indexOf(schedule);
    const item = document.createElement("div");
    item.className = "saved-item" + (activeView === idx ? " active" : "");
    item.innerHTML =
      '<span class="name">' +
      schedule.name +
      "</span>" +
      '<span class="info">' +
      schedule.courses.length +
      " courses</span>" +
      '<span class="delete-btn" data-idx="' +
      idx +
      '">×</span>';

    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      activeView = idx;
      renderSavedList();
      renderSavedScheduleOnCalendar(schedule);
    });

    list.appendChild(item);
  });

  bannerPlans.forEach((plan, pi) => {
    const bannerKey = "banner:" + pi;
    const item = document.createElement("div");
    item.className = "saved-item" + (activeView === bannerKey ? " active" : "");
    item.innerHTML =
      '<span class="banner-badge">TXST</span>' +
      '<span class="name">' +
      plan.name +
      "</span>" +
      '<span class="delete-btn txst-delete" title="Delete from TXST">×</span>';

    item.querySelector(".txst-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + plan.name + '" from TXST and Bobcat Plus?'))
        return;
      $("statusBar").textContent = "Deleting " + plan.name + "…";
      const resp = await sendToBackground({
        action: "deleteTxstPlan",
        term: currentTerm,
        planIndex: plan.txstPlanIndex,
      });
      if (!resp.ok) {
        $("statusBar").textContent =
          "Delete failed: " + (resp.error || "unknown error");
        return;
      }
      bannerPlans.splice(pi, 1);
      if (activeView === bannerKey) {
        activeView = "registered";
        loadSchedule(currentTerm);
      }
      renderSavedList();
      $("statusBar").textContent = plan.name + " deleted.";
      setTimeout(() => loadBannerPlans(currentTerm), 1500);
    });

    item.addEventListener("click", async (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      activeView = bannerKey;
      renderSavedList();

      if (plan.events && plan.events.length > 0) {
        renderCoursesOnCalendar(plan.events);
        $("statusBar").textContent = "Viewing: " + plan.name;
        return;
      }

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
        $("statusBar").textContent =
          plan.name + ": no scheduled meeting times found.";
        return;
      }

      if (activeView === bannerKey) {
        renderCoursesOnCalendar(plan.events);
        $("statusBar").textContent = "Viewing: " + plan.name;
      }
    });

    list.appendChild(item);
  });

  list.querySelectorAll(".delete-btn:not(.txst-delete)").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      savedSchedules.splice(idx, 1);
      chrome.storage.local.set({ savedSchedules });
      if (activeView === idx) {
        activeView = "registered";
        loadSchedule(currentTerm);
      }
      renderSavedList();
    });
  });
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
    const startOffset = (bm / 60) * 40;
    const height = (eh + em / 60 - (bh + bm / 60)) * 40;
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
      cell.appendChild(block);
    }
  }
  $("statusBar").textContent = manualDraft.length
    ? "Draft: " + manualDraft.length + " course(s) — add more or save."
    : "Draft is empty — pick courses from the list below.";
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
    const timeStr = formatTime24to12(bh, bm) + " - " + formatTime24to12(eh, em);

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
        "</div>";
      cell.appendChild(block);
    }
  }
  $("statusBar").textContent = "Viewing: " + schedule.name;
}

// ============================================================
// CALENDAR RENDERING
// ============================================================

const START_HOUR = 7;
const END_HOUR = 22;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

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
    const timeStr = formatTime24to12(bh, bm) + " - " + formatTime24to12(eh, em);

    const cell = $("cell-" + dayIdx + "-" + bh);
    if (!cell) continue;

    const courseKey = event.subject + event.courseNumber;
    const block = document.createElement("div");
    block.className = "course-block " + getChipForCourse(courseKey);
    block.setAttribute("data-course-key", courseKey);
    block.setAttribute("data-crn", event.crn || "");
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
  const h = parseInt(t.slice(0, 2));
  const m = t.slice(2);
  return formatTime24to12(h, parseInt(m));
}

function timeStrToMinutes(t) {
  if (!t) return null;
  return parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(2));
}

function sectionsConflict(a, b) {
  if (!a.days || !b.days || !a.start || !b.start) return false;
  const sharedDays = a.days.filter((d) => b.days.includes(d));
  if (sharedDays.length === 0) return false;
  const aStart = timeStrToMinutes(a.start),
    aEnd = timeStrToMinutes(a.end);
  const bStart = timeStrToMinutes(b.start),
    bEnd = timeStrToMinutes(b.end);
  return aStart < bEnd && bStart < aEnd;
}

function findFirstConflict(courses) {
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      if (sectionsConflict(courses[i], courses[j])) {
        return { a: courses[i], b: courses[j] };
      }
    }
  }
  if (cachedRegisteredTerm === currentTerm) {
    for (const proposed of courses) {
      if (cachedRegisteredCourses.some((r) => r.crn === proposed.crn)) continue;
      for (const registered of cachedRegisteredCourses) {
        if (sectionsConflict(proposed, registered)) {
          return {
            a: proposed,
            b: {
              ...registered,
              course: registered.course + " (already registered)",
            },
          };
        }
      }
    }
  }
  return null;
}

// ============================================================
// CHAT
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
      const planningTerm = currentTerm;
      const relevantRegistered =
        cachedRegisteredTerm === planningTerm ? cachedRegisteredCourses : [];

      console.log(
        "[BobcatPlus] Planning term:",
        planningTerm,
        "| Registered term:",
        cachedRegisteredTerm,
        "| Using registered:",
        relevantRegistered.length,
        "courses",
      );

      const preFiltered = applyPreFilter(compressed, relevantRegistered);

      const registeredBlock =
        relevantRegistered.length > 0
          ? `ALREADY REGISTERED (treat as locked — build around these, never conflict with them):\n${JSON.stringify(relevantRegistered)}\n\n`
          : "";

      console.log(
        "[BobcatPlus] Pre-filter: eligible sections after filter:",
        preFiltered.eligible
          .map((c) => c.course + "(" + c.sections.length + " sections)")
          .join(", "),
      );

      userMessage =
        `${registeredBlock}` +
        `ELIGIBLE COURSES TO SCHEDULE:\n${JSON.stringify(preFiltered)}\n\n` +
        `My preferences: ${input}`;
    } else {
      userMessage = input;
    }

    conversationHistory.push({ role: "user", content: userMessage });

    let validSchedules = [];
    let attempts = 0;
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
          content: `Your previous schedules had time conflicts. Please regenerate all 3 schedules fixing these conflicts: ${conflictDetails}. Double-check every pair of in-person sections that share any day.`,
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
        $("statusBar").textContent = `Conflicts found, retrying...`;
        continue;
      }

      if (conflicted.length > 0) {
        addMessage(
          "system",
          `⚠️ ${conflicted.join(", ")} had time conflicts and were removed. Showing ${validSchedules.length} valid schedule(s).`,
        );
      }

      validSchedules.forEach((schedule) => addScheduleOption(schedule));

      if (validSchedules.length === 0) {
        addMessage(
          "system",
          "Could not generate conflict-free schedules after multiple attempts. Try simplifying your preferences or ask for fewer constraints.",
        );
      }

      if (result.followUpQuestion && validSchedules.length > 0) {
        addMessage("ai", result.followUpQuestion);
      }

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

  const calendarCourses = courses.map((c) => ({
    subject: c.course.split(" ")[0],
    courseNumber: c.course.split(" ")[1],
    crn: c.crn,
    days: c.days,
    beginTime: c.start ? c.start.slice(0, 2) + ":" + c.start.slice(2) : null,
    endTime: c.end ? c.end.slice(0, 2) + ":" + c.end.slice(2) : null,
  }));

  const registeredAsCalendar = cachedRegisteredCourses.map((r) => ({
    subject: r.course.split(" ")[0],
    courseNumber: r.course.split(" ")[1],
    crn: r.crn,
    days: r.days,
    beginTime: r.start ? r.start.slice(0, 2) + ":" + r.start.slice(2) : null,
    endTime: r.end ? r.end.slice(0, 2) + ":" + r.end.slice(2) : null,
  }));
  const fullCalendarCourses = [...registeredAsCalendar, ...calendarCourses];

  const registeredLines = cachedRegisteredCourses
    .map((r) => {
      const time = r.days
        ? r.days.join("/") +
          " " +
          formatChatTime(r.start) +
          "-" +
          formatChatTime(r.end)
        : "Online";
      return (
        '<div style="margin:4px 0;opacity:0.6;border-left:2px solid var(--border);padding-left:6px">' +
        "<strong>" +
        r.course +
        "</strong> - " +
        r.title +
        "<br>" +
        '<span style="font-size:11px">Already registered - ' +
        time +
        "</span>" +
        "</div>"
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
          "-" +
          formatChatTime(c.end);
      return (
        '<div style="margin:4px 0">' +
        "<strong>" +
        c.course +
        "</strong> - " +
        c.title +
        "<br>" +
        '<span style="font-size:11px;opacity:0.8">CRN: ' +
        c.crn +
        " - " +
        time +
        " - " +
        c.requirementSatisfied +
        "</span>" +
        "</div>"
      );
    })
    .join("");

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML =
    '<div class="sender">' +
    name +
    " - " +
    totalCredits +
    " credits</div>" +
    '<div style="font-size:11px;margin-bottom:8px;opacity:0.85">' +
    rationale +
    "</div>" +
    registeredLines +
    courseLines +
    "<br>" +
    '<button class="save-schedule-btn">Save</button>' +
    '<button class="save-schedule-btn preview-btn" style="margin-left:6px">Preview</button>';

  div.querySelector(".save-schedule-btn").addEventListener("click", () => {
    saveSchedule(name, fullCalendarCourses);
    addMessage("system", '"' + name + '" saved.');
  });

  div.querySelector(".preview-btn").addEventListener("click", () => {
    renderSavedScheduleOnCalendar({ name, courses: fullCalendarCourses });
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
// WEEK HOURS
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
  if (el && totalHours > 0) {
    el.innerHTML =
      "<strong>" + totalHours + " credit hours</strong> this semester";
  }
}

// ============================================================
// OVERVIEW PANEL
// ============================================================
function updateOverviewFromEvents(events) {
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

  const panel = document.getElementById("overviewPanel");
  if (!panel) return;

  panel.innerHTML = `
    <div class="ov-row">
      <div class="ov-stat">
        <div class="ov-val">${totalCourses}</div>
        <div class="ov-label">Courses registered</div>
        <div class="ov-sub">${totalHours} credit hours ${onTrackLabel}</div>
      </div>
      ${
        waitlisted.length > 0
          ? `
      <div class="ov-stat">
        <div class="ov-val ov-red">${waitlisted.length}</div>
        <div class="ov-label">Waitlisted</div>
      </div>`
          : ""
      }
    </div>
    <div class="ov-divider"></div>
    <div class="ov-row">
      <div class="ov-stat" style="width:100%">
        <div class="ov-sub" style="font-size:11px;color:var(--text3)">GPA & credits load after degree audit runs</div>
      </div>
    </div>
  `;
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
});
