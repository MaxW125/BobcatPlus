// Bobcat Plus — DegreeWorks student + audit fetch (ES module).
//
// This module owns every call to DegreeWorks' responsiveDashboard/api
// surface plus the audit parsers that feed the eligible-course pipeline.
// Three concerns sit here together because they share the same audit JSON
// walker tree:
//
//   - getStudentInfo()           → student identity + minor flag from
//                                  /students/myself
//   - getDegreeAuditOverview()   → overview panel payload (credit math,
//                                  GPAs, classification) built from /audit
//   - getAuditData()             → completed / inProgress / needed[] +
//                                  RequirementGraph + wildcard surface
//                                  consumed by runAnalysis
//   - fetchCourseLinkFromDW()    → /course-link fetch + 1h cache used
//                                  by BPReq.expandAuditWildcards
//
// RequirementGraph wiring is the load-bearing bit: getAuditData attaches
// `graph` and `wildcards` whenever `self.BPReq` is populated (side-effect
// imports of requirements/*.js in background.js). When the parser
// successfully produces entries, they replace the legacy findNeeded walk
// as the authoritative `needed[]`, and a `auditDiagnostics.parity` object
// stays on the return for regression spot-checks (see D17 / docs/refactor-
// on-main-plan.md). findNeeded is preserved verbatim as the fallback path
// for the "BPReq modules failed to load" case called out in D13.
//
// fetchCourseLinkFromDW is split out from the pure orchestrator in
// requirements/wildcardExpansion.js on purpose: this is the ONLY piece
// that touches network + chrome.storage, so the orchestrator stays Node-
// testable with a mocked fetcher (see tests/unit/wildcardExpansion.test.js).

import { cacheGet, cacheSet, CACHE_TTL } from "./cache.js";
import { DW_BASE_URL } from "./constants.js";

// --- Shared helpers -------------------------------------------------------

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

function auditUrlFor(studentId, school, degree) {
  return (
    DW_BASE_URL +
    "/audit?studentId=" +
    studentId +
    "&school=" +
    school +
    "&degree=" +
    degree +
    "&is-process-new=false&audit-type=AA&auditId=&include-inprogress=true&include-preregistered=true&aid-term="
  );
}

async function fetchAuditJson(studentId, school, degree) {
  const response = await fetch(auditUrlFor(studentId, school, degree), {
    credentials: "include",
  });
  if (!response.ok) return null;
  const raw = await response.json();
  return unwrapAuditPayload(raw);
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

// --- Public surface -------------------------------------------------------

export async function getStudentInfo() {
  const response = await fetch(DW_BASE_URL + "/students/myself", {
    credentials: "include",
  });
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

/**
 * Degree audit summary for overview: major+minor credit progress, GPAs, classification.
 */
export async function getDegreeAuditOverview() {
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

// Legacy-vs-new parity summary used as the regression canary after D17
// removed the shadow-logging feature flag. Pure, no I/O.
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

// Fetch and parse the degree audit. `needed[]` comes from RequirementGraph
// when BPReq loaded successfully, otherwise from the legacy findNeeded
// walk kept as the D13 fallback. `auditDiagnostics.parity` is populated
// on both paths so spot-checks remain cheap.
export async function getAuditData(studentId, school, degree) {
  const response = await fetch(auditUrlFor(studentId, school, degree), {
    credentials: "include",
  });
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

// --- DegreeWorks course-link fetcher (wildcard expansion) -----------------
//
// Bug 4 Layer B. RequirementGraph surfaces wildcards (`CS 4@`, `MATH @`,
// etc.) alongside concrete entries, but until this shipped we had no way
// to turn them into actual course picks — they were silently dropped so
// the eligible pool was missing every subject-wildcard requirement (major
// electives, BA science, etc.).
//
// Hits DegreeWorks' `/api/course-link` endpoint (response wrapped in a
// `courseInformation` envelope, hence the legacy module naming). URL
// captured from a live DevTools trace on the CS BS audit:
//
//   GET {DW_BASE_URL}/course-link?discipline={SUBJECT}&number={NUMBER_PATTERN}
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
export async function fetchCourseLinkFromDW(subject, numberPattern) {
  if (!subject || !numberPattern) return null;
  const key = `courseLink|${subject}|${numberPattern}`;
  const cached = await cacheGet(key, CACHE_TTL.courseInfo);
  if (cached) return cached;

  const url =
    DW_BASE_URL +
    "/course-link" +
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
