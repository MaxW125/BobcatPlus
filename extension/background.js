//combined old Registration.js and DegreeAudit.js

// Phase 1 wiring: load the RequirementGraph parser modules so
// `self.BPReq.buildGraphFromAudit` / `deriveEligible` are available inside
// the MV3 service worker. Each module dual-exports (module.exports for Node
// tests, `globalThis.BPReq` for this runtime). RequirementGraph is the
// source of truth for `needed[]` whenever the modules load; legacy
// `findNeeded` is a fallback for the (rare) module-load failure case.
try {
  importScripts(
    "requirements/graph.js",
    "requirements/txstFromAudit.js",
    "requirements/wildcardExpansion.js",
    "performance/concurrencyPool.js",
  );
} catch (e) {
  // Never throw on module load — getAuditData falls back to legacy when
  // BPReq is missing (D13), and the BPPerf inline fallbacks below keep
  // the analysis bounded even if `performance/concurrencyPool.js` is
  // unreachable (path mismatch, stale service worker, etc). We log
  // loudly because a silent fallback previously reintroduced the prereq
  // hang bug (Bug 4 / "4-minute prereq wait" postmortem).
  console.error(
    "[BobcatPlus] importScripts failed — BPReq and/or BPPerf may be unavailable." +
      " Extension will run with inline fallbacks. Error:",
    e,
  );
}

// BPPerf guardrails — canonical implementations live in
// `performance/concurrencyPool.js` (where they're unit-tested), but the
// same logic is duplicated inline here so a failed module load does NOT
// revert to the pre-fix unbounded Promise.all + no-timeout behavior. If
// the module loaded cleanly these assignments are no-ops because `api`
// already attached mapPool/fetchWithTimeout to globalThis.BPPerf.
if (!self.BPPerf) self.BPPerf = {};
if (typeof self.BPPerf.mapPool !== "function") {
  console.warn(
    "[BobcatPlus] BPPerf.mapPool missing — using inline fallback. Check that " +
      "extension/performance/concurrencyPool.js is present and importScripts succeeded.",
  );
  self.BPPerf.mapPool = async function mapPoolInline(items, limit, mapper) {
    if (!Array.isArray(items)) throw new TypeError("mapPool: items must be an array");
    const n = items.length;
    const results = new Array(n);
    if (n === 0) return results;
    const cap = Math.max(1, Math.min(n, limit | 0));
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < cap; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = cursor++;
            if (i >= n) return;
            results[i] = await mapper(items[i], i);
          }
        })(),
      );
    }
    await Promise.all(workers);
    return results;
  };
}
if (typeof self.BPPerf.fetchWithTimeout !== "function") {
  console.warn(
    "[BobcatPlus] BPPerf.fetchWithTimeout missing — using inline fallback.",
  );
  self.BPPerf.fetchWithTimeout = async function fetchWithTimeoutInline(url, options, timeoutMs) {
    const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 12000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (e) { /* already aborted */ }
    }, ms);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

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
function trimStr(v) {
  return v != null && String(v).trim() !== "" ? String(v).trim() : "";
}

function pickGpaNumber(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = parseFloat(String(v).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 0 && n <= 4.5) return n;
  }
  return null;
}

async function getStudentInfo() {
  const response = await fetch(
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself",
    { credentials: "include" },
  );
  const me = await response.json();
  const student = me._embedded?.students?.[0];
  if (!student) throw new Error("No student record");
  const goal = student.goals?.[0];
  if (!goal) throw new Error("No academic goal");

  const details = goal.details || [];
  const detailDesc = (key) =>
    details.find((d) => d.code?.key === key)?.value?.description ||
    details.find((d) => d.code?.key === key)?.value?.title ||
    "";

  const minorRaw = detailDesc("MINOR");

  return {
    id: student.id,
    name: student.name,
    school: goal.school.key,
    degree: goal.degree.key,
    major: detailDesc("MAJOR") || "",
    minor: minorRaw ? minorRaw : null,
    cumulativeGPA: pickGpaNumber(
      student.cumulativeGPA,
      student.cumulativeGpa,
      student.gpa,
    ),
    institutionalGPA: pickGpaNumber(
      student.institutionalGPA,
      student.institutionalGpa,
      student.bannerGPA,
      student.bannerGpa,
      student.institutionGPA,
      student.gpaInstitution,
    ),
    classification:
      trimStr(student.academicLevel?.description) ||
      trimStr(student.level?.description) ||
      trimStr(student.studentLevelDescription) ||
      trimStr(student.classStanding) ||
      trimStr(student.classification) ||
      "",
  };
}

function auditNum(v) {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function blockHeading(b) {
  return String(
    b.title || b.label || b.blockLabel || b.blockTitle || "",
  ).trim();
}

function parsePercentComplete(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/%/g, "").trim());
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

function reqCreditsFromNode(node) {
  return auditNum(
    node.creditsRequired ??
      node.creditHoursRequired ??
      node.requiredCredits ??
      node.minimumCreditsRequired ??
      node.minimumCredits ??
      node.hoursRequired ??
      node.creditsTotal ??
      node.totalCreditsRequired ??
      node.degreeCreditsRequired ??
      node.hoursInProgram,
  );
}

function appliedCreditsFromNode(node) {
  return auditNum(
    node.creditsApplied ??
      node.creditHoursApplied ??
      node.creditsEarned ??
      node.appliedCredits ??
      node.hoursEarned ??
      node.totalCreditsApplied ??
      node.degreeCreditsApplied ??
      node.creditHoursIncluded,
  );
}

/**
 * Degree Works often labels fields *Credits*Required / *Credits*Applied (screenshot parity).
 * Picks the strongest req/applied pair on one object without walking into arrays.
 */
function findCreditPairOnObject(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  let req = 0;
  let app = 0;
  for (const [k, v] of Object.entries(o)) {
    const kl = k.toLowerCase();
    if (!/credit|hour/i.test(kl)) continue;
    const n = auditNum(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (/required|minimum|mandatory/i.test(kl)) req = Math.max(req, n);
    if (/applied|complete|earned|satisfied/i.test(kl)) app = Math.max(app, n);
  }
  if (req > 0) return { req, app };
  return null;
}

/** stillNeeded + minimumCredits (Degree Works degree block). */
function findProgressFromStillNeeded(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const min = auditNum(
    o.minimumCredits ??
      o.minimumCreditHours ??
      o.degreeCreditsRequired ??
      o.totalDegreeCredits ??
      o.creditsRequiredForDegree,
  );
  const still = auditNum(
    o.stillNeeded ??
      o.stillNeededCredits ??
      o.creditsStillNeeded ??
      o.degreeCreditsStillNeeded,
  );
  if (min > 0 && Number.isFinite(still) && still >= 0 && still <= min * 2) {
    const applied = Math.max(0, min - still);
    return { req: min, app: applied };
  }
  return null;
}

function findCreditPairDeep(o, depth = 0, maxDepth = 5) {
  if (!o || typeof o !== "object" || depth > maxDepth) return null;
  const still = findProgressFromStillNeeded(o);
  if (still) return still;
  const direct = findCreditPairOnObject(o);
  if (direct) return direct;
  for (const v of Object.values(o)) {
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const el of v) {
        if (el && typeof el === "object") {
          const p = findCreditPairDeep(el, depth + 1, maxDepth);
          if (p) return p;
        }
      }
      continue;
    }
    const p = findCreditPairDeep(v, depth + 1, maxDepth);
    if (p) return p;
  }
  return null;
}

/** Match exactly “Freshman” / “Senior” label somewhere in the audit tree. */
function findExactStandingLabel(root, maxVisit = 500) {
  const re = /^(Freshman|Sophomore|Junior|Senior)$/i;
  const stack = [root];
  let visit = 0;
  while (stack.length && visit < maxVisit) {
    const o = stack.pop();
    visit++;
    if (!o || typeof o !== "object") continue;
    for (const v of Object.values(o)) {
      if (typeof v === "string") {
        const t = v.trim();
        if (t.length < 24 && re.test(t)) {
          const m = t.match(re);
          if (m)
            return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
        }
      } else if (Array.isArray(v)) {
        for (const el of v) {
          if (el && typeof el === "object") stack.push(el);
        }
      } else if (v && typeof v === "object") {
        stack.push(v);
      }
    }
  }
  return "";
}

function pickInstitutionalCreditsForClassification(audit) {
  const ci = audit.classInformation;
  if (!ci || typeof ci !== "object") return null;
  for (const [k, v] of Object.entries(ci)) {
    if (!/credit|hour|hrs/i.test(k.toLowerCase())) continue;
    if (/transfer|transferr|transferr?ing/i.test(k.toLowerCase())) continue;
    if (!/inst|txst|texas|resident|degree/i.test(k.toLowerCase())) continue;
    const n = auditNum(v);
    if (n >= 12 && n <= 250) return n;
  }
  return null;
}

/** Sum credits + weighted progress from nested rule trees (Ellucian nested ruleArray). */
function aggregateRequirementTree(nodes) {
  let totalReq = 0;
  let earnedWeighted = 0;
  for (const node of nodes || []) {
    if (node.ruleArray && node.ruleArray.length > 0) {
      const sub = aggregateRequirementTree(node.ruleArray);
      totalReq += sub.totalReq;
      earnedWeighted += sub.earnedWeighted;
      continue;
    }
    const req = reqCreditsFromNode(node);
    const pct = parsePercentComplete(node.percentComplete);
    if (req > 0) {
      totalReq += req;
      if (pct != null) {
        earnedWeighted += req * (pct / 100);
      } else {
        earnedWeighted += Math.min(appliedCreditsFromNode(node), req);
      }
    }
  }
  return { totalReq, earnedWeighted };
}

/** Prefer nested rules so we do not double-count block summaries + rule leaves. */
function aggregateBlockProgress(block) {
  const still = findProgressFromStillNeeded(block);
  if (still && still.req > 0) {
    return {
      totalReq: still.req,
      earnedWeighted: Math.min(still.app, still.req),
    };
  }

  const sub = aggregateRequirementTree(block.ruleArray);
  if (sub.totalReq > 0) return sub;

  let headReq = reqCreditsFromNode(block);
  let applied = appliedCreditsFromNode(block);
  if (headReq <= 0) {
    const pair = findCreditPairOnObject(block);
    if (pair) {
      headReq = pair.req;
      applied = Math.max(applied, pair.app);
    }
  }
  if (headReq <= 0) {
    const deep = findCreditPairDeep(block, 0, 5);
    if (deep && deep.req > 0) {
      headReq = deep.req;
      applied = Math.max(applied, deep.app);
    }
  }
  const pctBlock = parsePercentComplete(block.percentComplete);
  if (headReq <= 0) return { totalReq: 0, earnedWeighted: 0 };

  let earnedWeighted = 0;
  if (pctBlock != null) earnedWeighted += headReq * (pctBlock / 100);
  else earnedWeighted += Math.min(applied, headReq);
  return { totalReq: headReq, earnedWeighted };
}

/**
 * Combined progress from all top-level audit blocks (credits live under ruleArray).
 * Minor flag comes from Degree Works titles and the student goal.
 */
function aggregateMajorMinorProgress(audit, studentMinorHint) {
  const blocks = audit.blockArray || [];
  let hasMinor = !!(
    studentMinorHint && String(studentMinorHint).trim()
  );

  let useReq = 0;
  let useEarned = 0;

  for (const b of blocks) {
    const titleLower = blockHeading(b).toLowerCase();
    if (/\bminor\b/i.test(titleLower)) hasMinor = true;

    const agg = aggregateBlockProgress(b);
    useReq += agg.totalReq;
    useEarned += agg.earnedWeighted;
  }

  if (useReq <= 0) {
    for (const b of blocks) {
      const t = blockHeading(b).toLowerCase();
      if (!/\bdegree|bachelor|master|program|major|minor\b/i.test(t)) continue;
      const p =
        findCreditPairDeep(b, 0, 6) ?? findCreditPairOnObject(b);
      if (p && p.req > 0) {
        useReq = p.req;
        useEarned = Math.min(p.app, p.req);
        break;
      }
    }
  }
  if (useReq <= 0) {
    const rootPair =
      findCreditPairDeep(audit, 0, 4) ?? findCreditPairOnObject(audit);
    if (rootPair) {
      useReq = rootPair.req;
      useEarned = Math.min(rootPair.app, rootPair.req);
    }
  }

  let pctFromDegreeBlock = null;
  for (const b of blocks) {
    const t = blockHeading(b).toLowerCase();
    const pc = parsePercentComplete(b.percentComplete);
    if (
      pc != null &&
      /\bdegree|bachelor|program|major|bulletin\b/i.test(t)
    ) {
      pctFromDegreeBlock = Math.round(pc);
      break;
    }
  }

  const progressPercent =
    pctFromDegreeBlock != null
      ? pctFromDegreeBlock
      : useReq > 0
        ? Math.min(100, Math.round((useEarned / useReq) * 100))
        : null;
  const creditsEarned =
    useReq > 0 ? Math.round(useEarned * 100) / 100 : null;

  return {
    creditsRequiredMajorMinor: useReq > 0 ? useReq : null,
    creditsEarnedMajorMinor: creditsEarned,
    progressPercent,
    hasMinor,
  };
}

function pickGpaFromAuditObject(o, keys) {
  if (!o || typeof o !== "object") return null;
  for (const k of keys) {
    if (o[k] != null && o[k] !== "") {
      const n = pickGpaNumber(o[k]);
      if (n != null) return n;
    }
  }
  return null;
}

/** Heuristic key scan for Banner / Degree Works variants not covered by fixed key lists. */
function scanObjectForGpas(o) {
  let institutional = null;
  let cumulative = null;
  if (!o || typeof o !== "object") {
    return { institutional, cumulative };
  }
  const entries = Object.entries(o);
  for (const [k, v] of entries) {
    if (v == null || v === "") continue;
    const n = pickGpaNumber(v);
    if (n == null) continue;
    const kl = k.toLowerCase();
    const looksInst =
      /institution|institutional|banner|resident|texas|txst|gpa.?tx|tx\.?\s*state/i.test(
        kl,
      );
    if (looksInst && institutional == null) institutional = n;
  }
  for (const [k, v] of entries) {
    if (v == null || v === "") continue;
    const n = pickGpaNumber(v);
    if (n == null) continue;
    const kl = k.toLowerCase();
    const looksInst =
      /institution|institutional|banner|resident|texas|txst|gpa.?tx|tx\.?\s*state/i.test(
        kl,
      );
    const looksCum =
      /cumulative|overall|combined|total(?!\s*credit)/i.test(kl) ||
      /^gpaoverall$/i.test(k.replace(/\s/g, ""));
    if (!looksInst && looksCum && cumulative == null) cumulative = n;
  }
  for (const [k, v] of entries) {
    if (v == null || v === "") continue;
    const n = pickGpaNumber(v);
    if (n == null) continue;
    if (/^gpa$/i.test(k) && cumulative == null) cumulative = n;
  }
  return { institutional, cumulative };
}

function scanObjectForClassification(o) {
  if (!o || typeof o !== "object") return "";
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (/^classification$/i.test(k)) return trimStr(v);
  }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (!/(standing|level|class|year|rank)/i.test(k)) continue;
    const t = trimStr(v);
    if (
      /freshman|sophomore|junior|senior|grad|undergrad|master|doctoral|first|second|third|fourth/i.test(
        t,
      )
    ) {
      return t;
    }
  }
  return "";
}

function scanObjectForGpasDeep(o, depth = 0) {
  let institutional = null;
  let cumulative = null;
  if (!o || typeof o !== "object" || depth > 2) {
    return { institutional, cumulative };
  }
  const flat = scanObjectForGpas(o);
  institutional = flat.institutional;
  cumulative = flat.cumulative;
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    if (/^classArray$/i.test(k)) continue;
    const inner = scanObjectForGpasDeep(v, depth + 1);
    institutional = institutional ?? inner.institutional;
    cumulative = cumulative ?? inner.cumulative;
  }
  return { institutional, cumulative };
}

function extractGpaAndClassificationFromAudit(audit, studentRow) {
  let gpaTexasState =
    pickGpaFromAuditObject(audit, [
      "institutionalGPA",
      "institutionalGpa",
      "bannerGPA",
      "bannerGpa",
      "gpaInstitution",
      "instGPA",
      "institutionGPA",
      "txstGPA",
      "txstGpa",
      "gpaTxst",
    ]) ?? studentRow.institutionalGPA;
  let gpaOverall =
    pickGpaFromAuditObject(audit, [
      "cumulativeGPA",
      "cumulativeGpa",
      "overallGPA",
      "overallGpa",
      "totalGPA",
      "combinedGPA",
      "gpa",
      "gpaOverall",
    ]) ?? studentRow.cumulativeGPA;

  const auditDeep = scanObjectForGpasDeep(audit);
  gpaTexasState = gpaTexasState ?? auditDeep.institutional;
  gpaOverall = gpaOverall ?? auditDeep.cumulative;

  let classification =
    trimStr(audit.classification) ||
    trimStr(audit.studentClassification) ||
    trimStr(audit.studentClassDescription) ||
    trimStr(audit.classStandingDescription) ||
    trimStr(audit.academicLevelDescription) ||
    trimStr(studentRow.classification);

  for (const hdr of [
    audit.studentHeader,
    audit.header,
    audit.auditHeader,
    audit.degreeHeader,
    audit.studentSummary,
  ]) {
    if (!hdr || typeof hdr !== "object") continue;
    const hGpa = scanObjectForGpas(hdr);
    gpaTexasState = gpaTexasState ?? hGpa.institutional;
    gpaOverall = gpaOverall ?? hGpa.cumulative;
    classification =
      classification ||
      scanObjectForClassification(hdr) ||
      trimStr(hdr.classification);
  }

  const ci = audit.classInformation;
  if (ci && typeof ci === "object") {
    gpaTexasState =
      gpaTexasState ??
      pickGpaFromAuditObject(ci, [
        "institutionalGPA",
        "institutionalGpa",
        "instGPA",
        "institutionGPA",
      ]);
    gpaOverall =
      gpaOverall ??
      pickGpaFromAuditObject(ci, [
        "cumulativeGPA",
        "cumulativeGpa",
        "gpa",
        "overallGPA",
        "overallGpa",
      ]);

    const scanned = scanObjectForGpas(ci);
    gpaTexasState = gpaTexasState ?? scanned.institutional;
    gpaOverall = gpaOverall ?? scanned.cumulative;

    classification =
      classification ||
      scanObjectForClassification(ci) ||
      trimStr(ci.studentClassDescription) ||
      trimStr(ci.classStandingDescription);

    if (Array.isArray(ci.classArray)) {
      for (const row of ci.classArray) {
        if (!row || typeof row !== "object") continue;
        const rScan = scanObjectForGpas(row);
        gpaTexasState = gpaTexasState ?? rScan.institutional;
        gpaOverall = gpaOverall ?? rScan.cumulative;
        if (!classification) {
          classification =
            scanObjectForClassification(row) ||
            trimStr(row.classStanding) ||
            trimStr(row.academicLevelDescription);
        }
      }
    }
  }

  const si = audit.studentInformation;
  if (si && typeof si === "object") {
    gpaTexasState =
      gpaTexasState ??
      pickGpaFromAuditObject(si, [
        "institutionalGPA",
        "institutionalGpa",
      ]);
    gpaOverall =
      gpaOverall ??
      pickGpaFromAuditObject(si, [
        "cumulativeGPA",
        "cumulativeGpa",
        "gpa",
      ]);
    const sScan = scanObjectForGpas(si);
    gpaTexasState = gpaTexasState ?? sScan.institutional;
    gpaOverall = gpaOverall ?? sScan.cumulative;
    classification =
      classification ||
      trimStr(si.classStanding) ||
      trimStr(si.studentClass) ||
      scanObjectForClassification(si);
  }

  const deepGp = deepCollectGpasFromAudit(audit);
  gpaTexasState = gpaTexasState ?? deepGp.institutional;
  gpaOverall = gpaOverall ?? deepGp.cumulative;

  return {
    gpaTexasState,
    gpaOverall,
    classification,
  };
}

function classifyByEarnedCredits(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return "";
  if (n < 30) return "Freshman";
  if (n < 60) return "Sophomore";
  if (n < 90) return "Junior";
  return "Senior";
}

async function fetchAuditJson(studentId, school, degree) {
  const auditUrl =
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/audit?studentId=" +
    studentId +
    "&school=" +
    school +
    "&degree=" +
    degree +
    "&is-process-new=false&audit-type=AA&auditId=&include-inprogress=true&include-preregistered=true&aid-term=";
  const response = await fetch(auditUrl, { credentials: "include" });
  if (!response.ok) return null;
  const raw = await response.json();
  return unwrapAuditPayload(raw);
}

/** API may return `{ data: audit }`, `{ result: audit }`, etc. */
function unwrapAuditPayload(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const candidates = [
    raw.data,
    raw.result,
    raw.audit,
    raw.payload,
    raw._embedded?.audit,
    raw.response,
  ];
  for (const c of candidates) {
    if (
      c &&
      typeof c === "object" &&
      (Array.isArray(c.blockArray) ||
        c.classInformation ||
        Array.isArray(c.studentHeader))
    ) {
      return c;
    }
  }
  return raw;
}

/**
 * Walk audit JSON for Banner/Degree Works GPA keys (handles nested header/summary).
 * Only accepts numeric values in [0, 4.5] via pickGpaNumber.
 */
function deepCollectGpasFromAudit(audit, maxDepth = 12) {
  let institutional = null;
  let cumulative = null;

  function consider(k, v) {
    const kl = String(k).toLowerCase();
    const n = pickGpaNumber(v);
    if (n == null) return;

    const skip =
      /high\s*school|secondary|transfer\s*gpa|rank|percentile|size|cohort|email|phone|zip|salary|fee|cost|balance|hour|credit(?!\s*gpa)|sat|act/i.test(
        kl,
      );
    if (skip) return;

    const looksInst =
      /\b(institution|institutional|banner|resident|texas|txst|gpa\s*inst|inst\s*gpa|inst\.?\s*gpa|local\s*gpa)\b/i.test(
        kl,
      ) ||
      (/txst/i.test(kl) && /gpa|point/i.test(kl));
    const looksCum =
      /\b(cumulative|overall|combined|career|degree\s*gpa|gpa\s*overall|^gpa$)\b/i.test(
        kl,
      ) ||
      (/gpa/i.test(kl) && /overall|cumulative|degree|program|total(?!\s*credit)/i.test(kl));

    if (looksInst && institutional == null) institutional = n;
    if (looksCum && cumulative == null) cumulative = n;
  }

  function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > maxDepth) return;
    if (Array.isArray(o)) {
      for (const item of o) walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number" || typeof v === "string") consider(k, v);
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  }

  walk(audit, 0);

  if (institutional == null && cumulative == null) {
    const any = [];
    function collectGpaKeys(o, depth) {
      if (!o || typeof o !== "object" || depth > maxDepth) return;
      for (const [k, v] of Object.entries(o)) {
        if (/\bgpa\b/i.test(k)) {
          const n = pickGpaNumber(v);
          if (n != null) any.push(n);
        } else if (v && typeof v === "object") {
          if (Array.isArray(v)) {
            for (const el of v) collectGpaKeys(el, depth + 1);
          } else {
            collectGpaKeys(v, depth + 1);
          }
        }
      }
    }
    collectGpaKeys(audit, 0);
    if (any.length >= 1) {
      institutional = any[0];
      cumulative = any.length > 1 ? any[any.length - 1] : any[0];
    }
  }

  return { institutional, cumulative };
}

/**
 * Degree audit summary for overview: major+minor credit progress, GPAs, classification.
 */
async function getDegreeAuditOverview() {
  const student = await getStudentInfo();
  const audit = await fetchAuditJson(student.id, student.school, student.degree);
  if (!audit) {
    const out = {
      ...student,
      creditsRequiredMajorMinor: null,
      creditsEarnedMajorMinor: null,
      progressPercent: null,
      hasMinor: !!(student.minor && String(student.minor).trim()),
      gpaTexasState: student.institutionalGPA,
      gpaOverall: student.cumulativeGPA,
      classification: student.classification || "",
    };
    return out;
  }

  const mm = aggregateMajorMinorProgress(audit, student.minor);
  const gp = extractGpaAndClassificationFromAudit(audit, student);

  let classification = gp.classification;
  if (!classification) classification = findExactStandingLabel(audit);
  if (!classification) {
    const instCr = pickInstitutionalCreditsForClassification(audit);
    if (instCr != null) classification = classifyByEarnedCredits(instCr);
  }
  if (!classification && mm.creditsEarnedMajorMinor != null) {
    classification = classifyByEarnedCredits(mm.creditsEarnedMajorMinor);
  }

  const merged = {
    ...student,
    ...mm,
    gpaTexasState: gp.gpaTexasState ?? student.institutionalGPA,
    gpaOverall: gp.gpaOverall ?? student.cumulativeGPA,
    classification,
    hasMinor:
      mm.hasMinor || !!(student.minor && String(student.minor).trim()),
  };

  const txNum = pickGpaNumber(
    merged.gpaTexasState,
    gp.gpaTexasState,
    student.institutionalGPA,
    student.institutionalGpa,
    student.bannerGPA,
    student.bannerGpa,
  );
  const ovNum = pickGpaNumber(
    merged.gpaOverall,
    gp.gpaOverall,
    student.cumulativeGPA,
    student.cumulativeGpa,
    student.gpa,
  );
  if (txNum != null) merged.gpaTexasState = txNum;
  if (ovNum != null) merged.gpaOverall = ovNum;
  if (merged.gpaOverall == null && merged.gpaTexasState != null) {
    merged.gpaOverall = merged.gpaTexasState;
  }
  return merged;
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
  const audit = unwrapAuditPayload(await response.json());

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

  // Phase 0 Bug 4 instrumentation: track every course entry we drop and WHY.
  // Does NOT change behavior — still drops the same entries — but lets us
  // measure the blast radius before the Phase X fix lands.
  const dropped = {
    wildcards: [],        // discipline === "@" || number === "@"
    hideFromAdvice: [],   // course.hideFromAdvice === "Yes"
    alreadyListed: [],    // duplicate course across rules (collapse of many-to-many)
    ruleNotCourse: [],    // rule.ruleType !== "Course" but had non-Course content with options
    completePercent: [],  // rule.percentComplete === "100" (skipped whole subtree)
  };
  const exceptClauses = []; // rule-level except arrays (today: ignored)

  function findNeeded(rules, parentLabels = []) {
    for (const rule of rules) {
      if (rule.ruleArray) findNeeded(rule.ruleArray, parentLabels.concat([rule.label || ""]));
      if (String(rule.percentComplete) === "100") {
        if (rule.ruleType !== "Block") {
          dropped.completePercent.push({
            ruleType: rule.ruleType,
            label: rule.label,
            parentLabels: parentLabels.slice(),
          });
        }
        continue;
      }
      // Track except clauses for later — Phase X will honor them.
      if (rule.requirement && Array.isArray(rule.requirement.except) && rule.requirement.except.length) {
        exceptClauses.push({
          label: rule.label,
          parentLabels: parentLabels.slice(),
          except: rule.requirement.except,
        });
      }
      if (rule.ruleType !== "Course") {
        if (rule.requirement && rule.requirement.courseArray && rule.requirement.courseArray.length) {
          dropped.ruleNotCourse.push({
            ruleType: rule.ruleType,
            label: rule.label,
            parentLabels: parentLabels.slice(),
            courseCount: rule.requirement.courseArray.length,
          });
        }
        continue;
      }
      if (!rule.requirement || !rule.requirement.courseArray) continue;
      for (const course of rule.requirement.courseArray) {
        if (course.discipline === "@" || course.number === "@") {
          dropped.wildcards.push({
            discipline: course.discipline,
            number: course.number,
            label: rule.label,
            parentLabels: parentLabels.slice(),
            withArray: course.withArray || null,
          });
          continue;
        }
        if (course.hideFromAdvice === "Yes") {
          dropped.hideFromAdvice.push({
            subject: course.discipline,
            courseNumber: course.number,
            label: rule.label,
            parentLabels: parentLabels.slice(),
          });
          continue;
        }
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
        if (already && !done && !ip) {
          dropped.alreadyListed.push({
            subject: course.discipline,
            courseNumber: course.number,
            label: rule.label,
            parentLabels: parentLabels.slice(),
            note: "course satisfies multiple rules; only first rule.label is retained",
          });
        }
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
    if (block.ruleArray) findNeeded(block.ruleArray, [block.title || ""]);
  }

  // Phase 0: dump the tally + (optionally) samples so we can size Bug 4 precisely.
  // Kept behind a debug flag so production runs stay quiet unless asked.
  try {
    const { bp_debug_audit } = await chrome.storage.local.get("bp_debug_audit");
    if (bp_debug_audit) {
      console.log("[BP audit drops]", {
        counts: {
          wildcards: dropped.wildcards.length,
          hideFromAdvice: dropped.hideFromAdvice.length,
          alreadyListed: dropped.alreadyListed.length,
          ruleNotCourse: dropped.ruleNotCourse.length,
          completePercent: dropped.completePercent.length,
          exceptClauses: exceptClauses.length,
        },
        sample: {
          wildcards: dropped.wildcards.slice(0, 5),
          hideFromAdvice: dropped.hideFromAdvice.slice(0, 5),
          alreadyListed: dropped.alreadyListed.slice(0, 5),
          ruleNotCourse: dropped.ruleNotCourse.slice(0, 5),
          exceptClauses: exceptClauses.slice(0, 3),
        },
      });
    }
  } catch (_) {
    // chrome.storage not available in some test contexts; never throw from here
  }

  // Phase 1 wiring — see docs/decisions.md D13 (implementation) and D17
  // (flag removal). RequirementGraph is the authoritative source for
  // needed[] whenever the BPReq modules loaded successfully. Legacy
  // findNeeded remains as the fallback for the module-load failure path
  // called out in D13's postmortem. Parity diagnostics stay attached to
  // auditDiagnostics so regressions show up in the trace.
  let graph = null;
  let derivedEntries = null;
  let derivedWildcards = null;
  let parity = null;

  const bpReqReady =
    typeof self !== "undefined" &&
    self.BPReq &&
    typeof self.BPReq.buildGraphFromAudit === "function" &&
    typeof self.BPReq.deriveEligible === "function";

  if (bpReqReady) {
    try {
      graph = self.BPReq.buildGraphFromAudit(audit);
      const derived = self.BPReq.deriveEligible(graph);
      derivedEntries = derived.entries || [];
      derivedWildcards = derived.wildcards || [];
      parity = computeAuditParity(needed, derivedEntries);
    } catch (e) {
      console.warn("[BobcatPlus] Phase 1 parser failed; falling back to legacy needed[]:", e);
      graph = null;
      derivedEntries = null;
      derivedWildcards = null;
      parity = { error: e.message || String(e) };
    }
  } else {
    console.warn(
      "[BobcatPlus] BPReq modules not loaded; using legacy findNeeded. " +
        "Check that requirements/*.js sit next to background.js and that " +
        "importScripts succeeded at module load.",
    );
  }

  // When the derived entries are usable, the new parser is the source of
  // truth for needed[]. The flat shape is identical enough that downstream
  // code (runAnalysis → searchCourse) works unchanged.
  let finalNeeded = needed;
  if (derivedEntries && derivedEntries.length > 0) {
    finalNeeded = derivedEntries
      .filter((e) => !e.hideFromUi) // hideFromAdvice fallbacks: surface in graph, not in needed
      .map((e) => ({
        subject: e.subject,
        courseNumber: e.courseNumber,
        label: e.label || "",
        parentLabels: e.parentLabels || [],
        ruleId: e.ruleId || null,
      }));
  }

  return {
    completed,
    inProgress,
    needed: finalNeeded,
    auditDiagnostics: { dropped, exceptClauses, parity },
    graph,
    wildcards: derivedWildcards,
  };
}

// Compute a legacy-vs-new parity summary: which courses are listed by
// findNeeded but not the new parser, which are new-only, and a cheap sample
// of each for log readability. Pure, no I/O.
function computeAuditParity(legacy, derived) {
  function key(c) {
    return (c.subject || "") + "|" + (c.courseNumber || "");
  }
  const legacyKeys = new Map();
  for (const c of legacy) legacyKeys.set(key(c), c);
  const derivedKeys = new Map();
  for (const c of derived) derivedKeys.set(key(c), c);
  const onlyInLegacy = [];
  const onlyInDerived = [];
  for (const [k, v] of legacyKeys) {
    if (!derivedKeys.has(k)) onlyInLegacy.push(v);
  }
  for (const [k, v] of derivedKeys) {
    if (!legacyKeys.has(k)) onlyInDerived.push(v);
  }
  return {
    legacyCount: legacy.length,
    derivedCount: derived.length,
    onlyInLegacy,
    onlyInDerived,
    sampleOnlyInLegacy: onlyInLegacy.slice(0, 5),
    sampleOnlyInDerived: onlyInDerived.slice(0, 5),
  };
}

// --- Step 2.5: Expand wildcard requirement entries via DegreeWorks ---
//
// Bug 4 Layer B. RequirementGraph surfaces wildcards (`CS 4@`, `MATH @`,
// etc.) alongside concrete entries, but until now we had no way to turn
// them into actual course picks — they were silently dropped so the
// eligible pool was missing every subject-wildcard requirement (major
// electives, BA science, etc.).
//
// This fetcher hits DegreeWorks' `/api/course-link` endpoint (response
// wrapped in a `courseInformation` envelope, hence the legacy module
// naming). URL captured from a live DevTools trace on the CS BS audit:
//
//   GET https://dw-prod.ec.txstate.edu/responsiveDashboard/api/course-link
//       ?discipline={SUBJECT}&number={NUMBER_PATTERN}
//
// Session cookie via `credentials: "include"`; no body, no CSRF token.
// Works from the extension background because `dw-prod.ec.txstate.edu`
// is in manifest.host_permissions. Cached for 1h in chrome.storage.local
// (matches the `course` TTL — wildcard expansions are basically stable
// over a single browsing session and we'd rather eat a stale cache than
// hammer DW on every audit reload).
//
// The pure orchestrator that consumes this — dedup, except subtraction,
// termCode filtering — lives in `requirements/wildcardExpansion.js` as
// `BPReq.expandAuditWildcards`. Split intentional: this function is the
// ONLY piece that touches the network + chrome.storage, so it stays
// testable via a mocked fetcher in Node (see
// `tests/unit/wildcardExpansion.test.js`).
async function fetchCourseLinkFromDW(subject, numberPattern) {
  if (!subject || !numberPattern) return null;
  const key = `courseLink|${subject}|${numberPattern}`;
  const cached = await cacheGet(key, CACHE_TTL.courseInfo);
  if (cached) return cached;

  const url =
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/course-link" +
    "?discipline=" + encodeURIComponent(subject) +
    "&number=" + encodeURIComponent(numberPattern);

  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      console.warn(
        "[BobcatPlus] course-link HTTP " + response.status + " for " +
          subject + " " + numberPattern,
      );
      return null;
    }
    const raw = await response.json();
    // Guard against DW occasionally serving an HTML error page with a
    // 200 status; refuse to cache anything that isn't the expected
    // envelope so the hour-long TTL doesn't lock us into a bad payload.
    const hasCourses =
      raw &&
      raw.courseInformation &&
      Array.isArray(raw.courseInformation.courses);
    if (!hasCourses) {
      console.warn(
        "[BobcatPlus] course-link returned no courseInformation.courses for " +
          subject + " " + numberPattern,
      );
      return null;
    }
    await cacheSet(key, raw);
    return raw;
  } catch (e) {
    console.warn(
      "[BobcatPlus] course-link fetch failed for " + subject + " " +
        numberPattern + ":",
      e,
    );
    return null;
  }
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
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=25",
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

// Banner's StudentRegistrationSsb session has a single "current term" per mode;
// interleaved calls across terms corrupt which response ties to which request.
// Serialize every session-state-mutating operation through this queue.
let sessionQueue = Promise.resolve();
function withSessionLock(fn) {
  const task = sessionQueue.then(fn, fn);
  sessionQueue = task.then(() => {}, () => {});
  return task;
}

// ============================================================
// chrome.storage.local cache helpers
// TTLs: course sections 1h, prerequisites 24h, descriptions 7d, terms 24h
// ============================================================
const CACHE_TTL = {
  course:     60 * 60 * 1000,           // 1 hour  — seats change but not by the minute
  prereq:     24 * 60 * 60 * 1000,      // 24 hours — fixed once schedule publishes
  desc:       7  * 24 * 60 * 60 * 1000, // 7 days  — truly static
  terms:      24 * 60 * 60 * 1000,      // 24 hours
  courseInfo: 60 * 60 * 1000,           // 1 hour  — DW wildcard expansion (same cadence as `course`)
};

async function cacheGet(key, ttl) {
  try {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (entry && Date.now() - entry.ts < ttl) return entry.data;
  } catch (e) {}
  return null;
}

async function cacheSet(key, data) {
  try {
    await chrome.storage.local.set({ [key]: { data, ts: Date.now() } });
  } catch (e) {}
}

// Returns the timestamp (ms) of a cached entry, or null if missing/expired.
async function cacheAge(key, ttl) {
  try {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (entry && Date.now() - entry.ts < ttl) return entry.ts;
  } catch (e) {}
  return null;
}

// --- Step 4a: Batch section search — one paginated Banner call per subject.
//
// This replaces the per-course call-pattern that used to drive runAnalysis
// and was the dominant bottleneck (see docs/bug4-eligible-diagnosis.md:
// "20-25s for 123 courses"). Each single-course searchCourse call does a
// 3-request handshake (resetDataForm + term/search + searchResults), all
// serialized behind the withSessionLock queue. Batching by subject collapses
// N courses across K subjects into a single session handshake plus one
// paginated searchResults call per subject — typically K≈10-15 vs N≈120.
//
// Results are cached under `subjectSearch|${term}|${subject}` with the
// same 1h TTL as single-course search, and also fan out into the legacy
// per-course cache key so the `getCourseSections` UI message handler
// (which still calls the single-course searchCourse path) sees a warm
// cache after any analysis run.
async function searchCoursesBySubjects(
  subjects,
  term,
  { forceRefresh = false } = {},
) {
  const unique = Array.from(
    new Set(
      (Array.isArray(subjects) ? subjects : [])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean),
    ),
  );
  const results = new Map();
  if (unique.length === 0) return results;

  // Cache key version suffix: bump whenever caching semantics change so
  // previously poisoned entries auto-expire rather than surviving their
  // 1h TTL. v1→v2: we no longer cache partial/failed subject searches
  // (see the `gotSuccessfulPage && fullyPaginated` guard below).
  const SUBJECT_CACHE_VERSION = "v2";
  const cacheKeyFor = (subject) =>
    `subjectSearch|${SUBJECT_CACHE_VERSION}|${term}|${subject}`;

  const toFetch = [];
  let oldestTs = null;
  for (const subject of unique) {
    const key = cacheKeyFor(subject);
    if (!forceRefresh) {
      const cached = await cacheGet(key, CACHE_TTL.course);
      // Defense in depth: even within v2, treat an empty cached array as
      // a miss. If a subject legitimately has zero sections this term
      // we'll refetch once per analysis (cheap — K subjects, not N
      // courses), which is the right trade vs silently masking every
      // course in the subject.
      if (cached && Array.isArray(cached) && cached.length > 0) {
        results.set(subject, cached);
        const ts = await cacheAge(key, CACHE_TTL.course);
        if (ts && (oldestTs === null || ts < oldestTs)) oldestTs = ts;
        continue;
      }
    }
    toFetch.push(subject);
  }
  if (toFetch.length === 0) {
    results.__oldestTs = oldestTs;
    return results;
  }

  await withSessionLock(async () => {
    // Single session handshake covers every subject we still need to
    // fetch. Banner's class-search mode is per-term, not per-subject —
    // once the term is selected, subsequent searchResults calls with
    // different `txt_subject` values all reuse the same session.
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

    const PAGE_MAX = 500; // Banner caps practical page size; we loop if needed
    const PAGE_CAP = 20;  // safety valve — no subject has 10k sections

    for (const subject of toFetch) {
      let pageOffset = 0;
      const all = [];
      let pageIdx = 0;
      // Track whether we ever received a well-formed successful response
      // for this subject. Without this, a timeout / 500 / malformed body
      // on the first page causes us to cache an empty array, which would
      // then mask every course in the subject as "not offered" for the
      // entire 1h cache TTL — the exact "eligible count keeps dropping
      // between runs" failure mode.
      let gotSuccessfulPage = false;
      let fullyPaginated = false;
      while (pageIdx < PAGE_CAP) {
        const form = new FormData();
        form.append("txt_subject", subject);
        form.append("txt_term", term);
        form.append("pageOffset", String(pageOffset));
        form.append("pageMaxSize", String(PAGE_MAX));
        form.append("sortColumn", "subjectDescription");
        form.append("sortDirection", "asc");
        form.append("startDatepicker", "");
        form.append("endDatepicker", "");
        form.append("uniqueSessionId", subject + "-" + Date.now());
        let result;
        try {
          const response = await self.BPPerf.fetchWithTimeout(
            "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/searchResults",
            { method: "POST", credentials: "include", body: form },
            20000,
          );
          result = await response.json();
        } catch (e) {
          console.warn(
            "[BobcatPlus] batch search failed for subject " +
              subject +
              " (page " +
              pageIdx +
              "): ",
            e,
          );
          break;
        }
        if (!result || !result.success || !Array.isArray(result.data)) break;
        gotSuccessfulPage = true;
        all.push(...result.data);
        const total = Number(result.totalCount);
        if (!Number.isFinite(total) || all.length >= total) {
          fullyPaginated = true;
          break;
        }
        pageOffset += PAGE_MAX;
        pageIdx++;
      }

      // Expose the current run's best-effort results regardless of cache
      // policy — `runAnalysis` should still get whatever we managed to
      // fetch this run.
      results.set(subject, all);

      // Only write to the 1h cache if we actually got a complete, valid
      // response. Partial pagination or hard failures stay uncached so
      // the next analysis re-tries with a fresh session instead of
      // inheriting a poisoned-empty subject.
      if (gotSuccessfulPage && fullyPaginated) {
        const key = cacheKeyFor(subject);
        await cacheSet(key, all);
        const ts = await cacheAge(key, CACHE_TTL.course);
        if (ts && (oldestTs === null || ts < oldestTs)) oldestTs = ts;
      } else {
        console.warn(
          "[BobcatPlus] subject " +
            subject +
            " search incomplete (pages=" +
            (pageIdx + (fullyPaginated ? 1 : 0)) +
            ", rows=" +
            all.length +
            "); not caching so the next run retries fresh",
        );
      }
    }
  });

  results.__oldestTs = oldestTs;
  return results;
}

// --- Step 4: Search for sections of a single course ---
async function searchCourse(subject, courseNumber, term, { forceRefresh = false } = {}) {
  const key = `course|${term}|${subject}|${courseNumber}`;
  if (!forceRefresh) {
    const cached = await cacheGet(key, CACHE_TTL.course);
    if (cached) return cached;
  }
  return withSessionLock(async () => {
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
      const key = `course|${term}|${subject}|${courseNumber}`;
      await cacheSet(key, result.data);
      return result.data;
    }
    return null;
  });
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
  const prereqKey = `prereq|${term}|${crn}`;
  let html = await cacheGet(prereqKey, CACHE_TTL.prereq);
  if (!html) {
    // fetchWithTimeout prevents a single stalled socket from wedging the
    // entire Promise.all-over-needed[] pool (see Bug 4 / "prereq hang"
    // postmortem in docs/bug4-eligible-diagnosis.md).
    const response = await self.BPPerf.fetchWithTimeout(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/getSectionPrerequisites?term=" +
        term +
        "&courseReferenceNumber=" +
        crn,
      { credentials: "include" },
      15000,
    );
    html = await response.text();
    await cacheSet(prereqKey, html);
  }
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
  const descKey = `desc|${term}|${crn}`;
  const cached = await cacheGet(descKey, CACHE_TTL.desc);
  if (cached !== null) return cached;
  try {
    const response = await self.BPPerf.fetchWithTimeout(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/getCourseDescription?term=" +
        term +
        "&courseReferenceNumber=" +
        crn,
      { credentials: "include" },
      15000,
    );
    const rawHtml = await response.text();
    const text = rawHtml
      .replace(/<[^>]*>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    await cacheSet(descKey, text);
    return text;
  } catch (e) {
    return "";
  }
}

// --- Main analysis function ---
// isCurrent is an optional predicate — when it returns false the caller has
// started a newer analysis, so this run bails early to stop spamming the queue.
async function runAnalysis(sendUpdate, termCodeOverride, isCurrent, { forceRefresh = false } = {}) {
  const current = typeof isCurrent === "function" ? isCurrent : () => true;
  const bail = () => !current();

  sendUpdate({ type: "status", message: "Detecting student info..." });
  const student = await getStudentInfo();
  if (bail()) return;
  sendUpdate({ type: "student", data: student });

  sendUpdate({ type: "status", message: "Loading degree audit..." });
  const {
    completed,
    inProgress,
    needed,
    auditDiagnostics,
    graph,
    wildcards,
  } = await getAuditData(student.id, student.school, student.degree);
  if (bail()) return;
  sendUpdate({
    type: "audit",
    data: {
      completed: completed.length,
      inProgress: inProgress.length,
      needed: needed.length,
    },
  });

  // NOTE: the "bail out if needed is empty" check used to live here, but
  // wildcard expansion (Bug 4 Layer B) can turn an empty concrete pool
  // into a populated one. Moved below, after expansion runs.

  sendUpdate({
    type: "status",
    message: "Resolving semester for section search...",
  });
  let term;
  if (termCodeOverride) {
    const terms = await getTerms();
    if (bail()) return;
    const found = terms.find((t) => t.code === termCodeOverride);
    term = found
      ? { code: found.code, description: found.description }
      : { code: termCodeOverride, description: termCodeOverride };
  } else {
    term = await getCurrentTerm();
    if (bail()) return;
  }
  sendUpdate({ type: "term", data: term });

  // --- Step 2.5: wildcard expansion (Bug 4 Layer B + C) ---
  //
  // RequirementGraph surfaces wildcards separately from concrete
  // `needed[]` entries. Resolve each one via DegreeWorks' course-link
  // endpoint and fold the results back into `needed[]` so they flow
  // through the same section-search → eligibility pipeline as concrete
  // courses. Layer C (honoring `except`) is free — the orchestrator
  // passes `exceptionKeysFromWildcard(w)` into the normalizer's
  // `excludeKeys` option.
  //
  // Failure modes degrade gracefully: if the fetcher returns null for a
  // given wildcard, that requirement just contributes nothing (logged in
  // the console). We never throw here — eligibility is best-effort.
  const bpReqExpandReady =
    typeof self !== "undefined" &&
    self.BPReq &&
    typeof self.BPReq.expandAuditWildcards === "function";

  if (bpReqExpandReady && Array.isArray(wildcards) && wildcards.length > 0) {
    sendUpdate({
      type: "status",
      message:
        "Expanding " +
        wildcards.length +
        " wildcard requirement" +
        (wildcards.length === 1 ? "" : "s") +
        "...",
    });
    try {
      const expansion = await self.BPReq.expandAuditWildcards(
        { wildcards, needed, completed, inProgress },
        { fetchCourseLink: fetchCourseLinkFromDW, termCode: term.code },
      );
      if (bail()) return;
      for (const entry of expansion.added) needed.push(entry);

      if (expansion.failures && expansion.failures.length) {
        console.warn(
          "[BobcatPlus] wildcard expansion: " +
            expansion.failures.length +
            " of " +
            wildcards.length +
            " wildcard(s) failed; those requirements will have no expanded candidates",
          expansion.failures.slice(0, 10).map((f) => ({
            label: f.wildcard && f.wildcard.ruleLabel,
            disc: f.wildcard && f.wildcard.discipline,
            prefix: f.wildcard && f.wildcard.numberPrefix,
            error: f.error,
          })),
        );
      }
      if (expansion.skipped && expansion.skipped.length) {
        console.info(
          "[BobcatPlus] wildcard expansion: " +
            expansion.skipped.length +
            " attribute-only wildcard(s) skipped (Layer D — hideFromAdvice siblings already in needed)",
        );
      }

      sendUpdate({
        type: "audit",
        data: {
          completed: completed.length,
          inProgress: inProgress.length,
          needed: needed.length,
        },
      });
    } catch (e) {
      console.warn(
        "[BobcatPlus] wildcard expansion threw; continuing with concrete needed[] only:",
        e,
      );
    }
  }

  if (needed.length === 0) {
    sendUpdate({
      type: "done",
      data: { eligible: [], blocked: [], notOffered: [], needed: [] },
    });
    return;
  }

  const eligible = [];
  const blocked = [];
  const notOffered = [];
  let oldestCacheTs = null; // track when course data was last fetched from Banner

  // Batch section search by subject (see searchCoursesBySubjects above).
  // We group `needed[]` by subject, make one paginated Banner call per
  // subject, and then index the returned sections back onto each course
  // entry by "${subject}|${courseNumber}". This collapses O(needed) round
  // trips to O(distinct subjects), which is the dominant speedup for this
  // phase.
  const uniqueSubjects = Array.from(
    new Set(
      needed
        .map((c) => (c && typeof c.subject === "string" ? c.subject.trim() : ""))
        .filter(Boolean),
    ),
  );
  sendUpdate({
    type: "status",
    message:
      "Searching " +
      uniqueSubjects.length +
      " subject" +
      (uniqueSubjects.length === 1 ? "" : "s") +
      " (" +
      needed.length +
      " course" +
      (needed.length === 1 ? "" : "s") +
      ")...",
  });
  let subjectSections;
  try {
    subjectSections = await searchCoursesBySubjects(
      uniqueSubjects,
      term.code,
      { forceRefresh },
    );
  } catch (e) {
    console.warn(
      "[BobcatPlus] searchCoursesBySubjects threw; marking all needed as notOffered:",
      e,
    );
    subjectSections = new Map();
  }
  if (bail()) return;

  if (subjectSections && subjectSections.__oldestTs) {
    oldestCacheTs = subjectSections.__oldestTs;
  }

  // Index returned sections by "SUBJECT|COURSENUMBER" for O(1) lookup.
  const sectionsIndex = new Map();
  for (const [, sections] of subjectSections) {
    if (!Array.isArray(sections)) continue;
    for (const s of sections) {
      if (!s) continue;
      const key = (s.subject || "") + "|" + (s.courseNumber || "");
      if (!sectionsIndex.has(key)) sectionsIndex.set(key, []);
      sectionsIndex.get(key).push(s);
    }
  }

  for (const course of needed) {
    if (bail()) return;
    const key = (course.subject || "") + "|" + (course.courseNumber || "");
    const matched = sectionsIndex.get(key);
    if (matched && matched.length > 0) {
      course.crn = matched[0].courseReferenceNumber;
      course.sections = matched;
      // Backfill the legacy per-course cache so the `getCourseSections`
      // UI message handler (which still uses single-course searchCourse)
      // sees a warm cache after an analysis run. Fire-and-forget; cache
      // write failures are non-fatal.
      const perCourseKey =
        `course|${term.code}|${course.subject}|${course.courseNumber}`;
      cacheSet(perCourseKey, matched).catch(() => {});
    } else {
      notOffered.push(course);
    }
  }

  if (bail()) return;

  // Check prereqs and fetch descriptions with bounded concurrency.
  //
  // Previously this fanned out a `Promise.all` over ~120+ courses, which
  // queued against Chrome's 6-sockets-per-origin cap and could wedge the
  // entire analysis if any single socket stalled (no per-request timeout).
  // `mapPool` caps in-flight requests at PREREQ_POOL_CONCURRENCY, and
  // `checkPrereqs` / `getCourseDescription` both use fetchWithTimeout
  // internally. Together that makes this phase bounded in both throughput
  // and worst-case latency. See docs/bug4-eligible-diagnosis.md.
  const coursesWithSections = needed.filter((c) => c.sections);
  const descCache = {};
  const PREREQ_POOL_CONCURRENCY = 6;
  const prereqTotal = coursesWithSections.length;
  let prereqDone = 0;
  // Throttled status tick-down — every 5 completions or every 400ms, whichever
  // comes first. Without this the status line sits on "Checking prerequisites
  // for N courses..." for the whole phase and makes slow runs look hung even
  // when they're making progress.
  let lastTickAt = 0;
  const tickStatus = () => {
    const now = Date.now();
    if (prereqDone === prereqTotal || prereqDone % 5 === 0 || now - lastTickAt > 400) {
      lastTickAt = now;
      sendUpdate({
        type: "status",
        message:
          "Checking prerequisites " + prereqDone + "/" + prereqTotal + "...",
      });
    }
  };
  sendUpdate({
    type: "status",
    message: "Checking prerequisites 0/" + prereqTotal + "...",
  });
  await self.BPPerf.mapPool(
    coursesWithSections,
    PREREQ_POOL_CONCURRENCY,
    async (course) => {
      if (bail()) return;
      try {
        const result = await checkPrereqs(
          course.crn,
          term.code,
          completed,
          inProgress,
        );
        if (bail()) return;
        if (result.met) {
          const cacheKey = course.subject + course.courseNumber;
          if (!descCache[cacheKey]) {
            descCache[cacheKey] = await getCourseDescription(
              course.crn,
              term.code,
            );
          }
          if (bail()) return;
          course.sections.forEach(
            (s) => (s.courseDescription = descCache[cacheKey]),
          );
          eligible.push(course);
          sendUpdate({ type: "eligible", data: course });
        } else {
          course.missingPrereqs = result.missing;
          blocked.push(course);
          sendUpdate({ type: "blocked", data: course });
        }
      } catch (e) {
        if (bail()) return;
        // Prereq check failed (network / timeout / parse error) — show the
        // course but flag it so the UI doesn't silently lie about
        // eligibility. AbortError from fetchWithTimeout lands here too.
        console.warn("[BobcatPlus] prereq check failed for", course.subject, course.courseNumber, e);
        course.prereqCheckFailed = true;
        eligible.push(course);
        sendUpdate({ type: "eligible", data: course });
      } finally {
        prereqDone++;
        tickStatus();
      }
    },
  );

  if (bail()) return;
  sendUpdate({
    type: "done",
    data: {
      eligible,
      blocked,
      notOffered,
      needed,
      cacheTs: oldestCacheTs,
      auditDiagnostics,
      // Phase 1: graph + wildcards flow through but are not yet consumed by
      // the solver. Populated whenever the BPReq modules loaded; null only
      // when the parse failed.
      graph,
      wildcards,
    },
  });
}

// --- Get available terms ---
async function getTerms() {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=25",
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

const REG_SCHEDULE_BASE =
  "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";

const REG_HISTORY_PAGE_URL =
  REG_SCHEDULE_BASE + "/ssb/registrationHistory/registrationHistory";

/** Cached Banner anti-CSRF token from the View Registration Information page (past terms). */
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

// --- Get current registered schedule ---
// Used by popup.js (via getSchedule message). SAML-aware: follows redirect chains
// that Banner returns when the session needs warming.
async function getCurrentSchedule(term) {
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

// --- Login popup: small window (user preference). Pass `registrationTerm` from the tab UI
// so `term/search` + `getRegistrationEvents` use the same code as the term dropdown (not a guess). ---
function openLoginPopup(sendResponse, registrationTermExplicit) {
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
    clearVerifySchedule();
    restartCount++;
    try {
      chrome.tabs.update(tabId, { url: DW_URL });
    } catch (_) {}
    if (reason) console.warn("[BobcatPlus] login popup:", reason);
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
   * Try the fast history handshake first (one flow), then full `getCurrentSchedule` if needed.
   * Avoids three stacked handshakes on every verify tick while the user is on the login popup.
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
        clearVerifySchedule();
        cleanup();
        try {
          chrome.windows.remove(popupWindowId, () => {
            chrome.runtime.sendMessage({ type: "loginSuccess" });
          });
        } catch (_) {
          chrome.runtime.sendMessage({ type: "loginSuccess" });
        }
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

    // Fallback path: DegreeWorks worksheet → force Banner SSO (avoids anonymous SSB hub).
    if (tab.url.includes(DW_SUCCESS)) {
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

// Every new runAnalysis request bumps this. In-flight stale analyses check
// their captured generation against the current one and bail, so concurrent
// runs for different terms collapse to just the latest request.
let analysisGeneration = 0;

// --- Listen for messages from popup and full tab ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runAnalysis") {
    const analysisTerm = message.term || null;
    const myGen = ++analysisGeneration;
    const isCurrent = () => myGen === analysisGeneration;
    runAnalysis((update) => {
      if (!isCurrent()) return;
      chrome.runtime.sendMessage({ ...update, _term: analysisTerm }).catch(() => {});
    }, analysisTerm, isCurrent, { forceRefresh: !!message.forceRefresh });
    sendResponse({ started: true });
  }

  // tab.js fires this at the very top of a term change so stale analyses bail
  // within ~1 searchCourse instead of waiting for the new runAnalysis message
  // (which currently doesn't land until loadSchedule + loadBannerPlans finish).
  if (message.action === "cancelAnalysis") {
    analysisGeneration++;
    sendResponse({ cancelled: true });
  }

  if (message.action === "openFullTab") {
    const q = message.openLogin ? "?login=1" : "";
    chrome.tabs.create({ url: chrome.runtime.getURL("tab.html" + q) });
    sendResponse({ opened: true });
  }

  if (message.action === "openLoginPopup") {
    openLoginPopup(sendResponse, message.term || null);
    return true; // keep channel open for async response
  }

  if (message.action === "getStudentInfo") {
    getStudentInfo()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getDegreeAuditOverview") {
    getDegreeAuditOverview()
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
    const myGen = ++analysisGeneration;
    const isCurrent = () => myGen === analysisGeneration;
    runAnalysis((update) => {
      if (!isCurrent()) return;
      chrome.runtime.sendMessage(update).catch(() => {});
    }, message.term || null, isCurrent);
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

