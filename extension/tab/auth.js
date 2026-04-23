// ============================================================
// AUTH — DegreeWorks+Banner session probe, SAML handshake
// helpers, per-tab registration-fetch queue, loadSchedule (the
// registered-courses import), the Import-Schedule button
// listener, and the auto-login recovery paths.
// ============================================================

import * as State from "./state.js";
import { $, registerCourseMeta } from "./state.js";
import { addMessage, waitWithChatCountdown } from "./chat.js";
import {
  buildEmptyCalendar, renderCalendarFromWorkingCourses,
} from "./calendar.js";
import { renderSavedList, updateSaveBtn } from "./schedule.js";
import {
  updateWeekHours, updateOverviewFromEvents,
} from "./overview.js";
import {
  expandRegistrationEvent, groupRegistrationEventsByCrn,
  extractMetaFromRegistrationEvent, normalizeRegistrationEventsPayload,
} from "./modal.js";
import { autoLoadEligibleCourses } from "./eligibleList.js";

// ── session probe ────────────────────────────────────────

export async function checkAuth() {
  try {
    const [dwRes, regRes] = await Promise.all([
      fetch("https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself",
        { credentials: "include" }),
      fetch("https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=1",
        { credentials: "include" }),
    ]);
    return dwRes.ok && regRes.ok;
  } catch (e) {
    return false;
  }
}

// ── auto-login recovery ──────────────────────────────────

let autoLoginInFlight = false;
let lastAutoLoginAt = 0;
let autoLoginAttempts = 0;

export function maybeAutoLogin(reason = "", termForProbe) {
  const now = Date.now();
  // Prevent login-popup thrash loops (open/close/open/close...).
  if (autoLoginInFlight) return;
  if (now - lastAutoLoginAt < 45_000) return;
  if (autoLoginAttempts >= 2) return;
  autoLoginInFlight = true;
  lastAutoLoginAt = now;
  autoLoginAttempts++;
  const t = termForProbe != null ? termForProbe : State.currentTerm;
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
          $("statusBar").textContent =
            "Still signed out — click Import Schedule to log in.";
          return;
        }
        State.setAnalysisResults(null);
        State.setCachedRawData(null);
        State.setCachedRegisteredCourses([]);
        State.setCachedRegisteredTerm(null);
        State.setConversationHistory([]);
        await waitWithChatCountdown(1);
        const result = await loadSchedule(State.currentTerm);
        if (result && result.authRequired) {
          $("statusBar").textContent =
            "Login didn't stick — open TXST in a normal tab, sign in, then click Import Schedule.";
          return;
        }
        autoLoadEligibleCourses({ forceRefresh: true });
      })().catch(() => {});
    }
    if (msg.type === "loginCancelled") {
      chrome.runtime.onMessage.removeListener(listener);
      autoLoginInFlight = false;
      $("statusBar").textContent =
        "Login cancelled — click Import Schedule to try again.";
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  if (reason) $("statusBar").textContent = reason;
}

/** When Banner returns JSON but zero events while DegreeWorks looks signed in —
    stale registration session — try to refresh. */
async function maybeRecoverEmptyRegistration(term, fromDiskCache) {
  if (fromDiskCache) return;
  try {
    if (sessionStorage.getItem(State.SKIP_EMPTY_RECOVER_ONCE)) {
      sessionStorage.removeItem(State.SKIP_EMPTY_RECOVER_ONCE);
      return;
    }
  } catch (_) {}
  try {
    if (sessionStorage.getItem(State.EMPTY_REG_RECOVER_KEY + term)) return;
  } catch (_) {}
  const ok = await checkAuth();
  if (!ok) return;
  try {
    sessionStorage.setItem(State.EMPTY_REG_RECOVER_KEY + term, "1");
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

// ── SAML / fetch helpers ─────────────────────────────────

function waitAnimationFrames(n) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => requestAnimationFrame(r)));
  return p;
}

function registrationResponseLooksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("[") || t.startsWith("{");
}

function pickSamlPostForm(doc) {
  const forms = [...doc.querySelectorAll("form")];
  if (!forms.length) return null;
  const hasRelay = (f) => f.querySelector(
    'input[name="SAMLResponse"],input[name="SAMLRequest"],input[name="RelayState"]',
  );
  return forms.find(hasRelay) || forms.find((f) => !f.closest("noscript")) || forms[0];
}

async function submitFirstFormFromHtml(htmlText, baseHref) {
  try {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const form = pickSamlPostForm(doc);
    if (!form) return null;
    const rawAction = form.getAttribute("action");
    if (rawAction && rawAction.trim().toLowerCase().startsWith("javascript:")) return null;
    const url = !rawAction || rawAction.trim() === ""
      ? new URL(baseHref)
      : new URL(rawAction, baseHref);
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    const params = new URLSearchParams();
    form.querySelectorAll("input[name]").forEach((i) => {
      const n = i.getAttribute("name");
      if (n) params.append(n, i.value);
    });
    form.querySelectorAll("select[name]").forEach((s) => {
      const n = s.getAttribute("name");
      if (n) params.append(n, s.value);
    });
    const init = { credentials: "include", redirect: "follow" };
    if (method === "GET") {
      url.search = params.toString();
      return await (await fetch(url.href, init)).text();
    }
    return await (await fetch(url.href, {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })).text();
  } catch (e) {
    return null;
  }
}

async function resolveRegistrationHtmlToJson(initialText, baseHref) {
  let text = initialText;
  let samlHops = 0;
  let authRequired = false;
  while (!registrationResponseLooksLikeJson(text) && samlHops < 8) {
    const next = await submitFirstFormFromHtml(text, baseHref);
    if (next === null) {
      // A failed hop while inside a SAML chain means the session is expired
      // and the IdP/SP POST was blocked in the extension context. Flag so
      // callers can open the login popup immediately instead of retrying.
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

// ── per-tab registration-fetch queue ─────────────────────

let registrationFetchQueue = Promise.resolve();
export function queueRegistrationFetch(fn) {
  const task = registrationFetchQueue.then(fn, fn);
  registrationFetchQueue = task.then(() => {}, () => {});
  return task;
}

// Sentinel error thrown (not returned) so the retry loop in loadSchedule can
// distinguish "auth expired" from a transient Banner session warmup failure.
class AuthRequiredError extends Error {
  constructor() { super("AUTH_REQUIRED"); this.name = "AuthRequiredError"; }
}

// ── Banner registration API (tab context) ────────────────

const TXST_REG_SCHEDULE_BASE =
  "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";
const TXST_REG_HISTORY_PAGE =
  TXST_REG_SCHEDULE_BASE + "/ssb/registrationHistory/registrationHistory";
const TAB_REG_HISTORY_SYNC_TTL_MS = 10 * 60 * 1000;
let tabRegHistorySyncCache = { token: "", ts: 0 };

async function getRegistrationHistorySynchronizerTokenTab() {
  const now = Date.now();
  if (
    tabRegHistorySyncCache.token &&
    now - tabRegHistorySyncCache.ts < TAB_REG_HISTORY_SYNC_TTL_MS
  ) {
    return tabRegHistorySyncCache.token;
  }
  const r = await fetch(TXST_REG_HISTORY_PAGE, {
    credentials: "include", redirect: "follow",
  });
  const html = await r.text();
  const m = html.match(/<meta\s+name="synchronizerToken"\s+content="([^"]*)"/i);
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
    TXST_REG_SCHEDULE_BASE + "/ssb/classRegistration/getRegistrationEvents";
  const resolved = await resolveRegistrationHtmlToJson(text, eventsBase);
  if (resolved.authRequired) throw new AuthRequiredError();
  text = resolved.text;
  if (!registrationResponseLooksLikeJson(text)) return null;
  return normalizeRegistrationEventsPayload(JSON.parse(text));
}

async function fetchRegistrationEventsHandshakeTab(term, registrationMode) {
  const t = String(term);
  if (registrationMode) {
    await fetch(TXST_REG_SCHEDULE_BASE + "/ssb/term/search?mode=registration", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ term: t }).toString(),
    });
  } else {
    await fetch(TXST_REG_SCHEDULE_BASE + "/ssb/classSearch/resetDataForm", {
      method: "POST", credentials: "include",
    });
    await fetch(TXST_REG_SCHEDULE_BASE + "/ssb/term/search?mode=search", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        term: t, studyPath: "", studyPathText: "",
        startDatepicker: "", endDatepicker: "",
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

// ── registered-events → workingCourses ───────────────────

function registrationCrnKey(ev) {
  return String(ev.crn ?? ev.courseReferenceNumber ?? "").trim();
}

export function buildRegisteredCoursesFromEvents(data) {
  const seen = new Set();
  const registered = [];
  const locks = new Set();
  const rows = normalizeRegistrationEventsPayload(data);
  if (!rows.length) return { registered, locks };
  const expanded = rows.map(expandRegistrationEvent);
  for (const event of expanded) {
    const ck = registrationCrnKey(event);
    if (!ck || seen.has(ck)) continue;
    seen.add(ck);
    const start = new Date(event.start);
    const end = new Date(event.end);
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
    registered.push({
      crn: ck,
      subject: event.subject,
      courseNumber: event.courseNumber,
      title: event.title,
      days,
      beginTime: String(bh).padStart(2, "0") + ":" + String(bm).padStart(2, "0"),
      endTime: String(eh).padStart(2, "0") + ":" + String(em).padStart(2, "0"),
      source: "registered",
      online: false,
    });
    locks.add(ck);
  }
  return { registered, locks };
}

// ── compression for LLM (retained for parity with background flow) ──

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
    const startStr = String(start.getHours()).padStart(2, "0") +
      String(start.getMinutes()).padStart(2, "0");
    const endStr = String(end.getHours()).padStart(2, "0") +
      String(end.getMinutes()).padStart(2, "0");
    const existing = courses.find((c) => c.crn === String(event.crn));
    if (existing) {
      if (!existing.days.includes(dayNames[dayIdx])) existing.days.push(dayNames[dayIdx]);
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

// ── refresh-prompt (retry button when auth looks OK but fetch failed) ──

function addScheduleRefreshPrompt() {
  document
    .querySelectorAll("[data-schedule-refresh-prompt]")
    .forEach((el) => el.remove());
  const div = document.createElement("div");
  div.className = "chat-message system";
  div.setAttribute("data-schedule-refresh-prompt", "1");
  div.innerHTML =
    '<div class="sender">System</div>' +
    '<div>Schedule didn\u2019t load. Click Refresh to retry.</div>' +
    '<button type="button" class="save-schedule-btn">Refresh</button>';
  const btn = div.querySelector("button");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Loading…";
    await loadSchedule(State.currentTerm);
    btn.textContent = "Refresh";
    btn.disabled = false;
    if (State.registeredFetchOk) {
      div.remove();
      addMessage("system", "Schedule loaded.");
    }
  });
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function emptyScheduleStatusMessage(term) {
  const d = State.termDescriptionsByCode[String(term)] || "";
  if (/\(view only\)/i.test(d)) {
    return "No meetings for this term — open Banner registration, select this View Only term, then Import Schedule.";
  }
  return "No registered courses for this term — if Banner closed registration, try the View Only row for Spring or Summer/Fall.";
}

// ── main loadSchedule ────────────────────────────────────

export async function loadSchedule(term) {
  const fetchGen = State.bumpScheduleFetchGeneration();
  State.setRegisteredFetchCompleted(false);
  $("statusBar").textContent = "Loading schedule...";

  let fromDiskCache = false;
  let authRequired = false;
  let data = null;
  try {
    data = await getCurrentSchedule(term);
  } catch (e) {
    if (e instanceof AuthRequiredError) authRequired = true;
  }
  if (fetchGen !== State.getScheduleFetchGeneration()) {
    return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
  }
  // Retry up to 2× for legitimate Banner session-warmup failures. Previously
  // the loop was 16 iterations: on expired auth each call triggered a full
  // SAML chain, producing 17+ identical IdP POSTs before surfacing the login
  // prompt. Now we bail immediately on AuthRequiredError.
  if (!authRequired && data === null) {
    for (let i = 0; i < 2; i++) {
      await waitAnimationFrames(2);
      if (fetchGen !== State.getScheduleFetchGeneration()) {
        return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
      }
      try {
        data = await getCurrentSchedule(term);
      } catch (e) {
        if (e instanceof AuthRequiredError) { authRequired = true; break; }
      }
      if (fetchGen !== State.getScheduleFetchGeneration()) {
        return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
      }
      if (data !== null) break;
    }
  }
  if (data === null) {
    const cached = await State.loadCachedRegistrationEvents(term);
    if (cached) { data = cached; fromDiskCache = true; }
  }
  if (fetchGen !== State.getScheduleFetchGeneration()) {
    return { stale: true, hadRegistrationRows: false, fromDiskCache: false, fetchOk: false };
  }
  if (data != null) data = normalizeRegistrationEventsPayload(data);

  State.setRegisteredFetchOk(data !== null);
  State.setRegisteredFetchCompleted(true);

  if (data && data.length > 0) {
    State.clearEmptyRegistrationRecoverFlag(term);
    document.querySelectorAll("[data-schedule-refresh-prompt]").forEach((el) => el.remove());
    State.registeredScheduleCache[term] = data;
    State.setCachedRegisteredCourses(
      compressRegisteredForLLM(data.map(expandRegistrationEvent)),
    );
    State.setCachedRegisteredTerm(term);
    const { registered, locks } = buildRegisteredCoursesFromEvents(data);
    State.setLockedCrns(locks);
    // Viewing a Banner plan: switch back to registered view and don't merge
    // plan courses in.
    if (State.activeScheduleKey.startsWith("banner:")) {
      State.setActiveScheduleKey("registered");
    }
    State.setWorkingCourses([
      ...registered,
      ...State.workingCourses.filter(
        (c) => c.source !== "registered" && c.source !== "banner",
      ),
    ]);

    // Register modal metadata for all registered CRNs.
    const mergedByCrn = groupRegistrationEventsByCrn(data);
    mergedByCrn.forEach((mergedEv, crn) => {
      const meta = extractMetaFromRegistrationEvent(mergedEv);
      registerCourseMeta(crn, meta);
    });

    renderCalendarFromWorkingCourses();
    renderSavedList();
    updateWeekHours(data);
    updateOverviewFromEvents(data);
    const unique = new Set(data.map((e) => e.crn));
    if (!fromDiskCache) State.persistRegistrationEvents(term, data);
    $("statusBar").textContent = fromDiskCache
      ? unique.size + " registered courses (saved copy — use Import Schedule to refresh)"
      : unique.size + " registered courses";
    updateSaveBtn();
    return { stale: false, hadRegistrationRows: true, fromDiskCache, fetchOk: true };
  } else if (data === null) {
    State.setCachedRegisteredCourses([]);
    State.setCachedRegisteredTerm(term);
    buildEmptyCalendar();
    $("statusBar").textContent = authRequired
      ? "Session expired — click Import Schedule to log back in."
      : "Could not reach registration data. Try Import Schedule again.";
    if (authRequired) maybeAutoLogin("Session expired — opening login…", term);
    if (!authRequired) addScheduleRefreshPrompt();
    return {
      stale: false, hadRegistrationRows: false, fromDiskCache, fetchOk: false, authRequired,
    };
  } else {
    document.querySelectorAll("[data-schedule-refresh-prompt]").forEach((el) => el.remove());
    State.setCachedRegisteredCourses([]);
    State.setCachedRegisteredTerm(term);
    buildEmptyCalendar();
    $("statusBar").textContent = emptyScheduleStatusMessage(term);
    void maybeRecoverEmptyRegistration(term, fromDiskCache);
    return {
      stale: false, hadRegistrationRows: false, fromDiskCache: false,
      fetchOk: true, authRequired: false,
    };
  }
}

// ── Import Schedule button + post-login listener ─────────

let importLoginListener = null;
function attachImportLoginListener(importBtn, importSvg) {
  if (importLoginListener) {
    chrome.runtime.onMessage.removeListener(importLoginListener);
    importLoginListener = null;
  }
  importLoginListener = (msg) => {
    if (msg.type === "loginSuccess") {
      chrome.runtime.onMessage.removeListener(importLoginListener);
      importLoginListener = null;
      addMessage("system", "Login successful! Loading your schedule next…");
      (async () => {
        importBtn.textContent = "Importing...";
        importBtn.classList.add("loading");
        const authed2 = await checkAuth();
        if (!authed2) {
          addMessage("system", "TXST session not ready yet. Try Import Schedule again.");
          importBtn.disabled = false;
          importBtn.classList.remove("loading");
          importBtn.innerHTML = importSvg;
          return;
        }
        await waitWithChatCountdown(1);
        State.setAnalysisResults(null);
        State.setCachedRawData(null);
        State.setCachedRegisteredCourses([]);
        State.setCachedRegisteredTerm(null);
        State.setConversationHistory([]);
        $("statusBar").textContent = "Importing schedule...";
        await loadSchedule(State.currentTerm);
        location.reload();
      })().catch((err) => {
        console.error("[BobcatPlus] post-login import:", err);
        addMessage("system", "Could not finish loading. Try Import Schedule again.");
        importBtn.disabled = false;
        importBtn.classList.remove("loading");
        importBtn.innerHTML = importSvg;
      });
    }
    if (msg.type === "loginCancelled") {
      chrome.runtime.onMessage.removeListener(importLoginListener);
      importLoginListener = null;
      addMessage("system", "Login cancelled. Click Import to try again.");
      importBtn.disabled = false;
      importBtn.classList.remove("loading");
      importBtn.innerHTML = importSvg;
    }
  };
  chrome.runtime.onMessage.addListener(importLoginListener);
}

const IMPORT_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Import Schedule`;

const importBtn = document.getElementById("importBtn");
if (importBtn) {
  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true;
    importBtn.classList.add("loading");
    importBtn.textContent = "Checking session...";
    const authed = await checkAuth();
    if (!authed) {
      importBtn.textContent = "Waiting for login...";
      addMessage("system",
        "Opening TXST login — sign in and the import will start automatically.");
      chrome.runtime.sendMessage({ action: "openLoginPopup", term: State.currentTerm });
      attachImportLoginListener(importBtn, IMPORT_SVG);
      return;
    }
    importBtn.textContent = "Importing...";
    $("statusBar").textContent = "Importing schedule...";
    State.setAnalysisResults(null);
    State.setCachedRawData(null);
    State.setCachedRegisteredCourses([]);
    State.setCachedRegisteredTerm(null);
    State.setConversationHistory([]);
    let resetBtn = true;
    try {
      const result = await loadSchedule(State.currentTerm);
      if (result.stale) return;
      if (result.authRequired ||
          (!result.hadRegistrationRows && !result.fromDiskCache)) {
        resetBtn = false;
        importBtn.textContent = "Waiting for login...";
        addMessage("system",
          "Opening TXST login — sign in to load your registration.");
        chrome.runtime.sendMessage({ action: "openLoginPopup", term: State.currentTerm });
        attachImportLoginListener(importBtn, IMPORT_SVG);
        return;
      }
    } finally {
      if (resetBtn) {
        importBtn.disabled = false;
        importBtn.classList.remove("loading");
        importBtn.innerHTML = IMPORT_SVG;
      }
    }
  });
}
