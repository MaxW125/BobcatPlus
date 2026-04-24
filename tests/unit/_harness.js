// Deterministic unit-test harness — H1 migration (C6).
//
// Design goals (per Phase 0):
//   - No OpenAI calls. Every test is pure and finishes in ms.
//   - Load scheduler/* ESM modules once via dynamic import(); reuse the
//     same `BP` facade across test files.
//   - Plain Node, no test framework. Every test is a function that throws on
//     failure. The runner collects them, prints a diff on fail, and exits 1.
//
// H1 contract: this file stays CommonJS so test files continue to
//   `const { BP } = require("./_harness")`
// without change. Dynamic import() starts eagerly; run.js awaits init()
// once before executing any test case so BP is always populated by the
// time a test file destructures it.
//
// Test files register via module.exports = { cases: [...] }.
// Runner `run.js` does the globbing and invocation.

// Shim window so any legacy code that writes window.* still has a target.
// The new ESM modules do not use window.*, but some test helpers might.
if (!global.window) global.window = global;

let _BP = null;

// Eagerly kick off the ESM load. run.js awaits init() before tests run,
// so by the time any test file does require("./_harness") the getter returns
// the real object.
const _ready = (async () => {
  const [
    { handleUserTurn },
    { buildStudentProfile, mergeCalendarBlocks, compressForSolver },
    { validateSchedule },
    { toMinutes, findOverlapPair, hashString },
    { createTrace },
    { solve, solveMulti, solveWithRelaxation, _infeasibleSuggestions },
    { buildConstraints, _constraintSnapshot },
    { scoreSchedule, breakdownOf, applyVector, rankSchedules, pickTop3, WEIGHT_VECTORS },
    { computeHonoredRate, computeArchetypeVector, computeArchetypeDistance,
      computePenaltyEffectiveness, computeRequirementGraphValidity },
    { callIntent, calibrateIntentWeights, INTENT_SCHEMA_VERSION, buildIntentPrompt },
    { callAffinity, clearAffinityCache },
    { callRationales, buildRationaleFacts },
    { callAdvisor },
    { runFixture },
  ] = await Promise.all([
    import("../../extension/scheduler/index.js"),
    import("../../extension/scheduler/profile.js"),
    import("../../extension/scheduler/validate.js"),
    import("../../extension/scheduler/time.js"),
    import("../../extension/scheduler/trace.js"),
    import("../../extension/scheduler/solver/solver.js"),
    import("../../extension/scheduler/solver/constraints.js"),
    import("../../extension/scheduler/solver/rank.js"),
    import("../../extension/scheduler/metrics.js"),
    import("../../extension/scheduler/llm/intent.js"),
    import("../../extension/scheduler/llm/affinity.js"),
    import("../../extension/scheduler/llm/rationale.js"),
    import("../../extension/scheduler/llm/advisor.js"),
    import("../../extension/scheduler/fixture.js"),
  ]);

  _BP = {
    // Primary API
    handleUserTurn,
    buildStudentProfile,
    mergeCalendarBlocks,
    // Solver surface
    compressForSolver,
    validateSchedule,
    solve, solveMulti, solveWithRelaxation,
    buildConstraints, _constraintSnapshot,
    pickTop3, rankSchedules, scoreSchedule,
    applyVector, breakdownOf, WEIGHT_VECTORS,
    // Phase 0 metric helpers
    computeHonoredRate, computeArchetypeVector, computeArchetypeDistance,
    computePenaltyEffectiveness, computeRequirementGraphValidity,
    // Low-level time utilities
    toMinutes, findOverlapPair, hashString,
    // LLM entry points
    callIntent, calibrateIntentWeights, INTENT_SCHEMA_VERSION, buildIntentPrompt,
    callAffinity, clearAffinityCache,
    callRationales, buildRationaleFacts,
    callAdvisor,
    // Trace + fixture
    createTrace, runFixture,
    _infeasibleSuggestions,
  };

  // Publish on global so any test that reads global.BP or window.BP directly still works.
  global.BP = _BP;
})();

async function init() {
  await _ready;
  if (!_BP || !_BP.solve || !_BP.rankSchedules) {
    throw new Error(
      "scheduler ESM modules loaded but BP exports are missing — harness cannot run",
    );
  }
  return _BP;
}

// ── assertions ───────────────────────────────────────────────────────────────

function fail(msg) {
  const err = new Error(msg);
  err.__assertion = true;
  throw err;
}

function assertEqual(actual, expected, label = "") {
  if (!Object.is(actual, expected)) {
    fail(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    fail(`${label ? label + ": " : ""}expected ${e}, got ${a}`);
  }
}

function assertTrue(cond, label = "assertion") {
  if (!cond) fail(label);
}

function assertApprox(actual, expected, tol = 1e-6, label = "") {
  if (Math.abs(actual - expected) > tol) {
    fail(
      `${label ? label + ": " : ""}expected ≈${expected} (±${tol}), got ${actual}`,
    );
  }
}

function assertGreater(actual, floor, label = "") {
  if (!(actual > floor)) {
    fail(`${label ? label + ": " : ""}expected >${floor}, got ${actual}`);
  }
}

function assertLess(actual, ceiling, label = "") {
  if (!(actual < ceiling)) {
    fail(`${label ? label + ": " : ""}expected <${ceiling}, got ${actual}`);
  }
}

module.exports = {
  get BP() { return _BP; },
  init,
  assertEqual,
  assertDeepEqual,
  assertTrue,
  assertApprox,
  assertGreater,
  assertLess,
  fail,
};
