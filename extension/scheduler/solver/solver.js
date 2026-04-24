// scheduler/solver/solver.js — CSP backtracking + multi-pass + relaxation
// Extracted from scheduleGenerator.js section 8 and 10.
//
// State: pick at most one section per course; total credits within
// [minCredits, maxCredits]; no pairwise time overlaps; no overlaps
// with calendar blocks or locked courses; hard avoid-days respected.
//
// Enumeration cap: SOLVER_NODE_CAP partial states or SOLVER_RESULT_CAP
// feasible results, then we stop and rank what we have.
//
// Depends on: ./constraints.js, ../time.js

import { toMinutes } from "../time.js";
import {
  preferenceSectionDistance,
  sectionConflictsFixed,
  sectionsConflict,
  buildConstraints,
  _constraintSnapshot,
} from "./constraints.js";

export const SOLVER_NODE_CAP = 200000;
export const SOLVER_RESULT_CAP = 2000;

// Mulberry32 seeded PRNG — deterministic shuffles for reproducible searches.
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function solve(eligible, constraints, options = {}) {
  const {
    calendarBlocks,
    lockedCourses,
    hardAvoidDays,
    hardNoEarlierThan,
    hardNoLaterThan,
    hardDropOnline,
    minCredits,
    maxCredits,
    minCourses,
    maxCourses,
  } = constraints;

  // Fixed slots = blocks + locked courses with meeting data
  const fixedSlots = [
    ...(calendarBlocks || []).map((b) => ({ days: b.days, start: b.start, end: b.end })),
    ...(lockedCourses || []).filter((l) => l.days && l.start && l.end)
                            .map((l) => ({ days: l.days, start: l.start, end: l.end })),
  ];

  // Per-course pre-filter: drop sections that conflict with fixed slots
  // or land on hard avoid-days. Also drop sections missing meeting data
  // unless online (data-quality defense).
  const perCourse = [];
  const dataQualityDrops = [];
  const perCourseCounts = [];
  const eliminatedCourses = [];
  for (const course of eligible) {
    const original = course.sections.length;
    const dropReasons = { missingData: 0, fixedConflict: 0, hardAvoidDay: 0 };
    const viable = course.sections.filter((s) => {
      if (!s.online && (!s.days || !s.start || !s.end)) {
        dataQualityDrops.push({ course: course.course, crn: s.crn, reason: "missing meeting data" });
        dropReasons.missingData++;
        return false;
      }
      if (hardDropOnline && s.online) return false;
      if (!s.online && hardNoEarlierThan) {
        const cutoff = toMinutes(hardNoEarlierThan);
        const start = toMinutes(s.start);
        if (start != null && cutoff != null && start < cutoff) return false;
      }
      if (!s.online && hardNoLaterThan) {
        const cutoff = toMinutes(hardNoLaterThan);
        const end = toMinutes(s.end);
        if (end != null && cutoff != null && end > cutoff) return false;
      }
      if (s.online) return true;
      if (sectionConflictsFixed(s, fixedSlots)) { dropReasons.fixedConflict++; return false; }
      if ((hardAvoidDays || []).length && s.days.some((d) => hardAvoidDays.includes(d))) {
        dropReasons.hardAvoidDay++;
        return false;
      }
      return true;
    });
    perCourseCounts.push({ course: course.course, original, viable: viable.length, dropReasons });
    if (viable.length) perCourse.push({ course, viable });
    else eliminatedCourses.push({ course: course.course, original, dropReasons });
  }

  // Course ordering strategy — defaults to MRV (fewest viable sections first)
  // for single-pass searches. Multi-pass callers supply alternatives to
  // diversify the search space; MRV alone fixates on the same subset of
  // small-branching-factor courses, producing near-identical schedules.
  const ordering = options.ordering || "mrv";
  const solverPrefs = options.solverPrefs || null;
  const resultCap = Math.min(
    SOLVER_RESULT_CAP,
    Number.isFinite(options.resultCap) && options.resultCap > 0
      ? options.resultCap
      : SOLVER_RESULT_CAP,
  );

  if (ordering === "mrv") {
    perCourse.sort((a, b) => a.viable.length - b.viable.length);
  } else if (ordering === "reverse-mrv") {
    perCourse.sort((a, b) => b.viable.length - a.viable.length);
  } else if (ordering === "shuffled") {
    const rng = seededRng(options.seed ?? 42);
    perCourse.sort((a, b) => a.viable.length - b.viable.length);
    shuffleInPlace(perCourse, rng);
  } else if (ordering === "pref-distance") {
    perCourse.sort((a, b) => a.viable.length - b.viable.length);
    for (const pc of perCourse) {
      pc.viable = pc.viable.slice().sort((a, b) => {
        const da = preferenceSectionDistance(a, solverPrefs);
        const db = preferenceSectionDistance(b, solverPrefs);
        if (da !== db) return da - db;
        return String(a.crn).localeCompare(String(b.crn));
      });
    }
  }

  // Also shuffle sections within each course for shuffled/reverse passes so
  // the same {courseSet, sectionSet} prefix isn't explored first every time.
  if (ordering !== "mrv" && ordering !== "pref-distance") {
    const rng = seededRng((options.seed ?? 42) + 1);
    for (const pc of perCourse) {
      const copy = pc.viable.slice();
      shuffleInPlace(copy, rng);
      pc.viable = copy;
    }
  }

  const results = [];
  let nodes = 0;

  // Index lookup for lab-pair constraints.
  const courseIdxByName = new Map();
  perCourse.forEach((pc, i) => courseIdxByName.set(pc.course.course, i));

  function recurse(idx, picked, credits) {
    nodes++;
    if (nodes > SOLVER_NODE_CAP) return;
    if (results.length >= resultCap) return;
    if (credits > maxCredits) return;
    if (picked.length > maxCourses) return;

    const remaining = perCourse.length - idx;

    // Pruning: can't reach minCourses even if we pick every remaining course
    if (picked.length + remaining < minCourses) return;

    // Pruning: can't reach minCredits even if every remaining course is 4cr
    if (credits + remaining * 4 < minCredits) return;

    if (idx === perCourse.length) {
      if (credits >= minCredits && picked.length >= minCourses) {
        // Final pair validation: every picked course whose pair is in the
        // eligible set must have its partner also picked.
        const pickedNames = new Set(picked.map((p) => p.courseObj.course));
        let pairOk = true;
        for (const p of picked) {
          const partner = p.courseObj.pairedCourse;
          if (partner && courseIdxByName.has(partner) && !pickedNames.has(partner)) {
            pairOk = false;
            break;
          }
        }
        if (pairOk) results.push({ picks: picked.slice(), credits });
      }
      return;
    }

    // Lab-pair pruning: consult partner's decision state before branching.
    const { course, viable } = perCourse[idx];
    const partner = course.pairedCourse;
    const partnerIdx = partner ? courseIdxByName.get(partner) : undefined;
    const partnerDecided = partnerIdx !== undefined && partnerIdx < idx;
    const partnerPicked = partnerDecided && picked.some((p) => p.courseObj.course === partner);
    const mustPickToHonorPair = partnerDecided && partnerPicked;
    const mustSkipToHonorPair = partnerDecided && !partnerPicked;

    // Pick branches FIRST so DFS reaches leaves fast — the first complete
    // assignment gets scored / credit-bounded immediately, which prunes
    // sibling subtrees aggressively.
    if (!mustSkipToHonorPair) {
      for (const sec of viable) {
        let ok = true;
        for (const p of picked) if (sectionsConflict(sec, p.section)) { ok = false; break; }
        if (!ok) continue;
        picked.push({ courseObj: course, section: sec });
        recurse(idx + 1, picked, credits + (sec.credits ?? 3));
        picked.pop();
        if (results.length >= resultCap) return;
      }
    }

    if (!mustPickToHonorPair) {
      recurse(idx + 1, picked, credits);
    }
  }

  recurse(0, [], 0);

  const totalViableSections = perCourse.reduce((s, c) => s + c.viable.length, 0);
  return {
    results, nodesExplored: nodes, dataQualityDrops, capHit: nodes > SOLVER_NODE_CAP,
    perCourseCounts, eliminatedCourses, totalViableSections,
    coursesWithViableSections: perCourse.length,
  };
}

// Run solve() with several course-orderings and merge results. Each ordering
// reaches a different region of the search space first, so pooling their
// results (deduped by section-set signature) produces a diverse pool.
// See docs/postmortems/bug1-morning-preference.md for the MRV-only failure
// that motivated multi-pass + pref-distance-first ordering.
export function solveMulti(eligible, constraints, preferences) {
  const orderings = [
    { ordering: "pref-distance" },
    { ordering: "mrv" },
    { ordering: "reverse-mrv" },
    { ordering: "shuffled", seed: 17 },
    { ordering: "shuffled", seed: 101 },
  ];
  const baseBudget = Math.max(1, Math.ceil(SOLVER_RESULT_CAP / orderings.length));

  const allResults = [];
  const seen = new Set();
  let totalNodes = 0;
  let capHitAnywhere = false;
  let firstSolved = null;
  const passContributions = [];
  for (let i = 0; i < orderings.length; i++) {
    const opts = orderings[i];
    const remainingOverall = SOLVER_RESULT_CAP - allResults.length;
    if (remainingOverall <= 0) break;
    const isLastPass = i === orderings.length - 1;
    const passCap = isLastPass
      ? remainingOverall
      : Math.min(baseBudget, remainingOverall);
    const s = solve(eligible, constraints, {
      ordering: opts.ordering,
      seed: opts.seed,
      solverPrefs: opts.ordering === "pref-distance" ? (preferences || null) : null,
      resultCap: passCap,
    });
    if (!firstSolved) firstSolved = s;
    totalNodes += s.nodesExplored;
    capHitAnywhere = capHitAnywhere || s.capHit;
    let newThisPass = 0;
    for (const r of s.results) {
      const key = r.picks.map((p) => p.section.crn).sort().join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      allResults.push(r);
      newThisPass++;
      if (allResults.length >= SOLVER_RESULT_CAP) break;
    }
    passContributions.push({
      ordering: opts.ordering,
      seed: opts.seed,
      passCap,
      generated: s.results.length,
      newUnique: newThisPass,
    });
    if (allResults.length >= SOLVER_RESULT_CAP) break;
  }
  return {
    ...firstSolved,
    results: allResults,
    nodesExplored: totalNodes,
    capHit: capHitAnywhere,
    passes: orderings.length,
    passContributions,
  };
}

// Smart suggestions for the infeasible state, derived from attempt data.
export function _infeasibleSuggestions(attempts, eligible, profile) {
  const out = [];
  const last = attempts[attempts.length - 1];
  if (!last) return ["Try easing one restriction or reducing your credit target."];

  const agg = { missingData: 0, fixedConflict: 0, hardAvoidDay: 0 };
  for (const ec of last.eliminatedCourses || []) {
    agg.missingData += ec.dropReasons.missingData;
    agg.fixedConflict += ec.dropReasons.fixedConflict;
    agg.hardAvoidDay += ec.dropReasons.hardAvoidDay;
  }

  if (agg.hardAvoidDay > agg.fixedConflict && agg.hardAvoidDay > agg.missingData) {
    const days = (last.constraints.hardAvoidDays || []).join("/");
    if (days) out.push(`Many sections meet on ${days} — try softening that day instead of fully blocking it.`);
  }
  if (agg.fixedConflict > 0) {
    const blockCount = last.constraints.calendarBlocks || 0;
    out.push(`Your calendar blocks eliminated ${agg.fixedConflict} candidate section${agg.fixedConflict !== 1 ? "s" : ""}${blockCount ? ` across ${blockCount} block${blockCount !== 1 ? "s" : ""}` : ""}. Consider tightening the block time range.`);
  }
  if (agg.missingData > 0) {
    out.push(`${agg.missingData} section${agg.missingData !== 1 ? "s" : ""} had TBA/missing meeting data and were skipped — these are often project courses or independent study.`);
  }
  if (last.viableCourses < 3) {
    out.push(`Only ${last.viableCourses} course${last.viableCourses !== 1 ? "s" : ""} ${last.viableCourses === 1 ? "has" : "have"} any viable sections after filtering. Broaden your constraints or check this term's offerings.`);
  }
  if (last.constraints.minCredits > 9) {
    out.push(`Credit floor is ${last.constraints.minCredits} — drop to 9 or 12 if you're open to a lighter load.`);
  }
  if (!out.length) {
    out.push("Try easing one restriction — fewer blocked days, wider credit range, or allowing online.");
  }
  return out;
}

export function solveWithRelaxation(eligible, preferences, studentProfile, lockedCourses, trace) {
  const relaxations = [];
  const attempts = [];
  let workingPrefs = { ...preferences };
  let constraints = buildConstraints(workingPrefs, studentProfile, lockedCourses);

  const t = trace.start("solver", "Searching feasible schedules…");
  let solved = solveMulti(eligible, constraints, workingPrefs);
  attempts.push({
    label: "initial",
    constraints: _constraintSnapshot(constraints, workingPrefs),
    viableCourses: solved.coursesWithViableSections,
    viableSections: solved.totalViableSections,
    eliminatedCourses: solved.eliminatedCourses,
    perCourseCounts: solved.perCourseCounts,
    nodesExplored: solved.nodesExplored,
    capHit: solved.capHit,
    results: solved.results.length,
  });
  t.update({ summary: `Pass 1: ${solved.coursesWithViableSections}/${eligible.length} courses viable, ${solved.results.length} unique schedules across ${solved.passes} orderings (${solved.nodesExplored} nodes)` });

  const steps = [
    {
      label: "ignoring 'no mornings' preference",
      apply: () => { workingPrefs.noEarlierThan = null; workingPrefs.morningCutoffWeight = 0; },
      condition: () => (workingPrefs.noEarlierThan && (workingPrefs.morningCutoffWeight ?? 0.5) < 1.0),
    },
    {
      label: "allowing classes to run past cutoff",
      apply: () => { workingPrefs.noLaterThan = null; workingPrefs.lateCutoffWeight = 0; },
      condition: () => (workingPrefs.noLaterThan && (workingPrefs.lateCutoffWeight ?? 0.5) < 1.0),
    },
    {
      label: "allowing classes on avoid-days",
      apply: () => { constraints.hardAvoidDays = []; workingPrefs.avoidDayWeight = 0; },
      condition: () => constraints.hardAvoidDays.length > 0,
    },
    {
      label: "widening credit target",
      apply: () => { constraints.minCredits = Math.max(9, constraints.minCredits - 3); constraints.maxCredits = Math.min(21, constraints.maxCredits + 3); },
      condition: () => constraints.minCredits > 9,
    },
    {
      label: "dropping online preference",
      apply: () => { workingPrefs.preferOnline = null; workingPrefs.onlineWeight = 0; },
      condition: () => workingPrefs.preferOnline === true,
    },
  ];

  for (const step of steps) {
    if (solved.results.length > 0) break;
    if (!step.condition()) continue;
    step.apply();
    relaxations.push(step.label);
    constraints = buildConstraints(workingPrefs, studentProfile, lockedCourses);
    solved = solveMulti(eligible, constraints, workingPrefs);
    attempts.push({
      label: step.label,
      constraints: _constraintSnapshot(constraints, workingPrefs),
      viableCourses: solved.coursesWithViableSections,
      viableSections: solved.totalViableSections,
      eliminatedCourses: solved.eliminatedCourses,
      perCourseCounts: solved.perCourseCounts,
      nodesExplored: solved.nodesExplored,
      capHit: solved.capHit,
      results: solved.results.length,
    });
  }

  if (solved.results.length > 0) {
    t.done({
      summary: `${solved.results.length} feasible schedules${relaxations.length ? ` (relaxed: ${relaxations.join("; ")})` : ""}`,
      capHit: solved.capHit,
      attempts,
    });
  } else {
    t.done({
      summary: `No feasible schedule after ${attempts.length} attempts. Final: ${solved.coursesWithViableSections}/${eligible.length} courses viable, ${solved.totalViableSections} sections`,
      error: "infeasible",
      attempts,
    });
  }

  return { solved, relaxations, constraints, workingPrefs, attempts };
}
