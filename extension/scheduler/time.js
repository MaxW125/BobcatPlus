// scheduler/time.js — time/day helper functions
// Extracted from scheduleGenerator.js section 1. Pure, no dependencies.

export function toMinutes(timeStr) {
  if (!timeStr) return null;
  const h = parseInt(timeStr.slice(0, 2), 10);
  const m = parseInt(timeStr.slice(2, 4), 10);
  return h * 60 + m;
}

export function timesOverlap(aStart, aEnd, bStart, bEnd) {
  const a1 = toMinutes(aStart), a2 = toMinutes(aEnd);
  const b1 = toMinutes(bStart), b2 = toMinutes(bEnd);
  if (a1 == null || b1 == null) return false;
  return a1 < b2 && b1 < a2;
}

export function daysOverlap(aDays, bDays) {
  if (!aDays || !bDays) return false;
  return aDays.some((d) => bDays.includes(d));
}

// Pair-finder for "has any two courses in this list got a real time clash?"
// Shared by the solver's validator and by tab.js's status-bar warning.
// Bug 5 (2026-04-21): online sections sometimes carry phantom meeting data
// from Banner; the `online` flag is the authoritative signal to skip.
// Accepts either 4-char "HHMM" or colon "HH:MM" time strings.
export function findOverlapPair(courses) {
  function toMin(t) {
    if (!t || typeof t !== "string") return null;
    const colon = t.indexOf(":");
    if (colon >= 0) {
      return parseInt(t.slice(0, colon), 10) * 60 + parseInt(t.slice(colon + 1), 10);
    }
    if (t.length >= 4) {
      return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2, 4), 10);
    }
    return null;
  }
  const list = Array.isArray(courses) ? courses : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || a.online) continue;
    const aS = toMin(a.beginTime ?? a.start);
    const aE = toMin(a.endTime   ?? a.end);
    if (!a.days || !a.days.length || aS == null || aE == null) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b || b.online) continue;
      const bS = toMin(b.beginTime ?? b.start);
      const bE = toMin(b.endTime   ?? b.end);
      if (!b.days || !b.days.length || bS == null || bE == null) continue;
      if (!a.days.some((d) => b.days.includes(d))) continue;
      if (aS < bE && bS < aE) return { a, b };
    }
  }
  return null;
}

export function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}
