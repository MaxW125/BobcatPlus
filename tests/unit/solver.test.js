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

module.exports = { cases };
