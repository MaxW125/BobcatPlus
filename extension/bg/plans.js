// Bobcat Plus — Banner Plan Ahead CRUD + calendar hydrate (ES module).
//
// Owns TXST StudentRegistrationSsb /ssb/plan/* flows: synchronizer-token
// bootstrap (ensureTxstPlanReadSession), submitPlan/batch save, delete,
// getPlanItems/getPlanEvents, selectPlan HTML parse, and lazy
// fetchPlanCalendar (class-search + searchResults per CRN).
// fetchPlanCalendar shares the registration mutex via withSessionLock.
//
// Moved from extension/background.js — refactor-on-main commit 6.

import { withSessionLock } from "./session.js";

const REG_BASE = "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";
const PLAN_PAGE_REFERER = REG_BASE + "/ssb/plan/plan";
const PLAN_ORIGIN = "https://reg-prod.ec.txstate.edu";

function generatePlanUniqueSessionId() {
  return "rx" + Math.random().toString(36).slice(2, 9) + Date.now();
}

function extractSynchronizerToken(html) {
  if (!html) return null;
  const patterns = [
    /name="synchronizerToken"\s+value="([^"]+)"/,
    /name='synchronizerToken'\s+value='([^']+)'/,
    /id="synchronizerToken"\s+value="([^"]+)"/,
    /"synchronizerToken"\s*:\s*"([^"]+)"/,
    /synchronizerToken['"]\s*:\s*['"]([^'"]+)['"]/,
    /<meta[^>]+name=["']synchronizerToken["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

function planAction(description, isDeleteAction, planCourseStatus) {
  return {
    class: "net.hedtech.banner.student.registration.RegistrationPlanAction",
    description,
    isDeleteAction,
    planCourseStatus,
  };
}

function clientPlanTuid() {
  return -(Math.floor(Math.random() * 2000000000) + 1);
}

function parseSubjectCourseFromRow(
  section,
  fallbackSubject,
  fallbackCourseNumber,
) {
  let subj = (fallbackSubject || section.subject || "").trim().toUpperCase();
  let cnum = String(
    fallbackCourseNumber || section.courseNumber || section.number || "",
  ).trim();
  const sc = (section.subjectCourse || section.courseDisplay || "").trim();
  const m = sc.match(/^([A-Z][A-Z\s&]*)\s+(\d{4})\b/);
  if (m) {
    subj = m[1].replace(/\s+/g, " ").trim().toUpperCase();
    cnum = m[2];
  }
  return { subj, cnum };
}

function resolveSectionNumberFromSearchRow(section) {
  const tryDirect = [
    section.section,
    section.sectionNumber,
    section.courseSectionNumber,
    section.classSection,
    section.ssbsectSection,
  ];
  for (const v of tryDirect) {
    if (v != null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  const sc = (section.subjectCourse || section.courseDisplay || "").trim();
  let m = sc.match(/-\s*(\d{1,4})\s*$/);
  if (m) return m[1];
  m = sc.match(/\s(\d{3,4})\s*$/);
  if (m) return m[1];
  if (
    section.sequenceNumber != null &&
    String(section.sequenceNumber).trim() !== ""
  ) {
    return String(section.sequenceNumber).trim();
  }
  const title = section.courseTitle || "";
  m = title.match(/\b(?:sec|section)\.?\s*#?\s*(\d{1,4})\b/i);
  if (m) return m[1];
  return "";
}

function escapeBannerCourseTitle(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function unwrapExtDirectResult(payload) {
  if (payload != null && typeof payload === "object" && "result" in payload) {
    return payload.result;
  }
  return payload;
}

function planMutationHeaders(synchronizerToken, contentType) {
  const h = {
    Referer: PLAN_PAGE_REFERER,
    Origin: PLAN_ORIGIN,
    "X-Requested-With": "XMLHttpRequest",
    "X-Synchronizer-Token": synchronizerToken,
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

function extractPlanNumberFromBatchResponse(payload) {
  // Confirmed response shape: { success: true, data: { planHeader: { id: 236798, ... } } }
  const planHeaderId = payload?.data?.planHeader?.id;
  if (planHeaderId != null) {
    const v = Number(planHeaderId);
    if (Number.isFinite(v) && v > 0) {
      return v;
    }
  }

  // Fallback: walk other known locations in case response shape varies
  const root = unwrapExtDirectResult(payload);
  if (!root || typeof root !== "object") return null;
  let best = null;
  const consider = (n) => {
    if (n == null || n === "") return;
    const v = typeof n === "string" ? parseInt(n, 10) : n;
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e7) {
      if (best == null || v > best) best = v;
    }
  };
  consider(root.planNumber);
  consider(root?.data?.planHeader?.id);
  const pools = [];
  for (const key of [
    "data",
    "create",
    "records",
    "rows",
    "entities",
    "plans",
  ]) {
    if (Array.isArray(root[key])) pools.push(...root[key]);
  }
  if (Array.isArray(payload)) pools.push(...payload);
  for (const row of pools) {
    if (!row || typeof row !== "object") continue;
    consider(row.planNumber);
    consider(row.id);
    if (row.data && typeof row.data === "object") consider(row.data.planNumber);
  }
  return best;
}

async function fetchPlanHtml(pathWithLeadingSlash) {
  const url =
    pathWithLeadingSlash.indexOf("http") === 0
      ? pathWithLeadingSlash
      : REG_BASE + pathWithLeadingSlash;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "text/html,*/*;q=0.8",
      Referer: PLAN_PAGE_REFERER,
    },
  });
  return res.text();
}

async function activatePlanSelection(planNumber, sessionId) {
  if (planNumber == null || planNumber === "") return;
  const path =
    "/ssb/plan/plan?select=" +
    encodeURIComponent(planNumber) +
    "&uniqueSessionId=" +
    encodeURIComponent(sessionId);
  await fetchPlanHtml(path);
}

function buildCreatePlanRowFromSection(
  section,
  term,
  planName,
  subject,
  courseNumber,
) {
  const { subj: parsedSubj, cnum: parsedCnum } = parseSubjectCourseFromRow(
    section,
    subject,
    courseNumber,
  );
  const subj = parsedSubj;
  const cnum = parsedCnum;
  const crn = String(section.courseReferenceNumber || "");
  const titleRaw = section.courseTitle || "";
  const titleEscaped = escapeBannerCourseTitle(
    titleRaw.replace(/&amp;/g, "&").replace(/&#39;/g, "'"),
  );
  const creditHours = Number(section.creditHourLow ?? section.creditHours ?? 3);
  const instructionalMethod = section.instructionalMethod || "";
  const instructionalMethodDescription =
    section.instructionalMethodDescription ||
    (instructionalMethod === "INT" ? "Fully Distance Education" : "");
  const scheduleType = section.scheduleType || "LEC";
  const scheduleTypeDescription = section.scheduleTypeDescription || "Lecture";
  const sec = resolveSectionNumberFromSearchRow(section);
  const partOfTerm = String(section.partOfTerm || "1");
  const partOfTermDescription =
    section.partOfTermDescription ||
    (partOfTerm === "1" ? "1 - Full Term (Main)" : partOfTerm);
  const partOfTermStartDate = section.partOfTermStartDate || null;
  const partOfTermEndDate = section.partOfTermEndDate || null;
  const tuid = clientPlanTuid();
  const addA = planAction("Add", false, "Add");
  const remA = planAction("Remove", true, "Remove");
  const selected = {
    class: "net.hedtech.banner.student.registration.RegistrationPlanAction",
    description: null,
    isDeleteAction: false,
    planCourseStatus: "Add",
  };

  const properties = {
    college: null,
    scheduleTypeDescription,
    subject: subj,
    criticalIndicator: false,
    planStatus: "Pending",
    section: sec,
    partOfTerm,
    learnerRegStartToDate: null,
    instructors: [],
    dwAttributeSummary: null,
    overrideDurationIndicator: false,
    courseTitle: titleRaw.replace(/&amp;/g, "&").replace(/&#39;/g, "'"),
    sourceCode: null,
    gradingMode: section.gradingMode || "S",
    instructionalMethod,
    durationUnit: null,
    activeIndicator: true,
    isDeleteAction: false,
    sequenceNumber: null,
    courseRegistrationStatusDescription: null,
    level: null,
    instructionalMethodDescription,
    campus: null,
    registrationCreditHour: null,
    courseReferenceNumber: crn,
    planNumber: null,
    creditHours,
    dwUniqueId: null,
    scheduleType,
    gradingModeDescription: section.gradingModeDescription || "Standard Letter",
    partOfTermDescription,
    isRegistered: false,
    lastModified: null,
    startDate: null,
    registrationStatusDate: null,
    partOfTermStartDate,
    levelDescription: null,
    selectedStartEndDate: null,
    credits: null,
    lockIndicator: false,
    partOfTermEndDate,
    dwChoiceDescription: null,
    dataOrigin: null,
    term,
    attribute: null,
    department: null,
    availableActions: [addA, remA],
    authorizationReason: null,
    dwGroupNumber: null,
    courseNumber: cnum,
    selectedPlanAction: { ...selected },
    tuid,
    message: null,
    dwGroupSelection: false,
    numberOfUnits: null,
    authorizationRequired: false,
    learnerRegStartFromDate: null,
    courseDisplay: cnum,
    comment: null,
    completionDate: null,
  };

  return {
    activeIndicator: true,
    attached: false,
    attribute: null,
    authorizationReason: null,
    authorizationRequired: false,
    availableActions: [addA, remA],
    campus: null,
    class:
      "net.hedtech.banner.student.registration.RegistrationStudentRegistrationPlanCourse",
    college: null,
    comment: null,
    completionDate: null,
    courseDisplay: cnum,
    courseNumber: cnum,
    courseReferenceNumber: crn,
    courseRegistrationStatusDescription: null,
    courseTitle: titleEscaped,
    creditHours,
    credits: null,
    criticalIndicator: false,
    dataOrigin: null,
    department: null,
    dirty: false,
    dirtyPropertyNames: [],
    durationUnit: null,
    dwAttributeSummary: null,
    dwChoiceDescription: null,
    dwGroupNumber: null,
    dwGroupSelection: false,
    dwUniqueId: null,
    errors: { errors: [] },
    gradingMode: section.gradingMode || "S",
    gradingModeDescription: section.gradingModeDescription || "Standard Letter",
    id: null,
    instructionalMethod,
    instructionalMethodDescription,
    instructors: [],
    isDeleteAction: false,
    isRegistered: false,
    lastModified: null,
    learnerRegStartFromDate: null,
    learnerRegStartToDate: null,
    level: null,
    levelDescription: null,
    lockIndicator: false,
    message: null,
    numberOfUnits: null,
    overrideDurationIndicator: false,
    partOfTerm,
    partOfTermDescription,
    partOfTermEndDate,
    partOfTermStartDate,
    planNumber: null,
    planStatus: "Pending",
    properties,
    registrationCreditHour: null,
    registrationStatusDate: null,
    scheduleType,
    scheduleTypeDescription,
    section: sec,
    selectedPlanAction: { ...selected },
    selectedStartEndDate: null,
    sequenceNumber: null,
    sourceCode: null,
    startDate: null,
    subject: subj,
    term,
    tuid,
    version: null,
    headerDescription: planName != null ? planName : null,
    headerComment: null,
  };
}

async function bindPlanTerm(term, uniqueSessionId) {
  const url =
    REG_BASE +
    "/ssb/term/saveTerm?mode=plan&term=" +
    encodeURIComponent(term) +
    "&uniqueSessionId=" +
    encodeURIComponent(uniqueSessionId);
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Referer: PLAN_PAGE_REFERER,
      Origin: PLAN_ORIGIN,
    },
  });
  if (!res.ok) {
    throw new Error("TXST rejected plan term bind (HTTP " + res.status + ")");
  }
  return res.json().catch(() => ({}));
}

async function addPlanItemToPlan(crn, term, synchronizerToken) {
  const body = new URLSearchParams({
    term: String(term),
    courseReferenceNumber: String(crn),
    section: "section",
  }).toString();
  const res = await fetch(REG_BASE + "/ssb/plan/addPlanItem", {
    method: "POST",
    credentials: "include",
    headers: {
      ...planMutationHeaders(
        synchronizerToken,
        "application/x-www-form-urlencoded; charset=UTF-8",
      ),
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new Error(
      (parsed && (parsed.message || parsed.error)) ||
        "addPlanItem HTTP " + res.status + ": " + text.slice(0, 160),
    );
  }
  if (parsed && parsed.success === false) {
    throw new Error(parsed.message || "addPlanItem was not accepted.");
  }
  if (!parsed || !parsed.model) {
    throw new Error("addPlanItem: no model returned for CRN " + crn);
  }
  return parsed.model;
}

async function getPlanSynchronizerToken(planPath) {
  const path = planPath || "/ssb/plan/plan";
  const html = await fetchPlanHtml(path);
  const token = extractSynchronizerToken(html);
  return { token, htmlSnippet: html.slice(0, 500) };
}

/**
 * Banner plan list/detail APIs expect plan mode + synchronizer token (same as manual save flow).
 * Without this, getPlanItems often returns [] after extension reload.
 */
async function ensureTxstPlanReadSession(term) {
  const uniqueSessionId = generatePlanUniqueSessionId();
  await bindPlanTerm(term, uniqueSessionId);
  const planPath =
    "/ssb/plan/plan?uniqueSessionId=" + encodeURIComponent(uniqueSessionId);
  let { token } = await getPlanSynchronizerToken(planPath);
  if (!token) {
    ({ token } = await getPlanSynchronizerToken("/ssb/plan/plan"));
  }
  return { uniqueSessionId, token };
}

function normalizePlanItemsPayload(payload) {
  if (payload == null) return [];
  const root = unwrapExtDirectResult(payload);
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.rows)) return root.rows;
  if (Array.isArray(root?.entities)) return root.entities;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizePlanEventsPayload(payload) {
  if (payload == null) return [];
  const root = unwrapExtDirectResult(payload);
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.events)) return root.events;
  if (Array.isArray(root?.rows)) return root.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.events)) return payload.events;
  return [];
}

export async function saveManualPlanToTxst(term, planName, rows, uniqueSessionId) {
  if (!planName || !String(planName).trim()) {
    throw new Error("Enter a plan name.");
  }
  if (!rows || rows.length === 0) {
    throw new Error("Add at least one course section.");
  }

  const sessionId = uniqueSessionId || generatePlanUniqueSessionId();
  await bindPlanTerm(term, sessionId);
  let { token } = await getPlanSynchronizerToken();
  if (!token) {
    throw new Error(
      "Could not read TXST security token. Log in, open Registration once, then retry.",
    );
  }

  const name = String(planName).trim();

  // Step 1: call addPlanItem for each CRN to get the model objects Banner expects.
  const models = [];
  for (const row of rows) {
    const crn = row.section && row.section.courseReferenceNumber;
    if (!crn) throw new Error("Section missing CRN: " + JSON.stringify(row));
    const model = await addPlanItemToPlan(crn, term, token);
    models.push(model);
  }

  // Step 2: submit the plan using the models Banner returned, adding headerDescription.
  const create = models.map((model) => ({ ...model, headerDescription: name }));

  const res = await fetch(REG_BASE + "/ssb/plan/submitPlan/batch", {
    method: "POST",
    credentials: "include",
    headers: {
      ...planMutationHeaders(token, "application/json"),
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
    body: JSON.stringify({
      create,
      update: [],
      destroy: [],
      uniqueSessionId: sessionId,
    }),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      parsed.message ||
        parsed.error ||
        "Save failed (" + res.status + "): " + text.slice(0, 200),
    );
  }
  const batchInner = unwrapExtDirectResult(parsed);
  if (
    (parsed && parsed.success === false) ||
    (batchInner && batchInner.success === false)
  ) {
    throw new Error(
      (batchInner && batchInner.message) ||
        parsed.message ||
        parsed.errors?.[0]?.message ||
        "TXST reported the plan save did not succeed.",
    );
  }

  const planNumber = extractPlanNumberFromBatchResponse(parsed);
  if (planNumber != null) {
    await activatePlanSelection(planNumber, sessionId);
  }

  return {
    ...parsed,
    bobcatPlanNumber: planNumber,
    bobcatRequestedPlanName: name,
  };
}
// --- Get Banner plan items for a term ---
export async function getBannerPlanItems(term) {
  try {
    const { uniqueSessionId, token } = await ensureTxstPlanReadSession(term);
    if (!token) {
      console.warn("[BobcatPlus] getBannerPlanItems: no synchronizer token");
      return [];
    }
    const q =
      "termFilter=" +
      encodeURIComponent(term) +
      "&uniqueSessionId=" +
      encodeURIComponent(uniqueSessionId);
    const res = await fetch(REG_BASE + "/ssb/plan/getPlanItems?" + q, {
      credentials: "include",
      headers: {
        ...planMutationHeaders(token),
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => []);
    return normalizePlanItemsPayload(data);
  } catch (e) {
    console.warn("[BobcatPlus] getBannerPlanItems:", e);
    return [];
  }
}

// --- Extract plan headers (id + name + planCourses) from the Banner plan page HTML ---
// Banner embeds plan data as: window.bootstraps = { plans: [...], planCount: N, ... };
// The outer object uses unquoted JS keys (not valid JSON), but the plans array itself
// contains properly-quoted JSON objects we can parse directly.
function extractPlanHeaders(html) {
  if (!html) return [];

  // Only search within the window.bootstraps assignment
  const bootstrapIdx = html.indexOf("window.bootstraps");
  if (bootstrapIdx === -1) return [];

  // Find "plans": [ or plans: [ after the bootstraps marker
  const plansRe = /["']?plans["']?\s*:\s*\[/g;
  plansRe.lastIndex = bootstrapIdx;
  const plansMatch = plansRe.exec(html);
  if (!plansMatch) return [];

  // The '[' is the last character of the match
  const arrayStart = plansMatch.index + plansMatch[0].length - 1;

  // Walk forward counting brackets (string-aware) to find the matching ']'
  let depth = 0;
  let end = -1;
  let inString = false;
  let prevChar = "";
  for (let i = arrayStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"' && prevChar !== "\\") {
      inString = !inString;
    } else if (!inString) {
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    prevChar = ch;
  }
  if (end === -1) return [];

  let plansArr;
  try {
    plansArr = JSON.parse(html.slice(arrayStart, end));
  } catch (e) {
    console.warn(
      "[BobcatPlus] extractPlanHeaders: plans array parse failed:",
      e.message,
    );
    return [];
  }

  if (!Array.isArray(plansArr)) return [];

  return plansArr
    .filter((p) => p && p.id != null)
    .map((p, i) => ({
      id: Number(p.id),
      name: String(p.description || "TXST Plan").trim(),
      planCourses: Array.isArray(p.planCourses) ? p.planCourses : [],
      term: p.term || null,
      planIndex: i + 1, // 1-based sequential index used by the Banner delete API
    }));
}

// --- Fetch all plans for a term, each with their calendar events ---
// --- Get all plans for a term from the Banner plan page (name + planCourses with CRNs) ---
// Does NOT fetch meeting times — those are loaded lazily via fetchPlanCalendar when
// the user clicks a plan in the sidebar.
export async function getAllBannerPlans(term) {
  try {
    const { uniqueSessionId } = await ensureTxstPlanReadSession(term);
    const selectPlanHtml = await fetchPlanHtml(
      "/ssb/plan/selectPlan?uniqueSessionId=" +
        encodeURIComponent(uniqueSessionId),
    );
    const planHeaders = extractPlanHeaders(selectPlanHtml);
    // Return plans with planCourses so tab.js can fetch meeting times on demand
    return planHeaders.map((p) => ({
      name: p.name,
      events: [], // populated lazily on first click
      planCourses: p.planCourses || [],
      txstPlanId: p.id,
      txstPlanIndex: p.planIndex, // 1-based index for the delete API
    }));
  } catch (e) {
    console.warn("[BobcatPlus] getAllBannerPlans:", e);
    return [];
  }
}

// --- Fetch calendar events for a specific plan by looking up meeting times for each CRN ---
// Called lazily when the user clicks a TXST plan in the sidebar.
export async function fetchPlanCalendar(term, planCourses) {
  if (!planCourses || planCourses.length === 0) return [];

  // Group planCourses by subject+courseNumber to minimise search calls
  const courseMap = new Map();
  const noCrnCourses = []; // plan courses with no valid CRN — added as TBA at the end
  for (const course of planCourses) {
    // Banner planCourses may use 'crn' or 'courseReferenceNumber'
    const crn = String(course.courseReferenceNumber || course.crn || "");
    if (!crn || crn === "0") { noCrnCourses.push(course); continue; }
    const key = (course.subject || "") + "/" + (course.courseNumber || "");
    if (!courseMap.has(key)) {
      courseMap.set(key, {
        subject: course.subject,
        courseNumber: course.courseNumber,
        crns: new Set(),
      });
    }
    courseMap.get(key).crns.add(crn);
  }

  // Reference week: Monday of the current week (calendar renderer only needs day+time)
  const now = new Date();
  const dow = now.getDay(); // 0 = Sun
  const refMonday = new Date(now);
  refMonday.setDate(now.getDate() - dow + (dow === 0 ? -6 : 1));
  refMonday.setHours(0, 0, 0, 0);

  const dayOffsets = {
    monday: 0,
    tuesday: 1,
    wednesday: 2,
    thursday: 3,
    friday: 4,
  };
  const events = [];

  for (const { subject, courseNumber, crns } of courseMap.values()) {
    let data = null;
    try {
      data = await withSessionLock(async () => {
        // Reset Banner search state before each query so it doesn't return cached results
        await fetch(REG_BASE + "/ssb/classSearch/resetDataForm", {
          method: "POST",
          credentials: "include",
        });
        await fetch(REG_BASE + "/ssb/term/search?mode=search", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            term,
            studyPath: "",
            studyPathText: "",
            startDatepicker: "",
            endDatepicker: "",
          }).toString(),
        });

        const form = new FormData();
        form.append("txt_subject", subject);
        form.append("txt_courseNumber", courseNumber);
        form.append("txt_term", term);
        form.append("pageOffset", "0");
        form.append("pageMaxSize", "500");
        form.append("sortColumn", "subjectDescription");
        form.append("sortDirection", "asc");
        form.append("startDatepicker", "");
        form.append("endDatepicker", "");
        form.append("uniqueSessionId", subject + courseNumber + "-" + Date.now());

        const res = await fetch(REG_BASE + "/ssb/searchResults/searchResults", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      });
      if (!data?.success || !Array.isArray(data.data)) continue;

      const placedCrns = new Set();
      for (const section of data.data) {
        const crn = String(section.courseReferenceNumber || "");
        if (!crns.has(crn)) continue;
        const mt = section.meetingsFaculty?.[0]?.meetingTime;
        if (!mt?.beginTime || !mt?.endTime) {
          // Online / arranged section — add once with no time data so it still shows on the plan
          if (!placedCrns.has(crn)) {
            placedCrns.add(crn);
            events.push({
              ...section,
              courseReferenceNumber: crn,
              crn,
              subject: section.subject || subject,
              courseNumber: section.courseNumber || courseNumber,
              title: section.courseTitle || section.courseDescription || section.title || "",
              start: "",
              end: "",
              online: true,
            });
          }
          continue;
        }

        const bh = mt.beginTime.slice(0, 2);
        const bm = mt.beginTime.slice(2);
        const eh = mt.endTime.slice(0, 2);
        const em = mt.endTime.slice(2);

        for (const [day, offset] of Object.entries(dayOffsets)) {
          if (!mt[day]) continue;
          const d = new Date(refMonday);
          d.setDate(d.getDate() + offset);
          const ds =
            d.getFullYear() +
            "-" +
            String(d.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(d.getDate()).padStart(2, "0");
          // Keep full search row so modal can read meetingsFaculty, sequence, method, etc.
          events.push({
            ...section,
            courseReferenceNumber: crn,
            crn,
            subject: section.subject || subject,
            courseNumber: section.courseNumber || courseNumber,
            title:
              section.courseTitle ||
              section.courseDescription ||
              section.title ||
              "",
            start: ds + "T" + bh + ":" + bm + ":00-0500",
            end: ds + "T" + eh + ":" + em + ":00-0500",
          });
          placedCrns.add(crn);
        }
      }
      // Any CRNs in the plan that weren't found in Banner search results — add as TBA placeholders
      for (const crn of crns) {
        if (placedCrns.has(crn)) continue;
        const pc = planCourses.find((c) => String(c.courseReferenceNumber || c.crn || "") === crn);
        events.push({
          courseReferenceNumber: crn,
          crn,
          subject: pc?.subject || subject,
          courseNumber: pc?.courseNumber || courseNumber,
          title: pc?.courseTitle || pc?.title || "",
          start: "",
          end: "",
          online: true,
        });
      }
    } catch (e) {
      console.warn("[BobcatPlus] fetchPlanCalendar:", subject, courseNumber, e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Add plan courses that had no CRN (added to plan without a specific section)
  for (const course of noCrnCourses) {
    events.push({
      crn: "",
      courseReferenceNumber: "",
      subject: course.subject || "",
      courseNumber: course.courseNumber || "",
      title: course.courseTitle || course.title || "",
      start: "",
      end: "",
      online: true,
    });
  }

  return events;
}

// --- Delete a plan from TXST Plan Ahead ---
// planIndex is the 1-based sequential index (the "delete=N" value Banner uses)
export async function deleteTxstPlan(term, planIndex) {
  const { uniqueSessionId, token } = await ensureTxstPlanReadSession(term);
  if (!token) throw new Error("Could not get TXST security token.");

  const res = await fetch(REG_BASE + "/ssb/plan/delete", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-Synchronizer-Token": token,
      Origin: PLAN_ORIGIN,
      Referer: REG_BASE + "/ssb/plan/selectPlan",
    },
    body: "delete=" + encodeURIComponent(planIndex),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      "Delete failed (" + res.status + "): " + text.slice(0, 200),
    );
  }
  return { ok: true };
}

// --- Get Banner plan calendar events for a term ---
export async function getBannerPlanEvents(term) {
  try {
    const { uniqueSessionId, token } = await ensureTxstPlanReadSession(term);
    if (!token) return [];
    const q =
      "termFilter=" +
      encodeURIComponent(term) +
      "&uniqueSessionId=" +
      encodeURIComponent(uniqueSessionId);
    const res = await fetch(REG_BASE + "/ssb/plan/getPlanEvents?" + q, {
      credentials: "include",
      headers: {
        ...planMutationHeaders(token),
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => []);
    const events = normalizePlanEventsPayload(data);
    return events.length ? events : null;
  } catch (e) {
    console.warn("[BobcatPlus] getBannerPlanEvents:", e);
    return null;
  }
}
