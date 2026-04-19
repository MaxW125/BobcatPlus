//combined old Registration.js and DegreeAudit.js

const GRADE_MAP = { A: 4, B: 3, C: 2, D: 1, F: 0, CR: 4 };

const SUBJECT_MAP = {
  "Academic Enrichment": "AE",
  Accounting: "ACC",
  "Adult Education": "ADED",
  "Aerospace Studies": "A S",
  "African American Studies": "AAS",
  Agriculture: "AG",
  "American Sign Language": "ASL",
  Analytics: "ANLY",
  Anthropology: "ANTH",
  Arabic: "ARAB",
  Art: "ART",
  "Art Foundation": "ARTF",
  "Art History": "ARTH",
  "Art Studio": "ARTS",
  "Art Theory & Practice": "ARTT",
  "Athletic Training": "AT",
  "Bilingual Education": "BILG",
  Biology: "BIO",
  "Business Administration": "B A",
  "Business Law": "BLAW",
  "Career & Technical Education": "CTE",
  Chemistry: "CHEM",
  Chinese: "CHI",
  "Civil Engineering": "CE",
  "Communication Design": "ARTC",
  "Communication Disorders": "CDIS",
  "Communication Studies": "COMM",
  "Computer Science": "CS",
  "Concrete Industry Management": "CIM",
  "Construction Science & Mgmt": "CSM",
  "Consumer Affairs": "CA",
  Counseling: "COUN",
  "Criminal Justice": "CJ",
  "Curriculum & Instruction": "CI",
  Dance: "DAN",
  "Developmental Education": "DE",
  "Diversity Studies": "DVST",
  "Early Childhood Education": "ECE",
  Economics: "ECO",
  Education: "ED",
  "Education Student Teaching": "EDST",
  "Educational Leadership": "EDCL",
  "Educational Psychology": "EDP",
  "Educational Technology": "EDTC",
  "Electrical Engineering": "EE",
  Engineering: "ENGR",
  "Engineering Management": "EMGT",
  English: "ENG",
  "English, Lang Arts & Reading": "ELAR",
  "Exercise & Sports Science": "ESS",
  "Family & Consumer Sciences": "FCS",
  "Fashion Merchandising": "FM",
  Finance: "FIN",
  French: "FR",
  "General Science": "GS",
  Geography: "GEO",
  Geology: "GEOL",
  German: "GER",
  "Health & Human Performance": "HHP",
  "Health Informatics": "HI",
  "Health Information Management": "HIM",
  "Health Professions": "HP",
  "Health Sciences": "HS",
  "Healthcare Administration": "HA",
  History: "HIST",
  Honors: "HON",
  "Human Dev & Family Sciences": "HDFS",
  "IPSE Program": "RISE",
  "Industrial Engineering": "IE",
  "Information Systems": "ISAN",
  "Innovation & Entrepreneurship": "IEM",
  "Integrated Studies": "INTS",
  "Interior Design": "ID",
  "International Studies": "IS",
  Italian: "ITAL",
  Japanese: "JAPA",
  Latin: "LAT",
  "Latina/o Studies": "LATS",
  "Legal Studies": "LS",
  "Long Term Care Administration": "LTCA",
  Management: "MGT",
  "Manufacturing Engineering": "MFGE",
  Marketing: "MKT",
  "Mass Communication": "MC",
  Mathematics: "MATH",
  "Matrls Sci, Engnr, Comrclztn": "MSEC",
  "Mechanical & Manufacturing Eng": "MMIE",
  "Mechanical Engineering": "ME",
  "Medical Laboratory Science": "MLS",
  "Military Science": "MS",
  Music: "MU",
  "Music Ensemble": "MUSE",
  "Music Performance": "MUSP",
  "NCBO Mathematics": "NCBM",
  "Nature & Heritage Tourism": "NHT",
  Nursing: "NURS",
  "Nutrition & Foods": "NUTR",
  "Occupational Education": "OCED",
  Philosophy: "PHIL",
  "Physical Fitness & Wellness": "PFW",
  "Physical Therapy": "PT",
  Physics: "PHYS",
  "Political Science (POSI)": "POSI",
  "Political Science (PS)": "PS",
  Portuguese: "POR",
  Psychology: "PSY",
  "Public Administration": "PA",
  "Public Health": "PH",
  "Quant Finance & Economics": "QFE",
  "Radiation Therapy": "RTT",
  Reading: "RDG",
  Recreation: "REC",
  Religion: "REL",
  "Research & Creative Expression": "RES",
  "Respiratory Care": "RC",
  Russian: "RUSS",
  "School Psychology": "SPSY",
  "Social Work": "SOWK",
  Sociology: "SOCI",
  "Span Lang, Lit, Culture in Eng": "HSPN",
  Spanish: "SPAN",
  "Special Education": "SPED",
  Statistics: "STAT",
  "Student Affairs in Higher Ed": "SAHE",
  "Sustainability Studies": "SUST",
  Technology: "TECH",
  "The Graduate College": "GC",
  Theatre: "TH",
  "University Seminar": "US",
  "Women's Studies": "WS",
};

// --- Step 1: Fetch student info ---
async function getStudentInfo() {
  const response = await fetch(
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself",
    { credentials: "include" },
  );
  const me = await response.json();
  const student = me._embedded.students[0];
  return {
    id: student.id,
    name: student.name,
    school: student.goals[0].school.key,
    degree: student.goals[0].degree.key,
    major:
      student.goals[0].details.find((d) => d.code.key === "MAJOR")?.value
        .description || "",
  };
}

// --- Step 2: Fetch and parse degree audit ---
async function getAuditData(studentId, school, degree) {
  const auditUrl =
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/audit?studentId=" +
    studentId +
    "&school=" +
    school +
    "&degree=" +
    degree +
    "&is-process-new=false&audit-type=AA&auditId=&include-inprogress=true&include-preregistered=true&aid-term=";
  const response = await fetch(auditUrl, { credentials: "include" });
  const audit = await response.json();

  const completed = [];
  const inProgress = [];
  const needed = [];

  for (const c of audit.classInformation.classArray) {
    if (c.letterGrade === "IP") {
      inProgress.push({
        subject: c.discipline,
        courseNumber: c.number,
        title: c.courseTitle,
      });
    } else if (c.letterGrade !== "W" && c.credits > 0) {
      completed.push({
        subject: c.discipline,
        courseNumber: c.number,
        grade: c.letterGrade,
      });
    }
  }

  function findNeeded(rules) {
    for (const rule of rules) {
      if (rule.ruleArray) findNeeded(rule.ruleArray);
      if (rule.percentComplete === "100") continue;
      if (rule.ruleType !== "Course") continue;
      if (!rule.requirement || !rule.requirement.courseArray) continue;
      if (
        rule.classesAppliedToRule &&
        rule.classesAppliedToRule.classArray &&
        rule.classesAppliedToRule.classArray.length > 0
      )
        continue;
      for (const course of rule.requirement.courseArray) {
        if (course.discipline === "@" || course.number === "@") continue;
        if (course.hideFromAdvice === "Yes") continue;
        const done = completed.some(
          (c) =>
            c.subject === course.discipline && c.courseNumber === course.number,
        );
        const ip = inProgress.some(
          (c) =>
            c.subject === course.discipline && c.courseNumber === course.number,
        );
        const already = needed.some(
          (n) =>
            n.subject === course.discipline && n.courseNumber === course.number,
        );
        if (!done && !ip && !already) {
          needed.push({
            subject: course.discipline,
            courseNumber: course.number,
            label: rule.label,
          });
        }
      }
    }
  }

  for (const block of audit.blockArray) {
    if (block.ruleArray) findNeeded(block.ruleArray);
  }

  return { completed, inProgress, needed };
}

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
      console.log("[BobcatPlus] planNumber from data.planHeader.id:", v);
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
  console.log("[BobcatPlus] extracted planNumber (fallback):", best);
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

async function saveManualPlanToTxst(term, planName, rows, uniqueSessionId) {
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

// --- Step 3: Get current registration term ---
async function getCurrentTerm() {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=10",
    { credentials: "include" },
  );
  const terms = await response.json();
  const active = terms.find(
    (t) =>
      !t.description.includes("View Only") &&
      !t.description.includes("Correspondence"),
  );
  return { code: active.code, description: active.description };
}

// --- Step 4: Search for sections of a single course ---
async function searchCourse(subject, courseNumber, term) {
  await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/resetDataForm",
    { method: "POST", credentials: "include" },
  );
  await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/term/search?mode=search",
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        term: term,
        studyPath: "",
        studyPathText: "",
        startDatepicker: "",
        endDatepicker: "",
      }).toString(),
    },
  );
  const searchForm = new FormData();
  searchForm.append("txt_subject", subject);
  searchForm.append("txt_courseNumber", courseNumber);
  searchForm.append("txt_term", term);
  searchForm.append("pageOffset", "0");
  searchForm.append("pageMaxSize", "50");
  searchForm.append("sortColumn", "subjectDescription");
  searchForm.append("sortDirection", "asc");
  searchForm.append("startDatepicker", "");
  searchForm.append("endDatepicker", "");
  searchForm.append(
    "uniqueSessionId",
    subject + courseNumber + "-" + Date.now(),
  );
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/searchResults",
    { method: "POST", credentials: "include", body: searchForm },
  );
  const result = await response.json();
  if (result.success && result.data && result.data.length > 0) {
    return result.data;
  }
  return null;
}

// --- Step 5: Check prerequisites for a course ---
function checkPrereqGroup(group, completed, inProgress) {
  const prereqMatches = [
    ...group.matchAll(
      /Course or Test:\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d{4})/g,
    ),
  ];
  const gradeMatches = [...group.matchAll(/Minimum Grade of ([A-Z])/g)];
  const concurrentMatches = [
    ...group.matchAll(/May (not )?be taken concurrently/g),
  ];
  const missing = [];

  for (let i = 0; i < prereqMatches.length; i++) {
    const prereqSubject = prereqMatches[i][1].replace(/\s+/g, " ").trim();
    const prereqNumber = prereqMatches[i][2];
    const minGrade = gradeMatches[i] ? gradeMatches[i][1] : "D";
    const minGradeNum = GRADE_MAP[minGrade] || 1;
    const canTakeConcurrently =
      concurrentMatches[i] && !concurrentMatches[i][1];
    const abbrev = SUBJECT_MAP[prereqSubject] || prereqSubject;

    const match = completed.find(
      (c) => c.subject === abbrev && c.courseNumber === prereqNumber,
    );
    const ipMatch = inProgress.some(
      (c) => c.subject === abbrev && c.courseNumber === prereqNumber,
    );

    if (match && (GRADE_MAP[match.grade] || 0) >= minGradeNum) {
      continue;
    } else if (ipMatch && canTakeConcurrently) {
      continue;
    } else if (ipMatch) {
      missing.push(
        abbrev + " " + prereqNumber + " (in progress, no concurrent)",
      );
    } else {
      missing.push(abbrev + " " + prereqNumber + " (min " + minGrade + ")");
    }
  }
  return missing;
}

async function checkPrereqs(crn, term, completed, inProgress) {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/getSectionPrerequisites?term=" +
      term +
      "&courseReferenceNumber=" +
      crn,
    { credentials: "include" },
  );
  const html = await response.text();
  const orGroups = html.split(/\)\s*or\s*\(/i);

  if (orGroups.length > 1) {
    let allMissing = [];
    for (const group of orGroups) {
      const missing = checkPrereqGroup(group, completed, inProgress);
      if (missing.length === 0) return { met: true, missing: [] };
      allMissing.push(...missing);
    }
    return { met: false, missing: [...new Set(allMissing)] };
  } else {
    const prereqMatches = [
      ...html.matchAll(
        /Course or Test:\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d{4})/g,
      ),
    ];
    if (prereqMatches.length === 0) return { met: true, missing: [] };
    const andGroups = html.split(/\)\s*and\s*\(/i);
    let allMissing = [];
    for (const group of andGroups) {
      const missing = checkPrereqGroup(group, completed, inProgress);
      allMissing.push(...missing);
    }
    if (allMissing.length === 0) return { met: true, missing: [] };
    return { met: false, missing: allMissing };
  }
}

// --- Fetch course description for a section ---
async function getCourseDescription(crn, term) {
  try {
    const response = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/getCourseDescription?term=" +
        term +
        "&courseReferenceNumber=" +
        crn,
      { credentials: "include" },
    );
    const rawHtml = await response.text();
    return rawHtml
      .replace(/<[^>]*>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
  } catch (e) {
    return "";
  }
}

// --- Main analysis function ---
async function runAnalysis(sendUpdate, termCodeOverride) {
  sendUpdate({ type: "status", message: "Detecting student info..." });
  const student = await getStudentInfo();
  sendUpdate({ type: "student", data: student });

  sendUpdate({ type: "status", message: "Loading degree audit..." });
  const { completed, inProgress, needed } = await getAuditData(
    student.id,
    student.school,
    student.degree,
  );
  sendUpdate({
    type: "audit",
    data: {
      completed: completed.length,
      inProgress: inProgress.length,
      needed: needed.length,
    },
  });

  if (needed.length === 0) {
    sendUpdate({
      type: "done",
      data: { eligible: [], blocked: [], notOffered: [], needed: [] },
    });
    return;
  }

  sendUpdate({
    type: "status",
    message: "Resolving semester for section search...",
  });
  let term;
  if (termCodeOverride) {
    const terms = await getTerms();
    const found = terms.find((t) => t.code === termCodeOverride);
    term = found
      ? { code: found.code, description: found.description }
      : { code: termCodeOverride, description: termCodeOverride };
  } else {
    term = await getCurrentTerm();
  }
  sendUpdate({ type: "term", data: term });

  const eligible = [];
  const blocked = [];
  const notOffered = [];

  // Search for sections
  for (let i = 0; i < needed.length; i++) {
    const course = needed[i];
    sendUpdate({
      type: "status",
      message:
        "Searching " +
        course.subject +
        " " +
        course.courseNumber +
        " (" +
        (i + 1) +
        "/" +
        needed.length +
        ")",
    });

    try {
      const sections = await searchCourse(
        course.subject,
        course.courseNumber,
        term.code,
      );
      if (sections) {
        course.crn = sections[0].courseReferenceNumber;
        course.sections = sections;
      } else {
        notOffered.push(course);
      }
    } catch (e) {
      notOffered.push(course);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Check prereqs and fetch descriptions for eligible courses
  const coursesWithSections = needed.filter((c) => c.sections);
  for (let i = 0; i < coursesWithSections.length; i++) {
    const course = coursesWithSections[i];
    sendUpdate({
      type: "status",
      message:
        "Checking prereqs for " +
        course.subject +
        " " +
        course.courseNumber +
        " (" +
        (i + 1) +
        "/" +
        coursesWithSections.length +
        ")",
    });

    try {
      const result = await checkPrereqs(
        course.crn,
        term.code,
        completed,
        inProgress,
      );
      if (result.met) {
        sendUpdate({
          type: "status",
          message:
            "Fetching descriptions for " +
            course.subject +
            " " +
            course.courseNumber +
            "...",
        });
        for (const section of course.sections) {
          section.courseDescription = await getCourseDescription(
            section.courseReferenceNumber,
            term.code,
          );
        }
        eligible.push(course);
        sendUpdate({ type: "eligible", data: course });
      } else {
        course.missingPrereqs = result.missing;
        blocked.push(course);
        sendUpdate({ type: "blocked", data: course });
      }
    } catch (e) {
      eligible.push(course);
      sendUpdate({ type: "eligible", data: course });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  sendUpdate({ type: "done", data: { eligible, blocked, notOffered, needed } });
}

// --- Get available terms ---
async function getTerms() {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=10",
    { credentials: "include" },
  );
  const terms = await response.json();
  return terms.filter((t) => !t.description.includes("Correspondence"));
}

// --- Get Banner plan items for a term ---
async function getBannerPlanItems(term) {
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
async function getAllBannerPlans(term) {
  try {
    const { uniqueSessionId } = await ensureTxstPlanReadSession(term);
    const selectPlanHtml = await fetchPlanHtml(
      "/ssb/plan/selectPlan?uniqueSessionId=" +
        encodeURIComponent(uniqueSessionId),
    );
    const planHeaders = extractPlanHeaders(selectPlanHtml);
    console.log(
      "[BobcatPlus] getAllBannerPlans:",
      planHeaders.length,
      "plans:",
      planHeaders.map((p) => p.name),
    );
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
async function fetchPlanCalendar(term, planCourses) {
  if (!planCourses || planCourses.length === 0) return [];

  // Group planCourses by subject+courseNumber to minimise search calls
  console.log(
    "[BobcatPlus] fetchPlanCalendar: planCourses sample:",
    JSON.stringify(planCourses.slice(0, 2)),
  );
  const courseMap = new Map();
  for (const course of planCourses) {
    // Banner planCourses may use 'crn' or 'courseReferenceNumber'
    const crn = String(course.courseReferenceNumber || course.crn || "");
    if (!crn || crn === "0") continue;
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
  console.log(
    "[BobcatPlus] fetchPlanCalendar: courseMap:",
    [...courseMap.entries()].map(
      ([k, v]) => k + " => CRNs:" + [...v.crns].join(","),
    ),
  );

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
    try {
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
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data?.success || !Array.isArray(data.data)) continue;

      const returnedCRNs = data.data.map((s) =>
        String(s.courseReferenceNumber || ""),
      );
      console.log(
        "[BobcatPlus] fetchPlanCalendar:",
        subject,
        courseNumber,
        "- want:",
        JSON.stringify([...crns]),
        "- got:",
        JSON.stringify(returnedCRNs),
      );

      for (const section of data.data) {
        const crn = String(section.courseReferenceNumber || "");
        if (!crns.has(crn)) continue;
        const mt = section.meetingsFaculty?.[0]?.meetingTime;
        if (!mt?.beginTime || !mt?.endTime) continue;

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
          events.push({
            crn,
            subject: section.subject || subject,
            courseNumber: section.courseNumber || courseNumber,
            title: section.courseTitle || "",
            start: ds + "T" + bh + ":" + bm + ":00-0500",
            end: ds + "T" + eh + ":" + em + ":00-0500",
          });
        }
      }
    } catch (e) {
      console.warn("[BobcatPlus] fetchPlanCalendar:", subject, courseNumber, e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(
    "[BobcatPlus] fetchPlanCalendar: built",
    events.length,
    "events for",
    courseMap.size,
    "courses",
  );
  return events;
}

// --- Delete a plan from TXST Plan Ahead ---
// planIndex is the 1-based sequential index (the "delete=N" value Banner uses)
async function deleteTxstPlan(term, planIndex) {
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
async function getBannerPlanEvents(term) {
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

// --- Registration API sometimes returns SAML auto-post HTML (fetch does not run JS).
// Service worker has no DOMParser — use regex form extraction instead. ---
function registrationBodyLooksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("[") || t.startsWith("{");
}

function extractHtmlAttr(fragment, attrName) {
  const re = new RegExp(
    "\\b" + attrName + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1",
    "i",
  );
  const m = fragment.match(re);
  return m ? m[2] : "";
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
    console.log("[BobcatPlus] submitFirstFormFromHtmlSw:", e);
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

// --- Get current registered schedule ---
// Used by popup.js (via getSchedule message). SAML-aware: follows redirect chains
// that Banner returns when the session needs warming.
async function getCurrentSchedule(term) {
  try {
    const r1 = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/term/search?mode=registration",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ term: term }).toString(),
      },
    );
    console.log("[BobcatPlus] term/search status:", r1.status);

    const r2 = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration",
      { credentials: "include" },
    );
    console.log("[BobcatPlus] classRegistration status:", r2.status);

    const response = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents?termFilter=",
      { credentials: "include" },
    );
    console.log("[BobcatPlus] getRegistrationEvents status:", response.status);
    const eventsBase =
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents";
    let text = await response.text();
    const resolved = await resolveRegistrationHtmlToJsonSw(text, eventsBase);
    text = resolved.text;
    if (!registrationBodyLooksLikeJson(text)) {
      console.log(
        "[BobcatPlus] getRegistrationEvents non-JSON after SAML hops:",
        resolved.samlHops,
        text.slice(0, 80),
      );
      return null;
    }
    return JSON.parse(text);
  } catch (e) {
    console.log("[BobcatPlus] getCurrentSchedule error:", e);
    return null;
  }
}

// --- Login popup: opens DegreeWorks login, watches for success, closes automatically ---
function openLoginPopup(sendResponse) {
  const DW_URL =
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/WEB31";
  const REG_URL =
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/registration/registration";

  const DW_SUCCESS = "responsiveDashboard/worksheets";
  const REG_SUCCESS = "ssb/registration/registration";

  let popupWindowId = null;
  let dwDone = false;
  let cancelled = false;

  function cleanup() {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.windows.onRemoved.removeListener(onWindowClosed);
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    if (tab.windowId !== popupWindowId) return;
    if (changeInfo.status !== "complete" || !tab.url) return;

    // Step 1: DegreeWorks login succeeded — navigate to registration to warm session
    if (!dwDone && tab.url.includes(DW_SUCCESS)) {
      dwDone = true;
      chrome.tabs.update(tabId, { url: REG_URL });
      return;
    }

    // Step 2: Registration session is warm — close popup and signal success
    if (dwDone && tab.url.includes(REG_SUCCESS)) {
      cleanup();
      setTimeout(() => {
        chrome.windows.remove(popupWindowId, () => {
          chrome.runtime.sendMessage({ type: "loginSuccess" });
        });
      }, 600);
    }
  }

  function onWindowClosed(windowId) {
    if (windowId !== popupWindowId) return;
    if (cancelled) return;
    cancelled = true;
    cleanup();
    chrome.runtime.sendMessage({ type: "loginCancelled" });
  }

  chrome.windows.create(
    {
      url: DW_URL,
      type: "popup",
      width: 520,
      height: 680,
      focused: true,
    },
    (win) => {
      popupWindowId = win.id;
      chrome.tabs.onUpdated.addListener(onTabUpdated);
      chrome.windows.onRemoved.addListener(onWindowClosed);
      sendResponse({ started: true });
    },
  );
}

// --- Listen for messages from popup and full tab ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runAnalysis") {
    runAnalysis((update) => {
      chrome.runtime.sendMessage(update);
    }, message.term || null);
    sendResponse({ started: true });
  }

  if (message.action === "openFullTab") {
    chrome.tabs.create({ url: chrome.runtime.getURL("tab.html") });
    sendResponse({ opened: true });
  }

  if (message.action === "openLoginPopup") {
    openLoginPopup(sendResponse);
    return true; // keep channel open for async response
  }

  if (message.action === "getStudentInfo") {
    getStudentInfo()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getTerms") {
    getTerms()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "getSchedule") {
    getCurrentSchedule(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "runAnalysisForTerm") {
    runAnalysis((update) => {
      chrome.runtime.sendMessage(update);
    }, message.term || null);
    sendResponse({ started: true });
  }

  if (message.action === "getCourseSections") {
    searchCourse(message.subject, message.courseNumber, message.term)
      .then((data) =>
        sendResponse({
          sections: data && Array.isArray(data) ? data : [],
          found: !!(data && data.length),
        }),
      )
      .catch((e) =>
        sendResponse({
          sections: [],
          found: false,
          error: e.message || String(e),
        }),
      );
    return true;
  }

  if (message.action === "getBannerPlanItems") {
    getBannerPlanItems(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "getBannerPlanEvents") {
    getBannerPlanEvents(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getAllBannerPlans") {
    getAllBannerPlans(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "fetchPlanCalendar") {
    fetchPlanCalendar(message.term, message.planCourses || [])
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "deleteTxstPlan") {
    deleteTxstPlan(message.term, message.planIndex)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  if (message.action === "saveTxstPlan") {
    saveManualPlanToTxst(
      message.term,
      String(message.planName || "").trim(),
      message.rows || [],
      message.uniqueSessionId,
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  return true;
});
