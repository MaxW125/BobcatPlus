// pickTop3 / rankSchedules / scoreBreakdown tests. Pure, no OpenAI.

const {
  BP,
  assertEqual,
  assertTrue,
  assertApprox,
  assertGreater,
} = require("./_harness");
const synth = require("./_synth");

const cases = [];

cases.push({
  name: "rankSchedules: empty input returns empty top + empty allScored",
  run() {
    const { top, allScored } = BP.rankSchedules([], synth.defaultPreferences(), {});
    assertEqual(top.length, 0);
    assertEqual(allScored.length, 0);
  },
});

cases.push({
  name: "rankSchedules: every scored entry has a 3-vector scoreBreakdown that reconstructs totals",
  run() {
    const eligible = synth.morningVsAfternoonEligible();
    const solved = BP.solve(eligible, synth.defaultConstraints({ minCourses: 3, minCredits: 9 }));
    assertGreater(solved.results.length, 0, "need solver output for test");

    const { allScored } = BP.rankSchedules(solved.results, synth.defaultPreferences(), {});
    for (const s of allScored) {
      assertTrue(s.scoreBreakdown, "missing scoreBreakdown");
      for (const k of ["affinity", "online", "balanced"]) {
        const bd = s.scoreBreakdown[k];
        assertTrue(bd, `missing ${k} breakdown`);
        const sum = bd.affinityTerm + bd.onlineTerm + bd.balanceTerm
                  - bd.morningPen - bd.latePen - bd.softAvoidPen - bd.creditPen;
        assertApprox(bd.total, sum, 1e-9, `${k} breakdown terms don't sum`);
      }
      // total on breakdown should match the top-level score field
      assertApprox(s.scoreAffinity, s.scoreBreakdown.affinity.total, 1e-9);
      assertApprox(s.scoreOnline,   s.scoreBreakdown.online.total,   1e-9);
      assertApprox(s.scoreBalanced, s.scoreBreakdown.balanced.total, 1e-9);
    }
  },
});

cases.push({
  name: "pickTop3: returns at most 3 picks",
  run() {
    const eligible = synth.morningVsAfternoonEligible();
    const solved = BP.solve(eligible, synth.defaultConstraints({ minCourses: 3, minCredits: 9 }));
    const top = BP.pickTop3(solved.results, synth.defaultPreferences(), {});
    assertTrue(top.length <= 3, `expected ≤3 picks, got ${top.length}`);
  },
});

cases.push({
  name: "pickTop3: every picked schedule is a valid feasible solver result (has picks + credits)",
  run() {
    const eligible = synth.morningVsAfternoonEligible();
    const solved = BP.solve(eligible, synth.defaultConstraints({ minCourses: 3, minCredits: 9 }));
    const top = BP.pickTop3(solved.results, synth.defaultPreferences(), {});
    for (const t of top) {
      assertTrue(t.result && Array.isArray(t.result.picks), "missing result.picks");
      assertTrue(typeof t.result.credits === "number", "missing result.credits");
      assertTrue(t.label, "missing label");
      assertTrue(t.scoreBreakdown, "missing scoreBreakdown on picked schedule");
    }
  },
});

cases.push({
  name: "pickTop3: picks are sorted/selected under each vector's argmax",
  run() {
    // With uniform prefs but mixed online sections, the 'online' vector should
    // prefer the schedule with the most online sections.
    const onlineCourse = synth.course({
      name: "ONL 1000",
      sections: [synth.section({ crn: "ONL1", online: true })],
    });
    const ipCourse = synth.course({
      name: "IP 1000",
      sections: [synth.section({ crn: "IP1", days: synth.MWF, ...synth.MORNING_10AM })],
    });
    const second = synth.course({
      name: "IP 2000",
      sections: [synth.section({ crn: "IP2", days: synth.TR, ...synth.AFTERNOON_2PM })],
    });
    const third = synth.course({
      name: "IP 3000",
      sections: [synth.section({ crn: "IP3", days: synth.MWF, ...synth.EVENING_6PM })],
    });
    const eligible = [onlineCourse, ipCourse, second, third];
    const solved = BP.solve(eligible, synth.defaultConstraints({ minCourses: 2, minCredits: 6 }));
    const top = BP.pickTop3(solved.results, synth.defaultPreferences(), {});
    const onlineLabeled = top.find((t) => t.label === "Most online / flexible");
    assertTrue(!!onlineLabeled, "online vector pick missing");
    const hasOnline = onlineLabeled.result.picks.some((p) => p.section.online);
    assertTrue(hasOnline,
      "online-vector pick should contain an online section when available");
  },
});

cases.push({
  name: "pickTop3: Jaccard cap prevents duplicate course-sets across 3 picks",
  run() {
    // When the eligible list only has one viable full-credit combination,
    // Jaccard fallback passes must still produce 3 distinct top objects
    // (by section — tradeoff between times — not by courses).
    const eligible = synth.morningVsAfternoonEligible();
    const solved = BP.solve(eligible, synth.defaultConstraints({ minCourses: 3, minCredits: 9 }));
    const top = BP.pickTop3(solved.results, synth.defaultPreferences(), {});
    const crnKey = (t) => t.result.picks.map((p) => p.section.crn).sort().join(",");
    const keys = new Set(top.map(crnKey));
    assertEqual(keys.size, top.length, "duplicate schedules by CRN set in top picks");
  },
});

module.exports = { cases };
