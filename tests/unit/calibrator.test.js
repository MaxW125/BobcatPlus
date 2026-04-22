// calibrateIntentWeights + buildConstraints end-to-end tests.
//
// Regression target: docs/bug1-morning-preference-diagnosis.md (Bug 1).
// The original 79-test suite tested `hardNoEarlierThan` at the solver leaf but
// never threaded a declarative user message through the full intent →
// calibrator → buildConstraints chain. That gap let the `bp_phase2_solver_
// hardfloor` flag look fine in tests while silently never firing in prod
// because the calibrator didn't floor `morningCutoffWeight` at 1.0 for plain
// "no classes before noon" phrasing.
//
// These cases assert the whole chain, plus negative cases so a future broader
// HARD match doesn't regress false-positive behavior.
//
// Test shape conventions:
//   msg      — raw user message that the calibrator sees
//   llmWeight — what we simulate the intent LLM returning (typically 0.6 for
//               bare "no", 0.8 for "really want"). 0.6 mirrors the live trace.
//   floor    — expected weight after calibrateIntentWeights
//   hardKey  — if set, the buildConstraints-level constraint we expect to
//               appear (e.g. "hardNoEarlierThan", "hardNoLaterThan",
//               "hardDropOnline", "hardAvoidDays")

const { BP, assertEqual, assertTrue } = require("./_harness");

const cases = [];

function runCalibrate(msg, prefs) {
  const intent = { statedPreferences: { ...prefs } };
  BP.calibrateIntentWeights(intent, msg);
  return intent.statedPreferences;
}

function runChain(msg, prefs, profileExtra = {}, flags = { prefordering: true, hardfloor: true }) {
  const out = runCalibrate(msg, prefs);
  const constraints = BP.buildConstraints(
    out,
    { calendarBlocks: [], avoidDays: [], ...profileExtra },
    [],
    flags,
  );
  return { prefs: out, constraints };
}

// ── Fix A: declarative-no should floor the weight at 1.0 ────────────────────

cases.push({
  name: "calibrator: 'no classes before noon' floors morningCutoffWeight at 1.0",
  run() {
    const prefs = runCalibrate("no classes before noon", {
      noEarlierThan: "1200",
      morningCutoffWeight: 0.6,
    });
    assertEqual(prefs.morningCutoffWeight, 1.0, "morningCutoffWeight");
  },
});

cases.push({
  name: "calibrator: 'no mornings' floors morningCutoffWeight at 1.0",
  run() {
    const prefs = runCalibrate("no mornings please", {
      noEarlierThan: "1200",
      morningCutoffWeight: 0.6,
    });
    assertEqual(prefs.morningCutoffWeight, 1.0, "morningCutoffWeight");
  },
});

cases.push({
  name: "calibrator: 'no classes friday' floors avoidDayWeight at 1.0",
  run() {
    const prefs = runCalibrate("no classes friday", {
      avoidDayWeight: 0.6,
    });
    assertEqual(prefs.avoidDayWeight, 1.0, "avoidDayWeight");
  },
});

cases.push({
  name: "calibrator: 'no classes after 5pm' floors lateCutoffWeight at 1.0",
  run() {
    // The late-keyword match fires on "after 5"; declarative-no via "no classes".
    const prefs = runCalibrate("no classes after 5pm", {
      noLaterThan: "1700",
      lateCutoffWeight: 0.6,
    });
    assertEqual(prefs.lateCutoffWeight, 1.0, "lateCutoffWeight");
  },
});

cases.push({
  name: "calibrator: 'no online classes' floors onlineWeight at 1.0",
  run() {
    const prefs = runCalibrate("no online classes, prefer in-person", {
      preferInPerson: true,
      onlineWeight: 0.6,
    });
    assertEqual(prefs.onlineWeight, 1.0, "onlineWeight");
  },
});

cases.push({
  name: "calibrator: combined message floors both morning and avoidDay weights",
  run() {
    // The original live-trace prompt from the Bug 1 diagnosis doc.
    const prefs = runCalibrate(
      "build me a schedule with no classes before noon, no classes friday",
      { noEarlierThan: "1200", morningCutoffWeight: 0.6, avoidDayWeight: 0.6 },
    );
    assertEqual(prefs.morningCutoffWeight, 1.0, "morningCutoffWeight");
    assertEqual(prefs.avoidDayWeight, 1.0, "avoidDayWeight");
  },
});

// ── Fix A negative cases: false positives must not trip ─────────────────────

cases.push({
  name: "calibrator: 'no problem with mornings' does NOT floor the weight",
  run() {
    const prefs = runCalibrate("no problem with mornings", {
      morningCutoffWeight: 0.5,
    });
    assertTrue(
      prefs.morningCutoffWeight < 1.0,
      `should not promote positive statement to hard, got ${prefs.morningCutoffWeight}`,
    );
  },
});

cases.push({
  name: "calibrator: 'no preference on mornings' does NOT floor the weight",
  run() {
    const prefs = runCalibrate("no preference on mornings", {
      morningCutoffWeight: 0.5,
    });
    assertTrue(
      prefs.morningCutoffWeight < 1.0,
      `should not promote a non-preference to hard, got ${prefs.morningCutoffWeight}`,
    );
  },
});

cases.push({
  name: "calibrator: 'no strong feelings about mornings' does NOT floor the weight",
  run() {
    const prefs = runCalibrate("no strong feelings about mornings", {
      morningCutoffWeight: 0.5,
    });
    assertTrue(
      prefs.morningCutoffWeight < 1.0,
      `should not promote ambivalence to hard, got ${prefs.morningCutoffWeight}`,
    );
  },
});

cases.push({
  name: "calibrator: hedge + morning keyword still caps at 0.7 when no declarative-no",
  run() {
    const prefs = runCalibrate("preferably no early mornings", {
      morningCutoffWeight: 0.9,
    });
    // "no early" matches declarative-no, so hard wins over hedge. Correct —
    // "preferably no X" is a real construct but the "no early" sub-clause is
    // explicit enough that we treat the overall intent as firm.
    assertEqual(prefs.morningCutoffWeight, 1.0, "morningCutoffWeight");
  },
});

cases.push({
  name: "calibrator: pure hedge without declarative-no caps at 0.7",
  run() {
    const prefs = runCalibrate("preferably mornings are avoided", {
      morningCutoffWeight: 0.9,
    });
    // "preferably" matches hedge; "mornings" matches the morning keyword set.
    // No `no X` before "mornings" so declarative-no does not fire; hedge cap wins.
    assertEqual(prefs.morningCutoffWeight, 0.7, "morningCutoffWeight");
  },
});

// ── End-to-end: calibrator + buildConstraints must set hardNoEarlierThan ────

cases.push({
  name: "chain: 'no classes before noon' → constraints.hardNoEarlierThan = '1200'",
  run() {
    const { prefs, constraints } = runChain("no classes before noon", {
      noEarlierThan: "1200",
      morningCutoffWeight: 0.6,
    });
    assertEqual(prefs.morningCutoffWeight, 1.0, "calibrated weight");
    assertEqual(constraints.hardNoEarlierThan, "1200", "hardNoEarlierThan");
  },
});

cases.push({
  name: "chain: 'no classes after 5pm' → constraints.hardNoLaterThan = '1700'",
  run() {
    const { prefs, constraints } = runChain("no classes after 5pm", {
      noLaterThan: "1700",
      lateCutoffWeight: 0.6,
    });
    assertEqual(prefs.lateCutoffWeight, 1.0, "calibrated weight");
    assertEqual(constraints.hardNoLaterThan, "1700", "hardNoLaterThan");
  },
});

cases.push({
  name: "chain: 'no online classes' → constraints.hardDropOnline = true",
  run() {
    const { prefs, constraints } = runChain("no online classes", {
      preferInPerson: true,
      onlineWeight: 0.6,
    });
    assertEqual(prefs.onlineWeight, 1.0, "calibrated weight");
    assertEqual(constraints.hardDropOnline, true, "hardDropOnline");
  },
});

cases.push({
  name: "chain: 'no classes friday' → constraints.hardAvoidDays includes Fri",
  run() {
    // avoidDayWeight floors at 1.0 → Fri promotes from soft to hard avoid.
    const { prefs, constraints } = runChain(
      "no classes friday",
      { avoidDayWeight: 0.6 },
      { avoidDays: ["Fri"] },
    );
    assertEqual(prefs.avoidDayWeight, 1.0, "calibrated weight");
    assertTrue(
      (constraints.hardAvoidDays || []).includes("Fri"),
      `hardAvoidDays should include Fri, got ${JSON.stringify(constraints.hardAvoidDays)}`,
    );
  },
});

cases.push({
  name: "chain: hardfloor flag OFF leaves constraints.hardNoEarlierThan undefined",
  run() {
    // Safety check — the flag gate must still work once the calibrator floors.
    const { prefs, constraints } = runChain(
      "no classes before noon",
      { noEarlierThan: "1200", morningCutoffWeight: 0.6 },
      {},
      { prefordering: true, hardfloor: false },
    );
    assertEqual(prefs.morningCutoffWeight, 1.0, "calibrator still floors regardless of flag");
    assertTrue(
      constraints.hardNoEarlierThan === undefined,
      `hardfloor flag off → no hard constraint, got ${constraints.hardNoEarlierThan}`,
    );
  },
});

module.exports = { cases };
