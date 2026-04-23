// Bobcat Plus — Banner prereq + description fetchers (ES module).
//
// Both entry points (`checkPrereqs`, `getCourseDescription`) are called
// per-CRN from inside the runAnalysis `BPPerf.mapPool` fan-out. Two
// invariants must not regress:
//
//   1. Every outbound HTTP uses `self.BPPerf.fetchWithTimeout` with at
//      least a 15s timeout. Chrome caps outbound connections at 6 per
//      origin; without a timeout a single stalled socket wedges the
//      entire pool and the eligible-list phase stalls for minutes (the
//      original "4-minute prereq hang" — see docs/bugs/bug4-eligible.md).
//      `self.BPPerf` is populated by the side-effect import of
//      extension/performance/concurrencyPool.js that background.js runs
//      at SW boot. Invariants: docs/invariants.md #3.
//
//   2. The responses are cached (prereq 24h, description 7d) — these are
//      effectively static once a term's schedule publishes, and each
//      analysis re-touches ~100 CRNs. Hitting Banner uncached every run
//      wastes ~100× per-course latency for zero freshness benefit.
//
// Prereq text from Banner is a free-form HTML blob with "Course or Test:
// <Subject> <Number>" + "Minimum Grade of <L>" + "May (not) be taken
// concurrently" phrases, punctuated by "( … ) or ( … )" / "( … ) and
// ( … )" groupings. `checkPrereqGroup` parses ONE group; `checkPrereqs`
// walks the "or" / "and" decomposition and says met/missing. The
// per-OR-group short-circuit ("if any OR branch is met → done") matches
// Banner's own evaluation semantics.

import { BANNER_BASE_URL, GRADE_MAP, SUBJECT_MAP } from "./constants.js";
import { cacheGet, cacheSet, CACHE_TTL } from "./cache.js";

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

export async function checkPrereqs(crn, term, completed, inProgress) {
  const prereqKey = `prereq|${term}|${crn}`;
  let html = await cacheGet(prereqKey, CACHE_TTL.prereq);
  if (!html) {
    // fetchWithTimeout prevents a single stalled socket from wedging the
    // entire mapPool fan-out (see Bug 4 / "prereq hang" postmortem in
    // docs/bugs/bug4-eligible.md).
    const response = await self.BPPerf.fetchWithTimeout(
      BANNER_BASE_URL +
        "/searchResults/getSectionPrerequisites?term=" +
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

export async function getCourseDescription(crn, term) {
  const descKey = `desc|${term}|${crn}`;
  const cached = await cacheGet(descKey, CACHE_TTL.desc);
  if (cached !== null) return cached;
  try {
    const response = await self.BPPerf.fetchWithTimeout(
      BANNER_BASE_URL +
        "/searchResults/getCourseDescription?term=" +
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
