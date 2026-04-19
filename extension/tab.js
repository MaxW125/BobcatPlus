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
1. A JSON object listing the student's eligible courses — each with a requirement label, 
   course description, and one or more open sections (CRN, days, times, seats, instructor).
2. The student's preferences in natural language (e.g. "no classes before 11am", 
   "I'm interested in public health careers", "I like writing-intensive courses").

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
let conversationHistory = []; // persists for the session
let cachedRawData = null; // holds analysis results across chat turns

let bannerPlans = []; // [{ name: string, crns: string[], planNumber?: string|number|null }]
let registeredScheduleCache = {}; // term → events array

let eligibleCourses = []; // populated by analysis
let expandedCourseKey = null; // which course row is open
let selectedSectionByCourse = {}; // courseKey -> section index
let manualDraft = []; // { key, subject, courseNumber, section }

// ============================================================
// INIT
// ============================================================

(async () => {
  chrome.runtime.sendMessage({ action: "getStudentInfo" }, (student) => {
    if (student) {
      currentStudent = student;
      $("studentName").textContent =
        student.name + " | " + student.major + " | " + student.degree;
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
    loadSchedule(currentTerm);
    loadBannerPlans(currentTerm);
    renderManualDraft();
  });
})();

// ============================================================
// TERM CHANGE
// ============================================================

$("termSelect").addEventListener("change", (e) => {
  currentTerm = e.target.value;
  analysisResults = null;
  cachedRawData = null;
  conversationHistory = []; // reset chat context when term changes
  activeView = "registered";
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
  loadSchedule(currentTerm);
  loadBannerPlans(currentTerm);
});

// ============================================================
// ELIGIBLE COURSES PICKER
// ============================================================

function formatSectionOneLine(section, subject, courseNum) {
  const crn = section.courseReferenceNumber || "?";
  const sn = String(
    section.sequenceNumber ??
      section.sectionNumber ??
      section.section ??
      "?",
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
  const seats = section.seatsAvailable != null ? " · " + section.seatsAvailable + " seats" : "";
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
    if (status) status.textContent = "Click Find to load your eligible courses for this term.";
    return;
  }

  const seenKeys = new Set();
  const dedupedCourses = eligibleCourses.filter((course) => {
    const k = course.subject + "-" + course.courseNumber;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });

  if (status) status.textContent = dedupedCourses.length + " eligible courses — click one to pick a section.";
  list.innerHTML = "";

  dedupedCourses.forEach((course) => {
    const key = course.subject + "-" + course.courseNumber;
    const openCount = (course.sections || []).filter((s) => s.openSection).length;
    const totalCount = (course.sections || []).length;

    const item = document.createElement("div");
    item.className = "eligible-course";

    const header = document.createElement("div");
    header.className = "eligible-course-header";
    header.innerHTML =
      '<span class="eligible-name">' +
      course.subject + " " + course.courseNumber +
      '<span class="eligible-req"> — ' + (course.label || "") + "</span></span>" +
      '<span class="eligible-meta">' + openCount + "/" + totalCount + " open</span>";

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
          '<input type="radio" name="sec-' + key + '" data-idx="' + i + '" ' +
          (i === currentIdx ? "checked" : "") + "> " +
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
        if (!crn) { $("statusBar").textContent = "Section has no CRN."; return; }
        if (manualDraft.some((d) => d.key === crn)) {
          $("statusBar").textContent = "CRN " + crn + " is already in the draft.";
          return;
        }
        manualDraft.push({ key: crn, subject: course.subject, courseNumber: course.courseNumber, section });
        renderManualDraft();
        if (activeView === "draft") { renderDraftOnCalendar(); renderSavedList(); }
        $("statusBar").textContent = "Added " + course.subject + " " + course.courseNumber + " (CRN " + crn + ") to draft.";
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
      if (activeView === "draft") { renderDraftOnCalendar(); renderSavedList(); }
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
  // Reuse cached results if the chat already ran analysis for this term
  if (analysisResults && (analysisResults.eligible || []).length > 0) {
    eligibleCourses = analysisResults.eligible;
    renderEligibleList();
    return;
  }
  $("eligibleStatus").textContent = "Analyzing your degree audit and searching Banner…";
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

  // Save locally so it shows up in the BobcatPlus sidebar.
  const courses = manualDraft.map((d) => {
    const mt = d.section?.meetingsFaculty?.[0]?.meetingTime;
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
    return {
      subject: d.subject,
      courseNumber: d.courseNumber,
      crn: d.key,
      days: days.length ? days : null,
      beginTime,
      endTime,
    };
  });
  const txstPlanNumber = resp.result?.bobcatPlanNumber ?? null;
  saveSchedule(planName, courses, txstPlanNumber);
  // Clear draft state after saving
  manualDraft = [];
  expandedCourseKey = null;
  selectedSectionByCourse = {};
  $("manualPlanName").value = "";
  setManualVisible(false);
  renderManualDraft();
  $("statusBar").textContent = "Saved: " + planName + ".";
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
// REGISTERED SCHEDULE
// ============================================================

$("viewRegistered").addEventListener("click", () => {
  activeView = "registered";
  renderSavedList();
  loadSchedule(currentTerm);
});

function loadSchedule(term) {
  // Serve from cache if available
  if (registeredScheduleCache[term]) {
    const data = registeredScheduleCache[term];
    renderCoursesOnCalendar(data);
    const unique = new Set(data.map((e) => e.crn));
    $("statusBar").textContent = unique.size + " registered courses";
    return;
  }
  $("statusBar").textContent = "Loading schedule...";
  chrome.runtime.sendMessage({ action: "getSchedule", term: term }, (data) => {
    if (activeView !== "registered") return;
    if (data && data.length > 0) {
      registeredScheduleCache[term] = data;
      renderCoursesOnCalendar(data);
      const unique = new Set(data.map((e) => e.crn));
      $("statusBar").textContent = unique.size + " registered courses";
    } else {
      buildEmptyCalendar();
      $("statusBar").textContent = "No registered courses for this term";
    }
  });
}

// ============================================================
// SAVED SCHEDULES
// ============================================================

async function loadBannerPlans(term) {
  const plans = await sendToBackground({ action: "getAllBannerPlans", term });
  // Accept any valid array response, including empty (e.g. all plans deleted)
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
      '<span class="info">' + manualDraft.length + " courses</span>";
    list.appendChild(draftItem);
  }

  if (termSchedules.length === 0 && bannerPlans.length === 0 && activeView !== "draft") {
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
      '">x</span>';

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
      '<span class="name">' + plan.name + "</span>" +
      '<span class="delete-btn txst-delete" title="Delete from TXST">\u00d7</span>';

    // Delete button
    item.querySelector(".txst-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + plan.name + '" from TXST and Bobcat Plus?')) return;
      $("statusBar").textContent = "Deleting " + plan.name + "\u2026";
      const resp = await sendToBackground({
        action: "deleteTxstPlan",
        term: currentTerm,
        planIndex: plan.txstPlanIndex,
      });
      if (!resp.ok) {
        $("statusBar").textContent = "Delete failed: " + (resp.error || "unknown error");
        return;
      }
      // Immediately remove from the local list and re-render
      bannerPlans.splice(pi, 1);
      if (activeView === bannerKey) {
        activeView = "registered";
        loadSchedule(currentTerm);
      }
      renderSavedList();
      $("statusBar").textContent = plan.name + " deleted.";
      // Re-fetch after a short delay so TXST finishes committing the delete
      // before we hit their API again (avoids a session race condition)
      setTimeout(() => loadBannerPlans(currentTerm), 1500);
    });

    item.addEventListener("click", async (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      activeView = bannerKey;
      renderSavedList();

      // If we already have events cached, render immediately
      if (plan.events && plan.events.length > 0) {
        renderCoursesOnCalendar(plan.events);
        $("statusBar").textContent = "Viewing: " + plan.name;
        return;
      }

      // Lazy-load: fetch meeting times for this plan's CRNs via section search
      $("statusBar").textContent = "Loading " + plan.name + "\u2026";
      buildEmptyCalendar();

      const events = await sendToBackground({
        action: "fetchPlanCalendar",
        term: currentTerm,
        planCourses: plan.planCourses || [],
      });

      // Cache on the plan object so subsequent clicks are instant
      plan.events = events || [];

      if (!plan.events.length) {
        buildEmptyCalendar();
        $("statusBar").textContent = plan.name + ": no scheduled meeting times found.";
        return;
      }

      // Only render if user hasn't navigated away while loading
      if (activeView === bannerKey) {
        renderCoursesOnCalendar(plan.events);
        $("statusBar").textContent = "Viewing: " + plan.name;
      }
    });

    list.appendChild(item);
  });

  list.querySelectorAll(".delete-btn").forEach((btn) => {
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
        '<div class="course-title">' + row.subject + " " + row.courseNumber + "</div>" +
        '<div class="course-time">' + timeStr + "</div>" +
        '<div class="course-time">CRN: ' + row.key + "</div>";
      cell.appendChild(block);
    }
  }
  $("statusBar").textContent = manualDraft.length
    ? "Draft: " + manualDraft.length + " course(s) — add more or save."
    : "Draft is empty — pick courses from the list below.";
}

function saveSchedule(name, courses, txstPlanNumber) {
  const schedule = { name, term: currentTerm, courses, created: Date.now(), txstPlanNumber: txstPlanNumber ?? null };
  savedSchedules.push(schedule);
  chrome.storage.local.set({ savedSchedules });
  activeView = savedSchedules.length - 1;
  renderSavedList();
  renderSavedScheduleOnCalendar(schedule);
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

      const block = document.createElement("div");
      block.className = "course-block";
      block.style.top = startOffset + "px";
      block.style.height = height + "px";
      block.innerHTML =
        '<div class="course-title">' +
        course.subject +
        " " +
        course.courseNumber +
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

    const block = document.createElement("div");
    block.className = "course-block";
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

// Convert "1230" string → "12:30 PM" for chat display
function formatChatTime(t) {
  if (!t) return "";
  const h = parseInt(t.slice(0, 2));
  const m = t.slice(2);
  return formatTime24to12(h, parseInt(m));
}

// Convert "1230" string → total minutes (750) for easy comparison
function timeStrToMinutes(t) {
  if (!t) return null;
  return parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(2));
}

// Returns true if two sections overlap on any shared day
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

// Returns the first conflicting pair {a, b} or null if clean
function findFirstConflict(courses) {
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      if (sectionsConflict(courses[i], courses[j])) {
        return { a: courses[i], b: courses[j] };
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

  // Step 1: run analysis if we haven't yet for this term
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

  // Step 2: get API key
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
    // Step 3: build message — inject compressed course data only on first turn
    const isFirstTurn = conversationHistory.length === 0;
    const userMessage = isFirstTurn
      ? `Here are my eligible courses:\n${JSON.stringify(compressForLLM(cachedRawData))}\n\nMy preferences: ${input}`
      : input;

    conversationHistory.push({ role: "user", content: userMessage });

    // Step 4: call OpenAI with up to 2 retry attempts if conflicts are found
    let validSchedules = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 3;
    let lastConflictDetails = [];

    while (validSchedules.length === 0 && attempts < MAX_ATTEMPTS) {
      attempts++;

      // On retry turns, append a correction message explaining exactly what was wrong
      if (attempts > 1) {
        const conflictDetails = lastConflictDetails
          .map(
            (d) =>
              `"${d.name}": ${d.course1} (${d.days1} ${d.start1}-${d.end1}) conflicts with ${d.course2} (${d.days2} ${d.start2}-${d.end2})`,
          )
          .join("; ");
        const retryMsg = {
          role: "user",
          content: `Your previous schedules had time conflicts. Please regenerate all 3 schedules fixing these conflicts: ${conflictDetails}. Double-check every pair of in-person sections that share any day.`,
        };
        conversationHistory.push(retryMsg);
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

      // Step 5: validate conflicts
      const conflicted = [];
      lastConflictDetails = []; // reset each attempt
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
        // lastConflictDetails is used on next loop iteration
        continue;
      }

      // Render whatever is valid
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

      break; // success or gave up
    }

    $("statusBar").textContent = "Ready";
  } catch (err) {
    console.error(err);
    addMessage("system", "Something went wrong: " + err.message);
    $("statusBar").textContent = "Error";
  }
}

// Renders one AI-generated schedule as a chat bubble with Save + Preview buttons
function addScheduleOption(schedule) {
  const { name, rationale, totalCredits, courses } = schedule;

  // Convert LLM format → format renderSavedScheduleOnCalendar expects
  const calendarCourses = courses.map((c) => ({
    subject: c.course.split(" ")[0],
    courseNumber: c.course.split(" ")[1],
    crn: c.crn,
    days: c.days,
    // Convert "1230" → "12:30" for the calendar renderer
    beginTime: c.start ? c.start.slice(0, 2) + ":" + c.start.slice(2) : null,
    endTime: c.end ? c.end.slice(0, 2) + ":" + c.end.slice(2) : null,
  }));

  const courseLines = courses
    .map((c) => {
      const time = c.online
        ? "Online"
        : c.days?.join("/") +
          " " +
          formatChatTime(c.start) +
          "–" +
          formatChatTime(c.end);
      return `<div style="margin:4px 0">
      <strong>${c.course}</strong> — ${c.title}<br>
      <span style="font-size:11px;opacity:0.8">CRN: ${c.crn} · ${time} · ${c.requirementSatisfied}</span>
    </div>`;
    })
    .join("");

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML = `
    <div class="sender">${name} · ${totalCredits} credits</div>
    <div style="font-size:11px;margin-bottom:8px;opacity:0.85">${rationale}</div>
    ${courseLines}
    <br>
    <button class="save-schedule-btn">💾 Save</button>
    <button class="save-schedule-btn preview-btn" style="margin-left:6px">👁 Preview</button>
  `;

  div.querySelector(".save-schedule-btn").addEventListener("click", () => {
    saveSchedule(name, calendarCourses);
    addMessage("system", `"${name}" saved.`);
  });

  div.querySelector(".preview-btn").addEventListener("click", () => {
    renderSavedScheduleOnCalendar({ name, courses: calendarCourses });
  });

  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

// ============================================================
// ANALYSIS RUNNER (talks to background.js)
// ============================================================

function runAnalysisAndWait() {
  return new Promise((resolve) => {
    const results = { eligible: [], blocked: [], notOffered: [], needed: [] };

    const listener = (message) => {
      if (message.type === "status") {
        $("statusBar").textContent = message.message;
      }
      if (message.type === "eligible") {
        results.eligible.push(message.data);
      }
      if (message.type === "blocked") {
        results.blocked.push(message.data);
      }
      if (message.type === "done") {
        chrome.runtime.onMessage.removeListener(listener);
        results.notOffered = message.data.notOffered;
        results.needed = message.data.needed;
        resolve(results);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({
      action: "runAnalysis",
      term: currentTerm,
    });
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
