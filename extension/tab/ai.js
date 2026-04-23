// ============================================================
// AI — chat input handling (sendChat), thinking-panel trace,
// applyAction dispatcher, schedule-proposal cards, rejected-
// candidate chips, AI toolbar (lock-all / clear-all), calendar
// block + avoid-day mutators, and the add-block input button.
// ============================================================

import * as State from "./state.js";
import { $ } from "./state.js";
import {
  addMessage, sleep, waitWithChatCountdown,
  removeExistingScheduleRefreshPrompts,
} from "./chat.js";
import {
  renderCalendarFromWorkingCourses,
  formatChatTime,
} from "./calendar.js";
import {
  addToWorkingSchedule, updateSaveBtn,
} from "./schedule.js";
import { runAnalysisAndWait } from "./eligibleList.js";

// Local rejected-candidates memory so chip clicks can skip the LLM round-trip.
const lastRejectedCandidates = new Map();
let chatGeneration = 0;
export function bumpChatGeneration() { return ++chatGeneration; }
export function getChatGeneration() { return chatGeneration; }
export function clearRejectedCandidates() { lastRejectedCandidates.clear(); }

// ── HTML escape (local, identical to chat.js) ────────────

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ── AI toolbar (lock-all + clear-all) ────────────────────

export function renderAIToolbar() {
  const hintEl = $("aiToolbarHint");
  const btn = $("aiLockAllBtn");
  const clearBtn = $("aiClearAllBtn");
  if (!hintEl || !btn) return;

  const total = State.workingCourses.length;
  const locked = State.workingCourses.filter(
    (c) => State.lockedCrns.has(String(c.crn)),
  ).length;
  const unlocked = total - locked;
  const allLocked = total > 0 && locked === total;

  if (total === 0) {
    hintEl.textContent = "Add courses in Build mode first so the AI has something to work around";
    btn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
  } else if (allLocked) {
    hintEl.textContent = "All " + total + " course" + (total !== 1 ? "s" : "") +
      " locked — AI will build around them";
    btn.disabled = true;
    if (clearBtn) clearBtn.disabled = false;
  } else {
    hintEl.textContent = locked > 0
      ? locked + " of " + total + " locked · AI may replace the other " + unlocked
      : unlocked + " course" + (unlocked !== 1 ? "s" : "") +
        " unlocked · AI may replace " + (unlocked !== 1 ? "them" : "it");
    btn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
  }
}

$("aiLockAllBtn")?.addEventListener("click", () => {
  for (const c of State.workingCourses) State.lockedCrns.add(String(c.crn));
  renderCalendarFromWorkingCourses();
});

$("aiClearAllBtn")?.addEventListener("click", () => {
  const removable = State.workingCourses.filter((c) => c.source !== "registered");
  if (!removable.length) return;
  State.setWorkingCourses(
    State.workingCourses.filter((c) => c.source === "registered"),
  );
  State.setLockedCrns(
    new Set([...State.lockedCrns].filter((crn) =>
      State.workingCourses.some((c) => String(c.crn) === crn),
    )),
  );
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
});

// ── calendar blocks + avoid days mutators ────────────────

export function applyNewCalendarBlocks(incoming) {
  if (!incoming || !incoming.length) return;
  State.setCalendarBlocks(window.mergeCalendarBlocks(State.calendarBlocks, incoming));
  chrome.storage.local.set({ calendarBlocks: State.calendarBlocks });
  if (State.studentProfile) State.studentProfile.calendarBlocks = State.calendarBlocks;
  renderCalendarFromWorkingCourses();
}

export function removeCalendarBlock(label) {
  State.setCalendarBlocks(
    State.calendarBlocks.filter(
      (b) => b.label.toLowerCase() !== (label || "").toLowerCase(),
    ),
  );
  chrome.storage.local.set({ calendarBlocks: State.calendarBlocks });
  if (State.studentProfile) State.studentProfile.calendarBlocks = State.calendarBlocks;
  renderCalendarFromWorkingCourses();
}

export function applyNewAvoidDay(day) {
  if (!day || State.avoidDays.includes(day)) return;
  State.setAvoidDays([...State.avoidDays, day]);
  chrome.storage.local.set({ avoidDays: State.avoidDays });
  if (State.studentProfile) State.studentProfile.avoidDays = State.avoidDays;
  renderCalendarFromWorkingCourses();
}

export function removeAvoidDay(day) {
  if (!day || !State.avoidDays.includes(day)) return;
  State.setAvoidDays(State.avoidDays.filter((d) => d !== day));
  chrome.storage.local.set({ avoidDays: State.avoidDays });
  if (State.studentProfile) State.studentProfile.avoidDays = State.avoidDays;
  renderCalendarFromWorkingCourses();
}

// ── credits helpers for locked→LLM + budget math ─────────

function getCreditsForCrn(crn) {
  if (State.cachedRawData?.eligible) {
    for (const course of State.cachedRawData.eligible) {
      const sec = (course.sections || []).find(
        (s) => String(s.courseReferenceNumber) === String(crn),
      );
      if (sec) return sec.creditHourLow ?? 3;
    }
  }
  return 3;
}

function getLockedCredits(lockedList) {
  let total = 0;
  for (const locked of lockedList) {
    let found = false;
    if (State.cachedRawData && State.cachedRawData.eligible) {
      for (const course of State.cachedRawData.eligible) {
        const sec = (course.sections || []).find(
          (s) => String(s.courseReferenceNumber) === String(locked.crn),
        );
        if (sec) { total += sec.creditHourLow ?? 3; found = true; break; }
      }
    }
    if (!found) total += 3;
  }
  return total;
}

function getLockedForLLM() {
  return State.workingCourses
    .filter((c) => State.lockedCrns.has(String(c.crn)))
    .map((c) => ({
      crn: c.crn,
      course: c.subject + " " + c.courseNumber,
      title: c.title || "",
      days: c.days || [],
      start: c.beginTime ? c.beginTime.replace(":", "") : null,
      end: c.endTime ? c.endTime.replace(":", "") : null,
    }));
}

// ── rejected-candidate chips (bypass LLM round-trip) ─────

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
  if (State.cachedRawData?.eligible) {
    for (const course of State.cachedRawData.eligible) {
      const sec = (course.sections || []).find(
        (s) => String(s.courseReferenceNumber) === String(crn),
      );
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
    crn: cand.crn, subject, courseNumber, title,
    days: cand.days || [],
    beginTime: cand.start ? cand.start.slice(0, 2) + ":" + cand.start.slice(2) : null,
    endTime: cand.end ? cand.end.slice(0, 2) + ":" + cand.end.slice(2) : null,
    source: "ai", online, credits,
  });
  addMessage("system", `Added ${cand.course} to your working calendar.`);
  updateSaveBtn();
}

function addSuggestedByReference(ref) {
  if (!ref) return;
  for (const cand of lastRejectedCandidates.values()) {
    if (cand.course === ref) { addCandidateByCrn(cand.crn); return; }
  }
  addMessage("system",
    `Couldn't find "${ref}" in recent suggestions. Click the Add button on the candidate chip instead.`);
}

function renderRejectedCandidates(candidates) {
  if (!candidates || !candidates.length) return;
  candidates.forEach((c) => { if (c.crn) lastRejectedCandidates.set(String(c.crn), c); });
  const div = document.createElement("div");
  div.className = "chat-message ai";
  const details = candidates.map((c) => {
    const time = c.days?.length
      ? c.days.join("/") + " " + formatChatTime(c.start) + "–" + formatChatTime(c.end)
      : "Online";
    return '<div style="font-size:11px;margin:4px 0;opacity:0.85"><strong>' +
      c.course + "</strong> · CRN " + c.crn + " · " + time +
      (c.wouldSatisfy ? ' · <em>' + c.wouldSatisfy + "</em>" : "") +
      (c.reason ? '<br><span style="opacity:0.75">' + c.reason + "</span>" : "") +
      "</div>";
  }).join("");
  const buttons = candidates.map((c) =>
    '<button class="save-schedule-btn add-candidate-btn" data-crn="' + c.crn +
    '" style="margin:4px 4px 0 0">Add ' + c.course + "</button>",
  ).join("");
  div.innerHTML =
    '<div class="sender">Also considered</div>' + details +
    '<div style="margin-top:6px">' + buttons + "</div>";
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

// ── thinking panel (hybrid-pipeline trace) ───────────────

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
  const rows = new Map();

  function statusGlyph(status) {
    if (status === "running") return "⋯";
    if (status === "done") return "✓";
    if (status === "error") return "✗";
    return "•";
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function update(entry) {
    const label = STAGE_LABELS[entry.stage] || entry.stage;
    const summary = entry.summary ? " — " + entry.summary : "";
    const dur = entry.duration != null ? ` (${entry.duration}ms)` : "";
    let html = '<span style="display:inline-block;width:14px">' + statusGlyph(entry.status) + "</span>" +
      "<strong>" + label + "</strong>" + summary + dur +
      (entry.error ? '<br><span style="color:#c44">' + entry.error + "</span>" : "");
    if (entry.rankBreakdown) {
      const body = esc(JSON.stringify(entry.rankBreakdown, null, 2));
      html += '<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;opacity:0.75">rank breakdown (debug)</summary>' +
        '<pre style="font-size:10px;max-height:320px;overflow:auto;background:#111;color:#ddd;padding:6px;border-radius:4px;white-space:pre-wrap">' +
        body + "</pre></details>";
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

// ── action dispatcher ────────────────────────────────────

export function applyAction(action) {
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
      addMessage("system",
        "Calendar block saved: " + b.label + " " + (b.days || []).join("/") + " " + b.start + "–" + b.end);
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
      const prior = State.avoidDays.slice();
      State.setAvoidDays([]);
      chrome.storage.local.set({ avoidDays: State.avoidDays });
      if (State.studentProfile) State.studentProfile.avoidDays = State.avoidDays;
      renderCalendarFromWorkingCourses();
      if (prior.length) addMessage("system", "Reset kept-clear days (was " + prior.join(", ") + ").");
      return "[Reset avoid days]";
    }
    case "lock_course": {
      State.lockedCrns.add(String(action.crn));
      renderCalendarFromWorkingCourses();
      return "[Locked CRN " + action.crn + "]";
    }
    case "unlock_course": {
      State.lockedCrns.delete(String(action.crn));
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

function renderContextRecap(action) {
  if (!action.recap?.trim()) return;
  const conf = typeof action.confidence === "number" ? action.confidence : 1;
  const ambig = action.ambiguities || [];
  const div = document.createElement("div");
  div.className = "chat-message system";
  let html = '<div class="sender">Got it — here\'s what I heard</div>' +
    '<div style="font-size:12px;line-height:1.4">' + escapeHtml(action.recap) + "</div>";
  if (conf < 0.7 || ambig.length) {
    const items = ambig.length
      ? ambig.map((a) => "<li>" + escapeHtml(a) + "</li>").join("")
      : "";
    html += '<div style="font-size:11px;margin-top:6px;opacity:0.8">' +
      (items ? "Not sure about:<ul style=\"margin:4px 0 0 16px\">" + items + "</ul>" : "") +
      (conf < 0.7 ? "<em>Correct me if any of that is off.</em>" : "") +
      "</div>";
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
  div.innerHTML = '<div class="sender">Had to relax some preferences</div>' +
    '<div style="font-size:11px">Couldn\'t satisfy every soft preference at once — here\'s what I gave on:</div>' +
    '<ul style="margin:4px 0 0 16px;font-size:11px">' + items + "</ul>";
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
      return '<div style="font-size:11px;margin:6px 0;border-left:2px solid var(--border);padding-left:6px">' +
        "<strong>" + (i + 1) + ". " + escapeHtml(a.label) + "</strong> — " +
        a.viableCourses + " courses viable · " + a.viableSections + " sections · " +
        a.results + " schedules · " + nodeInfo +
        '<br><span style="opacity:0.7">' + escapeHtml(cons) + "</span>" +
        (elim ? '<br><span style="opacity:0.7">fully eliminated: ' + elim + "</span>" : "") +
        (perCourseTable ? '<br><span style="opacity:0.7;font-family:monospace;font-size:10px">' + perCourseTable + "</span>" : "") +
        "</div>";
    }).join("");
    diagHtml = '<details style="margin-top:8px;font-size:11px"><summary style="cursor:pointer;opacity:0.8">Diagnostics — ' +
      diag.attempts.length + " attempt" + (diag.attempts.length !== 1 ? "s" : "") +
      " across " + diag.eligibleCount + " eligible courses</summary>" + rows + "</details>";
  }

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML = '<div class="sender">No feasible schedule</div>' +
    '<div style="font-size:12px">' + escapeHtml(action.message || "I couldn't find a schedule.") + "</div>" +
    (items ? '<ul style="margin:6px 0 0 16px;font-size:11px">' + items + "</ul>" : "") +
    diagHtml;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function addScheduleOption(schedule) {
  const label = schedule.label || schedule.name || "Schedule";
  const tagline = schedule.tagline || "";
  const rationale = schedule.rationale || "";
  const courses = schedule.courses || [];
  const honored = schedule.honoredPreferences || [];
  const unhonored = schedule.unhonoredPreferences || [];
  const lockedList = getLockedForLLM();

  // Compute credits locally — the AI's totalCredits has proven inaccurate.
  const lockedCr = getLockedCredits(lockedList);
  const newCr = courses.reduce((sum, c) =>
    sum + (typeof c.credits === "number" ? c.credits : 3), 0);
  const displayCredits = lockedCr + newCr;

  const lockedLines = lockedList.map((r) => {
    const time = r.days?.length
      ? r.days.join("/") + " " + formatChatTime(r.start) + "–" + formatChatTime(r.end)
      : "Online";
    return '<div style="margin:4px 0;opacity:0.6;border-left:2px solid var(--border);padding-left:6px"><strong>' +
      escapeHtml(r.course) + "</strong> — " + escapeHtml(r.title || "") +
      '<br><span style="font-size:11px">Locked · ' + escapeHtml(time) + "</span></div>";
  }).join("");
  const courseLines = courses.map((c) => {
    const time = c.online
      ? "Online"
      : (c.days?.join("/") + " " + formatChatTime(c.start) + "–" + formatChatTime(c.end));
    const affinityBadge = typeof c.affinity === "number" && c.affinity >= 0.7
      ? ' <span style="font-size:10px;padding:1px 4px;border-radius:3px;background:var(--accent-soft,#e8f0ff);opacity:0.9" title="' +
        escapeHtml(c.affinityReason || "") + '">★ ' + c.affinity.toFixed(2) + "</span>"
      : "";
    return '<div style="margin:4px 0"><strong>' + escapeHtml(c.course) + "</strong> — " +
      escapeHtml(c.title || "") + affinityBadge +
      '<br><span style="font-size:11px;opacity:0.8">CRN: ' + escapeHtml(String(c.crn)) +
      " · " + escapeHtml(time) +
      (c.requirementSatisfied ? " · " + escapeHtml(c.requirementSatisfied) : "") +
      "</span></div>";
  }).join("");
  const honoredHtml = honored.length
    ? '<div style="font-size:11px;margin:6px 0;opacity:0.85"><strong>Honored:</strong> ' +
      honored.map(escapeHtml).join(" · ") + "</div>"
    : "";
  const unhonoredHtml = unhonored.length
    ? '<div style="font-size:11px;margin:6px 0;color:var(--warn,#b07500)"><strong>Couldn\'t honor:</strong> ' +
      unhonored.map(escapeHtml).join(" · ") + "</div>"
    : "";
  const taglineHtml = tagline
    ? '<div style="font-size:11px;font-style:italic;opacity:0.75;margin-bottom:4px">' +
      escapeHtml(tagline) + "</div>"
    : "";

  const div = document.createElement("div");
  div.className = "chat-message ai";
  div.innerHTML =
    '<div class="sender">' + escapeHtml(label) + " · " + displayCredits + " credits</div>" +
    taglineHtml +
    '<div style="font-size:12px;margin-bottom:6px">' + escapeHtml(rationale) + "</div>" +
    honoredHtml + unhonoredHtml + lockedLines + courseLines + "<br>" +
    '<button class="save-schedule-btn add-to-calendar-btn">Add to Calendar</button>' +
    '<button class="save-schedule-btn lock-all-btn" style="margin-left:6px">Lock All</button>';
  div.querySelector(".add-to-calendar-btn").addEventListener("click", (e) => {
    for (const c of courses) {
      addToWorkingSchedule({
        crn: c.crn,
        subject: c.course.split(" ")[0],
        courseNumber: c.course.split(" ")[1],
        title: c.title,
        days: c.days || [],
        beginTime: c.start ? c.start.slice(0, 2) + ":" + c.start.slice(2) : null,
        endTime: c.end ? c.end.slice(0, 2) + ":" + c.end.slice(2) : null,
        source: "ai",
        online: c.online || false,
      });
    }
    updateSaveBtn();
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = "Added";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  });
  div.querySelector(".lock-all-btn").addEventListener("click", (e) => {
    for (const c of courses) State.lockedCrns.add(c.crn);
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

// ── main chat send ───────────────────────────────────────

async function sendChat() {
  const input = $("chatInput").value.trim();
  if (!input) return;
  // Lazy import to avoid circular dep (overview imports eligibleList; ai would
  // pull overview for setPanelMode, and overview pulls schedule + eligible).
  const { setPanelMode } = await import("./overview.js");
  if (State.panelMode !== "ai") setPanelMode("ai");
  addMessage("user", input);
  $("chatInput").value = "";

  if (!State.analysisResults) {
    addMessage("system",
      "Analyzing your degree audit and finding eligible courses. This may take a minute...");
    $("statusBar").textContent = "Running analysis...";
    const analysisResults = await runAnalysisAndWait();
    State.setAnalysisResults(analysisResults);
    if (analysisResults._skippedStaleTerm) {
      addMessage("system", "The term changed while loading. Send your message again.");
      $("statusBar").textContent = "";
      return;
    }
    State.setCachedRawData(analysisResults);
    State.setEligibleCourses(analysisResults.eligible || []);
    if (!analysisResults.eligible || !analysisResults.eligible.length) {
      addMessage("system",
        "No eligible courses were found for this term. This usually means your DegreeWorks audit hasn't loaded yet, or every remaining requirement is already satisfied. Try refreshing the Build panel.");
      $("statusBar").textContent = "No eligible courses found";
      return;
    }
    addMessage("system",
      `Found ${analysisResults.eligible.length} eligible courses. Sending to AI...`);
  }

  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  if (!openaiKey) {
    addMessage("system",
      "No OpenAI API key is configured for this extension. Open the browser console on this page and run:\n\nchrome.storage.local.set({ openaiKey: \"sk-...\" })\n\nThen reload the page and try again.");
    return;
  }

  // Generation counter: if a later sendChat starts OR the term changes while
  // this turn is in flight, bail before dispatching any actions so we never
  // mutate the UI for a stale term.
  const myGen = ++chatGeneration;
  const termAtStart = State.currentTerm;
  const stale = () => chatGeneration !== myGen || State.currentTerm !== termAtStart;

  $("statusBar").textContent = "Thinking…";
  const thinking = createThinkingPanel();

  try {
    const lockedList = getLockedForLLM();
    const lockedCourses = lockedList.map((c) => ({
      ...c, credits: getCreditsForCrn(c.crn),
    }));

    const profile = State.studentProfile || window.buildStudentProfile({
      name: State.currentStudent?.name || "Student",
      major: (State.currentStudent?.major || "") +
        (State.currentStudent?.degree ? " — " + State.currentStudent.degree : ""),
      classification: State.currentStudent?.classification || "Unknown",
      catalogYear: new Date().getFullYear(),
      completedHours: null, remainingHours: null,
      calendarBlocks: State.calendarBlocks,
      avoidDays: State.avoidDays,
    });
    profile.calendarBlocks = State.calendarBlocks;
    profile.avoidDays = State.avoidDays;

    const { actions, updatedProfile } = await window.handleUserTurn({
      userMessage: input,
      rawData: State.cachedRawData,
      studentProfile: profile,
      conversationHistory: State.conversationHistory,
      lockedCourses,
      ragChunks: [],
      apiKey: openaiKey,
      onTrace: (entry) => { if (!stale()) thinking.update(entry); },
    });

    thinking.finalize();
    if (stale()) return;

    State.conversationHistory.push({ role: "user", content: input });

    const assistantParts = [];
    for (const action of actions) {
      if (stale()) return;
      const summary = applyAction(action);
      if (summary) assistantParts.push(summary);
    }
    if (assistantParts.length) {
      State.conversationHistory.push({ role: "assistant", content: assistantParts.join("\n") });
    }

    if (State.studentProfile) {
      State.studentProfile.calendarBlocks = updatedProfile.calendarBlocks;
      State.studentProfile.avoidDays = updatedProfile.avoidDays;
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

// ── chat-input wiring ────────────────────────────────────

$("chatSend")?.addEventListener("click", sendChat);
$("chatInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Re-export a few chat utilities that auth.js expects without adding
// another import layer (auth already imports from chat.js directly).
export { addMessage, waitWithChatCountdown, sleep, removeExistingScheduleRefreshPrompts };
