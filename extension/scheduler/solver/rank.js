// scheduler/solver/rank.js — scoring + tiered Jaccard dedup
// Extracted from scheduleGenerator.js section 9.
//
// INVARIANT #5: Tiered Jaccard dedup — pickTop3 must select 3 schedules with
// meaningfully different course sets. Three passes in descending strictness:
//   Pass 1: Jaccard(courseSet_A, courseSet_B) <= 0.7 (meaningfully different)
//   Pass 2: Jaccard < 1.0 (at least one different course)
//   Pass 3: Last-resort fallback — return SOMETHING rather than < 3 picks.
// Never collapse this to a single threshold; the three-pass cascade is the
// invariant. See docs/invariants.md #5.
//
// Depends on: ../time.js (toMinutes, for scoreSchedule)

import { toMinutes } from "../time.js";

// Three shifted weight vectors → three distinct top schedules.
// Each returns a scalar; higher is better.
export const WEIGHT_VECTORS = {
  affinity: {
    affinity: 1.0, online: 0.2, balance: 0.1,
    morning: 0.3, late: 0.3, avoidDay: 0.6, creditTarget: 0.4,
  },
  online: {
    affinity: 0.3, online: 1.0, balance: 0.1,
    morning: 0.3, late: 0.3, avoidDay: 0.6, creditTarget: 0.4,
  },
  balanced: {
    affinity: 0.4, online: 0.2, balance: 1.0,
    morning: 0.3, late: 0.3, avoidDay: 0.6, creditTarget: 0.4,
  },
};

export function scoreSchedule(result, preferences, affinityScores) {
  const picks = result.picks;
  const n = picks.length || 1;
  let affinitySum = 0, onlineCount = 0, morningPenalty = 0, softAvoidPenalty = 0, latePenalty = 0;
  const dayLoad = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };

  for (const p of picks) {
    const sc = affinityScores[p.courseObj.course];
    affinitySum += sc ? sc.score : 0.5;
    if (p.section.online) onlineCount++;
    if (!p.section.online && preferences.noEarlierThan) {
      const cutoff = toMinutes(preferences.noEarlierThan);
      const start = toMinutes(p.section.start);
      if (start != null && cutoff != null && start < cutoff) {
        morningPenalty += (cutoff - start) / 60;
      }
    }
    if (!p.section.online && preferences.noLaterThan) {
      const cutoff = toMinutes(preferences.noLaterThan);
      const end = toMinutes(p.section.end);
      if (end != null && cutoff != null && end > cutoff) {
        latePenalty += (end - cutoff) / 60;
      }
    }
    if (!p.section.online && (preferences.softAvoidDays || []).length) {
      const hits = (p.section.days || []).filter((d) => preferences.softAvoidDays.includes(d));
      softAvoidPenalty += hits.length;
    }
    for (const d of (p.section.days || [])) dayLoad[d] = (dayLoad[d] || 0) + 1;
  }

  const affinityNorm = affinitySum / n;
  const onlineRatio = onlineCount / n;
  // Balance rewards spreading load across ALL 5 weekdays. Keeping zero-load
  // days in the calculation penalizes concentration directly (prior version
  // filtered to active days only, which rewarded Tue/Thu-only packing).
  const allDays = Object.values(dayLoad);
  const mean = allDays.reduce((s, v) => s + v, 0) / allDays.length;
  const variance = allDays.reduce((s, v) => s + (v - mean) ** 2, 0) / allDays.length;
  const balance = 1 / (1 + variance);

  const creditTargetDist = preferences.targetCredits
    ? Math.abs(result.credits - preferences.targetCredits) / 18
    : 0;

  return {
    affinityNorm, onlineRatio, morningPenalty, latePenalty, softAvoidPenalty, balance,
    creditTargetDist, dayLoad,
  };
}

// Per-vector breakdown: separates each scoring term so the trace / tests can
// explain why a schedule was picked. applyVector returns only `total` for
// back-compat; breakdownOf is the richer form.
export function breakdownOf(metrics, vec, prefs) {
  const wOn = prefs.onlineWeight ?? 0.5;
  let onlineTerm;
  if (prefs.preferOnline === true) {
    onlineTerm = wOn * vec.online * metrics.onlineRatio;
  } else if (prefs.preferInPerson === true) {
    onlineTerm = -wOn * vec.online * metrics.onlineRatio;
  } else {
    onlineTerm = wOn * vec.online * metrics.onlineRatio;
  }
  const affinityTerm = (prefs.careerAffinityWeight ?? 0.5) * vec.affinity * metrics.affinityNorm;
  const balanceTerm  = vec.balance * metrics.balance;
  const morningPen   = (prefs.morningCutoffWeight ?? 0.5) * vec.morning * metrics.morningPenalty;
  const latePen      = (prefs.lateCutoffWeight ?? 0.5) * vec.late * metrics.latePenalty;
  const softAvoidPen = (prefs.avoidDayWeight ?? 0.5) * vec.avoidDay * metrics.softAvoidPenalty;
  const creditPen    = vec.creditTarget * metrics.creditTargetDist;
  const total = affinityTerm + onlineTerm + balanceTerm
                - morningPen - latePen - softAvoidPen - creditPen;
  return { affinityTerm, onlineTerm, balanceTerm, morningPen, latePen, softAvoidPen, creditPen, total };
}

export function applyVector(metrics, vec, prefs) {
  return breakdownOf(metrics, vec, prefs).total;
}

// rankSchedules: score every feasible result, compute the per-vector breakdown,
// and select 3 distinct top picks using tiered Jaccard dedup (INVARIANT #5).
// Returns both the picks AND the full scored list so the trace / metrics layer
// can explain runner-up deltas. pickTop3 is a thin wrapper for back-compat.
export function rankSchedules(results, preferences, affinityScores) {
  if (!results.length) return { top: [], allScored: [] };
  const scored = results.map((r) => {
    const metrics = scoreSchedule(r, preferences, affinityScores);
    const breakAffinity = breakdownOf(metrics, WEIGHT_VECTORS.affinity, preferences);
    const breakOnline   = breakdownOf(metrics, WEIGHT_VECTORS.online,   preferences);
    const breakBalanced = breakdownOf(metrics, WEIGHT_VECTORS.balanced, preferences);
    return {
      result: r, metrics,
      scoreAffinity: breakAffinity.total,
      scoreOnline:   breakOnline.total,
      scoreBalanced: breakBalanced.total,
      scoreBreakdown: {
        affinity: breakAffinity,
        online:   breakOnline,
        balanced: breakBalanced,
      },
    };
  });

  const picksById = (s) => s.result.picks.map((p) => p.section.crn).sort().join(",");
  const courseSet = (s) => new Set(s.result.picks.map((p) => p.courseObj.course));
  // Jaccard similarity on course sets — two schedules with the same 5 courses
  // differing only in section choice are not "tradeoffs", they're the same
  // plan at different times. INVARIANT #5: three-pass cascade, never collapse.
  const JACCARD_CAP = 0.7;
  function jaccard(a, b) {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  const top = [];
  const taken = new Set();

  const pickFrom = (sortKey, label, tagline) => {
    const sorted = scored.slice().sort((a, b) => b[sortKey] - a[sortKey]);
    // Pass 1: require Jaccard <= 0.7 (meaningfully different course sets)
    for (const s of sorted) {
      const id = picksById(s);
      if (taken.has(id)) continue;
      const mine = courseSet(s);
      const tooSimilar = top.some((t) => jaccard(mine, courseSet(t)) > JACCARD_CAP);
      if (tooSimilar) continue;
      taken.add(id);
      top.push({ ...s, label, tagline });
      return;
    }
    // Pass 2: require at least one different course (Jaccard < 1.0).
    for (const s of sorted) {
      const id = picksById(s);
      if (taken.has(id)) continue;
      const mine = courseSet(s);
      const duplicate = top.some((t) => jaccard(mine, courseSet(t)) >= 1.0);
      if (duplicate) continue;
      taken.add(id);
      top.push({ ...s, label, tagline });
      return;
    }
    // Pass 3: last-resort fallback — return SOMETHING rather than < 3 picks.
    for (const s of sorted) {
      const id = picksById(s);
      if (taken.has(id)) continue;
      taken.add(id);
      top.push({ ...s, label, tagline });
      return;
    }
  };

  pickFrom("scoreAffinity", "Best for your goals", "maximizes career-fit");
  pickFrom("scoreOnline",   "Most online / flexible", "maximizes online / time-flexible");
  pickFrom("scoreBalanced", "Most balanced week", "spreads load evenly across days");

  return { top, allScored: scored };
}

// Back-compat: pickTop3 returns just the array of 3 picks.
export function pickTop3(results, preferences, affinityScores) {
  return rankSchedules(results, preferences, affinityScores).top;
}
