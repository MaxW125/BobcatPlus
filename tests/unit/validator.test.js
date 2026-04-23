// validateSchedule tests — defense-in-depth checker for the solver output.
//
// Why this file exists:
//   docs/invariants.md #6 says "validateSchedule is defense
//   in depth, not the enforcer. If it ever fires, the solver is wrong." That
//   contract is only useful if we know `validateSchedule` itself is correct.
//   Before today this file did not exist — the validator was asserted by
//   documentation alone. If the validator silently stopped catching a class
//   of violations, no test would notice until the solver actually produced
//   a bad schedule and nobody saw the warning.
//
//   These cases fix the three violation types in code (course_conflict,
//   block_conflict, locked_conflict) and also pin the explicit bypass paths
//   (online courses, locked-rows with missing days/start/end).

const { BP, assertEqual, assertTrue } = require("./_harness");

const cases = [];

// Canonical shapes the validator consumes. These mirror what the scheduler
// builds in the "pseudo" schedule passed to validateSchedule() on line ~1973
// of scheduleGenerator.js, not what _synth.js produces (which is the solver's
// INPUT shape, not its output shape).
function course(name, days, start, end, { online = false } = {}) {
  return { course: name, days, start, end, online };
}
function block(label, days, start, end) {
  return { label, days, start, end };
}
function locked(name, days, start, end) {
  return { course: name, days, start, end };
}
const MWF = ["Mon", "Wed", "Fri"];
const TR  = ["Tue", "Thu"];

// ── baseline: well-formed schedules should produce 0 violations ─────────────

cases.push({
  name: "validateSchedule: empty schedule → no violations",
  run() {
    const v = BP.validateSchedule({ courses: [] }, [], []);
    assertEqual(v.length, 0, `expected 0 violations, got ${JSON.stringify(v)}`);
  },
});

cases.push({
  name: "validateSchedule: single in-person course, no blocks → no violations",
  run() {
    const s = { courses: [course("ENG 1310", MWF, "1000", "1115")] };
    const v = BP.validateSchedule(s, [], []);
    assertEqual(v.length, 0);
  },
});

cases.push({
  name: "validateSchedule: non-overlapping times on same day → no violations",
  run() {
    const s = {
      courses: [
        course("A", MWF, "0800", "0915"),
        course("B", MWF, "1000", "1115"),
      ],
    };
    const v = BP.validateSchedule(s, [], []);
    assertEqual(v.length, 0);
  },
});

cases.push({
  name: "validateSchedule: overlapping times on different days → no violations",
  run() {
    const s = {
      courses: [
        course("A", MWF, "1000", "1115"),
        course("B", TR, "1000", "1115"),
      ],
    };
    const v = BP.validateSchedule(s, [], []);
    assertEqual(v.length, 0);
  },
});

// ── course_conflict: two in-person sections at the same day/time ───────────

cases.push({
  name: "validateSchedule: same day + overlapping times → course_conflict violation",
  run() {
    const s = {
      courses: [
        course("A", MWF, "1000", "1115"),
        course("B", MWF, "1030", "1145"),
      ],
    };
    const v = BP.validateSchedule(s, [], []);
    assertEqual(v.length, 1, `expected 1 violation, got ${JSON.stringify(v)}`);
    assertEqual(v[0].type, "course_conflict");
    // Order stable — the i<j double-loop means (A,B) not (B,A).
    assertEqual(v[0].a, "A");
    assertEqual(v[0].b, "B");
  },
});

cases.push({
  name: "validateSchedule: online section in pair bypasses course_conflict",
  run() {
    // Invariant: online courses are never counted as time-conflicting. This
    // is the guardrail that allows the solver to place an online section in
    // the same MWF 10am slot as an in-person one without false positives.
    const s = {
      courses: [
        course("A", MWF, "1000", "1115"),
        course("B", MWF, "1000", "1115", { online: true }),
      ],
    };
    const v = BP.validateSchedule(s, [], []);
    assertEqual(v.length, 0, `online should bypass, got ${JSON.stringify(v)}`);
  },
});

// ── block_conflict: calendar block covers a course's meeting ───────────────

cases.push({
  name: "validateSchedule: course overlapping a calendarBlock → block_conflict violation",
  run() {
    const s = { courses: [course("HIST 1310", TR, "1400", "1515")] };
    const blocks = [block("Work shift", ["Tue"], "1300", "1700")];
    const v = BP.validateSchedule(s, blocks, []);
    assertEqual(v.length, 1);
    assertEqual(v[0].type, "block_conflict");
    assertEqual(v[0].course, "HIST 1310");
    assertEqual(v[0].block, "Work shift");
  },
});

cases.push({
  name: "validateSchedule: online course + calendarBlock → no block_conflict",
  run() {
    const s = { courses: [course("ONL 1000", [], null, null, { online: true })] };
    const blocks = [block("Work", ["Tue"], "1300", "1700")];
    const v = BP.validateSchedule(s, blocks, []);
    assertEqual(v.length, 0);
  },
});

// ── locked_conflict: overlaps with a user-locked course (e.g. registered) ──

cases.push({
  name: "validateSchedule: course overlapping a lockedCourse → locked_conflict violation",
  run() {
    const s = { courses: [course("MATH 1315", MWF, "1000", "1115")] };
    const locks = [locked("CHEM 1310", MWF, "1030", "1145")];
    const v = BP.validateSchedule(s, [], locks);
    assertEqual(v.length, 1);
    assertEqual(v[0].type, "locked_conflict");
    assertEqual(v[0].course, "MATH 1315");
    assertEqual(v[0].locked, "CHEM 1310");
  },
});

cases.push({
  name: "validateSchedule: lockedCourse with missing days/start/end is skipped (defensive)",
  run() {
    // Live registered-events can arrive with null meeting times (TBA rows,
    // distance-ed sections). The validator bypasses them rather than crash.
    // Without this bypass, every async section on the schedule becomes a
    // phantom conflict.
    const s = { courses: [course("A", MWF, "1000", "1115")] };
    const locks = [
      { course: "TBA-1", days: null, start: null, end: null },
      { course: "TBA-2", days: MWF, start: null, end: "1115" },
      { course: "TBA-3", days: MWF, start: "1000", end: null },
    ];
    const v = BP.validateSchedule(s, [], locks);
    assertEqual(v.length, 0, `partial-locks should be skipped, got ${JSON.stringify(v)}`);
  },
});

// ── combined: all three violation types fire in one pass ───────────────────

cases.push({
  name: "validateSchedule: course + block + locked conflicts all surface in one call",
  run() {
    const s = {
      courses: [
        course("A", MWF, "1000", "1115"),
        course("B", MWF, "1030", "1145"),
      ],
    };
    const blocks = [block("Gym", MWF, "1000", "1200")];
    const locks = [locked("LAB", MWF, "1000", "1115")];
    const v = BP.validateSchedule(s, blocks, locks);
    const byType = v.reduce((acc, x) => {
      acc[x.type] = (acc[x.type] || 0) + 1;
      return acc;
    }, {});
    assertTrue(byType.course_conflict >= 1, `missing course_conflict in ${JSON.stringify(v)}`);
    assertTrue(byType.block_conflict >= 1, `missing block_conflict in ${JSON.stringify(v)}`);
    assertTrue(byType.locked_conflict >= 1, `missing locked_conflict in ${JSON.stringify(v)}`);
  },
});

cases.push({
  name: "validateSchedule: fully online schedule + any constraints → no violations",
  run() {
    const s = {
      courses: [
        course("ONL 1", [], null, null, { online: true }),
        course("ONL 2", [], null, null, { online: true }),
      ],
    };
    const blocks = [block("Work", MWF, "0900", "1700")];
    const locks = [locked("OTHER", MWF, "0900", "1000")];
    const v = BP.validateSchedule(s, blocks, locks);
    assertEqual(v.length, 0, "online sections should ignore every time-based check");
  },
});

module.exports = { cases };
