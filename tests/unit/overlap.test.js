// Unit tests for BP.findOverlapPair — the shared conflict-pair detector
// used by the solver's defense-in-depth validator and by tab.js's working-
// courses status-bar warning.
//
// Bug 5 regression: online sections sometimes carry phantom meeting data
// from Banner (days / beginTime / endTime populated). Downstream consumers
// must treat `online: true` as authoritative and ignore the meeting fields.

const {
  BP,
  assertEqual,
  assertTrue,
  assertDeepEqual,
  fail,
} = require("./_harness");

const find = BP.findOverlapPair;

function mk(props) {
  return Object.assign(
    { subject: "X", courseNumber: "0000", crn: "00000", days: [], beginTime: null, endTime: null, online: false },
    props,
  );
}

module.exports = {
  cases: [
    {
      name: "empty input returns null",
      run() {
        assertEqual(find([]), null);
        assertEqual(find(null), null);
        assertEqual(find(undefined), null);
      },
    },

    {
      name: "two in-person courses on different days do NOT overlap",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon", "Wed"], beginTime: "15:20", endTime: "16:50" });
        const b = mk({ subject: "CS",   courseNumber: "4398", days: ["Tue", "Thu"], beginTime: "15:30", endTime: "16:50" });
        assertEqual(find([a, b]), null);
      },
    },

    {
      name: "two in-person courses at same time on shared day DO overlap",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon", "Wed"], beginTime: "15:20", endTime: "16:50" });
        const b = mk({ subject: "HIST", courseNumber: "1310", days: ["Mon"],        beginTime: "15:30", endTime: "16:50" });
        const pair = find([a, b]);
        assertTrue(pair != null, "pair detected");
        assertEqual(pair.a.subject, "MATH");
        assertEqual(pair.b.subject, "HIST");
      },
    },

    {
      name: "back-to-back (a ends exactly when b starts) is NOT an overlap",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon"], beginTime: "15:20", endTime: "16:50" });
        const b = mk({ subject: "PHIL", courseNumber: "1305", days: ["Mon"], beginTime: "16:50", endTime: "18:10" });
        assertEqual(find([a, b]), null);
      },
    },

    {
      name: "Bug 5 regression: online course with phantom meeting data is skipped",
      run() {
        const realMath = mk({
          subject: "MATH", courseNumber: "3305",
          days: ["Mon", "Wed"], beginTime: "15:20", endTime: "16:50",
          online: false,
        });
        const phantomOnlineCs = mk({
          subject: "CS", courseNumber: "4371",
          days: ["Wed"], beginTime: "15:30", endTime: "16:50",
          online: true,
        });
        const pair = find([realMath, phantomOnlineCs]);
        assertEqual(
          pair, null,
          "online course must not produce a conflict even with populated meeting data",
        );
      },
    },

    {
      name: "two online courses at same wall-clock time do NOT conflict",
      run() {
        const a = mk({ subject: "CS", courseNumber: "4371", days: ["Mon"], beginTime: "09:00", endTime: "10:30", online: true });
        const b = mk({ subject: "CS", courseNumber: "4378", days: ["Mon"], beginTime: "09:00", endTime: "10:30", online: true });
        assertEqual(find([a, b]), null);
      },
    },

    {
      name: "helper tolerates 4-char HHMM format (solver convention)",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon"], beginTime: "1520", endTime: "1650" });
        const b = mk({ subject: "HIST", courseNumber: "1310", days: ["Mon"], beginTime: "1530", endTime: "1650" });
        const pair = find([a, b]);
        assertTrue(pair != null, "overlap detected in HHMM format");
      },
    },

    {
      name: "helper tolerates `start` / `end` aliases (LLM-turn output convention)",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon"], beginTime: null, endTime: null, start: "1520", end: "1650" });
        const b = mk({ subject: "HIST", courseNumber: "1310", days: ["Mon"], beginTime: null, endTime: null, start: "1530", end: "1650" });
        delete a.beginTime; delete a.endTime;
        delete b.beginTime; delete b.endTime;
        a.start = "1520"; a.end = "1650";
        b.start = "1530"; b.end = "1650";
        const pair = find([a, b]);
        assertTrue(pair != null, "overlap detected using start/end aliases");
      },
    },

    {
      name: "missing meeting data on one side does not crash; returns null",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon"], beginTime: "15:20", endTime: "16:50" });
        const b = mk({ subject: "ASL",  courseNumber: "1410", days: [], beginTime: null, endTime: null });
        assertEqual(find([a, b]), null);
      },
    },

    {
      name: "first overlapping pair found is the one returned (ordering stability)",
      run() {
        const a = mk({ subject: "MATH", courseNumber: "3305", days: ["Mon"], beginTime: "15:00", endTime: "16:00" });
        const b = mk({ subject: "HIST", courseNumber: "1310", days: ["Mon"], beginTime: "15:30", endTime: "16:30" });
        const c = mk({ subject: "CHEM", courseNumber: "1341", days: ["Mon"], beginTime: "15:45", endTime: "17:00" });
        const pair = find([a, b, c]);
        assertTrue(pair != null, "pair detected");
        // i=0, j=1 is the first overlap discovered.
        assertDeepEqual(
          [pair.a.subject, pair.b.subject],
          ["MATH", "HIST"],
          "returns first-found pair in nested-loop order",
        );
      },
    },
  ],
};
