// scheduler/validate.js — defense-in-depth schedule validator
// Extracted from scheduleGenerator.js section 3.
//
// INVARIANT #6: validateSchedule is defense-in-depth, NOT the primary gate.
// The solver guarantees feasibility. This validator catches data-quality
// issues (sections with missing/wrong meeting data) that slip past the solver.
// It must never be removed under the assumption that "the solver already checks".

import { daysOverlap, timesOverlap } from "./time.js";

export function validateSchedule(schedule, calendarBlocks = [], lockedCourses = []) {
  const violations = [];
  const courses = schedule.courses || [];

  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      const a = courses[i], b = courses[j];
      if (a.online || b.online) continue;
      if (daysOverlap(a.days, b.days) && timesOverlap(a.start, a.end, b.start, b.end)) {
        violations.push({ type: "course_conflict", a: a.course, b: b.course });
      }
    }
  }
  for (const c of courses) {
    if (c.online) continue;
    for (const b of calendarBlocks) {
      if (daysOverlap(c.days, b.days) && timesOverlap(c.start, c.end, b.start, b.end)) {
        violations.push({ type: "block_conflict", course: c.course, block: b.label });
      }
    }
    for (const l of lockedCourses) {
      if (!l.days || !l.start || !l.end) continue;
      if (daysOverlap(c.days, l.days) && timesOverlap(c.start, c.end, l.start, l.end)) {
        violations.push({ type: "locked_conflict", course: c.course, locked: l.course });
      }
    }
  }
  return violations;
}
