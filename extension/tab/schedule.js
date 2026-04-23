// ============================================================
// SCHEDULE — working-schedule mutators (add/remove/lock),
// saved / Banner Plan list rendering, "+ New Plan" row flow,
// and the TXST save button wiring.
// ============================================================

import * as State from "./state.js";
import {
  $, sendToBackground,
  setWorkingCourses, setLockedCrns, setActiveScheduleKey,
  setNewPlanDisplayName, setNewPlanSingleClickOpensEdit, setNewPlanClickTimer,
  setBannerPlans, setSavedSchedules,
  bumpScheduleViewGeneration, getScheduleViewGeneration,
} from "./state.js";
import {
  buildEmptyCalendar, renderCalendarFromWorkingCourses,
} from "./calendar.js";
import { buildRegisteredCoursesFromEvents } from "./auth.js";
import { updateWeekHours, updateWeekHoursFromWorking } from "./overview.js";

// ── working-schedule mutators ────────────────────────────

export function addToWorkingSchedule(entry) {
  const crn = String(entry.crn);
  // If replacing a section of the same course (different CRN), transfer the lock
  // so "Replace on calendar" doesn't silently drop a lock the user set.
  const displaced = State.workingCourses.find(
    (c) => c.subject === entry.subject && c.courseNumber === entry.courseNumber && String(c.crn) !== crn,
  );
  if (displaced && State.lockedCrns.has(String(displaced.crn))) {
    State.lockedCrns.delete(String(displaced.crn));
    State.lockedCrns.add(crn);
  }
  setWorkingCourses([
    ...State.workingCourses.filter((c) => String(c.crn) !== crn),
    { ...entry, crn },
  ]);
  renderCalendarFromWorkingCourses();
  updateWeekHoursFromWorking();
  updateSaveBtn();
}

export function removeFromWorkingSchedule(crn) {
  const k = String(crn);
  setWorkingCourses(State.workingCourses.filter((c) => String(c.crn) !== k));
  State.lockedCrns.delete(k);
  renderCalendarFromWorkingCourses();
  updateWeekHoursFromWorking();
  updateSaveBtn();
}

export function toggleLock(crn) {
  const k = String(crn);
  if (State.lockedCrns.has(k)) State.lockedCrns.delete(k);
  else State.lockedCrns.add(k);
  renderCalendarFromWorkingCourses();
}

export function updateSaveBtn() {
  const saveBtn = $("saveTxstBtn");
  if (!saveBtn) return;
  const hasNonRegistered = State.workingCourses.some((c) => c.source !== "registered");
  saveBtn.classList.toggle("txst-save-btn--dim", !hasNonRegistered);
  saveBtn.disabled = !hasNonRegistered;
}

// ── "New Plan" row flow ──────────────────────────────────

export function activateNewPlanRow() {
  if (State.activeScheduleKey === "new") return;
  bumpScheduleViewGeneration();
  setActiveScheduleKey("new");
  setWorkingCourses([]);
  setLockedCrns(new Set());
  renderCalendarFromWorkingCourses();
  updateSaveBtn();
  renderSavedList();
}

export function enterNewPlanEditMode() {
  const row = document.querySelector(".saved-item-new-plan");
  if (!row || row.querySelector(".new-plan-input")) return;
  if (State.activeScheduleKey !== "new") {
    bumpScheduleViewGeneration();
    setActiveScheduleKey("new");
    setWorkingCourses([]);
    setLockedCrns(new Set());
    renderCalendarFromWorkingCourses();
    updateSaveBtn();
  }
  document.querySelectorAll("#savedList .saved-item").forEach((el) =>
    el.classList.toggle("active", el.classList.contains("saved-item-new-plan")),
  );
  const span = row.querySelector(".new-plan-label");
  if (!span) return;
  span.style.display = "none";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "new-plan-input";
  input.autocomplete = "off";
  input.value = State.newPlanDisplayName;
  row.appendChild(input);
  requestAnimationFrame(() => { input.focus(); input.select(); });
  const commit = () => {
    setNewPlanDisplayName(input.value.trim());
    span.textContent = State.newPlanDisplayName || "New Plan";
    span.style.display = "";
    input.remove();
    row.dataset.planName = State.newPlanDisplayName;
    const saveBtn = $("saveTxstBtn");
    if (saveBtn) saveBtn.dataset.planName = State.newPlanDisplayName;
    setNewPlanSingleClickOpensEdit(false);
    renderSavedList();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { input.value = State.newPlanDisplayName; input.blur(); }
  });
}

// ── local save ───────────────────────────────────────────

export function saveSchedule(name, courses, txstPlanNumber) {
  const schedule = {
    name,
    term: State.currentTerm,
    courses,
    created: Date.now(),
    txstPlanNumber: txstPlanNumber ?? null,
  };
  setSavedSchedules([...State.savedSchedules, schedule]);
  chrome.storage.local.set({ savedSchedules: State.savedSchedules });
  renderSavedList();
  renderSavedScheduleOnCalendar(schedule);
}

// ── Banner plans (remote list) ───────────────────────────

export async function loadBannerPlans(term) {
  const plans = await sendToBackground({ action: "getAllBannerPlans", term });
  if (State.currentTerm !== term) return;
  if (Array.isArray(plans)) {
    setBannerPlans(plans);
    renderSavedList();
  }
  $("statusBar").textContent = "Ready";
}

// ── saved list (registered + local + TXST + new-plan row) ──

export function renderSavedList() {
  const list = $("savedList");
  if (!list) return;
  const termSchedules = State.savedSchedules.filter((s) => s.term === State.currentTerm);
  list.innerHTML = "";

  // Current registered schedule
  const regItem = document.createElement("div");
  regItem.className = "saved-item saved-item-registered" +
    (State.activeScheduleKey === "registered" ? " active" : "");
  regItem.innerHTML = '<span class="name">Current Registered Schedule</span>';
  regItem.addEventListener("click", () => {
    bumpScheduleViewGeneration();
    setActiveScheduleKey("registered");
    const cached = State.registeredScheduleCache[State.currentTerm];
    if (cached && cached.length) {
      const { registered, locks } = buildRegisteredCoursesFromEvents(cached);
      setLockedCrns(locks);
      setWorkingCourses(registered);
      updateWeekHours(cached);
    } else {
      setWorkingCourses(State.workingCourses.filter((c) => c.source === "registered"));
      setLockedCrns(new Set(State.workingCourses.map((c) => String(c.crn))));
      updateWeekHours(State.workingCourses);
    }
    renderCalendarFromWorkingCourses();
    renderSavedList();
    $("statusBar").textContent = "Viewing registered schedule";
    updateSaveBtn();
  });
  list.appendChild(regItem);

  // Locally saved AI schedules
  termSchedules.forEach((schedule, i) => {
    const key = "saved:" + i;
    const item = document.createElement("div");
    item.className = "saved-item" + (State.activeScheduleKey === key ? " active" : "");
    const courses = schedule.courses || [];
    const totalCredits = courses.reduce((sum, c) => sum + (c.credits || 3), 0);
    const pillLabels = courses.slice(0, 3).map((c) =>
      '<span class="sched-pill">' +
      (c.course || ((c.subject || "") + " " + (c.courseNumber || ""))).trim() +
      "</span>",
    ).join("");
    const overflowPill = courses.length > 3
      ? '<span class="sched-pill-more">+' + (courses.length - 3) + "</span>"
      : "";
    item.innerHTML =
      '<div class="sched-item-top"><span class="name">' + schedule.name +
      '</span><div class="sched-item-actions"><span class="info">' + totalCredits +
      ' cr</span><span class="delete-btn" data-key="' + key + '" data-idx="' + i + '">×</span></div></div>' +
      (courses.length ? '<div class="sched-pills">' + pillLabels + overflowPill + "</div>" : "");
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      bumpScheduleViewGeneration();
      setActiveScheduleKey(key);
      renderSavedScheduleOnCalendar(schedule);
      renderSavedList();
    });
    list.appendChild(item);
  });

  // TXST Banner plans
  State.bannerPlans.forEach((plan, pi) => {
    const key = "banner:" + pi;
    const item = document.createElement("div");
    item.className = "saved-item" + (State.activeScheduleKey === key ? " active" : "");
    const pc = plan.planCourses || [];
    const planPillLabels = pc.slice(0, 3).map((c) =>
      '<span class="sched-pill">' + ((c.subject || "") + " " + (c.courseNumber || "")).trim() + "</span>",
    ).join("");
    const planOverflow = pc.length > 3
      ? '<span class="sched-pill-more">+' + (pc.length - 3) + "</span>"
      : "";
    item.innerHTML =
      '<div class="sched-item-top"><span><span class="banner-badge">TXST</span><span class="name">' +
      plan.name +
      '</span></span><span class="delete-btn txst-delete" title="Delete from TXST">×</span></div>' +
      (pc.length ? '<div class="sched-pills">' + planPillLabels + planOverflow + "</div>" : "");
    item.querySelector(".txst-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + plan.name + '" from TXST?')) return;
      $("statusBar").textContent = "Deleting " + plan.name + "…";
      const resp = await sendToBackground({
        action: "deleteTxstPlan", term: State.currentTerm, planIndex: plan.txstPlanIndex,
      });
      if (!resp.ok) {
        $("statusBar").textContent = "Delete failed: " + (resp.error || "unknown");
        return;
      }
      State.bannerPlans.splice(pi, 1);
      if (State.activeScheduleKey === key) {
        setActiveScheduleKey("registered");
        setWorkingCourses(State.workingCourses.filter((c) => c.source === "registered"));
        renderCalendarFromWorkingCourses();
      }
      renderSavedList();
      $("statusBar").textContent = plan.name + " deleted.";
      setTimeout(() => loadBannerPlans(State.currentTerm), 1500);
    });
    item.addEventListener("click", async (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      const viewGen = bumpScheduleViewGeneration();
      setActiveScheduleKey(key);
      renderSavedList();
      try {
        if (!plan.events || !plan.events.length) {
          $("statusBar").textContent = "Loading " + plan.name + "…";
          const events = await sendToBackground({
            action: "fetchPlanCalendar", term: State.currentTerm, planCourses: plan.planCourses || [],
          });
          if (viewGen !== getScheduleViewGeneration()) return;
          plan.events = events || [];
          if (!plan.events.length) {
            buildEmptyCalendar();
            $("statusBar").textContent = plan.name + ": no meeting times found.";
            return;
          }
        }
        if (viewGen !== getScheduleViewGeneration()) return;
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
            beginTime = String(bh).padStart(2, "0") + ":" + String(bm).padStart(2, "0");
            endTime = String(eh).padStart(2, "0") + ":" + String(em).padStart(2, "0");
          }
          const isOnline = !!(event.online || !event.start);
          if (existing) {
            if (day && !existing.days.includes(day)) existing.days.push(day);
          } else {
            acc.push({
              crn, subject: event.subject || "", courseNumber: event.courseNumber || "",
              title: event.title || "", days: day ? [day] : [], beginTime, endTime,
              source: "banner", online: isOnline,
            });
          }
          return acc;
        }, []);
        if (viewGen !== getScheduleViewGeneration()) return;
        setWorkingCourses(planCourses);
        setLockedCrns(new Set());
        renderCalendarFromWorkingCourses();
        updateWeekHours(plan.events);
        $("statusBar").textContent = "Viewing: " + plan.name;
      } catch (err) {
        console.error("[BobcatPlus] banner plan load:", err);
        if (viewGen === getScheduleViewGeneration()) {
          $("statusBar").textContent = "Could not load plan. Try again.";
        }
      }
    });
    list.appendChild(item);
  });

  // "+ New Plan" — always last
  const newPlanItem = document.createElement("div");
  newPlanItem.className =
    "saved-item saved-item-new-plan" + (State.activeScheduleKey === "new" ? " active" : "");
  newPlanItem.dataset.planName = State.newPlanDisplayName;
  const newPlanSpan = document.createElement("span");
  newPlanSpan.className = "new-plan-label";
  newPlanSpan.textContent = State.newPlanDisplayName || "New Plan";
  newPlanItem.appendChild(newPlanSpan);
  newPlanItem.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (State.newPlanSingleClickOpensEdit) { enterNewPlanEditMode(); return; }
    clearTimeout(State.newPlanClickTimer);
    setNewPlanClickTimer(setTimeout(() => {
      setNewPlanClickTimer(null);
      activateNewPlanRow();
    }, 280));
  });
  newPlanItem.addEventListener("dblclick", (e) => {
    if (e.target.tagName === "INPUT") return;
    e.preventDefault();
    clearTimeout(State.newPlanClickTimer);
    setNewPlanClickTimer(null);
    enterNewPlanEditMode();
  });
  list.appendChild(newPlanItem);

  list.querySelectorAll(".delete-btn:not(.txst-delete)").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      State.savedSchedules.splice(idx, 1);
      chrome.storage.local.set({ savedSchedules: State.savedSchedules });
      if (State.activeScheduleKey === btn.dataset.key) {
        setActiveScheduleKey("registered");
        setWorkingCourses(State.workingCourses.filter((c) => c.source === "registered"));
        renderCalendarFromWorkingCourses();
      }
      renderSavedList();
    });
  });
}

export function renderSavedScheduleOnCalendar(schedule) {
  const fromSaved = (schedule.courses || []).map((c) => ({
    ...c, crn: String(c.crn ?? ""), source: "saved",
  }));
  setLockedCrns(new Set());
  setWorkingCourses([
    ...State.workingCourses.filter((c) => c.source === "registered"),
    ...fromSaved.filter((c) =>
      !State.workingCourses.some((w) => String(w.crn) === c.crn),
    ),
  ]);
  renderCalendarFromWorkingCourses();
  updateWeekHours(State.workingCourses);
  updateSaveBtn();
  $("statusBar").textContent = "Viewing: " + schedule.name;
}

// ── "Save to TXST" button wiring ─────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const saveTxstBtn = $("saveTxstBtn");
  if (!saveTxstBtn) return;
  saveTxstBtn.addEventListener("click", async () => {
    if (saveTxstBtn.disabled) return;
    const newPlanItems = document.querySelectorAll(".saved-item-new-plan");
    let planName = "";
    newPlanItems.forEach((el) => { if (el.dataset.planName) planName = el.dataset.planName.trim(); });
    if (!planName) planName = State.newPlanDisplayName;
    if (!planName) {
      const newPlanLabel = document.querySelector(".new-plan-label");
      if (newPlanLabel) {
        newPlanLabel.style.color = "var(--maroon)";
        newPlanLabel.textContent = "Name your plan (click New Plan)";
        setTimeout(() => {
          newPlanLabel.style.color = "";
          newPlanLabel.textContent = State.newPlanDisplayName || "New Plan";
        }, 2500);
      }
      $("statusBar").textContent = "Click New Plan to enter a name first.";
      return;
    }
    const nonRegistered = State.workingCourses.filter((c) => c.source !== "registered");
    if (!nonRegistered.length) {
      $("statusBar").textContent = "Add courses before saving.";
      return;
    }
    $("statusBar").textContent = "Saving to TXST…";
    saveTxstBtn.disabled = true;
    const rows = nonRegistered.map((c) => {
      const courseMatch = (State.eligibleCourses || []).find(
        (ec) => ec.subject === c.subject && ec.courseNumber === c.courseNumber,
      );
      const section = courseMatch?.sections?.find(
        (s) => String(s.courseReferenceNumber) === c.crn,
      );
      return {
        section: section || { courseReferenceNumber: c.crn, courseTitle: c.title },
        subject: c.subject,
        courseNumber: c.courseNumber,
      };
    });
    const resp = await sendToBackground({
      action: "saveTxstPlan", term: State.currentTerm, planName, rows,
    });
    saveTxstBtn.disabled = false;
    updateSaveBtn();
    if (!resp.ok) { $("statusBar").textContent = resp.error || "Save failed."; return; }
    $("statusBar").textContent = "Saved to TXST: " + planName;
    setNewPlanDisplayName("");
    setNewPlanSingleClickOpensEdit(true);
    document.querySelectorAll(".saved-item-new-plan").forEach((el) => {
      el.dataset.planName = "";
      const lbl = el.querySelector(".new-plan-label");
      if (lbl) lbl.textContent = "New Plan";
    });
    if (saveTxstBtn) saveTxstBtn.dataset.planName = "";
    await loadBannerPlans(State.currentTerm);
    renderSavedList();
  });
});
