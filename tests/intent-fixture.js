// Intent-only golden fixture for scheduleGenerator.js v3.
//
// Runs 5 representative student prompts through callIntent() and checks
// property assertions (not exact-match). LLM output varies across runs,
// so we assert the shape + the semantically-required fields — not every
// detail of the recap text.
//
// Usage:
//   OPENAI_API_KEY=sk-... node tests/intent-fixture.js
//
// Exit code 0 if all assertions pass, 1 if any fail.

const fs = require("fs");
const path = require("path");

// Shim window so the IIFE in scheduleGenerator.js can attach globals.
global.window = global;

const src = fs.readFileSync(
  path.join(__dirname, "..", "extension", "scheduleGenerator.js"),
  "utf8",
);
// eslint-disable-next-line no-eval
eval(src);

const BP = global.BP;
if (!BP || !BP.callIntent) {
  console.error("Failed to load BP.callIntent — check scheduleGenerator.js IIFE");
  process.exit(2);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}

// Minimal student profile used for every fixture case.
const profile = {
  name: "Test Student",
  major: "Computer Science",
  concentration: null,
  classification: "Junior",
  catalogYear: "2024-2025",
  completedHours: 60,
  remainingHours: 60,
  gpa: null,
  completedCourses: [],
  holds: [],
  calendarBlocks: [],
  avoidDays: [],
  careerGoals: null,
  advisingNotes: null,
};

// No-op trace so the runner doesn't need the UI panel.
const trace = BP.createTrace(() => {});

// ------------------------------------------------------------
// Fixture cases — each has a prompt and a list of property
// assertions. An assertion returns null on pass or a message on fail.
// ------------------------------------------------------------

const cases = [
  {
    name: "explicit work block + avoid day + credits + career",
    prompt:
      "I work Tuesdays and Thursdays 5pm to 10pm, keep Fridays clear, " +
      "targeting 15 credits. I want to get into cybersecurity.",
    assertions: [
      (i) => i.intent === "schedule" || fail("intent should be 'schedule', got " + i.intent),
      (i) => hasBlockFor(i.newCalendarBlocks, ["Tue", "Thu"], "1700", "2200") || fail("expected Tue/Thu 1700-2200 block, got " + JSON.stringify(i.newCalendarBlocks)),
      (i) => i.newAvoidDays.includes("Fri") || fail("expected Fri in newAvoidDays, got " + JSON.stringify(i.newAvoidDays)),
      (i) => i.statedPreferences.targetCredits === 15 || fail("expected targetCredits=15, got " + i.statedPreferences.targetCredits),
      (i) => Array.isArray(i.statedPreferences.careerKeywords) && i.statedPreferences.careerKeywords.some((k) => /security|cyber|crypto/i.test(k)) || fail("expected security-related career keywords, got " + JSON.stringify(i.statedPreferences.careerKeywords)),
      (i) => i.confidence >= 0.7 || fail("expected high confidence for explicit prompt, got " + i.confidence),
    ],
  },
  {
    name: "soft no-mornings preference",
    prompt: "I prefer not to have classes before 10am if possible.",
    assertions: [
      (i) => ["schedule", "chat"].includes(i.intent) || fail("intent should be schedule/chat, got " + i.intent),
      (i) => i.statedPreferences.noEarlierThan === "1000" || fail("expected noEarlierThan=1000, got " + i.statedPreferences.noEarlierThan),
      (i) => (i.statedPreferences.morningCutoffWeight == null || i.statedPreferences.morningCutoffWeight <= 0.7) || fail("expected soft morning weight (<=0.7), got " + i.statedPreferences.morningCutoffWeight),
    ],
  },
  {
    name: "hard no-mornings language maps to weight 1.0",
    prompt: "Absolutely no classes before 9am. I cannot do mornings.",
    assertions: [
      (i) => i.statedPreferences.noEarlierThan === "0900" || fail("expected noEarlierThan=0900, got " + i.statedPreferences.noEarlierThan),
      (i) => i.statedPreferences.morningCutoffWeight === 1.0 || fail("expected morningCutoffWeight=1.0 for 'absolutely', got " + i.statedPreferences.morningCutoffWeight),
    ],
  },
  {
    name: "advisor-type question, not schedule request",
    prompt: "What does the analysis track in computer science actually cover?",
    assertions: [
      (i) => i.intent === "advise" || fail("expected intent='advise', got " + i.intent),
      (i) => i.newCalendarBlocks.length === 0 || fail("advise shouldn't extract blocks"),
      (i) => i.newAvoidDays.length === 0 || fail("advise shouldn't extract avoid days"),
    ],
  },
  {
    name: "open-ended career goal with low-intensity phrasing",
    prompt: "I'd like to get into data science eventually, but I'm open to anything.",
    assertions: [
      (i) => Array.isArray(i.statedPreferences.careerKeywords) && i.statedPreferences.careerKeywords.some((k) => /data|machine|stat|analytic/i.test(k)) || fail("expected data-science keywords, got " + JSON.stringify(i.statedPreferences.careerKeywords)),
      (i) => (i.statedPreferences.careerAffinityWeight == null || i.statedPreferences.careerAffinityWeight <= 0.6) || fail("expected soft career weight (<=0.6) for 'open to anything', got " + i.statedPreferences.careerAffinityWeight),
    ],
  },
];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function fail(msg) {
  // Returning a truthy string causes the assertion to be reported as failed.
  // The pattern `cond || fail(...)` short-circuits to the message.
  return msg;
}

function hasBlockFor(blocks, days, start, end) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (b) =>
      b.start === start &&
      b.end === end &&
      days.every((d) => (b.days || []).includes(d)),
  );
}

function assertionResult(fn, intent) {
  try {
    const r = fn(intent);
    if (r === true) return { pass: true };
    if (typeof r === "string") return { pass: false, message: r };
    return { pass: false, message: "assertion returned " + JSON.stringify(r) };
  } catch (e) {
    return { pass: false, message: "threw: " + (e.message || String(e)) };
  }
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

(async () => {
  let totalAssertions = 0;
  let failedAssertions = 0;
  const failures = [];

  for (const c of cases) {
    process.stdout.write(`\n▸ ${c.name}\n  prompt: ${JSON.stringify(c.prompt)}\n`);
    let intent;
    try {
      intent = await BP.callIntent({
        userMessage: c.prompt,
        studentProfile: profile,
        ragChunks: [],
        apiKey,
        trace,
      });
    } catch (e) {
      console.error("  ✗ callIntent threw: " + (e.message || e));
      failedAssertions += c.assertions.length;
      totalAssertions += c.assertions.length;
      failures.push({ case: c.name, message: "callIntent failed: " + (e.message || e) });
      continue;
    }
    for (let i = 0; i < c.assertions.length; i++) {
      totalAssertions++;
      const res = assertionResult(c.assertions[i], intent);
      if (res.pass) {
        process.stdout.write(`  ✓ assertion ${i + 1}\n`);
      } else {
        failedAssertions++;
        failures.push({ case: c.name, index: i + 1, message: res.message });
        process.stdout.write(`  ✗ assertion ${i + 1}: ${res.message}\n`);
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`Intent fixture: ${totalAssertions - failedAssertions}/${totalAssertions} assertions passed across ${cases.length} prompts`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  • ${f.case}${f.index ? ` [#${f.index}]` : ""}: ${f.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
