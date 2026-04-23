// scoreSchedule / applyVector / breakdownOf tests. Pure, no OpenAI.
// Every metric is probed in isolation so a regression in one term does not
// mask a regression in another.

const {
  BP,
  assertEqual,
  assertApprox,
  assertTrue,
  assertGreater,
  assertLess,
} = require("./_harness");
const synth = require("./_synth");

const cases = [];

// Build a one-pick "schedule" result so scoreSchedule / applyVector can be
// exercised with a known, minimal input.
function scheduleOf(...picks) {
  return { picks, credits: picks.reduce((s, p) => s + (p.section.credits ?? 3), 0) };
}

cases.push({
  name: "scoreSchedule: morningPenalty = 0 when no section starts before cutoff",
  run() {
    const p = {
      courseObj: synth.course({ name: "TEST" }),
      section: synth.section({ crn: "X", days: synth.MWF, ...synth.AFTERNOON_2PM }),
    };
    const metrics = BP.scoreSchedule(
      scheduleOf(p),
      synth.defaultPreferences({ noEarlierThan: "1000" }),
      {},
    );
    assertEqual(metrics.morningPenalty, 0, "afternoon class should not penalize morning");
  },
});

cases.push({
  name: "scoreSchedule: morningPenalty measured in hours below cutoff",
  run() {
    // 08:00 start with cutoff 10:00 → penalty = 2 hours
    const p = {
      courseObj: synth.course({ name: "TEST" }),
      section: synth.section({ crn: "X", days: synth.MWF, start: "0800", end: "0915" }),
    };
    const metrics = BP.scoreSchedule(
      scheduleOf(p),
      synth.defaultPreferences({ noEarlierThan: "1000" }),
      {},
    );
    assertApprox(metrics.morningPenalty, 2.0, 1e-6, "expected 2h below 10:00 cutoff");
  },
});

cases.push({
  name: "scoreSchedule: online section bypasses morning/late penalties entirely",
  run() {
    const p = {
      courseObj: synth.course({ name: "ON" }),
      section: synth.section({ crn: "X", online: true, start: null, end: null }),
    };
    const metrics = BP.scoreSchedule(
      scheduleOf(p),
      synth.defaultPreferences({ noEarlierThan: "1000", noLaterThan: "1400" }),
      {},
    );
    assertEqual(metrics.morningPenalty, 0, "online ignores morning cutoff");
    assertEqual(metrics.latePenalty, 0, "online ignores late cutoff");
    assertEqual(metrics.onlineRatio, 1.0, "fully online → ratio 1.0");
  },
});

cases.push({
  name: "scoreSchedule: latePenalty measured in hours past cutoff",
  run() {
    // 18:00-19:15 with cutoff 17:00 → 19:15 - 17:00 = 2.25h
    const p = {
      courseObj: synth.course({ name: "EVE" }),
      section: synth.section({ crn: "X", days: synth.MWF, start: "1800", end: "1915" }),
    };
    const metrics = BP.scoreSchedule(
      scheduleOf(p),
      synth.defaultPreferences({ noLaterThan: "1700" }),
      {},
    );
    assertApprox(metrics.latePenalty, 2.25, 1e-6, "expected 2.25h past 17:00");
  },
});

cases.push({
  name: "scoreSchedule: softAvoidPenalty counts day-hits across sections",
  run() {
    const p1 = {
      courseObj: synth.course({ name: "A" }),
      section: synth.section({ crn: "X1", days: ["Fri"], ...synth.AFTERNOON_2PM }),
    };
    const p2 = {
      courseObj: synth.course({ name: "B" }),
      section: synth.section({ crn: "X2", days: ["Mon", "Fri"], ...synth.MORNING_10AM }),
    };
    const metrics = BP.scoreSchedule(
      scheduleOf(p1, p2),
      synth.defaultPreferences({ softAvoidDays: ["Fri"] }),
      {},
    );
    assertEqual(metrics.softAvoidPenalty, 2,
      "expected 2 Friday hits (one per section touching Fri)");
  },
});

cases.push({
  name: "scoreSchedule: balance rewards spread across all 5 weekdays",
  run() {
    // Schedule A: Mon-only packing → high variance, low balance
    const tue = ["Tue"];
    const pA1 = { courseObj: synth.course({ name: "A1" }),
      section: synth.section({ crn: "A1", days: tue, ...synth.MORNING_10AM }) };
    const pA2 = { courseObj: synth.course({ name: "A2" }),
      section: synth.section({ crn: "A2", days: tue, ...synth.AFTERNOON_2PM }) };
    // Schedule B: spread across Tue/Thu → lower variance, higher balance
    const pB1 = { courseObj: synth.course({ name: "B1" }),
      section: synth.section({ crn: "B1", days: ["Tue"], ...synth.MORNING_10AM }) };
    const pB2 = { courseObj: synth.course({ name: "B2" }),
      section: synth.section({ crn: "B2", days: ["Thu"], ...synth.AFTERNOON_2PM }) };

    const mA = BP.scoreSchedule(scheduleOf(pA1, pA2), synth.defaultPreferences(), {});
    const mB = BP.scoreSchedule(scheduleOf(pB1, pB2), synth.defaultPreferences(), {});
    assertGreater(mB.balance, mA.balance,
      "Tue/Thu spread should have better balance than Tue-only packing");
  },
});

cases.push({
  name: "scoreSchedule: creditTargetDist is |actual - target| / 18",
  run() {
    const p = {
      courseObj: synth.course({ name: "T" }),
      section: synth.section({ crn: "X", days: synth.MWF, ...synth.AFTERNOON_2PM, credits: 15 }),
    };
    const metrics = BP.scoreSchedule(
      scheduleOf(p),
      synth.defaultPreferences({ targetCredits: 12 }),
      {},
    );
    assertApprox(metrics.creditTargetDist, 3 / 18, 1e-6);
  },
});

cases.push({
  name: "applyVector: total matches hand-computed sum for default weights",
  run() {
    const metrics = {
      affinityNorm: 0.6, onlineRatio: 0.5, balance: 0.8,
      morningPenalty: 1.0, latePenalty: 0, softAvoidPenalty: 0,
      creditTargetDist: 0,
    };
    const prefs = synth.defaultPreferences();
    const vec = BP.WEIGHT_VECTORS.affinity;
    // Hand-computed: affinity=0.5 * 1.0 * 0.6, online=0.5 * 0.2 * 0.5,
    //                balance=0.1 * 0.8, morningPen=0.5 * 0.3 * 1.0
    const expected = 0.5 * 1.0 * 0.6 + 0.5 * 0.2 * 0.5 + 0.1 * 0.8 - 0.5 * 0.3 * 1.0;
    assertApprox(BP.applyVector(metrics, vec, prefs), expected, 1e-9);
  },
});

cases.push({
  name: "breakdownOf: terms sum to total (sanity)",
  run() {
    const metrics = {
      affinityNorm: 0.7, onlineRatio: 0.33, balance: 0.5,
      morningPenalty: 0.75, latePenalty: 0.5, softAvoidPenalty: 2,
      creditTargetDist: 0.1,
    };
    const prefs = synth.defaultPreferences({ morningCutoffWeight: 0.8 });
    const vec = BP.WEIGHT_VECTORS.balanced;
    const bd = BP.breakdownOf(metrics, vec, prefs);
    const sum = bd.affinityTerm + bd.onlineTerm + bd.balanceTerm
              - bd.morningPen - bd.latePen - bd.softAvoidPen - bd.creditPen;
    assertApprox(bd.total, sum, 1e-9, "breakdown terms must reconstruct total");
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Scorer invariants relevant to the user-reported bugs.
//
// These test the LOCAL invariant — "given two schedules that differ only by a
// stated preference, the preferred one scores higher." Bug 1 in the wild is a
// harder failure: the balance / affinity terms pushing a morning-containing
// pick to the top in a live run. That regression needs a full solver+scorer
// fixture and lives in Phase 2's integration tests, not here. This file's job
// is just to confirm the scoring function itself is not obviously broken.
// ────────────────────────────────────────────────────────────────────────────
cases.push({
  name: "invariant: same courses, afternoon sections outrank morning sections under noEarlierThan",
  run() {
    const morningPicks = [
      { courseObj: synth.course({ name: "ENG 1310" }),
        section: synth.section({ crn: "M1", days: synth.MWF, start: "0800", end: "0915" }) },
      { courseObj: synth.course({ name: "HIST 1310" }),
        section: synth.section({ crn: "M2", days: synth.TR, start: "0800", end: "0915" }) },
    ];
    const afternoonPicks = [
      { courseObj: synth.course({ name: "ENG 1310" }),
        section: synth.section({ crn: "A1", days: synth.MWF, start: "1400", end: "1515" }) },
      { courseObj: synth.course({ name: "HIST 1310" }),
        section: synth.section({ crn: "A2", days: synth.TR, start: "1400", end: "1515" }) },
    ];
    const prefs = synth.defaultPreferences({ noEarlierThan: "1000" });
    const sMorning   = BP.applyVector(BP.scoreSchedule(scheduleOf(...morningPicks),   prefs, {}), BP.WEIGHT_VECTORS.affinity, prefs);
    const sAfternoon = BP.applyVector(BP.scoreSchedule(scheduleOf(...afternoonPicks), prefs, {}), BP.WEIGHT_VECTORS.affinity, prefs);
    assertGreater(sAfternoon, sMorning,
      `afternoon (${sAfternoon}) should outrank morning (${sMorning}) when only morning penalty differs`);
  },
});

cases.push({
  name: "invariant: preferInPerson inverts online term so in-person outranks fully-online under affinity",
  run() {
    const prefs = synth.defaultPreferences();
    prefs.preferInPerson = true;
    const onlinePicks = [
      { courseObj: synth.course({ name: "ENG 1310" }),
        section: synth.section({ crn: "O1", online: true }) },
    ];
    const inpersonPicks = [
      { courseObj: synth.course({ name: "ENG 1310" }),
        section: synth.section({ crn: "I1", days: synth.MWF, ...synth.MORNING_10AM }) },
    ];
    const sOn  = BP.applyVector(BP.scoreSchedule(scheduleOf(...onlinePicks),   prefs, {}), BP.WEIGHT_VECTORS.affinity, prefs);
    const sIp  = BP.applyVector(BP.scoreSchedule(scheduleOf(...inpersonPicks), prefs, {}), BP.WEIGHT_VECTORS.affinity, prefs);
    assertGreater(sIp, sOn,
      `in-person should outrank online when preferInPerson, but ${sIp} <= ${sOn}`);
  },
});

module.exports = { cases };
