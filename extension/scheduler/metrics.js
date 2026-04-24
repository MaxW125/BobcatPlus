// scheduler/metrics.js — Phase 0 metric helpers
// Extracted from scheduleGenerator.js section 9b.
// Pure helpers exposed on BP for unit tests and trace payloads.
// Formulas defined in docs/METRICS.md.

import { applyVector, WEIGHT_VECTORS } from "./solver/rank.js";

// Accept either a top-schedule object (from rankSchedules, with .result.picks)
// or a schedule-shaped action (with .courses[]).
export function _scheduleCourses(schedule) {
  if (Array.isArray(schedule?.courses)) return schedule.courses;
  if (schedule?.result?.picks) {
    return schedule.result.picks.map((p) => ({
      days: p.section.days || [],
      start: p.section.start,
      end: p.section.end,
      online: !!p.section.online,
      credits: p.section.credits ?? 3,
    }));
  }
  return [];
}

export function computeHonoredRate(scheduleAction) {
  const h = (scheduleAction?.honoredPreferences || []).length;
  const u = (scheduleAction?.unhonoredPreferences || []).length;
  if (h + u === 0) return null;
  return h / (h + u);
}

// 5-axis shape vector: [morningHours, afternoonHours, eveningHours, activeDays, onlineCount].
// Online sections contribute to onlineCount but do not contribute hours to any window.
export function computeArchetypeVector(schedule) {
  const courses = _scheduleCourses(schedule);
  const NOON = 12 * 60, FIVE = 17 * 60;
  let morn = 0, aft = 0, eve = 0, online = 0;
  const active = new Set();
  for (const c of courses) {
    if (c.online) { online++; continue; }
    const start = _toMin(c.start);
    const end   = _toMin(c.end);
    if (start == null || end == null) continue;
    morn += Math.max(0, Math.min(end, NOON) - start) / 60;
    aft  += Math.max(0, Math.min(end, FIVE) - Math.max(start, NOON)) / 60;
    eve  += Math.max(0, end - Math.max(start, FIVE)) / 60;
    for (const d of c.days || []) active.add(d);
  }
  return [
    +morn.toFixed(3),
    +aft.toFixed(3),
    +eve.toFixed(3),
    active.size,
    online,
  ];
}

// Mean pairwise L1 distance in max-normalized space.
export function computeArchetypeDistance(schedules) {
  if (!Array.isArray(schedules) || schedules.length < 2) return null;
  const vecs = schedules.map(computeArchetypeVector);
  const axes = vecs[0].length;
  const maxes = new Array(axes).fill(0);
  for (const v of vecs) for (let j = 0; j < axes; j++) if (v[j] > maxes[j]) maxes[j] = v[j];
  const denoms = maxes.map((m) => (m > 0 ? m : 1));
  let total = 0, pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let k = i + 1; k < vecs.length; k++) {
      let axisSum = 0;
      for (let j = 0; j < axes; j++) {
        axisSum += Math.abs(vecs[i][j] - vecs[k][j]) / denoms[j];
      }
      total += axisSum / axes;
      pairs++;
    }
  }
  return pairs ? +(total / pairs).toFixed(4) : null;
}

// Did stated soft preferences actually move the top-1 pick?
// Returns 1 if zeroing all soft weights would have produced a different
// top-1 course set, 0 if they didn't matter, null if no soft prefs stated.
export function computePenaltyEffectiveness({ topSchedules, allScored, preferences, vectorKey = "scoreAffinity" } = {}) {
  if (!topSchedules?.length || !allScored?.length || !preferences) return null;
  const softKeys = ["morningCutoffWeight", "lateCutoffWeight", "avoidDayWeight", "onlineWeight", "careerAffinityWeight"];
  const anyStated = softKeys.some((k) => preferences[k] != null && preferences[k] > 0);
  if (!anyStated) return null;

  const vecName = { scoreAffinity: "affinity", scoreOnline: "online", scoreBalanced: "balanced" }[vectorKey] || "affinity";
  const vec = WEIGHT_VECTORS[vecName];

  const zeroed = { ...preferences };
  for (const k of softKeys) zeroed[k] = 0;

  let bestScore = -Infinity, bestIdx = -1;
  for (let i = 0; i < allScored.length; i++) {
    const score = applyVector(allScored[i].metrics, vec, zeroed);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  const withoutPrefs = allScored[bestIdx];

  const nameOf = (s) => new Set(s.result.picks.map((p) => p.courseObj.course));
  const A = nameOf(withoutPrefs);
  const B = nameOf(topSchedules[0]);
  for (const x of A) if (!B.has(x)) return 1;
  for (const x of B) if (!A.has(x)) return 1;
  return 0;
}

// Phase 0 stub — real implementation arrives in Phase 1 with the Requirement Graph.
// Returns null to indicate "not measurable yet" so callers don't gate on it.
export function computeRequirementGraphValidity(_schedule, _graph) {
  return null;
}

// Internal helper (mirrors toMinutes from time.js — kept local to avoid
// a dependency purely for this private use).
function _toMin(timeStr) {
  if (!timeStr) return null;
  const h = parseInt(timeStr.slice(0, 2), 10);
  const m = parseInt(timeStr.slice(2, 4), 10);
  return h * 60 + m;
}
