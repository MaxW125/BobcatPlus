// solve() and solveMulti() unit tests. Pure, no OpenAI.

const {
  BP,
  assertEqual,
  assertTrue,
  assertGreater,
} = require("./_harness");
const synth = require("./_synth");

const cases = [];

cases.push({
  name: "solve: empty eligible returns zero results",
  run() {
    const out = BP.solve([], synth.defaultConstraints());
    assertEqual(out.results.length, 0, "no results");
    assertEqual(out.coursesWithViableSections, 0, "no viable courses");
  },
});

cases.push({
  name: "solve: produces only conflict-free schedules",
  run() {
    const eligible = synth.conflictingEligible();
    const out = BP.solve(eligible, synth.defaultConstraints({ minCourses: 2, minCredits: 6 }));
    assertGreater(out.results.length, 0, "at least one schedule expected");
    for (const r of out.results) {
      // no two picks share any day × time overlap
      const picks = r.picks;
      for (let i = 0; i < picks.length; i++) {
        for (let j = i + 1; j < picks.length; j++) {
          const a = picks[i].section, b = picks[j].section;
          if (a.online || b.online) continue;
          const sharesDay = (a.days || []).some((d) => (b.days || []).includes(d));
          if (!sharesDay) continue;
          const aStart = BP.toMinutes(a.start), aEnd = BP.toMinutes(a.end);
          const bStart = BP.toMinutes(b.start), bEnd = BP.toMinutes(b.end);
          const overlap = aStart < bEnd && bStart < aEnd;
          assertTrue(!overlap,
            `CRN ${a.crn} vs ${b.crn} overlap — solver violated its contract`);
        }
      }
    }
  },
});

cases.push({
  name: "solve: conflicting A 1000 and B 1000 never both appear",
  run() {
    const eligible = synth.conflictingEligible();
    const out = BP.solve(eligible, synth.defaultConstraints({ minCourses: 2, minCredits: 6 }));
    for (const r of out.results) {
      const names = r.picks.map((p) => p.courseObj.course);
      const both = names.includes("A 1000") && names.includes("B 1000");
      assertTrue(!both, "A 1000 and B 1000 are time-conflicting siblings");
    }
  },
});

cases.push({
  name: "solve: respects minCredits floor",
  run() {
    const eligible = synth.conflictingEligible(); // all 3-credit
    const out = BP.solve(eligible, synth.defaultConstraints({ minCredits: 12, minCourses: 4 }));
    for (const r of out.results) {
      assertTrue(r.credits >= 12, `credits ${r.credits} < minCredits 12`);
      assertTrue(r.picks.length >= 4, `picks ${r.picks.length} < minCourses 4`);
    }
  },
});

cases.push({
  name: "solve: maxCredits ceiling is never exceeded",
  run() {
    const eligible = synth.morningVsAfternoonEligible(); // 4 courses × 3cr = 12cr max
    const out = BP.solve(eligible, synth.defaultConstraints({ minCredits: 6, maxCredits: 9 }));
    for (const r of out.results) {
      assertTrue(r.credits <= 9, `credits ${r.credits} > maxCredits 9`);
    }
  },
});

cases.push({
  name: "solve: lab-pair partner is always kept together",
  run() {
    const eligible = synth.labPairEligible();
    const out = BP.solve(eligible, synth.defaultConstraints({ minCourses: 2, minCredits: 6 }));
    assertGreater(out.results.length, 0, "at least one schedule expected");
    for (const r of out.results) {
      const names = new Set(r.picks.map((p) => p.courseObj.course));
      const hasLecture = names.has("BIO 1330");
      const hasLab = names.has("BIO 1130");
      assertEqual(hasLecture, hasLab,
        "lab partner mismatch: lecture without lab (or vice versa) is forbidden");
    }
  },
});

cases.push({
  name: "solve: hardAvoidDays eliminates sections on those days",
  run() {
    const eligible = synth.morningVsAfternoonEligible();
    const out = BP.solve(eligible, synth.defaultConstraints({
      hardAvoidDays: ["Fri"],
      minCourses: 2, minCredits: 6,
    }));
    for (const r of out.results) {
      for (const p of r.picks) {
        if (p.section.online) continue;
        const onFri = (p.section.days || []).includes("Fri");
        assertTrue(!onFri, `CRN ${p.section.crn} meets on Fri despite hardAvoidDays`);
      }
    }
  },
});

cases.push({
  name: "solveMulti: returns at least as many unique schedules as solve (seeded)",
  run() {
    const eligible = synth.morningVsAfternoonEligible();
    const constraints = synth.defaultConstraints({ minCourses: 3, minCredits: 9 });
    const solo = BP.solve(eligible, constraints);
    const multi = BP.solveMulti(eligible, constraints);
    // Multi should at least match the single-pass hit count.
    assertTrue(multi.results.length >= solo.results.length,
      `solveMulti ${multi.results.length} < solve ${solo.results.length}`);
  },
});

cases.push({
  name: "solve: online section skips meeting-time checks (no conflict possible)",
  run() {
    const online = synth.course({
      name: "ONLINE 1100",
      sections: [synth.section({ crn: "ON-1", online: true })],
    });
    const inperson = synth.course({
      name: "MWF 1100",
      sections: [synth.section({ crn: "IP-1", days: synth.MWF, start: "0900", end: "1015" })],
    });
    const out = BP.solve(
      [online, inperson],
      synth.defaultConstraints({ minCourses: 2, minCredits: 6 }),
    );
    // Should find at least one schedule with both. Credits 6 is the floor;
    // there's only one viable combo so exactly one result is expected.
    const both = out.results.some((r) => {
      const names = r.picks.map((p) => p.courseObj.course);
      return names.includes("ONLINE 1100") && names.includes("MWF 1100");
    });
    assertTrue(both, "online + in-person pairing expected");
  },
});

cases.push({
  name: "solve: hardDropOnline prunes online sections when constraint set",
  run() {
    const eligible = [
      synth.course({
        name: "HYBRID 1000",
        sections: [
          synth.section({ crn: "ON-1", online: true }),
          synth.section({ crn: "IP-1", days: synth.MWF, start: "1200", end: "1315" }),
        ],
      }),
    ];
    const out = BP.solve(
      eligible,
      synth.defaultConstraints({ hardDropOnline: true, minCourses: 1, minCredits: 3 }),
    );
    assertGreater(out.results.length, 0, "expected at least one schedule");
    for (const r of out.results) {
      for (const p of r.picks) {
        assertTrue(!p.section.online, `online section should be pruned, got CRN ${p.section.crn}`);
      }
    }
  },
});

cases.push({
  name: "solveMulti: first schedule honors soft prefs via pref-distance ordering (D14)",
  run() {
    // Regression target: docs/bug1-morning-preference-diagnosis.md.
    // When `morningCutoffWeight` is below 1.0 (so weight-1.0 → hard promotion
    // can't prune), pref-distance ordering alone must still surface a
    // preference-honoring schedule early enough to reach the ranker. In the
    // original implementation `pref-distance` was the 5th ordering, and the
    // prior orderings saturated the 2000-schedule pool before it ran. After
    // D14 `pref-distance` runs FIRST with a per-pass budget, so the first
    // schedule in `allResults` must use afternoon sections.
    //
    // Pool: 4 courses × 2 sections each. Morning (0800–1115) vs afternoon
    // (1400–1715) alternatives on non-conflicting day strips. Every 4-course
    // combo is feasible (no pairwise overlaps within an AM-row or PM-row), so
    // the solver freely reaches the all-afternoon schedule — the test asserts
    // that ordering puts it FIRST.
    const eligible = [
      synth.course({
        name: "A 1000",
        sections: [
          synth.section({ crn: "A-AM", days: synth.MWF, start: "0800", end: "0915" }),
          synth.section({ crn: "A-PM", days: synth.MWF, start: "1400", end: "1515" }),
        ],
      }),
      synth.course({
        name: "B 1000",
        sections: [
          synth.section({ crn: "B-AM", days: synth.TR, start: "0800", end: "0915" }),
          synth.section({ crn: "B-PM", days: synth.TR, start: "1400", end: "1515" }),
        ],
      }),
      synth.course({
        name: "C 1000",
        sections: [
          synth.section({ crn: "C-AM", days: synth.MWF, start: "1000", end: "1115" }),
          synth.section({ crn: "C-PM", days: synth.MWF, start: "1600", end: "1715" }),
        ],
      }),
      synth.course({
        name: "D 1000",
        sections: [
          synth.section({ crn: "D-AM", days: synth.TR, start: "1000", end: "1115" }),
          synth.section({ crn: "D-PM", days: synth.TR, start: "1600", end: "1715" }),
        ],
      }),
    ];
    const prefs = synth.defaultPreferences({
      noEarlierThan: "1200",
      morningCutoffWeight: 0.6, // soft — mimics plain "no" where LLM emits 0.6
    });
    // minCredits=9 keeps all 4 courses feasible without credit relaxation.
    // buildConstraints does NOT auto-promote below-1.0 weights to hard, so
    // the only mechanic isolating this test is pref-distance ordering.
    const constraints = synth.defaultConstraints({ minCourses: 3, minCredits: 9 });

    const multi = BP.solveMulti(eligible, constraints, prefs);
    assertGreater(multi.results.length, 0, "expected at least one schedule");

    const first = multi.results[0];
    const allAfternoon = first.picks.every(
      (p) => p.section.online || BP.toMinutes(p.section.start) >= BP.toMinutes("1200"),
    );
    assertTrue(
      allAfternoon,
      "first schedule should be all-afternoon (pref-distance ran first); got CRNs " +
        first.picks.map((p) => p.section.crn).join(","),
    );

    // And the pref-distance pass must have contributed. Each pass records its
    // contribution in passContributions — assert the pref-distance pass shows
    // a nonzero newUnique count so future refactors can't silently neuter it.
    const prefPass = (multi.passContributions || []).find(
      (p) => p.ordering === "pref-distance",
    );
    assertTrue(prefPass != null, "solveMulti should record a pref-distance pass");
    assertGreater(prefPass.newUnique, 0, "pref-distance pass must contribute schedules");
  },
});

cases.push({
  name: "solveMulti: per-pass budget prevents single ordering from monopolizing pool",
  run() {
    // Regression target: the D14 fix. A single pass (MRV) used to be able
    // to fill the full SOLVER_RESULT_CAP before the pref-distance pass ran.
    // The per-pass budget ensures multiple orderings contribute to the pool
    // even when the pool is deep. We verify by checking the MRV pass's
    // generated count stays at or under its per-pass cap.
    //
    // Synth: 8 courses × 2 non-conflicting sections = 2^8 = 256 combos,
    // well under the full cap. We check that the per-pass cap is respected.
    const eligible = [];
    for (let i = 0; i < 8; i++) {
      eligible.push(
        synth.course({
          name: `X ${1000 + i}`,
          sections: [
            synth.section({
              crn: `X-${i}-AM`,
              days: i % 2 === 0 ? synth.MWF : synth.TR,
              start: "0800",
              end: "0915",
            }),
            synth.section({
              crn: `X-${i}-PM`,
              days: i % 2 === 0 ? synth.MWF : synth.TR,
              start: "1400",
              end: "1515",
            }),
          ],
        }),
      );
    }
    const constraints = synth.defaultConstraints({ minCourses: 4, minCredits: 12 });
    const multi = BP.solveMulti(
      eligible,
      constraints,
      synth.defaultPreferences({ noEarlierThan: "1200", morningCutoffWeight: 0.6 }),
    );
    const mrvPass = (multi.passContributions || []).find((p) => p.ordering === "mrv");
    assertTrue(mrvPass != null, "mrv pass should run");
    // Per-pass budget = ceil(2000 / 5) = 400. Generated count for MRV should
    // never exceed its budget. This guards against a future refactor that
    // accidentally hands the full cap back to a single pass.
    assertTrue(
      mrvPass.generated <= mrvPass.passCap,
      `mrv generated ${mrvPass.generated} > passCap ${mrvPass.passCap}`,
    );
  },
});

cases.push({
  name: "solve: hardNoEarlierThan drops sections starting before cutoff",
  run() {
    const eligible = [
      synth.course({
        name: "EARLY LATE",
        sections: [
          synth.section({ crn: "AM", days: synth.MWF, start: "0900", end: "1015" }),
          synth.section({ crn: "PM", days: synth.MWF, start: "1300", end: "1415" }),
        ],
      }),
    ];
    const out = BP.solve(
      eligible,
      synth.defaultConstraints({
        hardNoEarlierThan: "1200",
        minCourses: 1,
        minCredits: 3,
      }),
    );
    assertGreater(out.results.length, 0, "expected at least one schedule");
    for (const r of out.results) {
      for (const p of r.picks) {
        assertTrue(
          BP.toMinutes(p.section.start) >= BP.toMinutes("1200"),
          `section ${p.section.crn} starts before hard noon floor`,
        );
      }
    }
  },
});

module.exports = { cases };
