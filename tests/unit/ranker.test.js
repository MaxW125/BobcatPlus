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

cases.push({
  name: "pickTop3: Pass-1 Jaccard<=0.7 prefers a different course-set over same-courses/different-sections",
  run() {
    // Regression target: commit 62722e2 ("add Jaccard<1.0 fallback tier").
    //
    // Scenario: solver emits 3 feasible results.
    //   r1 = {A,B,C} at morning sections — highest affinity score
    //   r2 = {A,B,C} at afternoon sections — same course set, different CRNs
    //   r3 = {A,B,D} — ONE course swapped; Jaccard(r3,r1) = 2/4 = 0.5
    //
    // Correct behavior: top[] should include r3's course set {A,B,D} in at
    // least one pick, because Pass 1 of pickFrom requires Jaccard<=0.7 vs
    // already-taken picks. If Pass 1's filter were removed (or weakened back
    // to section-signature-only dedup), r2 would outrank r3 on any vector
    // where it scored higher, and the top picks would be "same courses, just
    // different lab times" — which is the exact bug 62722e2 fixed.
    //
    // We construct results hand-wise (not via the solver) so the assertion
    // is pinned to the ranker's dedup contract, independent of solver state.
    const mk = (courseName, crn, days, start, end) => ({
      courseObj: synth.course({ name: courseName }),
      section: synth.section({ crn, days, start, end }),
    });

    const r1 = {
      picks: [
        mk("CS 3339", "R1-A", synth.MWF, "0800", "0915"),
        mk("MATH 2471", "R1-B", synth.TR, "0800", "0915"),
        mk("ENG 1310", "R1-C", synth.MWF, "1000", "1115"),
      ],
      credits: 9,
    };
    const r2 = {
      picks: [
        mk("CS 3339", "R2-A", synth.MWF, "1400", "1515"),
        mk("MATH 2471", "R2-B", synth.TR, "1400", "1515"),
        mk("ENG 1310", "R2-C", synth.MWF, "1600", "1715"),
      ],
      credits: 9,
    };
    const r3 = {
      picks: [
        mk("CS 3339", "R3-A", synth.MWF, "1000", "1115"),
        mk("MATH 2471", "R3-B", synth.TR, "1000", "1115"),
        mk("HIST 1310", "R3-D", synth.MWF, "1200", "1315"),
      ],
      credits: 9,
    };

    const top = BP.pickTop3([r1, r2, r3], synth.defaultPreferences(), {});
    assertTrue(top.length >= 2, `expected ≥2 top picks, got ${top.length}`);

    // The regression canary: HIST 1310 appears in the top when a Jaccard-0.5
    // alternative exists. If the dedup filter ever regressed, the top would
    // contain r1 + r2 (both {CS,MATH,ENG}) and HIST would be invisible.
    const hasHist = top.some((t) =>
      t.result.picks.some((p) => p.courseObj.course === "HIST 1310"),
    );
    assertTrue(
      hasHist,
      "Pass 1 Jaccard<=0.7 filter should surface the {A,B,D} alternative " +
        "instead of stacking two copies of {A,B,C}",
    );

    // Second-tier assertion: the set of course-sets in top is >1. Without
    // the filter, top would be [{A,B,C},{A,B,C},…] — one unique set.
    const courseSetKey = (t) =>
      [...new Set(t.result.picks.map((p) => p.courseObj.course))].sort().join(",");
    const uniqueCourseSets = new Set(top.map(courseSetKey));
    assertTrue(
      uniqueCourseSets.size >= 2,
      `top should expose ≥2 distinct course-sets when alternatives exist, got ${uniqueCourseSets.size}`,
    );
  },
});

module.exports = { cases };
