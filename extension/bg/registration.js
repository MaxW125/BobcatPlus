// Bobcat Plus — Banner registration schedule + login popup (ES module).
//
// Two load-bearing behaviors live here:
//
//   1. getCurrentSchedule(term) — read the student's registered schedule
//      for any term, including terms closed to registration. Order of
//      attempts is locked in (see D19 and
//      docs/postmortems/bug8-banner-half-auth-login-popup.md):
//
//        a. `term/search?mode=registration` handshake + classRegistration
//           warm-up → getRegistrationEvents
//        b. `term/search?mode=search` handshake (classSearch reset) →
//           getRegistrationEvents
//        c. `registrationHistory/reset?term=…` (View Registration
//           Information path) → getRegistrationEvents
//
//      Closed past/future terms require path (c). Active registration
//      terms work via (a); the middle one is the transitional state
//      observed when Banner is half-authenticated and returns an empty
//      JSON payload on (a) but succeeds on (b).
//
//   2. openLoginPopup — opens a small window at `/saml/login` (NOT at
//      `/ssb/registration/registration`). The anonymous Banner hub
//      ("What would you like to do?") will serve to unauthenticated
//      sessions without ever hitting the IdP, which is why we force
//      SP-initiated SAML here. Also primes `/saml/logout?local=true`
//      beforehand so we don't get stuck on a stale half-auth hub.
//
//      After Banner's probe passes, the **same popup tab** is sent to
//      the DegreeWorks worksheet URL so the browser completes DW's SP
//      SAML (the IdP is already warm). Silent SW fetch cannot warm DW
//      — its API returns 401 without redirect — so this navigation is
//      the minimal fix for clear-cookies / cold-DW. On worksheet load
//      (`DW_SUCCESS`), we fire `loginSuccess` and close. Recovery from
//      failed Banner probe still uses DW → bounce to Banner SAML; see
//      `awaitingDwWorksheetAfterBanner` below.
//
// All schedule fetches are serialized through `withSessionLock` — see
// docs/invariants.md #1. The probe loop inside
// `openLoginPopup` intentionally skips the lock when it's the only thing
// running; it tests session liveness via `fetchRegistrationEventsViaHistory`
// (which is GET-only and read-only from Banner's perspective) then falls
// back to the full `getCurrentSchedule` if that tells us nothing.

import { withSessionLock } from "./session.js";
import { getTerms } from "./bannerApi.js";

// Base URL without `/ssb` — the registration history and saml endpoints
// live one path level above the rest of the SSB surface. bannerApi.js's
// BANNER_BASE_URL includes `/ssb`, which is the wrong depth for these
// paths, so this module keeps its own base.
const REG_SCHEDULE_BASE =
  "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";

const REG_HISTORY_PAGE_URL =
  REG_SCHEDULE_BASE + "/ssb/registrationHistory/registrationHistory";

// --- Registration-history synchronizer token cache -----------------------
//
// The "View Registration Information" page embeds a per-session anti-CSRF
// token in a <meta name="synchronizerToken"> tag. Banner's registration-
// history XHR path refuses without it. Read once per 10 minutes and
// reuse; the token is stable over a session and the cost of the HTML
// fetch is a single round-trip with no data body.

let regHistorySyncTokenCache = { token: "", ts: 0 };
const REG_HISTORY_SYNC_TTL_MS = 10 * 60 * 1000;

async function getRegistrationHistorySynchronizerToken() {
  const now = Date.now();
  if (
    regHistorySyncTokenCache.token &&
    now - regHistorySyncTokenCache.ts < REG_HISTORY_SYNC_TTL_MS
  ) {
    return regHistorySyncTokenCache.token;
  }
  const r = await fetch(REG_HISTORY_PAGE_URL, {
    credentials: "include",
    redirect: "follow",
  });
  const html = await r.text();
  const m = html.match(
    /<meta\s+name="synchronizerToken"\s+content="([^"]*)"/i,
  );
  const token = m && m[1] ? m[1] : "";
  regHistorySyncTokenCache = { token, ts: now };
  return token;
}

function bannerStudentJsonAjaxHeaders(syncToken) {
  const h = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (syncToken) h["X-Synchronizer-Token"] = syncToken;
  return h;
}

// --- SAML auto-post resolver ---------------------------------------------
//
// Banner's XHR endpoints sometimes return an HTML auto-post form instead
// of JSON when the session needs a SAML round-trip. Service workers have
// no DOMParser, so the helpers below extract the `<form>` + inputs via
// regex and resubmit to the IdP. After up to 8 hops we expect a JSON
// body — any longer and we assume something structural went wrong and
// surface the raw HTML to the caller.
//
// `extractHtmlAttr` HTML-entity-decodes its result. Banner's current
// `/saml/login` AuthnRequest form ships with an entity-encoded action
// (`https&#x3a;&#x2f;&#x2f;eis-prod…`); a raw regex capture without
// decoding sends us into an infinite `/ssb/classRegistration/https&`
// redirect loop. See bug11 correction notes.

function registrationBodyLooksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("[") || t.startsWith("{");
}

/** Banner sometimes returns a wrapper object instead of a bare array. */
function normalizeRegistrationEventsArray(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.registrationEvents))
    return payload.registrationEvents;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

/**
 * Decode the HTML entities that Banner's SAML-flavored HTML now uses in
 * form attributes — e.g. `action="https&#x3a;&#x2f;&#x2f;eis-prod.ec.txstate.edu…"`.
 * Without decoding, `new URL(rawAction, baseHref)` treats the string as a
 * relative path and we POST to `/ssb/classRegistration/https&`, which 302s
 * back to `/saml/login` and loops forever. `tab.js` uses `DOMParser` which
 * decodes entities for free — this helper keeps the SW in sync.
 */
function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractHtmlAttr(fragment, attrName) {
  const re = new RegExp(
    "\\b" + attrName + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1",
    "i",
  );
  const m = fragment.match(re);
  return m ? decodeHtmlEntities(m[2]) : "";
}

function listFormBlocks(htmlText) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    out.push({ attrs: m[1], body: m[2], index: m.index });
  }
  return out;
}

function formInsideNoscript(htmlText, formIndex) {
  const before = htmlText.slice(0, formIndex);
  const open = before.lastIndexOf("<noscript");
  const close = before.lastIndexOf("</noscript>");
  return open > close;
}

function pickFormBlock(htmlText) {
  const blocks = listFormBlocks(htmlText);
  if (blocks.length === 0) return null;
  const hasSaml = (b) =>
    /name\s*=\s*["'](?:SAMLResponse|SAMLRequest|RelayState)["']/i.test(b.body);
  const saml = blocks.find(hasSaml);
  if (saml) return saml;
  const outside = blocks.find((b) => !formInsideNoscript(htmlText, b.index));
  return outside || blocks[0];
}

async function submitFirstFormFromHtmlSw(htmlText, baseHref) {
  try {
    const formMatch = pickFormBlock(htmlText);
    if (!formMatch) return null;
    const formAttrs = formMatch.attrs;
    const formBody = formMatch.body;
    let rawAction = extractHtmlAttr(formAttrs, "action");
    if (rawAction && rawAction.trim().toLowerCase().startsWith("javascript:"))
      return null;
    const url =
      !rawAction || rawAction.trim() === ""
        ? new URL(baseHref)
        : new URL(rawAction, baseHref);
    const method = (
      extractHtmlAttr(formAttrs, "method") || "GET"
    ).toUpperCase();
    const params = new URLSearchParams();
    const inputRe = /<input\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(formBody))) {
      const ia = im[1];
      const name = extractHtmlAttr(ia, "name");
      if (!name) continue;
      const value = extractHtmlAttr(ia, "value") || "";
      params.append(name, value);
    }
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
    console.warn("[BobcatPlus] submitFirstFormFromHtmlSw:", e);
    return null;
  }
}

async function resolveRegistrationHtmlToJsonSw(initialText, baseHref) {
  let text = initialText;
  let samlHops = 0;
  const maxHops = 8;
  while (!registrationBodyLooksLikeJson(text) && samlHops < maxHops) {
    const next = await submitFirstFormFromHtmlSw(text, baseHref);
    if (next === null) break;
    text = next;
    samlHops++;
  }
  return { text, samlHops };
}

// --- getRegistrationEvents fetch variants --------------------------------

/**
 * GET calendar JSON after session is already warmed (any path).
 * Optional `extraHeaders` matches Banner XHR (e.g. registration history flow).
 */
async function fetchGetRegistrationEventsArray(extraHeaders) {
  const headers = extraHeaders || {};
  const response = await fetch(
    REG_SCHEDULE_BASE +
      "/ssb/classRegistration/getRegistrationEvents?termFilter=",
    { credentials: "include", headers },
  );
  const eventsBase =
    REG_SCHEDULE_BASE +
    "/ssb/classRegistration/getRegistrationEvents";
  let text = await response.text();
  const resolved = await resolveRegistrationHtmlToJsonSw(text, eventsBase);
  text = resolved.text;
  if (!registrationBodyLooksLikeJson(text)) {
    console.warn(
      "[BobcatPlus] getRegistrationEvents non-JSON after SAML hops:",
      resolved.samlHops,
      text.slice(0, 80),
    );
    return null;
  }
  return normalizeRegistrationEventsArray(JSON.parse(text));
}

/**
 * View Registration Information — same as Banner "Look up a Schedule":
 * GET registrationHistory/reset?term=… then getRegistrationEvents (no classRegistration hop).
 * Required for terms closed to registration (Spring past window, etc.). See pastTerm.har.
 */
async function fetchRegistrationEventsViaHistoryReset(term) {
  try {
    const sync = await getRegistrationHistorySynchronizerToken();
    const ajax = bannerStudentJsonAjaxHeaders(sync);
    const historyHeaders = {
      ...ajax,
      Referer: REG_HISTORY_PAGE_URL,
    };
    const resetUrl =
      REG_SCHEDULE_BASE +
      "/ssb/registrationHistory/reset?term=" +
      encodeURIComponent(String(term));
    await fetch(resetUrl, {
      credentials: "include",
      headers: historyHeaders,
    });
    return await fetchGetRegistrationEventsArray(historyHeaders);
  } catch (e) {
    console.warn("[BobcatPlus] registrationHistory reset path failed:", e);
    return null;
  }
}

/**
 * Warm Banner session for `term`, then GET registration calendar JSON.
 * `registrationMode`: true = term/search?mode=registration (active registration terms);
 * false = classSearch reset + term/search?mode=search (often works when registration is closed).
 */
async function fetchRegistrationEventsHandshake(term, registrationMode) {
  const t = String(term);
  if (registrationMode) {
    await fetch(REG_SCHEDULE_BASE + "/ssb/term/search?mode=registration", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ term: t }).toString(),
    });
  } else {
    await fetch(REG_SCHEDULE_BASE + "/ssb/classSearch/resetDataForm", {
      method: "POST",
      credentials: "include",
    });
    await fetch(REG_SCHEDULE_BASE + "/ssb/term/search?mode=search", {
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
    REG_SCHEDULE_BASE + "/ssb/classRegistration/classRegistration",
    { credentials: "include" },
  );
  return fetchGetRegistrationEventsArray({});
}

// --- Public: current registered schedule ---------------------------------
//
// Used by popup.js (via `getSchedule` message) and by tab.js. SAML-aware:
// follows redirect chains that Banner returns when the session needs
// warming, and falls back to the registrationHistory path for past or
// otherwise closed terms. See D19 for why the order here is load-bearing.
export async function getCurrentSchedule(term) {
  return withSessionLock(async () => {
    try {
      let primary = await fetchRegistrationEventsHandshake(term, true);
      if (primary !== null && primary.length > 0) return primary;
      const fallback = await fetchRegistrationEventsHandshake(term, false);
      if (fallback !== null && fallback.length > 0) return fallback;
      const history = await fetchRegistrationEventsViaHistoryReset(term);
      if (history !== null && history.length > 0) return history;
      return primary !== null ? primary : fallback !== null ? fallback : history;
    } catch (e) {
      console.error("[BobcatPlus] getCurrentSchedule error:", e);
      return null;
    }
  });
}

// --- Public: login popup -------------------------------------------------
//
// Small window (user preference). `registrationTermExplicit` lets the tab
// UI pin the probe to the same term the user just selected, so we never
// false-negative on a term that's stale in the Bobcat Plus dropdown.
//
// D19 / Bug 8: the popup MUST start at `/saml/login`, not `/registration`.
// Banner will happily serve the anonymous hub ("What would you like to
// do?") to an unauthenticated session hitting `/registration`, which
// looks logged-in from our probe's perspective. SP-initiated SAML
// guarantees the IdP step happens before Banner touches cookies.
export function openLoginPopup(sendResponse, registrationTermExplicit) {
  const DW_URL =
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/WEB31";
  /** SP-initiated SSO — avoids the anonymous “What would you like to do?” hub on /registration alone. */
  const REG_SAML_LOGIN_URL = REG_SCHEDULE_BASE + "/saml/login";

  /** Clears Banner registration cookies so the next load hits SSO instead of a half-auth hub. */
  const REG_LOGOUT_URL =
    REG_SCHEDULE_BASE + "/saml/logout?local=true";

  const DW_SUCCESS = "responsiveDashboard/worksheets";

  let popupWindowId = null;
  let cancelled = false;
  let verifying = false;
  let verifyTimer = null;
  let verifyDeadline = 0;
  let restartCount = 0;
  /** Resolved once per login attempt — must match Bobcat Plus term selector when provided. */
  let resolvedProbeTerm = registrationTermExplicit || null;
  /**
   * After `probeBannerRegistration` succeeds, we load the DW worksheet in
   * the popup so the real browser can set the DW SP cookie. While this
   * is true, the next `DW_SUCCESS` URL finishes login instead of
   * redirecting to Banner (recovery path).
   */
  let awaitingDwWorksheetAfterBanner = false;

  function cleanup() {
    chrome.tabs.onUpdated.removeListener(onLoginTabUpdated);
    chrome.windows.onRemoved.removeListener(onLoginWindowClosed);
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
  }

  function clearVerifySchedule() {
    verifying = false;
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
  }

  /** Last resort — DegreeWorks entry (user may get a fresh SSO redirect from there). */
  function restartFromDegreeWorks(tabId, reason) {
    awaitingDwWorksheetAfterBanner = false;
    clearVerifySchedule();
    restartCount++;
    try {
      chrome.tabs.update(tabId, { url: DW_URL });
    } catch (_) {}
    if (reason) console.warn("[BobcatPlus] login popup:", reason);
  }

  function finishLoginSuccess() {
    awaitingDwWorksheetAfterBanner = false;
    clearVerifySchedule();
    cleanup();
    try {
      chrome.windows.remove(popupWindowId, () => {
        chrome.runtime.sendMessage({ type: "loginSuccess" });
      });
    } catch (_) {
      chrome.runtime.sendMessage({ type: "loginSuccess" });
    }
  }

  async function pickDefaultTermCode() {
    try {
      const terms = await getTerms();
      const now = new Date();
      for (const t of terms || []) {
        const desc = String(t.description || "");
        if (/\(view only\)/i.test(desc)) continue;
        if (/correspondence/i.test(desc)) continue;
        const m = desc.match(/(\d{2}-[A-Z]{3}-\d{4})/);
        if (!m) continue;
        const startDate = new Date(m[1]);
        if (startDate <= now) return t.code;
      }
      return (terms && terms[0] && terms[0].code) ? terms[0].code : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Banner registration readiness — fast history handshake, then full
   * `getCurrentSchedule` fallback. Kept cheap so the verify tick stays
   * sub-second while the user is on the login popup.
   *
   * DegreeWorks is warmed separately by navigating the popup tab to the
   * worksheet after this probe succeeds — see `awaitingDwWorksheetAfterBanner`.
   */
  async function probeBannerRegistration(term) {
    if (!term) return false;
    let data = await fetchRegistrationEventsViaHistoryReset(term);
    if (data !== null) return true;
    data = await getCurrentSchedule(term);
    return data !== null;
  }

  /** Clears cookies via fetch, then reloads registration — no /saml/logout *page* in the tab. */
  async function softRefreshRegistrationTab(tabId) {
    try {
      await fetch(REG_LOGOUT_URL, {
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
      });
    } catch (_) {}
    try {
      chrome.tabs.update(tabId, {
        url: REG_SAML_LOGIN_URL + "?_bpLogin=" + Date.now(),
      });
    } catch (_) {}
  }

  function scheduleVerify(tabId) {
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    verifying = true;
    verifyDeadline = Date.now() + 90_000;
    let probeAttemptsSinceReg = 0;
    let softRefreshRetries = 0;

    const tick = async () => {
      if (cancelled) return;
      if (!resolvedProbeTerm) resolvedProbeTerm = await pickDefaultTermCode();
      const ok = await probeBannerRegistration(resolvedProbeTerm);
      if (ok) {
        if (!awaitingDwWorksheetAfterBanner) {
          awaitingDwWorksheetAfterBanner = true;
          clearVerifySchedule();
          try {
            chrome.tabs.update(tabId, { url: DW_URL });
          } catch (_) {}
          return;
        }
        try {
          chrome.tabs.update(tabId, { url: DW_URL });
        } catch (_) {}
        return;
      }

      probeAttemptsSinceReg++;

      if (probeAttemptsSinceReg < 3 && Date.now() < verifyDeadline) {
        verifyTimer = setTimeout(tick, 380);
        return;
      }

      if (softRefreshRetries < 2 && Date.now() < verifyDeadline) {
        softRefreshRetries++;
        probeAttemptsSinceReg = 0;
        void softRefreshRegistrationTab(tabId);
        verifyTimer = setTimeout(tick, 1100);
        return;
      }

      if (Date.now() > verifyDeadline) {
        chrome.runtime.sendMessage({ type: "loginCancelled" });
        clearVerifySchedule();
        return;
      }

      if (restartCount >= 4) {
        chrome.runtime.sendMessage({ type: "loginCancelled" });
        clearVerifySchedule();
        return;
      }

      probeAttemptsSinceReg = 0;
      softRefreshRetries = 0;
      restartFromDegreeWorks(
        tabId,
        "Banner registration probe failed — restarting from DegreeWorks login",
      );
    };

    verifyTimer = setTimeout(tick, 180);
  }

  function onLoginTabUpdated(tabId, changeInfo, tab) {
    if (!tab || tab.windowId !== popupWindowId) return;
    if (changeInfo.status !== "complete" || !tab.url) return;

    const u = tab.url;

    // Pause probes while the user is at the IdP; do not match `/saml/login` here — recovery navigates
    // there programmatically and must keep the verify timer alive until the next `/ssb/` load.
    if (
      /authentic\.txstate\.edu/i.test(u) ||
      /\/idp\/profile\/SAML2\/POST\/SSO/i.test(u)
    ) {
      clearVerifySchedule();
      return;
    }

    // DegreeWorks worksheet loaded — either finish (happy path after Banner)
    // or bounce to Banner SAML (recovery when Banner probe failed first).
    if (tab.url.includes(DW_SUCCESS)) {
      if (awaitingDwWorksheetAfterBanner) {
        finishLoginSuccess();
        return;
      }
      chrome.tabs.update(tabId, {
        url: REG_SAML_LOGIN_URL + "?_dw=" + Date.now(),
      });
      return;
    }

    // Banner SSB after SAML (registration, class registration, etc.). Hub uses same host/path family as real session.
    if (/reg-prod\.ec\.txstate\.edu\/StudentRegistrationSsb\/ssb\//i.test(u)) {
      scheduleVerify(tabId);
    }
  }

  function onLoginWindowClosed(windowId) {
    if (windowId !== popupWindowId) return;
    if (cancelled) return;
    cancelled = true;
    cleanup();
    chrome.runtime.sendMessage({ type: "loginCancelled" });
  }

  void (async () => {
    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 2500);
      await fetch(REG_LOGOUT_URL, {
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        signal: ac.signal,
      });
      clearTimeout(timeout);
    } catch (e) {
      console.warn("[BobcatPlus] Banner logout prime before login popup:", e);
    }

    chrome.windows.create(
      {
        url: REG_SAML_LOGIN_URL,
        type: "popup",
        width: 560,
        height: 720,
        focused: true,
      },
      (win) => {
        if (!win || win.id == null) {
          sendResponse({ started: false });
          return;
        }
        popupWindowId = win.id;
        chrome.tabs.onUpdated.addListener(onLoginTabUpdated);
        chrome.windows.onRemoved.addListener(onLoginWindowClosed);
        sendResponse({ started: true });
      },
    );
  })();
}
