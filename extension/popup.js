const $ = (id) => document.getElementById(id);

const EMPTY_REG_RECOVER_KEY = "bpRegEmptyRecover:";

/** "plan" = open scheduler tab; "login" = open tab and run SAML there (never auto-open SAML from this popup). */
let planBtnMode = "plan";

// Load student info
chrome.runtime.sendMessage({ action: "getStudentInfo" }, (student) => {
  if (student) {
    $("studentInfo").innerHTML =
      '<div class="name">' +
      student.name +
      "</div>" +
      student.major +
      " | " +
      student.degree;
  } else {
    $("studentInfo").innerHTML = "Not logged in. Please log into TXST first.";
  }
});

// Load terms
chrome.runtime.sendMessage({ action: "getTerms" }, (terms) => {
  if (!terms || terms.length === 0) return;
  const select = $("termSelect");

  // Find current term: most recent non-View Only, non-Correspondence term whose start date has passed
  const now = new Date();
  let currentIdx = 0;
  for (let i = 0; i < terms.length; i++) {
    const desc = String(terms[i].description || "");
    if (/\(view only\)/i.test(desc)) continue;
    if (/correspondence/i.test(desc)) continue;
    // Extract start date from description like "Spring 2026 20-JAN-2026 - 13-MAY-2026"
    const dateMatch = desc.match(/(\d{2}-[A-Z]{3}-\d{4})/);
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

  loadSchedule(terms[currentIdx].code);
});

$("termSelect").addEventListener("change", (e) => {
  loadSchedule(e.target.value);
});

function popupEmptyScheduleHtml() {
  const desc =
    $("termSelect")?.selectedOptions?.[0]?.textContent || "";
  if (/\(view only\)/i.test(desc)) {
    return (
      '<div class="no-schedule">No Banner meetings for this View Only term — pick it in TXST registration first, then open the planner.</div>'
    );
  }
  return (
    '<div class="no-schedule">No Banner meetings for this term (registration may be closed). Try Summer/Fall or open the full planner.</div>'
  );
}

function loadSchedule(term) {
  planBtnMode = "plan";
  $("miniCalendar").innerHTML =
    '<div class="no-schedule">Loading schedule...</div>';
  chrome.runtime.sendMessage({ action: "getSchedule", term: term }, (data) => {
    if (data === null) {
      planBtnMode = "login";
      $("miniCalendar").innerHTML =
        '<div class="no-schedule">Could not load registration — open the planner tab and tap Login.</div>';
      $("planBtn").textContent = "Login";
      return;
    }

    if (!Array.isArray(data) || data.length === 0) {
      planBtnMode = "login";
      $("miniCalendar").innerHTML = popupEmptyScheduleHtml();
      $("planBtn").textContent = "Login";
      return;
    }
    try {
      sessionStorage.removeItem(EMPTY_REG_RECOVER_KEY + term);
    } catch (_) {}
    planBtnMode = "plan";
    renderMiniCalendar(data);
    $("planBtn").textContent = "Plan Semester";
  });
}

function renderMiniCalendar(events) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const buckets = [[], [], [], [], []];

  // Deduplicate by CRN + day
  const seen = new Set();
  for (const event of events) {
    const date = new Date(event.start);
    const dayIdx = date.getDay() - 1; // 0=Mon, 4=Fri
    if (dayIdx < 0 || dayIdx > 4) continue;
    const key = event.crn + "-" + dayIdx;
    if (seen.has(key)) continue;
    seen.add(key);

    const startDate = new Date(event.start);
    const endDate = new Date(event.end);
    const startTime =
      startDate.getHours() +
      ":" +
      String(startDate.getMinutes()).padStart(2, "0");
    const endTime =
      endDate.getHours() + ":" + String(endDate.getMinutes()).padStart(2, "0");

    buckets[dayIdx].push({
      name: event.subject + " " + event.courseNumber,
      courseKey: event.subject + event.courseNumber,
      begin: startTime,
      end: endTime,
    });
  }

  let html = "<table><tr>";
  days.forEach((d) => {
    html += "<th>" + d + "</th>";
  });
  html += "</tr><tr>";
  buckets.forEach((bucket) => {
    html += "<td>";
    bucket.sort((a, b) => a.begin.localeCompare(b.begin));
    bucket.forEach((c) => {
      const chip = getChipForCourse(c.courseKey);
      html +=
        '<div class="course-block ' +
        chip +
        '">' +
        c.name +
        "<br>" +
        formatTime12(c.begin) +
        "-" +
        formatTime12(c.end) +
        "</div>";
    });
    if (bucket.length === 0) html += "&nbsp;";
    html += "</td>";
  });
  html += "</tr></table>";
  $("miniCalendar").innerHTML = html;
}

function formatTime12(t) {
  const parts = t.split(":");
  let h = parseInt(parts[0]);
  const m = parts[1];
  const ampm = h >= 12 ? "p" : "a";
  h = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return h + ":" + m + ampm;
}

// Open full tab (or tab + SAML when schedule did not load)
$("planBtn").addEventListener("click", () => {
  const openLogin = planBtnMode === "login";
  chrome.runtime.sendMessage({ action: "openFullTab", openLogin });
  window.close();
});
