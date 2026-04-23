// Deterministic unit-test harness for scheduleGenerator.js.
//
// Design goals (per Phase 0):
//   - No OpenAI calls. Every test is pure and finishes in ms.
//   - Load scheduleGenerator.js once, reuse the same `BP` across test files.
//   - Plain Node, no test framework. Every test is a function that throws on
//     failure. The runner collects them, prints a diff on fail, and exits 1.
//
// Test files register via module.exports = { cases: [...] }.
// Runner `run.js` does the globbing and invocation.

const fs = require("fs");
const path = require("path");

// Shim window so scheduleGenerator.js's IIFE can attach globals in Node.
if (!global.window) global.window = global;

const GEN_PATH = path.join(__dirname, "..", "..", "extension", "scheduleGenerator.js");
const src = fs.readFileSync(GEN_PATH, "utf8");
// eslint-disable-next-line no-eval
eval(src);

const BP = global.BP;
if (!BP || !BP.solve || !BP.rankSchedules) {
  throw new Error(
    "scheduleGenerator.js loaded but BP exports are missing — harness cannot run",
  );
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
  BP,
  assertEqual,
  assertDeepEqual,
  assertTrue,
  assertApprox,
  assertGreater,
  assertLess,
  fail,
};
