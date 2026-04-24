// scheduler/solver/constraints.js — constraint builders + section-conflict helpers
// Extracted from scheduleGenerator.js section 10 (buildConstraints) and
// the conflict-check helpers used during backtracking.
//
// Depends on: ../time.js

import { toMinutes, timesOverlap, daysOverlap } from "../time.js";

// Preference-distance for section ordering (pref-biased solve pass). Mirrors
// docs/postmortems/bug1-morning-preference.md — lower is better.
export function preferenceSectionDistance(section, prefs) {
  if (!prefs) return 0;
  const wM = prefs.morningCutoffWeight ?? 0.5;
  const wL = prefs.lateCutoffWeight ?? 0.5;
  const wAv = prefs.avoidDayWeight ?? 0.5;
  const wOn = prefs.onlineWeight ?? 0.5;
  let d = 0;
  if (!section.online && prefs.noEarlierThan) {
    const cutoff = toMinutes(prefs.noEarlierThan);
    const start = toMinutes(section.start);
    if (start != null && cutoff != null && start < cutoff) {
      d += ((cutoff - start) / 60) * wM;
    }
  }
  if (!section.online && prefs.noLaterThan) {
    const cutoff = toMinutes(prefs.noLaterThan);
    const end = toMinutes(section.end);
    if (end != null && cutoff != null && end > cutoff) {
      d += ((end - cutoff) / 60) * wL;
    }
  }
  const soft = prefs.softAvoidDays || [];
  if (soft.length && !section.online) {
    const overlaps = (section.days || []).some((day) => soft.includes(day));
    if (overlaps) d += wAv;
  }
  if (prefs.preferInPerson && section.online) d += wOn;
  return d;
}

export function sectionConflictsFixed(section, fixedSlots) {
  if (section.online || !section.days || !section.start) return false;
  for (const slot of fixedSlots) {
    if (!slot.days || !slot.start) continue;
    if (daysOverlap(section.days, slot.days) &&
        timesOverlap(section.start, section.end, slot.start, slot.end)) return true;
  }
  return false;
}

export function sectionsConflict(a, b) {
  if (a.online || b.online) return false;
  return daysOverlap(a.days, b.days) && timesOverlap(a.start, a.end, b.start, b.end);
}

// buildConstraints: translate preferences + profile into the hard-constraint
// object the solver uses. Weight-1.0 soft prefs become hard constraints (D14).
// The calibrator floors a weight at 1.0 only when the student's phrasing is
// firm; below 1.0 the pref stays soft and only influences the scorer.
export function buildConstraints(preferences, studentProfile, lockedCourses) {
  const hardAvoidDays = (studentProfile.avoidDays || []).filter(() =>
    (preferences.avoidDayWeight ?? 0.5) >= 1.0
  );
  const base = {
    calendarBlocks: studentProfile.calendarBlocks || [],
    lockedCourses: lockedCourses || [],
    hardAvoidDays,
    minCredits: preferences.minCredits ?? 12,
    maxCredits: preferences.maxCredits ?? 18,
    minCourses: 3,
    maxCourses: 6,
  };
  if ((preferences.morningCutoffWeight ?? 0) >= 1.0 && preferences.noEarlierThan) {
    base.hardNoEarlierThan = preferences.noEarlierThan;
  }
  if ((preferences.lateCutoffWeight ?? 0) >= 1.0 && preferences.noLaterThan) {
    base.hardNoLaterThan = preferences.noLaterThan;
  }
  if ((preferences.onlineWeight ?? 0) >= 1.0 && preferences.preferInPerson) {
    base.hardDropOnline = true;
  }
  return base;
}

export function _constraintSnapshot(constraints, workingPrefs) {
  return {
    minCredits: constraints.minCredits,
    maxCredits: constraints.maxCredits,
    hardAvoidDays: constraints.hardAvoidDays.slice(),
    calendarBlocks: (constraints.calendarBlocks || []).length,
    lockedCourses: (constraints.lockedCourses || []).length,
    noEarlierThan: workingPrefs.noEarlierThan || null,
    preferOnline: workingPrefs.preferOnline ?? null,
  };
}
