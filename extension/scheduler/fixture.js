// ============================================================
// 14. GOLDEN-PROMPTS FIXTURE RUNNER
// Run via: import { runFixture } from "./scheduler/fixture.js"
// Fixture entries declare property-test assertions, not exact matches.
// ============================================================

import { handleUserTurn } from "./index.js";

export async function runFixture(fixture, { apiKey, rawData, studentProfile }) {
  const results = [];
  for (const entry of fixture) {
    const profile = { ...studentProfile, calendarBlocks: [], avoidDays: [] };
    let turnResult;
    try {
      turnResult = await handleUserTurn({
        userMessage: entry.prompt, rawData, studentProfile: profile,
        conversationHistory: [], lockedCourses: [], apiKey,
      });
    } catch (e) {
      results.push({ name: entry.name, pass: false, failures: [`threw: ${e.message}`] });
      continue;
    }
    const failures = [];
    for (const assertion of entry.assertions) {
      try {
        if (!assertion.check(turnResult)) failures.push(assertion.name);
      } catch (e) { failures.push(`${assertion.name} threw: ${e.message}`); }
    }
    results.push({
      name: entry.name, pass: failures.length === 0, failures,
      turnResult,
    });
  }
  return results;
}
