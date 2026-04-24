#!/usr/bin/env node
// Deterministic unit-test runner for scheduleGenerator.js.
//
// Usage:
//   node tests/unit/run.js
//
// Exits 0 if all non-expected-failure tests pass, 1 otherwise. Tests marked
// `expectedToFail: true` are reported but do NOT fail the suite — they are
// documentation of known gaps that later phases must close. If one of them
// unexpectedly passes, the runner exits 1 so we don't leave stale "known
// failures" rotting in the repo.

const fs = require("fs");
const path = require("path");

// Load the harness — H1: kicks off async ESM load, awaited in main() before tests run.
const harness = require("./_harness");

const UNIT_DIR = __dirname;
const testFiles = fs
  .readdirSync(UNIT_DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

// Test cases may be sync or async — if `run()` returns a promise we await
// it; otherwise we treat the synchronous return (or throw) as the result.
// Keeping both forms lets us keep the existing pure-sync tests unchanged
// while supporting orchestrators that need an injected async fetcher.
async function main() {
  // Wait for ESM scheduler modules to finish loading before any test case runs.
  // This ensures `const { BP } = require("./_harness")` in test files captures
  // the real facade rather than the null placeholder.
  await harness.init();
  let passed = 0;
  let failed = 0;
  let expectedFail = 0;
  let unexpectedPass = 0;
  const failures = [];
  const surprises = [];

  for (const file of testFiles) {
    process.stdout.write(`\n▸ ${file}\n`);
    let mod;
    try {
      mod = require(path.join(UNIT_DIR, file));
    } catch (e) {
      failed++;
      failures.push({ file, name: "(require)", err: e });
      process.stdout.write(`  ✗ failed to load: ${e.message}\n`);
      continue;
    }
    if (!Array.isArray(mod.cases)) {
      process.stdout.write(`  (skipped — no cases[])\n`);
      continue;
    }
    for (const c of mod.cases) {
      let threw = null;
      try {
        const ret = c.run();
        if (ret && typeof ret.then === "function") await ret;
      } catch (e) {
        threw = e;
      }
      if (c.expectedToFail) {
        if (threw) {
          expectedFail++;
          process.stdout.write(`  ☐ (known failure) ${c.name}\n    · ${threw.message}\n`);
        } else {
          // Known-failure test passed unexpectedly. Flag so we remove the flag.
          unexpectedPass++;
          surprises.push({ file, name: c.name });
          process.stdout.write(`  ! (UNEXPECTEDLY PASSED — remove expectedToFail) ${c.name}\n`);
        }
        continue;
      }
      if (threw) {
        failed++;
        failures.push({ file, name: c.name, err: threw });
        process.stdout.write(`  ✗ ${c.name}\n    · ${threw.message}\n`);
      } else {
        passed++;
        process.stdout.write(`  ✓ ${c.name}\n`);
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(
    `Unit tests: ${passed} passed · ${failed} failed · ${expectedFail} known-failures · ${unexpectedPass} surprises`,
  );

  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  • ${f.file} — ${f.name}: ${f.err.message}`);
    }
  }
  if (surprises.length) {
    console.log("\nUnexpected passes (remove `expectedToFail`):");
    for (const s of surprises) console.log(`  • ${s.file} — ${s.name}`);
  }

  process.exit(failed + unexpectedPass > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
