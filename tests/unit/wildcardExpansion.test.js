// Unit tests for `requirements/wildcardExpansion.js`:
//
//   - `normalizeCourseInformationCourses` — pure parser for DW
//     `courseInformation` responses (turns them into schedule-generator-
//     ready entries).
//
//   - `expandAuditWildcards` — async orchestrator that resolves
//     RequirementGraph wildcards into concrete needed[] entries. Takes
//     an injected `fetchCourseLink` callback so we can drive it with the
//     cs-4@ fixture without any network. Covers Bug 4 Layer B
//     (wildcard expansion) + Layer C (`except` subtraction).
//
// HTTP fetcher + cache (`fetchCourseLinkFromDW` in background.js) are
// exercised manually in the live extension; the orchestrator tests here
// cover every code path of the pure logic.

const path = require("path");
const fs = require("fs");

const { assertEqual, assertTrue, assertDeepEqual, fail } = require("./_harness");

// Load wildcardExpansion.js through the same globalThis handoff used by the
// extension runtime. graph.js / txstFromAudit.js are already loaded by the
// harness.
const WE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "extension",
  "requirements",
  "wildcardExpansion.js",
);
// eslint-disable-next-line no-eval
eval(fs.readFileSync(WE_PATH, "utf8"));

const BPReq = global.BPReq || (typeof self !== "undefined" && self.BPReq);
if (!BPReq || typeof BPReq.normalizeCourseInformationCourses !== "function") {
  throw new Error("wildcardExpansion.js did not attach normalizer to BPReq");
}

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "wildcard",
  "cs-4@.json",
);
const cs4raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

module.exports = {
  cases: [
    {
      name: "cs-4@ fixture: normalizer returns non-empty list with expected shape",
      run() {
        const out = BPReq.normalizeCourseInformationCourses(cs4raw);
        assertTrue(Array.isArray(out), "result is array");
        assertTrue(out.length > 0, "at least one course");
        const first = out[0];
        assertEqual(typeof first.subject, "string");
        assertEqual(typeof first.courseNumber, "string");
        assertTrue("title" in first, "carries title");
        assertTrue(Array.isArray(first.sections), "sections is array");
        assertTrue(Array.isArray(first.attributes), "attributes is array");
        assertTrue(Array.isArray(first.prerequisites), "prerequisites is array");
      },
    },

    {
      name: "cs-4@ fixture: every entry is a CS-4xxx course",
      run() {
        const out = BPReq.normalizeCourseInformationCourses(cs4raw);
        for (const e of out) {
          assertEqual(e.subject, "CS", `${e.subject} ${e.courseNumber} subject`);
          assertTrue(
            e.courseNumber.startsWith("4"),
            `${e.subject} ${e.courseNumber} level`,
          );
        }
      },
    },

    {
      name: "termCode filter keeps only matching sections",
      run() {
        const unfiltered = BPReq.normalizeCourseInformationCourses(cs4raw);
        const total = unfiltered.reduce(
          (n, e) => n + (Array.isArray(e.sections) ? e.sections.length : 0),
          0,
        );
        const fallFiltered = BPReq.normalizeCourseInformationCourses(cs4raw, {
          termCode: "202630",
        });
        const fallTotal = fallFiltered.reduce(
          (n, e) => n + e.sections.length,
          0,
        );
        assertTrue(
          fallTotal <= total,
          "term-filtered count cannot exceed unfiltered",
        );
        for (const e of fallFiltered) {
          for (const s of e.sections) {
            assertEqual(String(s.termCode), "202630", "section term is Fall 2026 code");
          }
        }
      },
    },

    {
      name: "excludeKeys drops matching courses",
      run() {
        const beforeCount = BPReq.normalizeCourseInformationCourses(cs4raw).length;
        const out = BPReq.normalizeCourseInformationCourses(cs4raw, {
          excludeKeys: new Set(["CS|4371", "CS|4398"]),
        });
        const keys = new Set(out.map((e) => e.subject + "|" + e.courseNumber));
        assertTrue(!keys.has("CS|4371"), "CS 4371 excluded");
        assertTrue(!keys.has("CS|4398"), "CS 4398 excluded");
        assertEqual(out.length, beforeCount - 2, "exactly 2 courses removed");
      },
    },

    {
      name: "excludeKeys accepts plain array too",
      run() {
        const out = BPReq.normalizeCourseInformationCourses(cs4raw, {
          excludeKeys: ["CS|4371"],
        });
        assertTrue(
          !out.some((e) => e.subject === "CS" && e.courseNumber === "4371"),
          "array-form exclusion applied",
        );
      },
    },

    {
      name: "provenance fields flow through",
      run() {
        const out = BPReq.normalizeCourseInformationCourses(cs4raw, {
          ruleLabel: "Advanced Electives",
          ruleId: "rule-abc-123",
          parentLabels: ["Major in CS", "Advanced Electives"],
        });
        for (const e of out) {
          assertEqual(e.label, "Advanced Electives");
          assertEqual(e.ruleId, "rule-abc-123");
          assertDeepEqual(e.parentLabels, ["Major in CS", "Advanced Electives"]);
        }
      },
    },

    {
      name: "attributeFilter keeps only courses with that attribute",
      run() {
        // DTSC ('Dif Tui- Science & Engineering') appears on CS 4100 in the
        // fixture. Use it as a realistic filter and assert we get at least
        // that course back, and no courses without the code.
        const out = BPReq.normalizeCourseInformationCourses(cs4raw, {
          attributeFilter: "DTSC",
        });
        assertTrue(out.length > 0, "at least one course has DTSC");
        for (const e of out) {
          const codes = (e.attributes || []).map((a) => a.code);
          assertTrue(
            codes.includes("DTSC"),
            `${e.subject} ${e.courseNumber} should carry DTSC; got ${JSON.stringify(codes)}`,
          );
        }
      },
    },

    {
      name: "accepts both { courseInformation: { courses } } and { courses } shapes",
      run() {
        const wrapped = BPReq.normalizeCourseInformationCourses(cs4raw);
        const unwrapped = BPReq.normalizeCourseInformationCourses(
          cs4raw.courseInformation,
        );
        assertEqual(
          wrapped.length,
          unwrapped.length,
          "same count whether top-level wrapper is present or not",
        );
      },
    },

    {
      name: "empty / malformed input returns empty array, not a throw",
      run() {
        assertDeepEqual(BPReq.normalizeCourseInformationCourses(null), []);
        assertDeepEqual(BPReq.normalizeCourseInformationCourses(undefined), []);
        assertDeepEqual(BPReq.normalizeCourseInformationCourses({}), []);
        assertDeepEqual(
          BPReq.normalizeCourseInformationCourses({ courseInformation: {} }),
          [],
        );
      },
    },

    {
      name: "wildcardCacheKey is stable across runs and distinct across inputs",
      run() {
        const a1 = BPReq.wildcardCacheKey(
          { discipline: "CS", numberPrefix: "4" },
          "202630",
        );
        const a2 = BPReq.wildcardCacheKey(
          { discipline: "CS", numberPrefix: "4" },
          "202630",
        );
        const b = BPReq.wildcardCacheKey(
          { discipline: "CS", numberPrefix: "3" },
          "202630",
        );
        const c = BPReq.wildcardCacheKey(
          { discipline: "CS", numberPrefix: "4" },
          "202650",
        );
        assertEqual(a1, a2, "same inputs → same key");
        assertTrue(a1 !== b, "different number prefix → different key");
        assertTrue(a1 !== c, "different term → different key");
      },
    },

    {
      name: "exceptionKeysFromWildcard pulls concrete excepts out of a wildcard record",
      run() {
        const fake = {
          discipline: "CS",
          numberPrefix: "4",
          exceptOptions: [
            { kind: "concrete", course: { discipline: "CS", number: "4371" } },
            { kind: "concrete", course: { discipline: "CS", number: "4398" } },
            // Wildcard excepts are a separate consideration — normalizer
            // ignores them for the concrete-exclusion set.
            { kind: "subjectWildcard", discipline: "CS", numberPrefix: "49" },
            // Malformed entries should be tolerated.
            null,
            { kind: "concrete" },
          ],
        };
        const keys = BPReq.exceptionKeysFromWildcard(fake);
        assertTrue(keys.has("CS|4371"), "CS 4371 in except set");
        assertTrue(keys.has("CS|4398"), "CS 4398 in except set");
        assertEqual(keys.size, 2, "only concrete excepts included");
      },
    },

    {
      name: "round trip: wildcard + exceptionKeys + termCode reproduces the CS-4xxx net",
      run() {
        // Exercises the call pattern the real fetcher will use:
        //   keys = exceptionKeysFromWildcard(w)
        //   entries = normalize(raw, { excludeKeys: keys, termCode })
        const fakeWildcard = {
          discipline: "CS",
          numberPrefix: "4",
          exceptOptions: [
            { kind: "concrete", course: { discipline: "CS", number: "4371" } },
          ],
        };
        const excludeKeys = BPReq.exceptionKeysFromWildcard(fakeWildcard);
        const entries = BPReq.normalizeCourseInformationCourses(cs4raw, {
          excludeKeys,
          termCode: "202630",
        });
        assertTrue(
          !entries.some((e) => e.courseNumber === "4371"),
          "CS 4371 excluded via round trip",
        );
        assertTrue(entries.length > 0, "some entries still surface");
        // Fall 2026 filter: every kept section must match termCode
        for (const e of entries) {
          for (const s of e.sections) {
            assertEqual(String(s.termCode), "202630");
          }
        }
      },
    },

    // ─── expandAuditWildcards (Bug 4 Layer B + C) ──────────────────────────

    {
      name: "expandAuditWildcards: CS 4@ expands to CS 4xxx courses, fetcher called once",
      async run() {
        const fetcher = makeFetcher({ "CS|4@": cs4raw });
        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              {
                kind: "subjectWildcard",
                discipline: "CS",
                numberPrefix: "4",
                ruleLabel: "Advanced Electives",
                ruleId: "rule-adv-electives",
                parentLabels: ["Major in CS"],
                exceptOptions: [],
              },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          { fetchCourseLink: fetcher, termCode: "202630" },
        );

        assertEqual(fetcher.calls.length, 1, "fetcher called exactly once");
        assertEqual(fetcher.calls[0].subject, "CS", "passed subject");
        assertEqual(
          fetcher.calls[0].numberPattern,
          "4@",
          "passed pattern `${numberPrefix}@`",
        );
        assertTrue(result.added.length > 0, "got at least one expanded course");
        assertEqual(
          result.needed.length,
          result.added.length,
          "needed = input needed (0) + added",
        );
        for (const e of result.added) {
          assertEqual(e.subject, "CS", "every added course is CS");
          assertTrue(
            e.courseNumber.startsWith("4"),
            `${e.courseNumber} is a 4xxx course`,
          );
          assertEqual(e.label, "Advanced Electives", "label provenance carried");
          assertEqual(e.ruleId, "rule-adv-electives", "ruleId provenance carried");
          assertDeepEqual(e.parentLabels, ["Major in CS"]);
        }
      },
    },

    {
      name: "expandAuditWildcards: every added entry matches expected fixture set (Fall 2026 only)",
      async run() {
        // Derive the expected set directly from the fixture so the test
        // is self-checking: any CS 4xxx course with at least one Fall
        // 2026 (termCode "202630") section must appear in added[].
        const expected = new Set();
        for (const c of cs4raw.courseInformation.courses) {
          const hasFall = (c.sections || []).some(
            (s) => String(s.termCode) === "202630",
          );
          if (hasFall) expected.add(`CS|${c.courseNumber}`);
        }
        assertTrue(
          expected.size > 0,
          "sanity: fixture has at least one Fall 2026 CS 4xxx course",
        );

        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              {
                discipline: "CS",
                numberPrefix: "4",
                ruleLabel: "Advanced Electives",
                parentLabels: [],
                exceptOptions: [],
              },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          {
            fetchCourseLink: makeFetcher({ "CS|4@": cs4raw }),
            termCode: "202630",
          },
        );

        const got = new Set(result.added.map((e) => `${e.subject}|${e.courseNumber}`));
        assertEqual(got.size, expected.size, "count matches fixture-derived expectation");
        for (const k of expected) {
          assertTrue(got.has(k), `${k} should be in added`);
        }
      },
    },

    {
      name: "expandAuditWildcards: Layer C — concrete `except` is subtracted from added",
      async run() {
        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              {
                discipline: "CS",
                numberPrefix: "4",
                ruleLabel: "Advanced Electives",
                exceptOptions: [
                  { kind: "concrete", course: { discipline: "CS", number: "4371" } },
                  { kind: "concrete", course: { discipline: "CS", number: "4398" } },
                ],
                parentLabels: [],
              },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          {
            fetchCourseLink: makeFetcher({ "CS|4@": cs4raw }),
            termCode: "202630",
          },
        );

        const keys = new Set(result.added.map((e) => `${e.subject}|${e.courseNumber}`));
        assertTrue(!keys.has("CS|4371"), "CS 4371 excepted");
        assertTrue(!keys.has("CS|4398"), "CS 4398 excepted");
      },
    },

    {
      name: "expandAuditWildcards: dedup — skips courses already in needed/completed/inProgress",
      async run() {
        // Pre-populate each of the three "student already has this" lists
        // with a distinct CS 4xxx course and assert none of them appear
        // in added. Uses the fixture's actual course numbers so the test
        // doesn't rely on coincidence.
        const fixtureCourses = cs4raw.courseInformation.courses
          .filter((c) =>
            (c.sections || []).some((s) => String(s.termCode) === "202630"),
          )
          .map((c) => c.courseNumber);
        assertTrue(fixtureCourses.length >= 3, "need ≥3 Fall 2026 CS 4xxx courses");
        const [inNeeded, inCompleted, inProgress] = fixtureCourses;

        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              { discipline: "CS", numberPrefix: "4", ruleLabel: "x", exceptOptions: [] },
            ],
            needed: [{ subject: "CS", courseNumber: inNeeded, label: "existing" }],
            completed: [{ subject: "CS", courseNumber: inCompleted, grade: "A" }],
            inProgress: [{ subject: "CS", courseNumber: inProgress, title: "" }],
          },
          {
            fetchCourseLink: makeFetcher({ "CS|4@": cs4raw }),
            termCode: "202630",
          },
        );

        const addedKeys = new Set(
          result.added.map((e) => `${e.subject}|${e.courseNumber}`),
        );
        assertTrue(!addedKeys.has(`CS|${inNeeded}`), "already-in-needed skipped");
        assertTrue(!addedKeys.has(`CS|${inCompleted}`), "already-completed skipped");
        assertTrue(!addedKeys.has(`CS|${inProgress}`), "already-in-progress skipped");
        // result.needed preserves original needed[] entry + adds new ones
        assertEqual(
          result.needed.length,
          1 + result.added.length,
          "needed is original (1) + added",
        );
      },
    },

    {
      name: "expandAuditWildcards: fetcher passes correct pattern for pure subject wildcard (CS @)",
      async run() {
        const fetcher = makeFetcher({});
        await BPReq.expandAuditWildcards(
          {
            wildcards: [
              { discipline: "CS", numberPrefix: "", ruleLabel: "x", exceptOptions: [] },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          { fetchCourseLink: fetcher, termCode: "202630" },
        );
        assertEqual(fetcher.calls.length, 1, "fetcher called once");
        assertEqual(fetcher.calls[0].numberPattern, "@", "empty prefix → `@`");
      },
    },

    {
      name: "expandAuditWildcards: null fetcher result records a failure, does not throw",
      async run() {
        const fetcher = makeFetcher({}); // every key returns null
        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              { discipline: "CS", numberPrefix: "4", ruleLabel: "x", exceptOptions: [] },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          { fetchCourseLink: fetcher, termCode: "202630" },
        );
        assertEqual(result.added.length, 0, "no entries added on fetch null");
        assertEqual(result.failures.length, 1, "one failure recorded");
        assertEqual(result.failures[0].wildcard.discipline, "CS", "failure carries wildcard");
      },
    },

    {
      name: "expandAuditWildcards: fetcher throw is caught per-wildcard, others still run",
      async run() {
        const fetcher = async (subject, pattern) => {
          if (subject === "BOOM") throw new Error("simulated network death");
          if (subject === "CS" && pattern === "4@") return cs4raw;
          return null;
        };
        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              { discipline: "BOOM", numberPrefix: "1", ruleLabel: "broken", exceptOptions: [] },
              { discipline: "CS", numberPrefix: "4", ruleLabel: "ok", exceptOptions: [] },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          { fetchCourseLink: fetcher, termCode: "202630" },
        );
        assertEqual(result.failures.length, 1, "exactly one failure");
        assertTrue(
          /simulated network death/.test(result.failures[0].error),
          "failure.error carries the thrown message",
        );
        assertTrue(result.added.length > 0, "working wildcard still expanded");
      },
    },

    {
      name: "expandAuditWildcards: attribute-only wildcard (`@ @`) is skipped, fetcher not called",
      async run() {
        const fetcher = makeFetcher({});
        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              {
                discipline: "@",
                numberPrefix: "",
                ruleLabel: "Math Core",
                withClauses: [{ field: "ATTRIBUTE", code: "020" }],
                exceptOptions: [],
              },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          { fetchCourseLink: fetcher, termCode: "202630" },
        );
        assertEqual(fetcher.calls.length, 0, "fetcher NOT called for `@` subject");
        assertEqual(result.added.length, 0, "no additions");
        assertEqual(result.skipped.length, 1, "one wildcard skipped");
        assertTrue(
          /Layer D/.test(result.skipped[0].reason),
          "reason references Layer D",
        );
      },
    },

    {
      name: "expandAuditWildcards: missing fetchCourseLink throws a helpful error",
      async run() {
        let threw = null;
        try {
          await BPReq.expandAuditWildcards(
            { wildcards: [], needed: [], completed: [], inProgress: [] },
            { termCode: "202630" }, // no fetchCourseLink
          );
        } catch (e) {
          threw = e;
        }
        assertTrue(threw != null, "threw on missing fetcher");
        assertTrue(
          /fetchCourseLink/.test(threw.message),
          "error message names the missing option",
        );
      },
    },

    {
      name: "expandAuditWildcards: empty wildcards → no fetches, needed unchanged",
      async run() {
        const fetcher = makeFetcher({});
        const preNeeded = [{ subject: "CS", courseNumber: "1428", label: "a" }];
        const result = await BPReq.expandAuditWildcards(
          { wildcards: [], needed: preNeeded, completed: [], inProgress: [] },
          { fetchCourseLink: fetcher, termCode: "202630" },
        );
        assertEqual(fetcher.calls.length, 0, "no fetches");
        assertEqual(result.added.length, 0);
        assertDeepEqual(result.needed, preNeeded, "input needed returned intact");
      },
    },

    {
      name: "expandAuditWildcards: null termCode keeps courses regardless of section count",
      async run() {
        // With termCode=null the orchestrator should NOT drop entries
        // whose sections filter down to empty — there's no filter to
        // apply. All 31 CS 4xxx fixture entries should come through.
        const result = await BPReq.expandAuditWildcards(
          {
            wildcards: [
              { discipline: "CS", numberPrefix: "4", ruleLabel: "x", exceptOptions: [] },
            ],
            needed: [],
            completed: [],
            inProgress: [],
          },
          { fetchCourseLink: makeFetcher({ "CS|4@": cs4raw }), termCode: null },
        );
        assertEqual(
          result.added.length,
          cs4raw.courseInformation.courses.length,
          "every fixture course kept when no term filter",
        );
      },
    },
  ],
};

// ─── helpers ─────────────────────────────────────────────────────────────

// Canned async fetcher. `responses[subject + "|" + numberPattern]` → raw
// JSON or null. Records call order on `.calls` so tests can assert on
// the exact (subject, pattern) tuples requested.
function makeFetcher(responses) {
  const calls = [];
  const fn = async (subject, numberPattern) => {
    calls.push({ subject, numberPattern });
    const key = subject + "|" + numberPattern;
    return Object.prototype.hasOwnProperty.call(responses, key)
      ? responses[key]
      : null;
  };
  fn.calls = calls;
  return fn;
}
