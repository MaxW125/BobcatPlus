// ============================================================
// STATE — shared page-context state cells, DOM helpers,
// registration-events disk cache, calendar-meta map.
// All mutable UI state lives here so sibling modules can
// share one source of truth without circular imports.
// ============================================================

export const $ = (id) => document.getElementById(id);
export function sendToBackground(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

// ── student + profile ────────────────────────────────────
export let currentStudent = null;
export function setCurrentStudent(v) { currentStudent = v; }
export let studentProfile = null;
export function setStudentProfile(v) { studentProfile = v; }
export let degreeAuditSnapshot = null;
export function setDegreeAuditSnapshot(v) { degreeAuditSnapshot = v; }

// ── persisted preferences ────────────────────────────────
export let calendarBlocks = [];
export function setCalendarBlocks(v) { calendarBlocks = v; }
export let avoidDays = [];
export function setAvoidDays(v) { avoidDays = v; }

// ── term + generation counters ───────────────────────────
export let currentTerm = null;
export function setCurrentTerm(v) { currentTerm = v; }
export let termDescriptionsByCode = Object.create(null);
export function setTermDescriptionsByCode(v) { termDescriptionsByCode = v; }

export let termChangeGeneration = 0;
export function bumpTermChangeGeneration() { return ++termChangeGeneration; }
export function getTermChangeGeneration() { return termChangeGeneration; }

export let scheduleFetchGeneration = 0;
export function bumpScheduleFetchGeneration() { return ++scheduleFetchGeneration; }
export function getScheduleFetchGeneration() { return scheduleFetchGeneration; }

export let scheduleViewGeneration = 0;
export function bumpScheduleViewGeneration() { return ++scheduleViewGeneration; }
export function getScheduleViewGeneration() { return scheduleViewGeneration; }

// ── analysis / eligible cache ────────────────────────────
export let analysisResults = null;
export function setAnalysisResults(v) { analysisResults = v; }
export let cachedRawData = null;
export function setCachedRawData(v) { cachedRawData = v; }
export let cachedOverviewEvents = [];
export function setCachedOverviewEvents(v) { cachedOverviewEvents = v; }

// ── registered schedule cache ────────────────────────────
export let cachedRegisteredCourses = [];
export function setCachedRegisteredCourses(v) { cachedRegisteredCourses = v; }
export let cachedRegisteredTerm = null;
export function setCachedRegisteredTerm(v) { cachedRegisteredTerm = v; }
export let registeredFetchCompleted = false;
export function setRegisteredFetchCompleted(v) { registeredFetchCompleted = v; }
export let registeredFetchOk = false;
export function setRegisteredFetchOk(v) { registeredFetchOk = v; }
export let registeredScheduleCache = {};
export function setRegisteredScheduleCache(v) { registeredScheduleCache = v; }

// ── saved / banner plans ─────────────────────────────────
export let savedSchedules = [];
export function setSavedSchedules(v) { savedSchedules = v; }
export let bannerPlans = [];
export function setBannerPlans(v) { bannerPlans = v; }
export let conversationHistory = [];
export function setConversationHistory(v) { conversationHistory = v; }

// ── eligible list view ───────────────────────────────────
export let eligibleCourses = [];
export function setEligibleCourses(v) { eligibleCourses = v; }
export let showOpenSeatsOnly = false;
export function setShowOpenSeatsOnly(v) { showOpenSeatsOnly = v; }
export let expandedCourseKey = null;
export function setExpandedCourseKey(v) { expandedCourseKey = v; }

// ── working schedule ─────────────────────────────────────
export let workingCourses = [];
export function setWorkingCourses(v) { workingCourses = v; }
export let lockedCrns = new Set();
export function setLockedCrns(v) { lockedCrns = v; }

// ── UI mode ──────────────────────────────────────────────
export let panelMode = "build";
export function setPanelModeState(v) { panelMode = v; }
export let schedulesCollapsed = false;
export function setSchedulesCollapsed(v) { schedulesCollapsed = v; }
export let activeScheduleKey = "registered";
export function setActiveScheduleKey(v) { activeScheduleKey = v; }
export let newPlanDisplayName = "";
export function setNewPlanDisplayName(v) { newPlanDisplayName = v; }
export let newPlanSingleClickOpensEdit = true;
export function setNewPlanSingleClickOpensEdit(v) { newPlanSingleClickOpensEdit = v; }
export let newPlanClickTimer = null;
export function setNewPlanClickTimer(v) { newPlanClickTimer = v; }

// ── calendar geometry ────────────────────────────────────
export const START_HOUR = 7;
export const END_HOUR = 22;
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const PX_STEPS = [30, 38, 52, 68]; // zoom levels: -2 → +1
export let PX_PER_HOUR = 52;
export function setPxPerHour(v) { PX_PER_HOUR = v; }

// ── modal metadata ───────────────────────────────────────
export const calendarCourseMetaByCrn = new Map();
export function clearCalendarCourseMeta() { calendarCourseMetaByCrn.clear(); }
export function registerCourseMeta(crn, meta) {
  if (crn && meta) calendarCourseMetaByCrn.set(String(crn), meta);
}

// ── registration events persistence (chrome.storage.local) ──
const REG_EVENTS_STORAGE_KEY = "bobcatRegEventsCache";
export function persistRegistrationEvents(term, events) {
  if (!term || !Array.isArray(events) || !events.length) return;
  try {
    chrome.storage.local.set({
      [REG_EVENTS_STORAGE_KEY]: { term: String(term), events, savedAt: Date.now() },
    });
  } catch (_) {}
}
export function loadCachedRegistrationEvents(term) {
  return new Promise((resolve) => {
    chrome.storage.local.get(REG_EVENTS_STORAGE_KEY, (obj) => {
      const c = obj[REG_EVENTS_STORAGE_KEY];
      if (c && String(c.term) === String(term) && Array.isArray(c.events) && c.events.length) {
        resolve(c.events);
        return;
      }
      resolve(null);
    });
  });
}

// ── empty-registration recovery sessionStorage keys ──────
export const EMPTY_REG_RECOVER_KEY = "bpRegEmptyRecover:";
export const SKIP_EMPTY_RECOVER_ONCE = "bpSkipEmptyRecoverOnce";
export function clearEmptyRegistrationRecoverFlag(term) {
  try { sessionStorage.removeItem(EMPTY_REG_RECOVER_KEY + term); } catch (_) {}
}
