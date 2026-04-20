const $ = (id) => document.getElementById(id);

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

  // Find current term: most recent non-View Only term whose start date has passed
  const now = new Date();
  let currentIdx = 0;
  for (let i = 0; i < terms.length; i++) {
    // Extract start date from description like "Spring 2026 20-JAN-2026 - 13-MAY-2026"
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

  loadSchedule(terms[currentIdx].code);
});

$("termSelect").addEventListener("change", (e) => {
  loadSchedule(e.target.value);
});

function loadSchedule(term) {
  $("miniCalendar").innerHTML =
    '<div class="no-schedule">Loading schedule...</div>';
  chrome.runtime.sendMessage({ action: "getSchedule", term: term }, (data) => {
    if (!data || data.length === 0) {
      $("miniCalendar").innerHTML =
        '<div class="no-schedule">No registered courses for this term</div>';
      $("planBtn").textContent = "Plan This Semester";
      return;
    }
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

// Open full tab
$("planBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openFullTab" });
  window.close();
});
