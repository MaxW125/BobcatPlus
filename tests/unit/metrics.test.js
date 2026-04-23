// Phase 0 metric helpers. Definitions in docs/METRICS.md.

const {
  BP,
  assertEqual,
  assertApprox,
  assertTrue,
  assertGreater,
} = require("./_harness");
const synth = require("./_synth");

const cases = [];

// ── honoredRate ─────────────────────────────────────────────────────────────

cases.push({
  name: "honoredRate: null when no prefs stated",
  run() {
    assertEqual(
      BP.computeHonoredRate({ honoredPreferences: [], unhonoredPreferences: [] }),
      null,
    );
  },
});

cases.push({
  name: "honoredRate: 1.0 when every stated pref honored",
  run() {
    assertEqual(
      BP.computeHonoredRate({ honoredPreferences: ["a", "b"], unhonoredPreferences: [] }),
      1,
    );
  },
});

cases.push({
  name: "honoredRate: h / (h + u) when mixed",
  run() {
    assertApprox(
      BP.computeHonoredRate({
        honoredPreferences: ["a", "b", "c"],
        unhonoredPreferences: ["d"],
      }),
      3 / 4,
      1e-9,
    );
  },
});

// ── archetypeVector ─────────────────────────────────────────────────────────

cases.push({
  name: "archetypeVector: empty schedule yields zero vector",
  run() {
    const v = BP.computeArchetypeVector({ courses: [] });
    assertEqual(JSON.stringify(v), JSON.stringify([0, 0, 0, 0, 0]));
  },
});

cases.push({
  name: "archetypeVector: morning class contributes only morning hours",
  run() {
    const v = BP.computeArchetypeVector({
      courses: [{ days: synth.MWF, start: "0900", end: "1000", online: false }],
    });
    // 1 hour × 1 class = 1 morning hour; active days = 3; online = 0
    assertApprox(v[0], 1.0, 1e-6, "morningHours");
    assertApprox(v[1], 0,   1e-6, "afternoonHours");
    assertApprox(v[2], 0,   1e-6, "eveningHours");
    assertEqual(v[3], 3, "activeDays Mon+Wed+Fri");
    assertEqual(v[4], 0, "onlineCount");
  },
});

cases.push({
  name: "archetypeVector: class spanning noon splits hours across morning and afternoon",
  run() {
    // 11:00-13:00 → 1 h morning (11-12), 1 h afternoon (12-13)
    const v = BP.computeArchetypeVector({
      courses: [{ days: ["Mon"], start: "1100", end: "1300", online: false }],
    });
    assertApprox(v[0], 1.0, 1e-6);
    assertApprox(v[1], 1.0, 1e-6);
  },
});

cases.push({
  name: "archetypeVector: class spanning 5pm splits afternoon + evening",
  run() {
    // 16:00-18:00 → 1 h afternoon (16-17), 1 h evening (17-18)
    const v = BP.computeArchetypeVector({
      courses: [{ days: ["Tue"], start: "1600", end: "1800", online: false }],
    });
    assertApprox(v[1], 1.0, 1e-6);
    assertApprox(v[2], 1.0, 1e-6);
  },
});

cases.push({
  name: "archetypeVector: online counts but contributes zero hours and zero active days",
  run() {
    const v = BP.computeArchetypeVector({
      courses: [{ online: true }, { online: true }],
    });
    assertEqual(v[0], 0);
    assertEqual(v[1], 0);
    assertEqual(v[2], 0);
    assertEqual(v[3], 0);
    assertEqual(v[4], 2);
  },
});

// ── archetypeDistance ───────────────────────────────────────────────────────

cases.push({
  name: "archetypeDistance: identical schedules → 0",
  run() {
    const s = { courses: [{ days: ["Mon"], start: "0900", end: "1000", online: false }] };
    assertEqual(BP.computeArchetypeDistance([s, s]), 0);
  },
});

cases.push({
  name: "archetypeDistance: wildly different shapes → > 0.25 (silent-prefs target)",
  run() {
    const sMorning = { courses: [{ days: ["Mon", "Wed", "Fri"], start: "0900", end: "1000", online: false }] };
    const sEvening = { courses: [{ days: ["Tue", "Thu"], start: "1800", end: "1930", online: false }] };
    const sOnline  = { courses: [{ online: true }, { online: true }] };
    const d = BP.computeArchetypeDistance([sMorning, sEvening, sOnline]);
    assertGreater(d, 0.25, `expected distance > 0.25, got ${d}`);
  },
});

cases.push({
  name: "archetypeDistance: < 2 schedules → null",
  run() {
    const s = { courses: [{ days: ["Mon"], start: "0900", end: "1000", online: false }] };
    assertEqual(BP.computeArchetypeDistance([s]), null);
  },
});

// ── penaltyEffectiveness ────────────────────────────────────────────────────

cases.push({
  name: "penaltyEffectiveness: null when no soft prefs stated",
  run() {
    const prefs = synth.defaultPreferences({
      morningCutoffWeight: 0, lateCutoffWeight: 0, avoidDayWeight: 0,
      onlineWeight: 0, careerAffinityWeight: 0,
    });
    const out = BP.computePenaltyEffectiveness({
      topSchedules: [{ result: { picks: [] } }],
      allScored: [{ result: { picks: [] }, metrics: { affinityNorm: 0, onlineRatio: 0, balance: 1, morningPenalty: 0, latePenalty: 0, softAvoidPenalty: 0, creditTargetDist: 0 } }],
      preferences: prefs,
    });
    assertEqual(out, null);
  },
});

cases.push({
  name: "penaltyEffectiveness: 1 when zeroing prefs would change the pick's course set",
  run() {
    // Two candidates A (morning) and B (afternoon). With a hard morning cutoff
    // active, B wins. Without it, A wins (affinity ties, but balance/onlineRatio
    // are identical — so we lean on morning penalty alone).
    const metricsA = { affinityNorm: 0.6, onlineRatio: 0, balance: 0.5,
                       morningPenalty: 2.0, latePenalty: 0, softAvoidPenalty: 0, creditTargetDist: 0 };
    const metricsB = { affinityNorm: 0.6, onlineRatio: 0, balance: 0.5,
                       morningPenalty: 0,   latePenalty: 0, softAvoidPenalty: 0, creditTargetDist: 0 };
    const pickObj = (name, metrics) => ({
      result: { picks: [{ courseObj: { course: name }, section: { crn: "X" } }] },
      metrics,
      scoreAffinity: 0,
      scoreOnline: 0,
      scoreBalanced: 0,
    });
    const A = pickObj("A", metricsA);
    const B = pickObj("B", metricsB);
    const prefs = synth.defaultPreferences({ morningCutoffWeight: 1.0 });

    // Under the real vector the top pick is B (no morning penalty). Zeroing
    // prefs makes morningPenalty * 0 = 0 for both, so A and B tie — we then
    // need an asymmetry to force a change. Tweak affinityNorm so A beats B
    // without morning weight, and morningPenalty forces B to beat A with it.
    A.metrics.affinityNorm = 1.0;
    const out = BP.computePenaltyEffectiveness({
      topSchedules: [B],
      allScored: [A, B],
      preferences: prefs,
      vectorKey: "scoreAffinity",
    });
    assertEqual(out, 1, "morning preference forced B; zeroing flips to A");
  },
});

cases.push({
  name: "penaltyEffectiveness: 0 when all candidates tie on prefs (removing them changes nothing)",
  run() {
    const sameMetrics = { affinityNorm: 0.6, onlineRatio: 0, balance: 0.5,
                          morningPenalty: 0, latePenalty: 0, softAvoidPenalty: 0, creditTargetDist: 0 };
    const pick = (name) => ({
      result: { picks: [{ courseObj: { course: name }, section: { crn: "X" } }] },
      metrics: { ...sameMetrics },
      scoreAffinity: 0, scoreOnline: 0, scoreBalanced: 0,
    });
    const A = pick("A");
    const B = pick("B");
    const prefs = synth.defaultPreferences({ morningCutoffWeight: 1.0 });
    const out = BP.computePenaltyEffectiveness({
      topSchedules: [A],
      allScored: [A, B],
      preferences: prefs,
      vectorKey: "scoreAffinity",
    });
    assertEqual(out, 0, "identical metrics → top-1 unchanged when prefs zeroed");
  },
});

// ── requirementGraphValidity (stub in Phase 0) ──────────────────────────────

cases.push({
  name: "requirementGraphValidity: returns null until Phase 1 lands",
  run() {
    assertEqual(BP.computeRequirementGraphValidity({ courses: [] }, null), null);
  },
});

module.exports = { cases };
