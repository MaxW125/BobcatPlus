// Synthetic fixtures for the unit-test harness.
//
// Keep the shapes EXACTLY aligned with what `compressForSolver()` produces so
// that the solver, scorer, and ranker see inputs indistinguishable from
// production data. If you find yourself tempted to mock something that isn't
// on the real shape, you're probably testing the wrong thing.

// Section: {crn, days[], start, end, online, credits, instructor, campus,
//           courseDescription, meetingsFaculty[]}
function section({
  crn,
  days = [],
  start = null,
  end = null,
  online = false,
  credits = 3,
  instructor = "Prof. Test",
  campus = "Main",
}) {
  return {
    crn: String(crn),
    days: days.slice(),
    start,
    end,
    online,
    credits,
    instructor,
    campus,
    courseDescription: "",
    // Solver reads `s.meetingsFaculty[0]?.meetingTime` only in compressForSolver;
    // after compression the fields above are the source of truth. We still
    // include a plausible stub so compressForSolver tests don't explode.
    meetingsFaculty: [{ meetingTime: {} }],
  };
}

// Course: {course, title, requirementLabel, pairedCourse|null, sections[]}
function course({ name, title = null, requirementLabel = null, pairedCourse = null, sections = [] }) {
  return {
    course: name,
    title: title || name,
    requirementLabel: requirementLabel || "",
    pairedCourse,
    sections,
  };
}

// ── shorthand time constants ────────────────────────────────────────────────
const MORNING_8AM = { start: "0800", end: "0915" };
const MORNING_10AM = { start: "1000", end: "1115" };
const NOON = { start: "1200", end: "1315" };
const AFTERNOON_2PM = { start: "1400", end: "1515" };
const EVENING_6PM = { start: "1800", end: "1915" };

const MWF = ["Mon", "Wed", "Fri"];
const TR = ["Tue", "Thu"];

// ── canonical constraints ───────────────────────────────────────────────────
function defaultConstraints(overrides = {}) {
  return {
    calendarBlocks: [],
    lockedCourses: [],
    hardAvoidDays: [],
    minCredits: 12,
    maxCredits: 18,
    minCourses: 3,
    maxCourses: 6,
    ...overrides,
  };
}

function defaultPreferences(overrides = {}) {
  return {
    noEarlierThan: null,
    noLaterThan: null,
    softAvoidDays: [],
    targetCredits: null,
    careerKeywords: [],
    careerAffinityWeight: 0.5,
    onlineWeight: 0.5,
    morningCutoffWeight: 0.5,
    lateCutoffWeight: 0.5,
    avoidDayWeight: 0.5,
    preferOnline: false,
    preferInPerson: false,
    ...overrides,
  };
}

// ── scenario builders ───────────────────────────────────────────────────────

// A 3-course eligible list where every course has a morning section and an
// afternoon section. Used to test whether scoring prefers afternoon when the
// student asks for afternoon — Bug 1 scenario.
function morningVsAfternoonEligible() {
  return [
    course({
      name: "ENG 1310",
      requirementLabel: "English",
      sections: [
        section({ crn: "10001", days: MWF, ...MORNING_8AM }),   // morning
        section({ crn: "10002", days: MWF, ...AFTERNOON_2PM }), // afternoon (same days)
      ],
    }),
    course({
      name: "HIST 1310",
      requirementLabel: "History",
      sections: [
        section({ crn: "20001", days: TR, ...MORNING_10AM }),
        section({ crn: "20002", days: TR, ...AFTERNOON_2PM }),
      ],
    }),
    course({
      name: "MATH 1315",
      requirementLabel: "Math",
      sections: [
        section({ crn: "30001", days: MWF, ...NOON }),         // spans noon (both morning + afternoon)
        section({ crn: "30002", days: MWF, ...EVENING_6PM }),  // evening
      ],
    }),
    course({
      name: "PSY 1300",
      requirementLabel: "Social Science",
      sections: [
        section({ crn: "40001", days: TR, ...MORNING_10AM }),
        section({ crn: "40002", days: TR, ...AFTERNOON_2PM }),
      ],
    }),
  ];
}

// Eligible list with a direct time conflict between two courses so the solver
// must skip one. Used for conflict-detection tests.
function conflictingEligible() {
  return [
    course({
      name: "A 1000",
      sections: [section({ crn: "A1", days: MWF, ...MORNING_10AM })],
    }),
    course({
      name: "B 1000",
      // same Mon 10-11:15 slot — direct conflict
      sections: [section({ crn: "B1", days: MWF, ...MORNING_10AM })],
    }),
    course({
      name: "C 1000",
      sections: [section({ crn: "C1", days: TR, ...AFTERNOON_2PM })],
    }),
    course({
      name: "D 1000",
      sections: [section({ crn: "D1", days: TR, ...EVENING_6PM })],
    }),
  ];
}

// Lab-pair eligible: a lecture + required lab with a lab time that forces
// a specific lecture section pick.
function labPairEligible() {
  return [
    course({
      name: "BIO 1330",
      pairedCourse: "BIO 1130",
      sections: [
        section({ crn: "BIO-L-A", days: TR, ...MORNING_10AM }),
        section({ crn: "BIO-L-B", days: TR, ...AFTERNOON_2PM }),
      ],
    }),
    course({
      name: "BIO 1130",
      pairedCourse: "BIO 1330",
      sections: [
        section({ crn: "BIO-LAB-A", days: MWF, ...AFTERNOON_2PM }),
      ],
    }),
    course({
      name: "ENG 1310",
      sections: [section({ crn: "ENG-A", days: MWF, ...MORNING_10AM })],
    }),
    course({
      name: "HIST 1310",
      sections: [section({ crn: "HIST-A", days: TR, ...EVENING_6PM })],
    }),
  ];
}

module.exports = {
  section,
  course,
  MWF, TR,
  MORNING_8AM, MORNING_10AM, NOON, AFTERNOON_2PM, EVENING_6PM,
  defaultConstraints,
  defaultPreferences,
  morningVsAfternoonEligible,
  conflictingEligible,
  labPairEligible,
};
